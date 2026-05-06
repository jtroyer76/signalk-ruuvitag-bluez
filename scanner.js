// BlueZ-DBus BLE advertisement scanner.
//
// EventEmitter wrapper around the same logic the Phase 1 spike used:
// open the system DBus, find the BlueZ adapter, start LE discovery with
// DuplicateData=true, and re-emit each PropertiesChanged signal as an
// 'advertisement' event filtered to a single manufacturer ID.
//
// Events:
//   'advertisement' { address, rssi, name, manufacturerData: Buffer }
//   'started'       { adapterPath }
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
  }

  async start() {
    this.bus = dbus.systemBus()

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

    this.emit('started', { adapterPath: this.adapterPath })
  }

  async stop() {
    if (!this.bus) return
    try {
      if (this.adapter) await this.adapter.StopDiscovery()
    } catch (e) {
      this.logger.debug(`StopDiscovery error: ${e.message}`)
    }
    if (this.objectManager && this._addedHandler) {
      this.objectManager.off('InterfacesAdded', this._addedHandler)
    }
    try { this.bus.disconnect() } catch (e) { /* ignore */ }
    this.bus = null
    this.adapter = null
    this.objectManager = null
    this.devices.clear()
    this.emit('stopped')
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
    this.emit('advertisement', {
      address: state.address || null,
      name: state.name || null,
      rssi: state.rssi != null ? state.rssi : null,
      manufacturerData: data,
    })
  }
}

module.exports = { BluezScanner }
