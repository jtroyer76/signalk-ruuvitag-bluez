// Tests for BluezScanner's per-device watch bookkeeping and its reconnect
// supervision. dbus-next hands out a fresh proxy on every getProxyObject()
// call and fans each signal out to every listener on the bus, so watching a
// path twice doubles every advertisement; the fake bus below reproduces that
// fan-out. The real D-Bus I/O needs a live system bus + bluetoothd and is
// exercised on-device.
// Run with: node scanner.test.js

'use strict'

const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const { BluezScanner, nextReconnectDelay } = require('./scanner')

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

t('nextReconnectDelay: doubles each step', () => {
  assert.equal(nextReconnectDelay(1000), 2000)
  assert.equal(nextReconnectDelay(2000), 4000)
  assert.equal(nextReconnectDelay(4000), 8000)
})

t('nextReconnectDelay: caps at 30s', () => {
  assert.equal(nextReconnectDelay(16000), 30000)
  assert.equal(nextReconnectDelay(30000), 30000)
})

t('constructor: requires a numeric manufacturerId', () => {
  assert.throws(() => new BluezScanner({}), TypeError)
  assert.throws(() => new BluezScanner({ manufacturerId: 'x' }), TypeError)
  assert.doesNotThrow(() => new BluezScanner({ manufacturerId: RUUVI }))
})

t('stop() before start() is a safe no-op', async () => {
  const s = new BluezScanner({ manufacturerId: RUUVI })
  await s.stop()
  assert.equal(s.running, false)
})

t('_handleDrop is ignored before a connection is established', async () => {
  const s = new BluezScanner({ manufacturerId: RUUVI })
  s.running = true // started, but _establish never succeeded
  await s._handleDrop('test')
  assert.equal(s.reconnecting, false)
  assert.equal(s.reconnectTimer, null)
})

t('a drop after establish schedules one reconnect; stop() cancels it', async () => {
  const s = new BluezScanner({ manufacturerId: RUUVI })
  s.running = true
  s.established = true
  await s._handleDrop('test')
  assert.equal(s.reconnecting, true)
  assert.notEqual(s.reconnectTimer, null)

  // A second trigger while already reconnecting must not stack loops.
  const timer = s.reconnectTimer
  await s._handleDrop('again')
  assert.equal(s.reconnectTimer, timer)

  await s.stop()
  assert.equal(s.running, false)
  assert.equal(s.reconnectTimer, null)
})

let failed = 0
;(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`ok    ${name}`)
    } catch (e) {
      console.error(`FAIL  ${name}`)
      console.error(`      ${e.message}`)
      failed++
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  process.exit(failed ? 1 : 0)
})()
