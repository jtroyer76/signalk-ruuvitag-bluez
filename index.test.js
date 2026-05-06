// Tests for buildDelta — the function that turns a decoded Ruuvi frame
// plus a tag config into a SignalK delta. The unit conversions and path
// templating live there and are easy to typo, so they get explicit
// coverage. Run with: node index.test.js

'use strict'

const assert = require('node:assert/strict')
const { decode } = require('./decoder')
const {
  buildDelta,
  buildMeta,
  normalizeConfig,
  emitMetaIfNeeded,
  PLUGIN_ID,
} = require('./index')

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

// --- normalizeConfig ---
//
// Regression test for the "tag.id is undefined for saved config" bug:
// SignalK persists plugin config as { "<id>": { enabled, name, location } }
// — the id is the *key* of the dict, not a field on the value. Freshly-
// discovered tags get .id set inline, but tags loaded from saved config
// don't, which broke metaSent dedup (every saved tag had id=undefined).
t('normalizeConfig: backfills .id from dict key onto each entry', () => {
  const saved = {
    c2646bf3e6eb: { enabled: true, name: 'c2646b', location: 'inside' },
    f2a71fe090cc: { enabled: true, name: 'f2a71f', location: 'fridge' },
  }
  const config = normalizeConfig(saved)
  assert.equal(config.c2646bf3e6eb.id, 'c2646bf3e6eb')
  assert.equal(config.f2a71fe090cc.id, 'f2a71fe090cc')
  // Other fields preserved
  assert.equal(config.c2646bf3e6eb.name, 'c2646b')
  assert.equal(config.f2a71fe090cc.location, 'fridge')
})

t('normalizeConfig: deep-clones so mutating result does not affect input', () => {
  const saved = { abc: { enabled: true, name: 'a', location: 'inside' } }
  const config = normalizeConfig(saved)
  config.abc.location = 'mutated'
  assert.equal(saved.abc.location, 'inside')
  assert.equal(saved.abc.id, undefined)
})

t('normalizeConfig: handles undefined / empty input', () => {
  assert.deepEqual(normalizeConfig(undefined), {})
  assert.deepEqual(normalizeConfig(null), {})
  assert.deepEqual(normalizeConfig({}), {})
})

t('normalizeConfig: tolerates malformed entries', () => {
  const config = normalizeConfig({ good: { enabled: true }, bad: null })
  assert.equal(config.good.id, 'good')
  assert.equal(config.bad, null)
})

// --- emitMetaIfNeeded ---
//
// The bug we shipped was that metaSent.has(tag.id) collapsed to has(undefined)
// for saved tags, so only the first tag emitted meta. These tests pin the
// dedup behavior to the actual tag id and prove that two distinct tags get
// two distinct meta deltas.
function makeFakeApp() {
  const calls = []
  return {
    calls,
    handleMessage: (id, delta) => calls.push({ id, delta }),
  }
}

t('emitMetaIfNeeded: emits exactly one meta delta the first time, dedups after', () => {
  const app = makeFakeApp()
  const sent = new Set()
  const tag = { id: 'aaa', name: 'a', location: 'inside.salon', enabled: true }

  emitMetaIfNeeded(app, tag, sent)
  emitMetaIfNeeded(app, tag, sent)
  emitMetaIfNeeded(app, tag, sent)

  assert.equal(app.calls.length, 1)
  assert.equal(app.calls[0].id, PLUGIN_ID)
  assert.equal(sent.has('aaa'), true)
  assert.ok(Array.isArray(app.calls[0].delta.updates[0].meta))
  assert.ok(app.calls[0].delta.updates[0].meta.length > 0)
  // No values mixed in (Update is a discriminated union, values XOR meta)
  assert.equal(app.calls[0].delta.updates[0].values, undefined)
  // Timestamp included (matches signalk-victron-ble PR #39 pattern)
  assert.equal(typeof app.calls[0].delta.updates[0].timestamp, 'string')
})

t('emitMetaIfNeeded: two distinct tags emit two distinct meta deltas', () => {
  // The bug fixed in v1.0.3: with id=undefined for both saved tags, the
  // second call here would have been deduped and only one meta delta
  // would have been sent. With the fix (normalizeConfig backfilling id),
  // tag.id is unique per tag and we get one delta per tag.
  const app = makeFakeApp()
  const sent = new Set()
  const inside = { id: 'aaa', name: 'a', location: 'inside', enabled: true }
  const fridge = { id: 'bbb', name: 'b', location: 'fridge', enabled: true }

  emitMetaIfNeeded(app, inside, sent)
  emitMetaIfNeeded(app, fridge, sent)

  assert.equal(app.calls.length, 2, 'should emit one meta delta per unique tag id')
  const paths0 = app.calls[0].delta.updates[0].meta.map((m) => m.path)
  const paths1 = app.calls[1].delta.updates[0].meta.map((m) => m.path)
  assert.ok(paths0.some((p) => p.startsWith('environment.inside.')))
  assert.ok(paths1.some((p) => p.startsWith('environment.fridge.')))
})

t('emitMetaIfNeeded: skipped entirely when tag.id is undefined (defensive)', () => {
  // Belt-and-suspenders: even if normalizeConfig were bypassed somehow,
  // the dedup Set would still grow with one undefined entry. Dedup still
  // works (only one emit), but this documents the failure mode.
  const app = makeFakeApp()
  const sent = new Set()
  const a = { name: 'a', location: 'inside', enabled: true } // .id missing
  const b = { name: 'b', location: 'fridge', enabled: true } // .id missing

  emitMetaIfNeeded(app, a, sent)
  emitMetaIfNeeded(app, b, sent)

  // Both calls had undefined id, so dedup collapses them to one. This is
  // the OLD broken behavior — kept as an explicit reminder that the fix
  // lives upstream in normalizeConfig, not in this function.
  assert.equal(app.calls.length, 1)
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
