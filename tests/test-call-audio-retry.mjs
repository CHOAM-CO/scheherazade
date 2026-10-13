import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createSegmentRetry } = createRequire(import.meta.url)('../onboarding/public/js/call-core.cjs')
let limits = 0, attempts = 0, waits = 0
const retry = createSegmentRetry({ onLimit: () => limits++, wait: async () => { waits++ } })
const fail = async () => { attempts++; throw new Error('HTTP 503') }
await assert.rejects(retry.run(fail), /503/)
assert.equal(attempts, 2); assert.equal(waits, 1); assert.equal(limits, 0)
assert.equal(await retry.run(async () => 'next segment'), 'next segment')
await assert.rejects(retry.run(fail)); await assert.rejects(retry.run(fail))
assert.equal(limits, 0, 'success resets the consecutive exhausted-segment counter')
await assert.rejects(retry.run(fail)); assert.equal(limits, 1)
retry.reset()
let once = true
assert.equal(await retry.run(async () => { if (once) { once = false; throw new Error('network') }; return 'recovered' }), 'recovered')
assert.equal(limits, 1)
let valid = true, calls = 0
const cancelled = createSegmentRetry({ onLimit: () => assert.fail('cancel is not a failure'), wait: async () => { valid = false } })
await assert.rejects(cancelled.run(async () => { calls++; throw new Error('network') }, () => valid), /cancelled/)
assert.equal(calls, 1, 'hangup during backoff prevents another POST')
let release
const stale = retry.run(() => new Promise(resolve => { release = resolve }))
retry.reset(); release('old response')
await assert.rejects(stale, /cancelled/)
console.log('audio retry: 2 attempts, skipped segments, 3-strike limit, recovery and cancellation passed')
