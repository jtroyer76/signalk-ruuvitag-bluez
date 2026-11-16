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

const ADAPTER = '/org/bluez/hci0'

// A system bus that _establish() can run against end to end. Device paths
// delegate to fakeBus() so PropertiesChanged fan-out behaves the same.
// `gate`, if given, holds GetManagedObjects() until it resolves, leaving
// an _establish() suspended mid-flight.
function fakeSystemBus({ gate } = {}) {
  const devices = fakeBus()
  const bus = new EventEmitter()
  const objectManager = new EventEmitter()
  bus.objectManager = objectManager
  bus.startDiscoveryCalls = 0
  bus.disconnected = false
  const omIface = {
    on: (ev, fn) => objectManager.on(ev, fn),
    off: (ev, fn) => objectManager.off(ev, fn),
    GetManagedObjects: async () => {
      if (gate) await gate
      return { [ADAPTER]: { 'org.bluez.Adapter1': {} } }
    },
  }
  const adapterIface = {
    SetDiscoveryFilter: async () => {},
    StartDiscovery: async () => { bus.startDiscoveryCalls++ },
    StopDiscovery: async () => {},
  }
  const adapterProps = { Get: async () => ({ value: true }), Set: async () => {} }
  bus.getProxyObject = async (name, path) => {
    if (path === '/') return { getInterface: () => omIface }
    if (path === ADAPTER) {
      return { getInterface: (i) => (i === 'org.bluez.Adapter1' ? adapterIface : adapterProps) }
    }
    return devices.getProxyObject(name, path)
  }
  bus.disconnect = () => { bus.disconnected = true }
  bus.devices = devices
  return bus
}

// scanner.js calls dbus.systemBus() through the module object, so replacing
// it here hands each _establish() the next queued fake.
const dbus = require('dbus-next')
const busQueue = []
dbus.systemBus = () => {
  if (!busQueue.length) throw new Error('test did not queue a fake bus')
  return busQueue.shift()
}

const silentLogger = () => {
  const log = { debug: [], info: [], error: [] }
  return {
    log,
    logger: {
      debug: (m) => log.debug.push(m),
      info: (m) => log.info.push(m),
      error: (m) => log.error.push(m),
    },
  }
}

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

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

t('_teardown forgets watchers so the next bus watches every path again', async () => {
  const s = scannerWithBus()
  await s._watch(PATH)
  s.bus.disconnect = () => {}
  await s._teardown()
  assert.equal(s.watchers.size, 0)

  s.bus = fakeBus()
  await s._watch(PATH)
  assert.equal(s.bus.listeners(PATH), 1)
})

t('a late error from a replaced bus does not tear down the live one', async () => {
  const { logger } = silentLogger()
  const s = new BluezScanner({ manufacturerId: RUUVI, logger })
  const oldBus = fakeSystemBus()
  const newBus = fakeSystemBus()
  busQueue.push(oldBus, newBus)
  await s.start()
  await s.stop()
  await s.start()
  assert.equal(s.bus, newBus)

  oldBus.emit('error', new Error('late error from disconnected bus'))
  await new Promise((r) => setImmediate(r))
  assert.equal(s.reconnecting, false)
  assert.equal(s.established, true)
  assert.equal(s.bus, newBus)
  assert.equal(newBus.disconnected, false)
  await s.stop()
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
