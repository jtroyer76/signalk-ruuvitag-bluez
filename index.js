// SignalK plugin entry point for signalk-ruuvitag-bluez.
//
// Wires together:
//   scanner.js — BlueZ-DBus advertisement scanner
//   decoder.js — Ruuvi RAWv2 (5) and RAWv1 (3) decoder
//
// Forks the structure of vokkim/signalk-ruuvitag-plugin so user configs
// migrate cleanly: the tag id is the lowercase MAC without colons (matching
// node-ruuvitag's tag.id), and SignalK paths follow the same conventions
// (environment.<location>.{temperature,relativeHumidity,pressure,...},
// electrical.batteries.<name>.voltage).

'use strict'

const { BluezScanner } = require('./scanner')
const { decode, RUUVI_MANUFACTURER_ID } = require('./decoder')

const PLUGIN_ID = 'signalk-ruuvitag-bluez'
const STATUS_INTERVAL_MS = 30_000

module.exports = function (app) {
  let config = {}
  let scanner = null
  let statusTimer = null
  let adsSeen = 0
  let adsDelivered = 0
  // Tracks which tag ids have already had their metadata emitted this
  // session. SignalK calls stop()/start() on config save, which clears
  // this Set, so a rename or location change re-emits metadata cleanly.
  let metaSent = new Set()

  // Match node-ruuvitag's tag.id: "C2:64:6B:F3:E6:EB" -> "c2646bf3e6eb"
  const macToId = (mac) => mac.replace(/:/g, '').toLowerCase()

  // SignalK status/error API renamed between versions; try the newer name
  // first and fall back. console.* is the last resort for very old servers.
  const setStatus = (msg) => {
    if (typeof app.setPluginStatus === 'function') return app.setPluginStatus(msg)
    if (typeof app.setProviderStatus === 'function') return app.setProviderStatus(msg)
  }
  const setError = (msg) => {
    if (typeof app.setPluginError === 'function') return app.setPluginError(msg)
    if (typeof app.setProviderError === 'function') return app.setProviderError(msg)
  }
  const debug = typeof app.debug === 'function' ? app.debug : () => {}
  const errorLog = typeof app.error === 'function' ? app.error.bind(app) : console.error

  const start = async (initialConfig) => {
    config = normalizeConfig(initialConfig)
    adsSeen = 0
    adsDelivered = 0
    metaSent = new Set()

    scanner = new BluezScanner({
      manufacturerId: RUUVI_MANUFACTURER_ID,
      logger: { debug, info: debug, error: errorLog },
    })

    scanner.on('advertisement', ({ address, rssi, manufacturerData }) => {
      const decoded = decode(manufacturerData)
      if (!decoded) return
      adsSeen++

      const id = macToId(address)
      if (!config[id]) {
        // First sighting — register with safe defaults so the tag appears
        // in the plugin config UI for the user to name and enable.
        config[id] = {
          id,
          name: id.substring(0, 6),
          location: 'inside.mainCabin',
          enabled: false,
        }
        debug(`discovered new tag ${id} (${address}); configure and enable to publish`)
      }

      const tag = config[id]
      if (!tag.enabled) return

      // Emit metadata once per tag as its own meta-only delta. The
      // SignalK Update type is a discriminated union — values XOR meta —
      // and the spec requires meta be sent before values for new leaves.
      // Includes timestamp explicitly because the server's processing
      // path expects it on meta deltas (matches the pattern in
      // stefanor/signalk-victron-ble PR #39).
      emitMetaIfNeeded(app, tag, metaSent)
      app.handleMessage(PLUGIN_ID, buildDelta(tag, decoded, rssi))
      adsDelivered++
    })

    scanner.on('started', ({ adapterPath }) => {
      debug(`scanner started on ${adapterPath}`)
    })

    scanner.on('error', (e) => {
      errorLog(`scanner: ${e.message}`)
      setError(e.message)
    })

    try {
      await scanner.start()
      setStatus('scanning')
    } catch (e) {
      errorLog(`failed to start scanner: ${e.message}`)
      setError(e.message)
      throw e
    }

    statusTimer = setInterval(() => {
      const enabled = Object.values(config).filter((c) => c && c.enabled).length
      const known = Object.keys(config).length
      setStatus(
        `scanning - last ${STATUS_INTERVAL_MS / 1000}s: ${adsSeen} ads in, ${adsDelivered} delivered (${enabled}/${known} tags enabled)`
      )
      adsSeen = 0
      adsDelivered = 0
    }, STATUS_INTERVAL_MS)
  }

  const stop = async () => {
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
    if (scanner) {
      try { await scanner.stop() } catch (e) { errorLog(`stop: ${e.message}`) }
      scanner = null
    }
    setStatus('stopped')
  }

  const schema = () => {
    const properties = {}
    for (const [id, tag] of Object.entries(config)) {
      properties[id] = {
        type: 'object',
        title: `Tag ${id}`,
        properties: {
          enabled: {
            title: 'Enabled. Receive data and emit Signal K values.',
            type: 'boolean',
            default: false,
          },
          name: {
            title: 'Source name',
            description:
              'Used in $source label and electrical.batteries.<name>.voltage path. 1-12 chars, [a-zA-Z0-9].',
            type: 'string',
            pattern: '^[a-zA-Z0-9]+$',
            minLength: 1,
            maxLength: 12,
            default: (tag && tag.name) || id.substring(0, 6),
          },
          location: {
            title: 'Location',
            description:
              'Used in environment.<location>.* paths. Dot-separated, e.g. "inside.salon" or "outside.cockpit".',
            type: 'string',
            pattern: '^[a-zA-Z0-9]+(\\.[a-zA-Z0-9]+)*$',
            minLength: 1,
            maxLength: 32,
            default: (tag && tag.location) || 'inside.mainCabin',
          },
        },
      }
    }
    return {
      type: 'object',
      title: 'RuuviTag Plugin (BlueZ)',
      description:
        'Tags appear here after their first advertisement is received. Set name + location and enable to publish to SignalK.',
      properties,
    }
  }

  return {
    id: PLUGIN_ID,
    name: 'RuuviTag Plugin (BlueZ)',
    description:
      'Receives RuuviTag environmental data via BlueZ over DBus. No HCI sockets, no setcap, no privileged Docker. Coexists with other BlueZ users (e.g. signalk-victron-ble).',
    schema,
    start,
    stop,
  }
}

// SignalK persists plugin config as { "<id>": { enabled, name, location } }
// — the id is the dict key, not a field on the entry. Freshly-discovered
// tags are added with id inline; tags loaded from saved config aren't.
// Backfilling here means every code path can trust tag.id is set, which
// matters for things like the metaSent dedup keyed on tag.id (without
// this, two saved tags would collapse to one undefined key).
function normalizeConfig(initialConfig) {
  const config = JSON.parse(JSON.stringify(initialConfig || {}))
  for (const [id, tag] of Object.entries(config)) {
    if (tag && typeof tag === 'object') tag.id = id
  }
  return config
}

// Send the meta-only delta for this tag once per plugin lifetime. Using
// a mutable Set means a config change (which triggers stop/start) gets
// us a fresh empty Set and re-emits, picking up any rename/relocation.
function emitMetaIfNeeded(app, tag, metaSent) {
  if (metaSent.has(tag.id)) return
  app.handleMessage(PLUGIN_ID, {
    updates: [
      {
        timestamp: new Date().toISOString(),
        meta: buildMeta(tag),
      },
    ],
  })
  metaSent.add(tag.id)
}

// Metadata declared on the first delta we deliver for each tag. Tells
// SignalK (and downstream consumers like InfluxDB) the units behind each
// path so the admin UI can show conversions and historical stores can
// label series correctly.
const META_BY_FIELD = {
  temperature:    { units: 'K',     description: 'Temperature' },
  relativeHumidity: { units: 'ratio', description: 'Relative humidity, 0-1' },
  humidity:       { units: 'ratio', description: 'Humidity, 0-1' },
  pressure:       { units: 'Pa',    description: 'Atmospheric pressure' },
  accelerationX:  { units: 'g',     description: 'Acceleration on the X axis' },
  accelerationY:  { units: 'g',     description: 'Acceleration on the Y axis' },
  accelerationZ:  { units: 'g',     description: 'Acceleration on the Z axis' },
  rssi:           { units: 'dBm',   description: 'Bluetooth received signal strength' },
  voltage:        { units: 'V',     description: 'Battery voltage' },
}

function buildMeta(tag) {
  const loc = tag.location
  const humKey = loc.startsWith('outside.') ? 'humidity' : 'relativeHumidity'
  const meta = []
  for (const field of ['temperature', 'pressure', 'accelerationX', 'accelerationY', 'accelerationZ', 'rssi']) {
    meta.push({ path: `environment.${loc}.${field}`, value: META_BY_FIELD[field] })
  }
  meta.push({ path: `environment.${loc}.${humKey}`, value: META_BY_FIELD[humKey] })
  meta.push({ path: `electrical.batteries.${tag.name}.voltage`, value: META_BY_FIELD.voltage })
  return meta
}

// Build a SignalK delta from a decoded Ruuvi frame. Field selection and
// unit conversions mirror vokkim/signalk-ruuvitag-plugin so existing
// dashboards keep working when users switch.
function buildDelta(tag, d, rssi) {
  const loc = tag.location
  const humidityKey = loc.startsWith('outside.') ? 'humidity' : 'relativeHumidity'
  const values = []

  if (d.temperature != null) {
    // °C -> K
    values.push({
      path: `environment.${loc}.temperature`,
      value: round(d.temperature + 273.15, 3),
    })
  }
  if (d.humidity != null) {
    // % -> ratio
    values.push({
      path: `environment.${loc}.${humidityKey}`,
      value: round(d.humidity / 100, 5),
    })
  }
  if (d.pressure != null) {
    // already in Pa from format 5
    values.push({
      path: `environment.${loc}.pressure`,
      value: d.pressure,
    })
  }
  if (d.accelerationX != null) {
    // mg -> g
    values.push({
      path: `environment.${loc}.accelerationX`,
      value: round(d.accelerationX / 1000, 5),
    })
  }
  if (d.accelerationY != null) {
    values.push({
      path: `environment.${loc}.accelerationY`,
      value: round(d.accelerationY / 1000, 5),
    })
  }
  if (d.accelerationZ != null) {
    values.push({
      path: `environment.${loc}.accelerationZ`,
      value: round(d.accelerationZ / 1000, 5),
    })
  }
  if (rssi != null) {
    values.push({
      path: `environment.${loc}.rssi`,
      value: rssi,
    })
  }
  if (d.batteryVoltage != null) {
    // mV -> V
    values.push({
      path: `electrical.batteries.${tag.name}.voltage`,
      value: round(d.batteryVoltage / 1000, 3),
    })
  }

  return {
    updates: [
      {
        $source: `${PLUGIN_ID}.${tag.name}`,
        values,
      },
    ],
  }
}

function round(n, digits) {
  const f = Math.pow(10, digits)
  return Math.round(n * f) / f
}

// Internal — exposed for tests only.
module.exports.buildDelta = buildDelta
module.exports.buildMeta = buildMeta
module.exports.normalizeConfig = normalizeConfig
module.exports.emitMetaIfNeeded = emitMetaIfNeeded
module.exports.PLUGIN_ID = PLUGIN_ID
