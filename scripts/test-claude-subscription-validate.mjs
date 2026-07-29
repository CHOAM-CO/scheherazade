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
// cannot be reused here. NOT verified by that run: that a *valid* token
// answers 200 on this endpoint — that needs a live credential. The branch is
// written so the unverified half cannot strand anyone: see the fail-open cases
// below, which are the substance of the design, not defensive padding.
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

console.log('\n2. the request shape is the one that was live-verified')
{
  stubFetch(jsonResponse(200, {}))
  await validateProviderKey('claude-subscription', TOKEN)
  const { url, init } = calls[0]
  const headers = init.headers
  const headerNames = Object.keys(headers).map((h) => h.toLowerCase())
  assert(String(url) === 'https://api.anthropic.com/v1/messages', 'targets /v1/messages')
  assert(init.method === 'POST', 'POST')
  assert(headers.authorization === `Bearer ${TOKEN}`, 'sends Authorization: Bearer <token>')
  assert(!headerNames.includes('x-api-key'), 'never sends x-api-key (a different server evaluator)')
  assert(headers['anthropic-beta'] === 'oauth-2025-04-20', 'sends anthropic-beta: oauth-2025-04-20')
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
    [403, { type: 'error', error: { type: 'permission_error', message: 'x' } }, '403 permission/scope error'],
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
