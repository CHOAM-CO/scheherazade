#!/usr/bin/env node
// test-custom-key-host.mjs — the save-time "this key is about to go to a
// different host" predicate from onboarding/public/js/settings.js.
// Run: node scripts/test-custom-key-host.mjs
//
// WHY THIS FILE EXISTS: that predicate shipped wrong twice in one day.
// v1 warned whenever a key would be sent and the host changed -- including
// when the user had just typed that key themselves, i.e. it was loudest on
// the most common flow. v2 compared the STORED base URL against the new one
// for every case, which both missed the leak it was written for (paste
// vendor-A's url+key, then pick a preset that returns the URL to the stored
// host -> "same host" -> silence, with vendor A's key saved against it) and
// fired on the ordinary case (a paste whose baseUrl and apiKey travel
// together). Neither version could be caught: settings.js is browser JS and
// no harness in scripts/ executes it.
//
// So the predicate was pulled out as a pure function and this file EXTRACTS
// IT BY NAME from the real source and runs it. Nothing is duplicated here --
// if the shipped function changes, these cases run the changed one.
//
// SOURCE-TEXT PIN (this repo's known hazard, see docs/HISTORY.md): renaming
// or reshaping `credentialCrossesHosts` / `originOf` / `sameOrigin` in
// settings.js makes the extraction below fail LOUDLY with a nonzero exit,
// which is the intended trade -- a silent skip would be worse than no test.
//
// Mirrors scripts/test-provider-env.mjs's plain assert()/pass/fail convention.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'onboarding/public/js/settings.js'), 'utf8')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`PASS  ${label}`) } else { fail++; console.log(`FAIL  ${label}`) }
}

// ── extract the real implementations ───────────────────────────────────────
function extract(name, kind) {
  const re = kind === 'arrow'
    ? new RegExp(`\\n  const ${name} = [^\\n]+`)
    : new RegExp(`\\n  function ${name}\\([^]*?\\n  \\}`)
  const m = SRC.match(re)
  if (!m) {
    console.log(`FAIL  could not extract ${name} from settings.js -- it was renamed or reshaped; update this test`)
    process.exit(1)
  }
  return m[0]
}

const credentialCrossesHosts = new Function(
  `${extract('originOf', 'arrow')}
   ${extract('sameOrigin', 'arrow')}
   ${extract('credentialCrossesHosts', 'fn')}
   return credentialCrossesHosts`,
)()

const GROK = 'http://localhost:8766'
const VENDOR_A = 'https://api.vendor-a.com'
const VENDOR_B = 'https://api.vendor-b.com'

// ── 1. the leak this predicate exists for ──────────────────────────────────
// Paste carries vendor A's url AND key; the user then changes the URL. The
// key must not travel to the new host without the dialog saying so.
{
  const v = credentialCrossesHosts({
    nextUrl: GROK, typedKey: 'K_A', keyFromPaste: true, pastedKeyBaseUrl: VENDOR_A,
    storedUrl: GROK, hasStoredKey: false,
  })
  assert(v.warn === true, 'pasted key + URL changed back to the STORED host: warns (v2 went silent here -- stored-vs-new said "same host")')
  assert(v.stored === false, 'pasted key: the dialog is told this is a pasted key, not a stored one')
  assert(v.priorUrl === VENDOR_A, 'pasted key: the reference host is the one that arrived WITH the key')
}

// ── 2. the ordinary case must stay quiet ───────────────────────────────────
{
  const v = credentialCrossesHosts({
    nextUrl: VENDOR_A, typedKey: 'K_A', keyFromPaste: true, pastedKeyBaseUrl: VENDOR_A,
    storedUrl: GROK, hasStoredKey: false,
  })
  assert(v.warn === false, 'paste whose baseUrl and apiKey travel together, unchanged: silent (v2 warned -- ~100% of first paste-box use)')
}
{
  const v = credentialCrossesHosts({
    nextUrl: VENDOR_B, typedKey: 'K_TYPED', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: GROK, hasStoredKey: true,
  })
  assert(v.warn === false, 'a key the user typed themselves: silent -- they chose it against the URL in front of them')
}
{
  const v = credentialCrossesHosts({
    nextUrl: GROK, typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: GROK, hasStoredKey: true,
  })
  assert(v.warn === false, 'stored key, same host: silent')
}

// ── 3. the stored-key path (predates the paste box) ────────────────────────
{
  const v = credentialCrossesHosts({
    nextUrl: VENDOR_B, typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: VENDOR_A, hasStoredKey: true,
  })
  assert(v.warn === true, 'blank field ("keep the stored key") + a new host: warns')
  assert(v.stored === true, 'stored key: the dialog is told it is the stored one')
}
{
  // A key stored via POST /api/byok/validate leaves no CUSTOM_BASE_URL, so
  // there is no recorded host to compare against. Unknown is not safe.
  const v = credentialCrossesHosts({
    nextUrl: VENDOR_B, typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: '', hasStoredKey: true,
  })
  assert(v.warn === true, 'stored key with NO recorded host: warns (unknown reference is not silence)')
}

// ── 4. origin, not host ────────────────────────────────────────────────────
{
  const downgrade = credentialCrossesHosts({
    nextUrl: 'http://api.vendor-a.com', typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: 'https://api.vendor-a.com', hasStoredKey: true,
  })
  assert(downgrade.warn === true, 'https -> http on the same host: warns (a host-only compare put a stored key on the wire in cleartext)')
  const port = credentialCrossesHosts({
    nextUrl: 'http://localhost:9999', typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: 'http://localhost:8766', hasStoredKey: true,
  })
  assert(port.warn === true, 'same host, different port: warns (a different port is a different service)')
  const pathOnly = credentialCrossesHosts({
    nextUrl: 'http://localhost:8766/v1', typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: 'http://localhost:8766', hasStoredKey: true,
  })
  assert(pathOnly.warn === false, 'same origin, different path: silent (not a new party)')
}

// ── 5. no key involved at all ──────────────────────────────────────────────
{
  const v = credentialCrossesHosts({
    nextUrl: VENDOR_B, typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: VENDOR_A, hasStoredKey: false,
  })
  assert(v.warn === false, 'no key anywhere: silent, however much the host changes')
}

// ── 6. an unparseable reference fails toward warning ───────────────────────
{
  const v = credentialCrossesHosts({
    nextUrl: VENDOR_B, typedKey: '', keyFromPaste: false, pastedKeyBaseUrl: '',
    storedUrl: 'not a url', hasStoredKey: true,
  })
  assert(v.warn === true, 'unparseable stored URL: warns rather than staying quiet')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
