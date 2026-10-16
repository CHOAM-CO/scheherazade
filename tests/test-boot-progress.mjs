import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createLaneModelRetry } = require('../lane-model-retry.cjs')
let calls = 0
const retry = createLaneModelRetry(async (model, effort) => {
  assert.equal(model, 'new-model'); assert.equal(effort, 'high')
  return ++calls === 1 ? { ok: false, reason: 'endpoint file: ENOENT' } : { ok: true, applied: true }
}, { wait: async () => {}, attempts: 3 })
assert.equal((await retry('new-model', 'high')).ok, true)
assert.equal(calls, 2)
// Separate deterministic supersession test: wait resolves immediately but starts newer request.
let superseding, once = false
const selection = createLaneModelRetry(async model => ({ ok: model === 'new', reason: 'no endpoint' }), { wait: async () => { if (!once) { once = true; superseding = selection('new') } }, attempts: 3 })
assert.equal((await selection('old')).reason, 'superseded')
assert.equal((await superseding).ok, true)
console.log('PASS boot model selection retries endpoint readiness and latest selection wins')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { bootBoundary, readBootProgress } = require('../boot-progress.cjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-boot-test-'))
const previous = process.env.SCHZ_BOOT_STARTED_MS
try {
  const now = Date.now()
  process.env.SCHZ_BOOT_STARTED_MS = String(now)
  bootBoundary('test memory open', 'memory', home)
  assert.equal(readBootProgress(home, new Date(now).toISOString()).phase, 'memory')
  assert.equal(readBootProgress(home, new Date(now + 5000).toISOString()), null)
  bootBoundary('test endpoint ready', 'ready', home)
  assert.equal(readBootProgress(home, new Date(now).toISOString()).phase, 'ready')
} finally {
  if (previous === undefined) delete process.env.SCHZ_BOOT_STARTED_MS
  else process.env.SCHZ_BOOT_STARTED_MS = previous
  for (const file of fs.readdirSync(home)) fs.unlinkSync(path.join(home, file))
  fs.rmdirSync(home)
}
console.log('PASS boot phases share elapsed clock and reject previous spawn markers')
