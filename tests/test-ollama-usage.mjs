#!/usr/bin/env node
// test-ollama-usage.mjs -- fetchOllamaUsage (onboarding/http-server.cjs), the
// ollama.com usage lane. ollama.com changed /api/usage in 2026-10 from a
// limits/fraction payload to 7-day totals + daily buckets with no quota
// field anywhere (receipt 2026-10-07 15:22). The parser must:
//   1. NEW shape  -> ok, shape:'totals', weekly/today spend + 7 buckets
//   2. OLD shape  -> ok, shape:'limits', pct fields (rollback safety)
//   3. unknown    -> ok:false, branch:'unknown_shape', field NAMES only
//   4. http error -> fresh: ok:false http_error; with a cached good reading:
//                    that reading, stale:true
//   5. cache: a second call inside 60s does not hit fetch; force=1 does
// fetch and the key reader are injected via the deps argument -- no network,
// no Electron safeStorage.
//
// Run: node tests/test-ollama-usage.mjs

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { fetchOllamaUsage, _resetOllamaUsageCache } = require(path.join(ROOT, 'onboarding', 'http-server.cjs'))

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const NEW_SHAPE = {
  range: '7d', scope: 'self', granularity: 'day',
  from: '2026-09-30T00:00:00Z', until: '2026-10-07T06:22:48Z',
  totals: { request_count: 2686, usage_usd: 6.5575, input_tokens: 228299941, cached_input_tokens: 204134384, output_tokens: 1918428 },
  buckets: [
    { from: '2026-09-30T00:00:00Z', until: '2026-10-01T00:00:00Z', request_count: 599, usage_usd: 1.16426, input_tokens: 48694444, cached_input_tokens: 44445184, output_tokens: 390549 },
    { from: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z', request_count: 400, usage_usd: 0.9, input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 },
    { from: '2026-10-02T00:00:00Z', until: '2026-10-03T00:00:00Z', request_count: 300, usage_usd: 0.8, input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 },
    { from: '2026-10-03T00:00:00Z', until: '2026-10-04T00:00:00Z', request_count: 300, usage_usd: 0.7, input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 },
    { from: '2026-10-04T00:00:00Z', until: '2026-10-05T00:00:00Z', request_count: 300, usage_usd: 0.6, input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 },
    { from: '2026-10-05T00:00:00Z', until: '2026-10-06T00:00:00Z', request_count: 300, usage_usd: 0.5, input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 },
    { from: '2026-10-06T00:00:00Z', until: '2026-10-07T00:00:00Z', request_count: 487, usage_usd: 1.89324, input_tokens: 1, cached_input_tokens: 1, output_tokens: 1 },
  ],
}
const OLD_SHAPE = {
  activity: { cost: 1.2, period: 'week', models: [] },
  limits: {
    session: { usage: 0.918, models: [{ name: 'a', request_count: 3 }] },
    weekly: { usage: 0.428, models: [{ name: 'a', request_count: 10 }, { name: 'b', request_count: 5 }] },
  },
}

function stub(responses) {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return { ok: r.status === 200, status: r.status, json: async () => r.body }
  }
  return { calls, fetchFn }
}
const readKey = () => 'sk-test'
const noKey = () => null

console.log('1. new shape (totals + buckets)')
{
  _resetOllamaUsageCache()
  const { calls, fetchFn } = stub([{ status: 200, body: NEW_SHAPE }])
  const u = await fetchOllamaUsage({ force: true }, { fetch: fetchFn, readKey })
  check('ok', u.ok === true)
  check('shape totals', u.shape === 'totals')
  check('range/from/until carried', u.range === '7d' && u.from === NEW_SHAPE.from && u.until === NEW_SHAPE.until)
  check('weeklyRequests', u.weeklyRequests === 2686)
  check('weeklyUsd', u.weeklyUsd === 6.5575)
  check('token totals', u.inputTokens === 228299941 && u.cachedInputTokens === 204134384 && u.outputTokens === 1918428)
  check('today from last bucket', u.todayRequests === 487 && u.todayUsd === 1.89324)
  check('7 buckets {day, requests, usd}', u.buckets.length === 7
    && u.buckets[0].day === '2026-09-30' && u.buckets[0].requests === 599 && u.buckets[0].usd === 1.16426)
  check('legacy pct null (no quota)', u.sessionPct === null && u.weeklyPct === null)
  check('asOf ISO', typeof u.asOf === 'string' && !Number.isNaN(Date.parse(u.asOf)))
  check('no stale flag', !u.stale)
  check('bearer header + usage url', calls.length === 1 && calls[0].url === 'https://ollama.com/api/usage'
    && calls[0].init.headers.Authorization === 'Bearer sk-test')
}

console.log('2. old shape (limits fractions)')
{
  _resetOllamaUsageCache()
  const { fetchFn } = stub([{ status: 200, body: OLD_SHAPE }])
  const u = await fetchOllamaUsage({ force: true }, { fetch: fetchFn, readKey })
  check('ok', u.ok === true)
  check('shape limits', u.shape === 'limits')
  check('sessionPct 91.8', u.sessionPct === 91.8)
  check('weeklyPct 42.8', u.weeklyPct === 42.8)
  check('weeklyRequests summed over models', u.weeklyRequests === 15)
  check('no totals fields', u.weeklyUsd === undefined && u.buckets === undefined)
}

console.log('3. unknown shape')
{
  _resetOllamaUsageCache()
  const { fetchFn } = stub([{ status: 200, body: { foo: 1, bar: { secret: 'x' } } }])
  const u = await fetchOllamaUsage({ force: true }, { fetch: fetchFn, readKey })
  check('ok false', u.ok === false)
  check('branch unknown_shape', u.branch === 'unknown_shape')
  check('detail lists field names only', u.detail === 'fields: foo, bar')
  check('no values leak', !JSON.stringify(u).includes('secret'))
}

console.log('4. http error: fresh vs stale cache')
{
  _resetOllamaUsageCache()
  const fresh = await fetchOllamaUsage({ force: true }, { fetch: stub([{ status: 500, body: null }]).fetchFn, readKey })
  check('fresh failure is ok:false http_error', fresh.ok === false && fresh.branch === 'http_error' && fresh.detail === 'HTTP 500')

  const good = await fetchOllamaUsage({ force: true }, { fetch: stub([{ status: 200, body: NEW_SHAPE }]).fetchFn, readKey })
  check('good reading cached', good.ok && good.shape === 'totals')
  const stale = await fetchOllamaUsage({ force: true }, { fetch: stub([{ status: 503, body: null }]).fetchFn, readKey })
  check('stale carries last good reading', stale.ok === true && stale.shape === 'totals' && stale.weeklyUsd === 6.5575)
  check('stale flagged with reason', stale.stale === true && stale.staleReason === 'HTTP 503')
  const unreachable = await fetchOllamaUsage({ force: true }, { fetch: stub([new Error('boom')]).fetchFn, readKey })
  check('network throw also stale', unreachable.stale === true && unreachable.staleReason === 'boom')
  const keyless = await fetchOllamaUsage({ force: true }, { fetch: stub([]).fetchFn, readKey: noKey })
  check('no_key with cache is stale too', keyless.stale === true && keyless.staleReason === 'no_key')
  _resetOllamaUsageCache()
  const keylessFresh = await fetchOllamaUsage({ force: true }, { fetch: stub([]).fetchFn, readKey: noKey })
  check('no_key fresh is ok:false no_key', keylessFresh.ok === false && keylessFresh.branch === 'no_key')
}

console.log('5. 60s cache / force')
{
  _resetOllamaUsageCache()
  let t = 1_000_000
  const now = () => t
  const { calls, fetchFn } = stub([{ status: 200, body: NEW_SHAPE }, { status: 200, body: OLD_SHAPE }, { status: 200, body: OLD_SHAPE }])
  const a = await fetchOllamaUsage({}, { fetch: fetchFn, readKey, now })
  t += 30_000
  const b = await fetchOllamaUsage({}, { fetch: fetchFn, readKey, now })
  check('second call inside 60s served from cache', b === a && calls.length === 1)
  const c = await fetchOllamaUsage({ force: true }, { fetch: fetchFn, readKey, now })
  check('force bypasses cache', c.shape === 'limits' && calls.length === 2)
  t += 61_000
  const d = await fetchOllamaUsage({}, { fetch: fetchFn, readKey, now })
  check('expired cache refetches', calls.length === 3 && d.shape === 'limits')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
