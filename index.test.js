// Tests for buildDelta — the function that turns a decoded Ruuvi frame
// plus a tag config into a SignalK delta. The unit conversions and path
// templating live there and are easy to typo, so they get explicit
// coverage. Run with: node index.test.js

'use strict'

const assert = require('node:assert/strict')
const { decode } = require('./decoder')
const { buildDelta, buildMeta, PLUGIN_ID } = require('./index')

const tests = []
const t = (name, fn) => tests.push({ name, fn })

const findValue = (delta, path) => {
  const v = delta.updates[0].values.find((x) => x.path === path)
  return v ? v.value : undefined
}

// Real captured E6EB frame from the Phase 1 spike. Decoded values:
// 14.895 °C, 63.605 %, 102037 Pa, accel (964, 204, -32) mg, 2.911 V,
// rssi -55 dBm. Tag named 'salon' inside.
t('buildDelta: inside tag emits all paths with SI conversions', () => {
  const decoded = decode(Buffer.from('050ba36362cb4503c400ccffe0a3f678a39dc2646bf3e6eb', 'hex'))
  const tag = { id: 'c2646bf3e6eb', name: 'salon', location: 'inside.salon', enabled: true }
  const delta = buildDelta(tag, decoded, -55)

  assert.equal(delta.updates.length, 1)
  assert.equal(delta.updates[0].$source, `${PLUGIN_ID}.salon`)

  // °C -> K (14.895 + 273.15 = 288.045)
  assert.equal(findValue(delta, 'environment.inside.salon.temperature'), 288.045)
  // % -> ratio (63.605 / 100 = 0.63605)
  assert.equal(findValue(delta, 'environment.inside.salon.relativeHumidity'), 0.63605)
  // Pa pass-through
  assert.equal(findValue(delta, 'environment.inside.salon.pressure'), 102037)
  // mg -> g
  assert.equal(findValue(delta, 'environment.inside.salon.accelerationX'), 0.964)
  assert.equal(findValue(delta, 'environment.inside.salon.accelerationY'), 0.204)
  assert.equal(findValue(delta, 'environment.inside.salon.accelerationZ'), -0.032)
  // RSSI pass-through
  assert.equal(findValue(delta, 'environment.inside.salon.rssi'), -55)
  // mV -> V
  assert.equal(findValue(delta, 'electrical.batteries.salon.voltage'), 2.911)

  // Inside locations use relativeHumidity, not humidity
  assert.equal(findValue(delta, 'environment.inside.salon.humidity'), undefined)
})

t('buildDelta: outside location uses humidity key', () => {
  const decoded = decode(Buffer.from('050ba36362cb4503c400ccffe0a3f678a39dc2646bf3e6eb', 'hex'))
  const tag = { id: 'c2646bf3e6eb', name: 'cockpit', location: 'outside.cockpit', enabled: true }
  const delta = buildDelta(tag, decoded, -55)

  assert.equal(findValue(delta, 'environment.outside.cockpit.humidity'), 0.63605)
  assert.equal(findValue(delta, 'environment.outside.cockpit.relativeHumidity'), undefined)
})

t('buildDelta: invalid pressure (sentinel) omits pressure path', () => {
  // 90CC tag had pressure=0xFFFF
  const decoded = decode(Buffer.from('050b5163b6ffff00200010fc24a9b637a306f2a71fe090cc', 'hex'))
  const tag = { id: 'f2a71fe090cc', name: 'fridge', location: 'inside.fridge', enabled: true }
  const delta = buildDelta(tag, decoded, -71)

  assert.equal(findValue(delta, 'environment.inside.fridge.pressure'), undefined)
  // Other valid fields still present
  assert.notEqual(findValue(delta, 'environment.inside.fridge.temperature'), undefined)
  assert.notEqual(findValue(delta, 'environment.inside.fridge.relativeHumidity'), undefined)
})

t('buildDelta: omits rssi if null', () => {
  const decoded = decode(Buffer.from('050ba36362cb4503c400ccffe0a3f678a39dc2646bf3e6eb', 'hex'))
  const tag = { id: 'c2646bf3e6eb', name: 'salon', location: 'inside.salon', enabled: true }
  const delta = buildDelta(tag, decoded, null)
  assert.equal(findValue(delta, 'environment.inside.salon.rssi'), undefined)
})

t('buildDelta: all-invalid frame produces empty values array', () => {
  const decoded = decode(Buffer.from('058000ffffffff800080008000ffffffffffffffffffffff', 'hex'))
  const tag = { id: 'ffffffffffff', name: 'dead', location: 'inside.x', enabled: true }
  const delta = buildDelta(tag, decoded, null)
  assert.equal(delta.updates[0].values.length, 0)
})

const findMeta = (meta, path) => meta.find((m) => m.path === path)

t('buildMeta: declares units for every emitted path of an inside tag', () => {
  const tag = { id: 'c2646bf3e6eb', name: 'salon', location: 'inside.salon', enabled: true }
  const meta = buildMeta(tag)
  assert.equal(findMeta(meta, 'environment.inside.salon.temperature').value.units, 'K')
  assert.equal(findMeta(meta, 'environment.inside.salon.relativeHumidity').value.units, 'ratio')
  assert.equal(findMeta(meta, 'environment.inside.salon.pressure').value.units, 'Pa')
  assert.equal(findMeta(meta, 'environment.inside.salon.accelerationX').value.units, 'g')
  assert.equal(findMeta(meta, 'environment.inside.salon.accelerationY').value.units, 'g')
  assert.equal(findMeta(meta, 'environment.inside.salon.accelerationZ').value.units, 'g')
  assert.equal(findMeta(meta, 'environment.inside.salon.rssi').value.units, 'dBm')
  assert.equal(findMeta(meta, 'electrical.batteries.salon.voltage').value.units, 'V')
  // 'humidity' (the outside variant) should NOT appear for an inside tag
  assert.equal(findMeta(meta, 'environment.inside.salon.humidity'), undefined)
})

t('buildMeta: outside tag declares humidity, not relativeHumidity', () => {
  const tag = { id: 'c2646bf3e6eb', name: 'cockpit', location: 'outside.cockpit', enabled: true }
  const meta = buildMeta(tag)
  assert.equal(findMeta(meta, 'environment.outside.cockpit.humidity').value.units, 'ratio')
  assert.equal(findMeta(meta, 'environment.outside.cockpit.relativeHumidity'), undefined)
})

t('buildMeta: every entry has a description string', () => {
  const tag = { id: 'c2646bf3e6eb', name: 'salon', location: 'inside.salon', enabled: true }
  for (const m of buildMeta(tag)) {
    assert.equal(typeof m.value.description, 'string')
    assert.ok(m.value.description.length > 0, `empty description for ${m.path}`)
  }
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    fn()
    console.log(`ok    ${name}`)
  } catch (e) {
    console.error(`FAIL  ${name}`)
    console.error(`      ${e.message}`)
    failed++
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
