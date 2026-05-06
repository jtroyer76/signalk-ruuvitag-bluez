// Tests for decoder.js. Run with: node decoder.test.js
//
// No test framework — just node:assert. Each test is self-contained.

'use strict'

const assert = require('node:assert/strict')
const { decode } = require('./decoder')

const tests = []
const t = (name, fn) => tests.push({ name, fn })

// near() lets test vectors specified to 2-3 decimals tolerate the
// rounding we apply inside the decoder.
function near(actual, expected, eps = 0.001) {
  if (actual === null && expected === null) return
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`expected ~${expected}, got ${actual}`)
  }
}

// --- Format 5 (RAWv2) ---

// Canonical valid-data test vector from the Ruuvi spec page itself.
// https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5-rawv2
t('format 5: canonical Ruuvi spec vector', () => {
  const buf = Buffer.from('0512FC5394C37C0004FFFC040CAC364200CDCBB8334C884F', 'hex')
  const r = decode(buf)
  assert.equal(r.dataFormat, 5)
  near(r.temperature, 24.30)
  near(r.humidity, 53.49)
  assert.equal(r.pressure, 100044)
  assert.equal(r.accelerationX, 4)
  assert.equal(r.accelerationY, -4)
  assert.equal(r.accelerationZ, 1036)
  assert.equal(r.batteryVoltage, 2977)
  assert.equal(r.txPower, 4)
  assert.equal(r.movementCounter, 66)
  assert.equal(r.measurementSequence, 205)
  assert.equal(r.mac, 'CB:B8:33:4C:88:4F')
})

// Real captured frame from the user's Ruuvi tag E6EB during the Phase 1
// spike. Values cross-checked by hand against the spec.
t('format 5: real captured frame (E6EB)', () => {
  const buf = Buffer.from('050ba36362cb4503c400ccffe0a3f678a39dc2646bf3e6eb', 'hex')
  const r = decode(buf)
  assert.equal(r.dataFormat, 5)
  near(r.temperature, 14.895)
  near(r.humidity, 63.605)
  assert.equal(r.pressure, 102037)
  assert.equal(r.accelerationX, 964)
  assert.equal(r.accelerationY, 204)
  assert.equal(r.accelerationZ, -32)
  assert.equal(r.batteryVoltage, 2911)
  assert.equal(r.txPower, 4)
  assert.equal(r.movementCounter, 120)
  assert.equal(r.measurementSequence, 41885)
  assert.equal(r.mac, 'C2:64:6B:F3:E6:EB')
})

// Real captured frame from the user's other tag (90CC). This tag was
// reporting pressure as the 0xFFFF "not measured" sentinel, so it
// exercises the per-field invalid-value path while keeping other fields
// valid.
t('format 5: real frame with invalid pressure sentinel (90CC)', () => {
  const buf = Buffer.from('050b5163b6ffff00200010fc24a9b637a306f2a71fe090cc', 'hex')
  const r = decode(buf)
  assert.equal(r.dataFormat, 5)
  near(r.temperature, 14.485)
  near(r.humidity, 63.815)
  assert.equal(r.pressure, null)
  assert.equal(r.accelerationX, 32)
  assert.equal(r.accelerationY, 16)
  assert.equal(r.accelerationZ, -988)
  assert.equal(r.mac, 'F2:A7:1F:E0:90:CC')
})

// Every field carrying its "invalid" sentinel — none should slip through
// as a wild number.
t('format 5: all fields invalid', () => {
  const buf = Buffer.from('058000ffffffff800080008000ffffffffffffffffffffff', 'hex')
  const r = decode(buf)
  assert.equal(r.dataFormat, 5)
  assert.equal(r.temperature, null)
  assert.equal(r.humidity, null)
  assert.equal(r.pressure, null)
  assert.equal(r.accelerationX, null)
  assert.equal(r.accelerationY, null)
  assert.equal(r.accelerationZ, null)
  assert.equal(r.batteryVoltage, null)
  assert.equal(r.txPower, null)
  assert.equal(r.movementCounter, null)
  assert.equal(r.measurementSequence, null)
  assert.equal(r.mac, null)
})

// Power-info field is two bit-packed values (11 + 5). Test the split
// across the byte boundary by isolating each half.
t('format 5: power info bit-packing', () => {
  // Min battery (raw 0 -> 1.600 V), max valid TX (raw 30 -> +20 dBm).
  // High 11 bits = 0, low 5 bits = 11110 -> 0x001E
  const lowOnly = Buffer.alloc(24)
  lowOnly[0] = 0x05
  lowOnly.writeUInt16BE(0x001e, 13)
  const r1 = decode(lowOnly)
  assert.equal(r1.batteryVoltage, 1600)
  assert.equal(r1.txPower, 20) // -40 + 30*2

  // Max valid battery (raw 0x7FE = 2046 -> 3.646 V), TX raw 0 (-40 dBm).
  // High 11 bits = 0x7FE, low 5 bits = 0 -> 0xFFC0
  const highOnly = Buffer.alloc(24)
  highOnly[0] = 0x05
  highOnly.writeUInt16BE(0xffc0, 13)
  const r2 = decode(highOnly)
  assert.equal(r2.batteryVoltage, 1600 + 2046)
  assert.equal(r2.txPower, -40)
})

// --- Format 3 (RAWv1) ---

// Synthetic vector built from the spec — humidity 50%, temp +26.30°C,
// pressure 102766 Pa, accel (0, 0, 1000 mg), battery 2977 mV.
t('format 3: synthetic positive temperature vector', () => {
  const buf = Buffer.from('03641A1ECE1E0000000003E80BA1', 'hex')
  const r = decode(buf)
  assert.equal(r.dataFormat, 3)
  assert.equal(r.humidity, 50)
  near(r.temperature, 26.30)
  assert.equal(r.pressure, 102766)
  assert.equal(r.accelerationX, 0)
  assert.equal(r.accelerationY, 0)
  assert.equal(r.accelerationZ, 1000)
  assert.equal(r.batteryVoltage, 2977)
  // Fields not present in RAWv1:
  assert.equal(r.txPower, null)
  assert.equal(r.movementCounter, null)
  assert.equal(r.measurementSequence, null)
  assert.equal(r.mac, null)
})

// Format 3 sign bit handling — -5.20°C is encoded as integer-sign in the
// MSB of byte 2 plus fractional centi-degrees in byte 3.
t('format 3: negative temperature via sign bit', () => {
  const buf = Buffer.from('0300851400000000000000000000', 'hex')
  const r = decode(buf)
  near(r.temperature, -5.20)
})

// --- Edge cases ---

t('decode: unknown format byte returns null', () => {
  assert.equal(decode(Buffer.from('99aabbccdd', 'hex')), null)
})

t('decode: truncated format-5 buffer returns null', () => {
  assert.equal(decode(Buffer.from([0x05, 0x12, 0xfc])), null)
})

t('decode: empty / null input returns null', () => {
  assert.equal(decode(Buffer.alloc(0)), null)
  assert.equal(decode(null), null)
  assert.equal(decode(undefined), null)
})

t('decode: accepts Uint8Array as well as Buffer', () => {
  const u = new Uint8Array(Buffer.from('0512FC5394C37C0004FFFC040CAC364200CDCBB8334C884F', 'hex'))
  const r = decode(u)
  near(r.temperature, 24.30)
})

// --- Run ---

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
