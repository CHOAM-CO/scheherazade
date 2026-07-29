#!/usr/bin/env node
// test-claude-subscription-validate.mjs — pins the validation contract of the
// 'claude-subscription' branch in http-server.cjs's validateProviderKey().
// Run: node scripts/test-claude-subscription-validate.mjs
//
// WHY THIS FILE EXISTS: until 2026-07-29 that branch was a hardcoded
// `return { ok: true }` — it accepted any non-empty string, so a mistyped or
// truncated paste was stored in the keychain and reported to the user as
// "connected", failing later at agent spawn with nothing pointing back at the
// paste. Worse, three separate comments elsewhere in this repo cited that call
// as the safety net that made a mis-capture "surface as an honest token
// rejected". It could not; nothing could produce a rejection for this
// provider. This file is the regression floor for the real check.
//
// WHAT IS LIVE-VERIFIED AND WHAT IS NOT. Verified against the real API on
// 2026-07-29 with a deliberately bogus token (no credential involved):
//   - Bearer + anthropic-beta: oauth-2025-04-20 → HTTP 401
//     {"type":"authentication_error","message":"OAuth access token is invalid."}
//   - the SAME string as x-api-key      → HTTP 401 "invalid x-api-key"
// Two different server-side evaluators, which is why the 'claude' BYOK branch
// cannot be reused here.
//   - the same 401 authentication_error comes back for a body naming a model
//     that does not exist, i.e. auth is evaluated BEFORE the model. So the
//     hardcoded model id below cannot turn a valid token into a rejection the
//     day that id is retired.
//   - `claude auth status` is NOT a substitute for any of this: with a garbage
//     token it still answers {"loggedIn":true,"authMethod":"oauth_token"}. It
//     reports presence. The name is the whole trap.
// NOW ALSO VERIFIED WITH A REAL TOKEN (2026-07-29, minted for this and revoked
// straight after): this exact shape answers 200. So does /v1/models, and so
// does the plainer docs-only shape — meaning ?beta=true, x-app and the
// claude-code beta are all optional, and an earlier version of this header
// which framed them as the difference between working and rejecting every
// valid credential was overstating a risk that measured zero. They stay
// because matching the known-working client is the better default, not
// because anything was caught.
//
// The fail-open cases below are still the substance of the design: what they
// protect against is not an unverified shape, it is the day the endpoint,
// the network or the account has a bad minute.
//
// SCOPE: this stubs globalThis.fetch. It proves the branch's decision table
// and the exact request it issues. It does NOT contact Anthropic, does not
// prove a real token is accepted, and says nothing about the /api/byok/validate
// route's storage gate.
//
// Mirrors scripts/test-custom-provider-validate.mjs's assert()/pass/fail style.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { validateProviderKey } = require('../onboarding/http-server.cjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}`)
  }
}

const realFetch = globalThis.fetch
const calls = []
function stubFetch(responder) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return responder()
  }
}
function jsonResponse(status, body) {
  return () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}
const TOKEN = 'sk-ant-oat01-' + 'A'.repeat(95)

console.log('\n1. a valid token (200) passes cleanly')
{
  stubFetch(jsonResponse(200, { id: 'msg_x' }))
  const r = await validateProviderKey('claude-subscription', TOKEN)
  assert(r.ok === true, '200 => ok:true')
  assert(r.verified !== false, '200 => not marked unverified (it WAS verified)')
  assert(calls.length === 1, '200 => exactly one request issued')
}

console.log('\n2. the request matches what the real CLI puts on the wire')
{
  // Every assertion here is a transcription of a captured request, NOT a
  // choice. The CLI was pointed at a local server (ANTHROPIC_BASE_URL,
  // isolated config dir, junk token) and this is what came out:
  //   POST /v1/messages?beta=true
  //   authorization: Bearer <token>
  //   anthropic-beta: claude-code-20250219,oauth-2025-04-20,<8 feature betas>
  //   anthropic-version: 2023-06-01
  //   x-app: cli
  // The FIRST version of this file asserted `anthropic-beta ===
  // 'oauth-2025-04-20'` and passed 38/38, because it pinned the shape I had
  // written from the docs instead of the shape that works. Tests pinning the
  // author's own guess are the failure mode this block exists to close: if
  // any of ?beta=true / claude-code-20250219 / x-app is required for an OAuth
  // credential, that version rejected every valid token.
  stubFetch(jsonResponse(200, {}))
  await validateProviderKey('claude-subscription', TOKEN)
  const { url, init } = calls[0]
  const headers = init.headers
  const headerNames = Object.keys(headers).map((h) => h.toLowerCase())
  assert(String(url) === 'https://api.anthropic.com/v1/messages?beta=true', 'targets /v1/messages?beta=true')
  assert(init.method === 'POST', 'POST')
  assert(headers.authorization === `Bearer ${TOKEN}`, 'sends Authorization: Bearer <token>')
  assert(!headerNames.includes('x-api-key'), 'never sends x-api-key (a different server evaluator)')
  assert(headers['anthropic-beta'] === 'claude-code-20250219,oauth-2025-04-20',
    'anthropic-beta carries the identity pair, claude-code first (CLI order)')
  assert(headers['x-app'] === 'cli', 'sends x-app: cli')
  assert(headers['anthropic-version'] === '2023-06-01', 'sends anthropic-version')
  // The token must not leak into the body of a request that gets logged
  // upstream; it belongs in exactly one place.
  assert(!String(init.body).includes(TOKEN), 'token appears in the header only, never in the body')
  const body = JSON.parse(init.body)
  assert(body.max_tokens === 1, 'max_tokens:1 (validation must not be an expensive call)')
}

console.log('\n3. THE rejection: 401 authentication_error is the ONLY thing that fails')
{
  stubFetch(jsonResponse(401, {
    type: 'error',
    error: { type: 'authentication_error', message: 'OAuth access token is invalid.' },
  }))
  const r = await validateProviderKey('claude-subscription', 'sk-ant-oat01-truncated')
  assert(r.ok === false, '401 authentication_error => ok:false')
  assert(typeof r.reason === 'string' && r.reason.length > 0, 'carries a reason for the user')
  assert(!r.reason.includes('sk-ant-oat01-truncated'), 'the reason never echoes the credential')
}

console.log('\n4. FAIL-OPEN: nothing else may reject a print-once credential')
{
  // Each of these was a real candidate for "looks like a failure, is not proof
  // of an invalid token". A setup-token cannot be re-pasted — a wrong
  // rejection here means redoing the whole interactive OAuth flow.
  const cases = [
    [401, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }, '401 but NOT authentication_error'],
    // Not hypothetical: this is verbatim what a VALID setup-token gets from
    // /api/oauth/validate, the endpoint whose name most invites a future
    // "improvement" here (measured 2026-07-29). If that swap ever happens,
    // this row is what keeps it from destroying every credential.
    [403, { type: 'error', error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement any_of(user:profile, user:office, user:ccr_inference)' } }, '403 permission/scope error'],
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, '429 rate limited'],
    [500, { type: 'error', error: { type: 'api_error', message: 'x' } }, '500 upstream broken'],
    [503, {}, '503 with an empty body'],
    [401, { something: 'unrecognised' }, '401 with a shape we do not know'],
    [400, { error: { type: 'authentication_error' } }, 'authentication_error on a NON-401 status'],
  ]
  for (const [status, body, label] of cases) {
    stubFetch(jsonResponse(status, body))
    const r = await validateProviderKey('claude-subscription', TOKEN)
    assert(r.ok === true, `${label} => ok:true (does not destroy the credential)`)
    assert(r.verified === false, `${label} => verified:false (honest about not knowing)`)
  }
}

console.log('\n5. FAIL-OPEN: a 401 whose body will not parse')
{
  stubFetch(() => ({
    ok: false,
    status: 401,
    json: async () => { throw new Error('not json') },
  }))
  const r = await validateProviderKey('claude-subscription', TOKEN)
  assert(r.ok === true, 'unparseable 401 body => ok:true')
  assert(r.verified === false, 'unparseable 401 body => verified:false')
}

console.log('\n6. FAIL-OPEN: the network itself failed')
{
  // This is the case the branch keeps its OWN try/catch for. The function-level
  // handler ends in { ok: false, reason: err.message }; inheriting it would let
  // one dropped frame burn a credential the user cannot get back.
  stubFetch(() => { throw new TypeError('fetch failed') })
  const r = await validateProviderKey('claude-subscription', TOKEN)
  assert(r.ok === true, 'network throw => ok:true')
  assert(r.verified === false, 'network throw => verified:false')
  assert(!('reason' in r) || r.ok === true, 'network throw is not dressed as a validation failure')
}

console.log('\n7. an empty key still fails, and without touching the network')
{
  stubFetch(jsonResponse(200, {}))
  for (const empty of ['', '   ', undefined, null]) {
    const r = await validateProviderKey('claude-subscription', empty)
    assert(r.ok === false, `empty key (${JSON.stringify(empty)}) => ok:false`)
  }
  assert(calls.length === 0, 'no request is issued for an empty key')
}

globalThis.fetch = realFetch

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
