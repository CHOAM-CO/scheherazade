// test-model-preflight.mjs — pins the pre-spawn model preflight
// (headless-lane.mjs judgeModelProbe / preflightModel, 2026-08-13).
//
// Field case this guards: a model tag the endpoint does not have made
// `claude -p` exit 0 with no error event — no breaker, no error file, the
// user saw only silence. The preflight turns that soft failure into a loud
// EX_CONFIG boot failure, and ONLY that: auth errors, 5xx, timeouts, and
// unreachable endpoints all fail OPEN (they have their own loud paths).
//
// Verdict shapes are pinned against LIVE receipts, not resemblance:
// the 404 body below is byte-for-byte what a local ollama daemon answered
// on 2026-08-13 for a nonexistent tag.

import { createServer } from 'node:http'
import { judgeModelProbe, preflightModel } from '../headless-lane.mjs'

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

// ── judgeModelProbe: pure verdicts ──────────────────────────────────────────
console.log('judgeModelProbe verdicts')

// Live receipt 2026-08-13, local ollama daemon, nonexistent tag.
const OLLAMA_404 = '{"type":"error","error":{"type":"not_found_error","message":"model \'deepseek-v4-flash:0731\' not found"},"request_id":"req_2daaf4d19152f9b4b3eda5bc"}'
let v = judgeModelProbe({ status: 404, body: OLLAMA_404 })
assert(v.verdict === 'bad_model' && v.detail.includes('not found'), 'ollama daemon 404 not_found_error -> bad_model (live receipt)')

v = judgeModelProbe({ status: 404, body: 'plain text not json' })
assert(v.verdict === 'bad_model', 'bare 404 with non-JSON body -> bad_model (status alone convicts)')

v = judgeModelProbe({ status: 400, body: '{"type":"error","error":{"type":"not_found_error","message":"model x not found"}}' })
assert(v.verdict === 'bad_model', 'Anthropic-shaped not_found_error convicts regardless of status')

v = judgeModelProbe({ status: 200, body: '{"id":"msg_1","type":"message","content":[]}' })
assert(v.verdict === 'ok', '2xx -> ok')

v = judgeModelProbe({ status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}' })
assert(v.verdict === 'inconclusive', '401 auth error -> inconclusive (fail open: key validation owns this)')

v = judgeModelProbe({ status: 500, body: 'oops' })
assert(v.verdict === 'inconclusive', '5xx -> inconclusive (fail open)')

v = judgeModelProbe({ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens too small"}}' })
assert(v.verdict === 'inconclusive', 'non-model 4xx -> inconclusive (never convict on a request-shape error)')

// ── preflightModel: E2E against a mock endpoint (no tokens spent) ───────────
console.log('preflightModel E2E (mock endpoint)')

const routes = {
  'bad-tag': (res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(OLLAMA_404) },
  'good-tag': (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_1","type":"message","content":[]}') },
}
const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const parsed = JSON.parse(body)
    seen.push({ url: req.url, model: parsed.model, auth: req.headers.authorization || '', xKey: req.headers['x-api-key'] || '' })
    ;(routes[parsed.model] || routes['bad-tag'])(res)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

v = await preflightModel({ baseUrl: `${base}/`, model: 'bad-tag', authToken: 'tok123' })
assert(v.verdict === 'bad_model', 'mock 404 endpoint -> bad_model')
assert(seen[0] && seen[0].url === '/v1/messages', 'probe hits /v1/messages (trailing slash on base normalized)')
assert(seen[0] && seen[0].auth === 'Bearer tok123', 'AUTH_TOKEN rides as Bearer (mirrors runtime lane)')

v = await preflightModel({ baseUrl: base, model: 'good-tag', apiKey: 'key456' })
assert(v.verdict === 'ok', 'mock 200 endpoint -> ok')
assert(seen[1] && seen[1].xKey === 'key456' && seen[1].auth === '', 'API_KEY rides as x-api-key only when no AUTH_TOKEN')

server.close()

v = await preflightModel({ baseUrl: 'http://127.0.0.1:1', model: 'any', timeoutMs: 2000 })
assert(v.verdict === 'inconclusive', 'unreachable endpoint -> inconclusive (fail open, never blocks boot)')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
