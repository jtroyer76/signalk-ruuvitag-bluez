// Decoder for Ruuvi BLE manufacturer data (manufacturer ID 0x0499).
//
// Supports:
//   - Data format 5 (RAWv2) — current Ruuvi firmware
//   - Data format 3 (RAWv1) — legacy firmware
//
// Specs:
//   https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5-rawv2
//   https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-3-rawv1
//
// decode(buffer) returns a plain object with all parsed fields, or null if
// the buffer isn't a recognized Ruuvi format. Fields whose raw value is the
// "not measured" sentinel are returned as null rather than as out-of-range
// numbers.

'use strict'

const RUUVI_MANUFACTURER_ID = 0x0499

function decode(input) {
  if (!input || input.length < 1) return null
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const format = b[0]
  if (format === 5) return decodeFormat5(b)
  if (format === 3) return decodeFormat3(b)
  return null
}

function decodeFormat5(b) {
  if (b.length < 24) return null

  const temp = b.readInt16BE(1)
  const hum = b.readUInt16BE(3)
  const press = b.readUInt16BE(5)
  const aX = b.readInt16BE(7)
  const aY = b.readInt16BE(9)
  const aZ = b.readInt16BE(11)
  const power = b.readUInt16BE(13)
  const battRaw = (power >> 5) & 0x7ff
  const txRaw = power & 0x1f
  const move = b[15]
  const seq = b.readUInt16BE(16)
  const macHex = b.subarray(18, 24).toString('hex').toUpperCase()
  const mac = macHex.match(/.{2}/g).join(':')

  return {
    dataFormat: 5,
    temperature: temp === -32768 ? null : +(temp * 0.005).toFixed(3),
    humidity: hum === 0xffff ? null : +(hum * 0.0025).toFixed(4),
    pressure: press === 0xffff ? null : press + 50000,
    accelerationX: aX === -32768 ? null : aX,
    accelerationY: aY === -32768 ? null : aY,
    accelerationZ: aZ === -32768 ? null : aZ,
    batteryVoltage: battRaw === 0x7ff ? null : 1600 + battRaw,
    txPower: txRaw === 0x1f ? null : -40 + txRaw * 2,
    movementCounter: move === 0xff ? null : move,
    measurementSequence: seq === 0xffff ? null : seq,
    mac: mac === 'FF:FF:FF:FF:FF:FF' ? null : mac,
  }
}

function decodeFormat3(b) {
  if (b.length < 14) return null

  const humRaw = b[1]
  const tInt = b[2] & 0x7f
  const tSign = b[2] & 0x80 ? -1 : 1
  const tFrac = b[3]
  const press = b.readUInt16BE(4)
  const aX = b.readInt16BE(6)
  const aY = b.readInt16BE(8)
  const aZ = b.readInt16BE(10)
  const batt = b.readUInt16BE(12)

  return {
    dataFormat: 3,
    temperature: +(tSign * (tInt + tFrac / 100)).toFixed(2),
    humidity: humRaw * 0.5,
    pressure: press === 0xffff ? null : press + 50000,
    accelerationX: aX,
    accelerationY: aY,
    accelerationZ: aZ,
    batteryVoltage: batt,
    // Fields not present in RAWv1:
    txPower: null,
    movementCounter: null,
    measurementSequence: null,
    mac: null,
  }
}

module.exports = { decode, RUUVI_MANUFACTURER_ID }
