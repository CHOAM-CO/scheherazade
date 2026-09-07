#!/usr/bin/env node
// test-custom-provider-validate.mjs — pins the validation contract of the
// 'custom' provider branch in http-server.cjs's validateProviderKey().
// Run: node tests/test-custom-provider-validate.mjs
//
// WHY THIS FILE EXISTS: an external (non-Claude) red team on the
// custom-provider change (2026-07-25) found that the branch returned
// `{ ok: true, reachable: false }` for a base URL that had already FAILED
// resolveCustomBaseUrl(). POST /api/byok/validate persists a credential
// whenever `result.ok` is true and a non-blank key was supplied
// (`provider === 'custom' && key && key.trim()`), so ok:true on a
// known-unusable URL both stored a key for a config that can never spawn
// (buildProviderEnv rejects the identical URL with not_ready) and reported
// success to the caller. This file exists so that regression cannot come
// back silently.
//
// SCOPE: the pre-network decision only. Every case below returns before
// checkLocalLiveness() issues a fetch, so there is no live proxy, no
// Electron, no safeStorage here. It does NOT prove the /api/byok/validate
// route's storage gate itself, nor anything about a reachable proxy.
//
// Mirrors tests/test-provider-env.mjs's plain assert()/pass/fail
// convention.

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

console.log('\n1. custom + invalid base URL => ok:false (never ok:true)')
{
  // A non-blank key is supplied on purpose: this is exactly the input shape
  // that made the old ok:true persist a credential.
  const cases = [
    ['ftp://invalid-scheme', 'non-http(s) scheme'],
    ['not-a-valid-url', 'unparseable'],
    ['', 'empty string'],
    [undefined, 'missing entirely'],
  ]
  for (const [baseUrl, label] of cases) {
    const result = await validateProviderKey('custom', 'a-real-looking-secret', { baseUrl })
    assert(result.ok === false, `${label}: ok === false`)
    assert(typeof result.reason === 'string' && result.reason.length > 0, `${label}: carries a reason string`)
    assert(!('detail' in result) || result.ok === false, `${label}: does not dress a failure as an informational detail`)
  }
}

console.log('\n2. the ok:true/reachable:false shape stays reserved for a WELL-FORMED target')
{
  // Port 1 on localhost: syntactically fine, nothing listening. This is the
  // legitimate "proxy not started yet" case and MUST stay non-blocking --
  // the whole point of the distinction the fix draws.
  const result = await validateProviderKey('custom', '', { baseUrl: 'http://127.0.0.1:1' })
  assert(result.ok === true, 'well-formed but dead URL: ok === true (does not block setup)')
  assert(result.reachable === false, 'well-formed but dead URL: reachable === false (informational)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
