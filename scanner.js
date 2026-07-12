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
const { Variant } = dbus

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
// If no matching advertisement arrives for this long after we've seen at
// least one, assume discovery stalled (bluetoothd restart / adapter reset)
// and reconnect. Armed on the first sighting so an install with no tags in
// range doesn't reconnect in a loop.
const LIVENESS_TIMEOUT_MS = 60_000

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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const wasActive = !!this.bus
    await this._teardown()
    if (wasActive) this.emit('stopped')
  }

  async _establish() {
    this.bus = dbus.systemBus()

    // Attach before any awaits: an unhandled 'error' on the bus EventEmitter
    // would otherwise throw and take down the server. Kept on the bus object
    // for its whole life; guards in _handleDrop make stale invocations no-ops.
    this._busErrorHandler = (err) => {
      this.logger.error(`dbus error: ${err.message}`)
      this._handleDrop('dbus connection error')
    }
    this.bus.on('error', this._busErrorHandler)

    const bluez = await this.bus.getProxyObject('org.bluez', '/')
    this.objectManager = bluez.getInterface('org.freedesktop.DBus.ObjectManager')

    const objects = await this.objectManager.GetManagedObjects()

    for (const [path, ifaces] of Object.entries(objects)) {
      if (ifaces['org.bluez.Adapter1']) {
        this.adapterPath = path
        break
      }
    }
    if (!this.adapterPath) {
      throw new Error('No BlueZ adapter found. Is bluetoothd running?')
    }

    const adapterObj = await this.bus.getProxyObject('org.bluez', this.adapterPath)
    this.adapter = adapterObj.getInterface('org.bluez.Adapter1')
    const adapterProps = adapterObj.getInterface('org.freedesktop.DBus.Properties')

    const powered = await adapterProps.Get('org.bluez.Adapter1', 'Powered')
    if (!unwrap(powered)) {
      this.logger.info('BlueZ adapter not powered, powering on')
      await adapterProps.Set('org.bluez.Adapter1', 'Powered', new Variant('b', true))
    }

    // DuplicateData=true: BlueZ emits a fresh PropertiesChanged for every
    // advertisement instead of deduplicating per-device.
    await this.adapter.SetDiscoveryFilter({
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    })

    this._addedHandler = async (path, ifaces) => {
      const dev = ifaces['org.bluez.Device1']
      if (!dev) return
      const props = unwrapAll(dev)
      if (props.ManufacturerData) {
        props.ManufacturerData = unwrapMfgData(props.ManufacturerData)
      }
      const state = this._update(path, props)
      this._maybeEmit(state)
      await this._watch(path)
    }
    this.objectManager.on('InterfacesAdded', this._addedHandler)

    for (const [path, ifaces] of Object.entries(objects)) {
      if (!ifaces['org.bluez.Device1']) continue
      const props = unwrapAll(ifaces['org.bluez.Device1'])
      if (props.ManufacturerData) {
        props.ManufacturerData = unwrapMfgData(props.ManufacturerData)
      }
      this._update(path, props)
      await this._watch(path)
    }

    try {
      await this.adapter.StartDiscovery()
    } catch (e) {
      if (!/AlreadyExists|InProgress/i.test(e.message || '')) throw e
      this.logger.info('Discovery already running (another DBus client owns it) - continuing')
    }

    this.established = true
    this.emit('started', { adapterPath: this.adapterPath })
  }

  // A connection drop or discovery stall was detected. Tear the current
  // connection down and enter the reconnect loop. Guarded so overlapping
  // triggers (bus error + liveness timeout) and stale old-bus errors during
  // a reconnect don't stack loops.
  async _handleDrop(reason) {
    if (!this.running || this.reconnecting || !this.established) return
    this.reconnecting = true
    this.established = false
    this.logger.error(`BlueZ connection lost (${reason}); reconnecting`)
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
        await this._establish()
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
      try { this.bus.disconnect() } catch (e) { /* ignore */ }
    }
    this.bus = null
    this.adapter = null
    this.adapterPath = null
    this.objectManager = null
    this._addedHandler = null
    this._busErrorHandler = null
    this.devices.clear()
  }

  // (Re)arm the discovery-liveness watchdog. Called on every delivered
  // advertisement, so the timer only exists once data has actually flowed.
  _resetLiveness() {
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    if (!this.running) return
    this.livenessTimer = setTimeout(() => {
      this._handleDrop(`no advertisements for ${LIVENESS_TIMEOUT_MS / 1000}s`)
    }, LIVENESS_TIMEOUT_MS)
    if (this.livenessTimer.unref) this.livenessTimer.unref()
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

  async _watch(path) {
    try {
      const obj = await this.bus.getProxyObject('org.bluez', path)
      const propsIface = obj.getInterface('org.freedesktop.DBus.Properties')
      propsIface.on('PropertiesChanged', (iface, changed) => {
        if (iface !== 'org.bluez.Device1') return
        const u = unwrapAll(changed)
        if (u.ManufacturerData !== undefined) {
          u.ManufacturerData = unwrapMfgData(u.ManufacturerData)
        }
        const state = this._update(path, u)
        // Only emit on advertisements that carry fresh manufacturer data
        // (RSSI-only updates are noise here — the decoder needs payload).
        if (u.ManufacturerData !== undefined) this._maybeEmit(state)
      })
    } catch (e) {
      this.logger.debug(`watch(${path}) failed: ${e.message}`)
    }
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
