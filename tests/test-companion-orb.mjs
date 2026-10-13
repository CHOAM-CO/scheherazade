// Sound-only orb math (design-0027): band energy, RMS, lerped state steps.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const orb = require('../onboarding/public/js/companion-orb.cjs')
let count = 0
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`) }
const silence = new Uint8Array(1024).fill(128)
const loud = Uint8Array.from({ length: 1024 }, (_, i) => (i % 2 ? 228 : 28))
test('silence has zero rms', () => assert.equal(orb.rms(silence), 0))
test('loud signal clamps to 1', () => assert.equal(orb.rms(loud), 1))
test('band averages the requested bins', () => { const fd = new Uint8Array(512); fd.fill(255, 1, 20); assert.equal(orb.band(fd, 1, 20), 1); assert.equal(orb.band(fd, 60, 200), 0) })
test('band of empty range is 0', () => assert.equal(orb.band(new Uint8Array(4), 60, 200), 0))
test('sibilant tilt is positive, voiced tilt negative', () => {
  const s = new Uint8Array(512); s.fill(200, 60, 200); const v = new Uint8Array(512); v.fill(200, 1, 20)
  assert.ok(orb.measure(silence, s).tilt > 0); assert.ok(orb.measure(silence, v).tilt < 0)
})
test('speaking moves amp toward the sample, lerped not snapped', () => {
  const n = orb.step(orb.initial(), { state: 'speaking', sample: { amp: 1, lo: 0, hi: 0 } })
  assert.ok(n.amp > 0 && n.amp < 1); assert.ok(n.act > 0)
})
test('idle ignores samples', () => assert.equal(orb.step(orb.initial(), { state: 'idle', sample: { amp: 1, lo: 1, hi: 1 } }).amp, 0))
test('listening raises dots, reduced motion does not', () => {
  assert.ok(orb.step(orb.initial(), { state: 'listening' }).lis > 0)
  assert.equal(orb.step(orb.initial(), { state: 'listening', reduced: true }).lis, 0)
})
test('reduced motion never deforms while speaking', () => assert.equal(orb.step(orb.initial(), { state: 'speaking', sample: { amp: 1, lo: 1, hi: 1 }, reduced: true }).act, 0))
test('off dims toward 25%', () => { let v = orb.initial(); for (let i = 0; i < 200; i++) v = orb.step(v, { state: 'off' }); assert.ok(Math.abs(v.dim - 0.25) < 0.01) })
test('hue shifts up with high band', () => assert.ok(orb.hueOf({ hi: 1, lo: 0 }) > orb.hueOf({ hi: 0, lo: 0 })))
console.log(`${count} companion orb checks passed`)
