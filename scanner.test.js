// Tests for BluezScanner's signal routing and its reconnect supervision.
// The fake system bus below stands in for dbus-next: it records AddMatch
// calls and delivers PropertiesChanged as raw 'message' events, the way
// the scanner's single path_namespace subscription receives them. The
// real D-Bus I/O needs a live system bus + bluetoothd and is exercised
// on-device.
// Run with: node scanner.test.js

'use strict'

const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const { BluezScanner, nextReconnectDelay } = require('./scanner')

const RUUVI = 0x0499
const ADAPTER = '/org/bluez/hci0'
const PATH = '/org/bluez/hci0/dev_C2_64_6B_F3_E6_EB'
const SIGNAL = 4 // dbus-next MessageType.SIGNAL

const mfgChange = () => ({
  ManufacturerData: { value: { [RUUVI]: { value: [5, 1, 2, 3] } } },
})
const device = (address) => ({ 'org.bluez.Device1': { Address: { value: address } } })

// A system bus that _establish() can run against end to end. `devices`
// seeds GetManagedObjects() with path -> ifaces. `gate`, if given, holds
// GetManagedObjects() until it resolves, leaving an _establish()
// suspended mid-flight.
function fakeSystemBus({ gate, devices = {} } = {}) {
  const bus = new EventEmitter()
  const objectManager = new EventEmitter()
  bus.objectManager = objectManager
  bus.startDiscoveryCalls = 0
  bus.addMatches = []
  bus.disconnected = false
  const omIface = {
    on: (ev, fn) => objectManager.on(ev, fn),
    off: (ev, fn) => objectManager.off(ev, fn),
    GetManagedObjects: async () => {
      if (gate) await gate
      return { [ADAPTER]: { 'org.bluez.Adapter1': {} }, ...devices }
    },
  }
  const adapterIface = {
    SetDiscoveryFilter: async () => {},
    StartDiscovery: async () => { bus.startDiscoveryCalls++ },
    StopDiscovery: async () => {},
  }
  const adapterProps = { Get: async () => ({ value: true }), Set: async () => {} }
  bus.getProxyObject = async (_name, path) => {
    if (path === '/') return { getInterface: () => omIface }
    if (path === ADAPTER) {
      return { getInterface: (i) => (i === 'org.bluez.Adapter1' ? adapterIface : adapterProps) }
    }
    throw new Error(`unexpected per-device proxy for ${path}`)
  }
  bus.call = async (msg) => {
    if (msg.member === 'AddMatch') bus.addMatches.push(msg.body[0])
  }
  bus.signal = (path, iface, changed) => bus.emit('message', {
    type: SIGNAL,
    path,
    interface: 'org.freedesktop.DBus.Properties',
    member: 'PropertiesChanged',
    body: [iface, changed, []],
  })
  bus.disconnect = () => { bus.disconnected = true }
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

// A started scanner on a fresh fake bus, counting advertisements.
async function startedScanner(opts) {
  const { logger } = silentLogger()
  const s = new BluezScanner({ manufacturerId: RUUVI, logger })
  const bus = fakeSystemBus(opts)
  busQueue.push(bus)
  await s.start()
  const adverts = []
  s.on('advertisement', (a) => adverts.push(a))
  return { s, bus, adverts }
}

const tests = []
const t = (name, fn) => tests.push({ name, fn })

t('one path_namespace AddMatch covers every device', async () => {
  const devices = {}
  for (let i = 0; i < 50; i++) devices[`${ADAPTER}/dev_00_00_00_00_00_${String(i).padStart(2, '0')}`] = device(`00:${i}`)
  const { s, bus } = await startedScanner({ devices })
  assert.equal(bus.addMatches.length, 1)
  assert.match(bus.addMatches[0], /member='PropertiesChanged'/)
  assert.match(bus.addMatches[0], /path_namespace='\/org\/bluez'/)
  assert.match(bus.addMatches[0], /sender='org.bluez'/)
  await s.stop()
})

t('BlueZ remove/re-add churn adds no match rules', async () => {
  const { s, bus } = await startedScanner()
  for (let i = 0; i < 1000; i++) {
    bus.objectManager.emit('InterfacesAdded', PATH, device('C2:64:6B:F3:E6:EB'))
    bus.objectManager.emit('InterfacesRemoved', PATH, ['org.bluez.Device1'])
  }
  assert.equal(bus.addMatches.length, 1)
  await s.stop()
})

t('PropertiesChanged with manufacturer data emits one advertisement', async () => {
  const { s, bus, adverts } = await startedScanner({ devices: { [PATH]: device('C2:64:6B:F3:E6:EB') } })
  bus.signal(PATH, 'org.bluez.Device1', mfgChange())
  assert.equal(adverts.length, 1)
  assert.equal(adverts[0].address, 'C2:64:6B:F3:E6:EB')
  assert.deepEqual([...adverts[0].manufacturerData], [5, 1, 2, 3])
  await s.stop()
})

t('RSSI-only, other-interface and unknown-device signals are ignored', async () => {
  const { s, bus, adverts } = await startedScanner({ devices: { [PATH]: device('C2:64:6B:F3:E6:EB') } })
  bus.signal(PATH, 'org.bluez.Device1', { RSSI: { value: -60 } })
  bus.signal(PATH, 'org.bluez.Battery1', mfgChange())
  bus.signal(`${ADAPTER}/dev_AA_AA_AA_AA_AA_AA`, 'org.bluez.Device1', mfgChange())
  assert.equal(adverts.length, 0)
  assert.equal(s.devices.get(PATH).rssi, -60)
  await s.stop()
})

t('a removed device stays removed if a late signal arrives', async () => {
  const { s, bus, adverts } = await startedScanner({ devices: { [PATH]: device('C2:64:6B:F3:E6:EB') } })
  bus.objectManager.emit('InterfacesRemoved', PATH, ['org.bluez.Device1'])
  bus.signal(PATH, 'org.bluez.Device1', mfgChange())
  assert.equal(adverts.length, 0)
  assert.equal(s.devices.has(PATH), false)
  await s.stop()
})

t('a device added at runtime is routed', async () => {
  const { s, bus, adverts } = await startedScanner()
  bus.objectManager.emit('InterfacesAdded', PATH, device('C2:64:6B:F3:E6:EB'))
  bus.signal(PATH, 'org.bluez.Device1', mfgChange())
  assert.equal(adverts.length, 1)
  await s.stop()
})

t('teardown detaches the message handler from the old bus', async () => {
  const { s, bus, adverts } = await startedScanner({ devices: { [PATH]: device('C2:64:6B:F3:E6:EB') } })
  await s.stop()
  assert.equal(bus.listenerCount('message'), 0)
  bus.signal(PATH, 'org.bluez.Device1', mfgChange())
  assert.equal(adverts.length, 0)
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

t('stop()/start() during an in-flight _establish leaves one run on the new bus', async () => {
  const { logger } = silentLogger()
  const s = new BluezScanner({ manufacturerId: RUUVI, logger })
  const gate = deferred()
  const staleBus = fakeSystemBus({ gate: gate.promise })
  const liveBus = fakeSystemBus()
  busQueue.push(staleBus, liveBus)

  const staleRun = s._establish()
  await new Promise((r) => setImmediate(r)) // suspended in GetManagedObjects
  await s.stop()
  await s.start()
  gate.resolve()
  await staleRun

  assert.equal(s.bus, liveBus)
  assert.equal(s.established, true)
  assert.equal(liveBus.objectManager.listenerCount('InterfacesAdded'), 1)
  assert.equal(liveBus.objectManager.listenerCount('InterfacesRemoved'), 1)
  assert.equal(liveBus.listenerCount('message'), 1)
  assert.equal(staleBus.listenerCount('message'), 0)
  assert.equal(liveBus.addMatches.length, 1)
  assert.equal(staleBus.startDiscoveryCalls, 0)
  assert.equal(liveBus.startDiscoveryCalls, 1)
  await s.stop()
})

t('liveness timeout on quiet tags logs at info, not error', async () => {
  const { log, logger } = silentLogger()
  const s = new BluezScanner({ manufacturerId: RUUVI, logger })
  s.running = true
  s.established = true
  await s._onLivenessTimeout()
  assert.equal(log.error.length, 0)
  assert.match(log.info.join('\n'), /no advertisements for 60s; restarting discovery/)
  await s.stop()
})

t('a bus error during start() after stop() fails start(), not a reconnect', async () => {
  const { logger } = silentLogger()
  const s = new BluezScanner({ manufacturerId: RUUVI, logger })
  busQueue.push(fakeSystemBus())
  await s.start()
  await s.stop()
  assert.equal(s.established, false)

  const gate = deferred()
  const bus = fakeSystemBus({ gate: gate.promise })
  busQueue.push(bus)
  const starting = s.start()
  await new Promise((r) => setImmediate(r)) // suspended in GetManagedObjects
  bus.emit('error', new Error('bus dropped mid-connect'))
  await new Promise((r) => setImmediate(r))
  assert.equal(s.reconnecting, false)
  assert.equal(s.reconnectTimer, null)
  gate.resolve()
  await starting
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
