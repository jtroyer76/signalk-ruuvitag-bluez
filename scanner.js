// BlueZ-DBus BLE advertisement scanner.
//
// EventEmitter wrapper around the same logic the Phase 1 spike used:
// open the system DBus, find the BlueZ adapter, start LE discovery with
// DuplicateData=true, and re-emit each PropertiesChanged signal as an
// 'advertisement' event filtered to a single manufacturer ID.
//
// Resilience: the scanner supervises its own connection. A dbus-level
// error (system bus restart, socket drop) and a discovery stall (bluetoothd
// restart, adapter reset — advertisements simply stop arriving) both funnel
// into a single capped-backoff reconnect. Without this the plugin silently
// stops delivering data until SignalK is restarted, and an unhandled bus
// 'error' event could crash the server process.
//
// Events:
//   'advertisement' { address, rssi, name, manufacturerData: Buffer }
//   'started'       { adapterPath }   (re-emitted on every reconnect)
//   'stopped'
//   'error'         Error
//
// Why not node-ble: node-ble's API is shaped around connecting to GATT
// peripherals; it doesn't expose live PropertiesChanged events for
// passive scanning. dbus-next is the right primitive here.

'use strict'

const EventEmitter = require('node:events')
const dbus = require('dbus-next')
const { Variant, Message, MessageType } = dbus

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
// If no matching advertisement arrives for this long after we've seen at
// least one, assume discovery stalled (bluetoothd restart / adapter reset)
// and reconnect. Armed on the first sighting so an install with no tags in
// range doesn't reconnect in a loop.
const LIVENESS_TIMEOUT_MS = 60_000

// One subscription for every device's PropertiesChanged, routed by object
// path in _onMessage(). Per-device proxies would add one D-Bus match rule
// per device, and dbus-next 0.10.2 never sends RemoveMatch (swapped
// hasOwnProperty args in bus.js), so every BlueZ remove/re-add leaked a
// rule until the bus's max_match_rules_per_connection (2048) was hit.
const PROPS_MATCH_RULE =
  "type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties'," +
  "member='PropertiesChanged',path_namespace='/org/bluez'"

const nextReconnectDelay = (current) => Math.min(current * 2, RECONNECT_MAX_MS)

const unwrap = (v) => (v && v.value !== undefined ? v.value : v)

function unwrapAll(props) {
  const out = {}
  for (const [k, v] of Object.entries(props || {})) out[k] = unwrap(v)
  return out
}

function unwrapMfgData(md) {
  if (!md) return null
  const out = {}
  for (const [id, variant] of Object.entries(md)) {
    out[Number(id)] = Buffer.from(unwrap(variant))
  }
  return out
}

class BluezScanner extends EventEmitter {
  constructor({ manufacturerId, logger } = {}) {
    super()
    if (typeof manufacturerId !== 'number') {
      throw new TypeError('BluezScanner requires { manufacturerId: <uint16> }')
    }
    this.manufacturerId = manufacturerId
    this.logger = logger || { debug: () => {}, info: () => {}, error: console.error }
    this.bus = null
    this.adapter = null
    this.adapterPath = null
    this.objectManager = null
    this.devices = new Map() // path -> { address, name, rssi, manufacturerData }
    this._addedHandler = null
    this._messageHandler = null
    this._removedHandler = null
    this._busErrorHandler = null
    // Supervision state.
    this.running = false      // between start() and stop()
    this.established = false   // a connection is currently live
    this.reconnecting = false  // a reconnect loop is in flight
    this.reconnectDelay = RECONNECT_BASE_MS
    this.reconnectTimer = null
    this.livenessTimer = null
  }

  async start() {
    this.running = true
    this.reconnecting = false
    this.reconnectDelay = RECONNECT_BASE_MS
    // First connect fails loudly (SignalK marks the plugin errored); only
    // drops after a successful connect are self-healed.
    await this._establish()
  }

  async stop() {
    this.running = false
    this.reconnecting = false
    // Otherwise a bus error during the next start()'s connect would pass the
    // _handleDrop guard and be self-healed instead of failing start() loudly.
    this.established = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const wasActive = !!this.bus
    await this._teardown()
    if (wasActive) this.emit('stopped')
  }

  async _establish() {
    const bus = dbus.systemBus()
    this.bus = bus

    // Attach before any awaits: an unhandled 'error' on the bus EventEmitter
    // would otherwise throw and take down the server. Kept on the bus object
    // for its whole life. dbus-next keeps emitting 'error' on a bus after
    // disconnect(), so an error from a bus that has since been replaced must
    // not tear down the current one.
    this._busErrorHandler = (err) => {
      if (bus !== this.bus) {
        this.logger.debug(`dbus error on replaced connection: ${err.message}`)
        return
      }
      this.logger.error(`dbus error: ${err.message}`)
      this._handleDrop('BlueZ connection lost (dbus connection error); reconnecting')
    }
    this.bus.on('error', this._busErrorHandler)

    try {
      return await this._connect(bus)
    } catch (e) {
      // A run that stop()/start() superseded fails against its disconnected
      // bus; its error belongs to nobody and must not tear down the new run.
      if (bus !== this.bus) return false
      throw e
    }
  }

  // Bring `bus` up to an active discovery session. Returns false, leaving all
  // state alone, if stop()/start() replaced `bus` while an await was pending
  // (Signal K restarts plugins on config save, possibly mid-reconnect).
  async _connect(bus) {
    const superseded = () => bus !== this.bus

    const bluez = await bus.getProxyObject('org.bluez', '/')
    if (superseded()) return false
    const objectManager = bluez.getInterface('org.freedesktop.DBus.ObjectManager')
    this.objectManager = objectManager

    const objects = await objectManager.GetManagedObjects()
    if (superseded()) return false

    const adapterPath = Object.keys(objects).find((path) => objects[path]['org.bluez.Adapter1'])
    if (!adapterPath) {
      throw new Error('No BlueZ adapter found. Is bluetoothd running?')
    }
    this.adapterPath = adapterPath

    const adapterObj = await bus.getProxyObject('org.bluez', adapterPath)
    if (superseded()) return false
    const adapter = adapterObj.getInterface('org.bluez.Adapter1')
    this.adapter = adapter
    const adapterProps = adapterObj.getInterface('org.freedesktop.DBus.Properties')

    const powered = await adapterProps.Get('org.bluez.Adapter1', 'Powered')
    if (superseded()) return false
    if (!unwrap(powered)) {
      this.logger.info('BlueZ adapter not powered, powering on')
      await adapterProps.Set('org.bluez.Adapter1', 'Powered', new Variant('b', true))
      if (superseded()) return false
    }

    // DuplicateData=true: BlueZ emits a fresh PropertiesChanged for every
    // advertisement instead of deduplicating per-device.
    await adapter.SetDiscoveryFilter({
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    })
    if (superseded()) return false

    await bus.call(new Message({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'AddMatch',
      signature: 's',
      body: [PROPS_MATCH_RULE],
    }))
    if (superseded()) return false
    this._messageHandler = (msg) => this._onMessage(msg)
    bus.on('message', this._messageHandler)

    this._addedHandler = (path, ifaces) => {
      const dev = ifaces['org.bluez.Device1']
      if (!dev) return
      const props = unwrapAll(dev)
      if (props.ManufacturerData) {
        props.ManufacturerData = unwrapMfgData(props.ManufacturerData)
      }
      const state = this._update(path, props)
      this._maybeEmit(state)
    }
    objectManager.on('InterfacesAdded', this._addedHandler)

    this._removedHandler = (path, ifaces) => {
      if (!ifaces.includes('org.bluez.Device1')) return
      this.devices.delete(path)
    }
    objectManager.on('InterfacesRemoved', this._removedHandler)

    for (const [path, ifaces] of Object.entries(objects)) {
      if (!ifaces['org.bluez.Device1']) continue
      const props = unwrapAll(ifaces['org.bluez.Device1'])
      if (props.ManufacturerData) {
        props.ManufacturerData = unwrapMfgData(props.ManufacturerData)
      }
      this._update(path, props)
    }

    try {
      await adapter.StartDiscovery()
    } catch (e) {
      if (!/AlreadyExists|InProgress/i.test(e.message || '')) throw e
      this.logger.info('Discovery already running (another DBus client owns it) - continuing')
    }
    if (superseded()) return false

    this.established = true
    this.emit('started', { adapterPath })
    return true
  }

  // A connection drop or discovery stall was detected. Tear the current
  // connection down and enter the reconnect loop. Guarded so overlapping
  // triggers (bus error + liveness timeout) and stale old-bus errors during
  // a reconnect don't stack loops.
  async _handleDrop(message, level = 'error') {
    if (!this.running || this.reconnecting || !this.established) return
    this.reconnecting = true
    this.established = false
    this.logger[level](message)
    this.reconnectDelay = RECONNECT_BASE_MS
    await this._teardown()
    this._scheduleReconnect()
  }

  _scheduleReconnect() {
    if (!this.running) {
      this.reconnecting = false
      return
    }
    this.logger.info(`reconnecting to BlueZ in ${Math.round(this.reconnectDelay / 1000)}s`)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (!this.running) {
        this.reconnecting = false
        return
      }
      try {
        // Superseded by stop()/start(): the new run owns the state now.
        if (!(await this._establish())) return
        this.reconnectDelay = RECONNECT_BASE_MS
        this.reconnecting = false
        this.logger.info('reconnected to BlueZ')
      } catch (e) {
        this.logger.error(`reconnect failed: ${e.message}`)
        await this._teardown()
        this.reconnectDelay = nextReconnectDelay(this.reconnectDelay)
        this._scheduleReconnect()
      }
    }, this.reconnectDelay)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  // Best-effort release of the current connection. Every step is guarded so
  // it is safe to call on an already-dead bus (the drop case) and on a live
  // one (the stop case). The bus 'error' listener is intentionally left on
  // the (now dereferenced) bus so disconnect()-triggered errors don't throw;
  // it is garbage-collected with the bus.
  async _teardown() {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
    if (this.bus) {
      try {
        if (this.adapter) await this.adapter.StopDiscovery()
      } catch (e) {
        this.logger.debug(`StopDiscovery error: ${e.message}`)
      }
      if (this.objectManager && this._addedHandler) {
        try { this.objectManager.off('InterfacesAdded', this._addedHandler) } catch (e) { /* ignore */ }
      }
      if (this.objectManager && this._removedHandler) {
        try { this.objectManager.off('InterfacesRemoved', this._removedHandler) } catch (e) { /* ignore */ }
      }
      // No RemoveMatch needed: the rule dies with the connection below.
      if (this._messageHandler) this.bus.off('message', this._messageHandler)
      try { this.bus.disconnect() } catch (e) { /* ignore */ }
    }
    this.bus = null
    this.adapter = null
    this.adapterPath = null
    this.objectManager = null
    this._addedHandler = null
    this._removedHandler = null
    this._messageHandler = null
    this._busErrorHandler = null
    this.devices.clear()
  }

  // (Re)arm the discovery-liveness watchdog. Called on every delivered
  // advertisement, so the timer only exists once data has actually flowed.
  _resetLiveness() {
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    if (!this.running) return
    this.livenessTimer = setTimeout(() => this._onLivenessTimeout(), LIVENESS_TIMEOUT_MS)
    if (this.livenessTimer.unref) this.livenessTimer.unref()
  }

  // Silence is ambiguous: a stalled discovery looks the same as every tag
  // being out of range, asleep or on a flat battery, so this is not logged
  // as a connection failure.
  _onLivenessTimeout() {
    return this._handleDrop(
      `no advertisements for ${LIVENESS_TIMEOUT_MS / 1000}s; restarting discovery`,
      'info',
    )
  }

  _update(path, props) {
    const s = this.devices.get(path) || {}
    if (props.Address !== undefined) s.address = props.Address
    if (props.Name !== undefined) s.name = props.Name
    if (props.RSSI !== undefined) s.rssi = props.RSSI
    if (props.ManufacturerData !== undefined) s.manufacturerData = props.ManufacturerData
    this.devices.set(path, s)
    return s
  }

  // PropertiesChanged for any BlueZ object arrives here via the single
  // PROPS_MATCH_RULE subscription. Only known devices are reported, so a
  // signal racing InterfacesRemoved can't resurrect a removed device.
  _onMessage(msg) {
    if (msg.type !== MessageType.SIGNAL) return
    if (msg.interface !== 'org.freedesktop.DBus.Properties' || msg.member !== 'PropertiesChanged') return
    const [iface, changed] = msg.body || []
    if (iface !== 'org.bluez.Device1') return
    if (!this.devices.has(msg.path)) return
    const u = unwrapAll(changed)
    if (u.ManufacturerData !== undefined) {
      u.ManufacturerData = unwrapMfgData(u.ManufacturerData)
    }
    const state = this._update(msg.path, u)
    // Only emit on advertisements that carry fresh manufacturer data
    // (RSSI-only updates are noise here — the decoder needs payload).
    if (u.ManufacturerData !== undefined) this._maybeEmit(state)
  }

  _maybeEmit(state) {
    if (!state.manufacturerData) return
    const data = state.manufacturerData[this.manufacturerId]
    if (!data) return
    this._resetLiveness()
    this.emit('advertisement', {
      address: state.address || null,
      name: state.name || null,
      rssi: state.rssi != null ? state.rssi : null,
      manufacturerData: data,
    })
  }
}

module.exports = { BluezScanner, nextReconnectDelay }
