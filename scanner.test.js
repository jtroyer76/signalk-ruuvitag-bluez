// Tests for BluezScanner's per-device watch bookkeeping. dbus-next hands
// out a fresh proxy on every getProxyObject() call and fans each signal out
// to every listener on the bus, so watching a path twice doubles every
// advertisement. The fake bus below reproduces that fan-out.
// Run with: node scanner.test.js

'use strict'

const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const { BluezScanner } = require('./scanner')

const RUUVI = 0x0499
const PATH = '/org/bluez/hci0/dev_C2_64_6B_F3_E6_EB'

// Every proxy for a path shares one signal emitter, like dbus-next's
// bus._signals. .off() on any proxy removes only that proxy's handler.
function fakeBus() {
  const signals = new Map() // path -> EventEmitter
  const bus = {
    getProxyObject: async (_name, path) => {
      if (!signals.has(path)) signals.set(path, new EventEmitter())
      const shared = signals.get(path)
      return {
        getInterface: () => ({
          on: (ev, fn) => shared.on(ev, fn),
          off: (ev, fn) => shared.off(ev, fn),
        }),
      }
    },
    signal: (path, ...args) => signals.get(path).emit('PropertiesChanged', ...args),
    listeners: (path) => (signals.has(path) ? signals.get(path).listenerCount('PropertiesChanged') : 0),
  }
  return bus
}

function scannerWithBus() {
  const scanner = new BluezScanner({ manufacturerId: RUUVI })
  scanner.bus = fakeBus()
  return scanner
}

const mfgChange = () => ({
  ManufacturerData: { value: { [RUUVI]: { value: [5, 1, 2, 3] } } },
})

const tests = []
const t = (name, fn) => tests.push({ name, fn })

t('_watch: same path twice registers one listener', async () => {
  const s = scannerWithBus()
  await s._watch(PATH)
  await s._watch(PATH)
  assert.equal(s.bus.listeners(PATH), 1)
})

t('_watch: concurrent calls for same path register one listener', async () => {
  const s = scannerWithBus()
  await Promise.all([s._watch(PATH), s._watch(PATH), s._watch(PATH)])
  assert.equal(s.bus.listeners(PATH), 1)
})

t('one signal produces one advertisement after repeated watches', async () => {
  const s = scannerWithBus()
  await s._watch(PATH)
  await s._watch(PATH)
  let n = 0
  s.on('advertisement', () => n++)
  s.bus.signal(PATH, 'org.bluez.Device1', mfgChange())
  assert.equal(n, 1)
})

t('_unwatch then re-watch (BlueZ remove/re-add) keeps one listener', async () => {
  const s = scannerWithBus()
  for (let i = 0; i < 5; i++) {
    await s._watch(PATH)
    s._unwatch(PATH)
  }
  await s._watch(PATH)
  assert.equal(s.bus.listeners(PATH), 1)
})

t('_unwatch during pending _watch does not leave a listener', async () => {
  const s = scannerWithBus()
  const p = s._watch(PATH)
  s._unwatch(PATH)
  await p
  assert.equal(s.bus.listeners(PATH), 0)
  assert.equal(s.watchers.size, 0)
})

;(async () => {
  let failed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`ok   ${name}`)
    } catch (e) {
      failed++
      console.log(`FAIL ${name}\n     ${e.message}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  if (failed) process.exit(1)
})()
