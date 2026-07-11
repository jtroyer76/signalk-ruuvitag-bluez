// Tests for the scanner's reconnect supervision. The D-Bus I/O itself needs
// a live system bus + bluetoothd and is exercised on-device; here we pin the
// pure backoff math and the supervision state machine (guards, scheduling,
// teardown) that decide whether and when a reconnect happens.
// Run with: node scanner.test.js

'use strict'

const assert = require('node:assert/strict')
const { BluezScanner, nextReconnectDelay } = require('./scanner')

const RUUVI = 0x0499

const tests = []
const t = (name, fn) => tests.push({ name, fn })

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
