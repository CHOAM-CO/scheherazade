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

// ── 7. the WIRING, not just the arithmetic ────────────────────────────────
// A mutation battery on the previous version found the gap: deleting
// `pastedKeyBaseUrl` from the call site makes priorUrl empty, which turns
// warn into false and silently restores the leak this whole file exists to
// pin -- and every assertion above stayed green, because they call the
// function directly with arguments the test supplies. The predicate's inputs
// have to be pinned too, and they live in the call site.
//
// These are SOURCE-TEXT assertions (this repo's known hazard, see this file's
// header). They fail loudly on a rename, which is the trade.
{
  // Anchored on `= credentialCrossesHosts(` so it cannot match the function
  // DEFINITION, which appears first in the file and whose parameter list
  // would satisfy a looser pattern while proving nothing about the call.
  const call = SRC.match(/=\s*credentialCrossesHosts\(\{[^]*?\}\)/)
  assert(Boolean(call), 'the call site passes an object literal to credentialCrossesHosts')
  const callSrc = call ? call[0] : ''
  for (const [field, source] of [
    ['nextUrl', 'baseUrl'],
    ['typedKey', 'apiKey'],
    ['keyFromPaste', 'keyFromPaste'],
    ['pastedKeyBaseUrl', 'pastedKeyBaseUrl'],
    ['storedUrl', 'cfg.CUSTOM_BASE_URL'],
    ['hasStoredKey', 'cfg.hasCustomApiKey'],
  ]) {
    // Either `field: source` or the ES6 shorthand `field,` when the two names
    // coincide -- both are the same wiring.
    const explicit = new RegExp(`${field}:\\s*[^,}]*${source.replace('.', '\\.')}`)
    const shorthand = field === source ? new RegExp(`\\b${field}\\s*,`) : null
    assert(explicit.test(callSrc) || (shorthand !== null && shorthand.test(callSrc)),
      `call site feeds ${field} from ${source} (dropping any one of these silently disables the warning)`)
  }
}
// The two state variables must be set together when a paste lands, and
// cleared together when the user takes the field over. Setting one without
// the other is exactly how a stale reference host survives a second paste.
{
  const fill = SRC.match(/keyFromPaste = Boolean\(parsed\.apiKey\)[^\n]*\n[^\n]*/)
  assert(Boolean(fill) && /pastedKeyBaseUrl = /.test(fill[0]),
    'the paste handler sets pastedKeyBaseUrl on the line after keyFromPaste')
  const oninput = SRC.match(/\$\('set-custom-key-input'\)\.oninput = \(\) => \{[^}]*\}/)
  assert(Boolean(oninput) && /keyFromPaste = false/.test(oninput[0]) && /pastedKeyBaseUrl = ''/.test(oninput[0]),
    'the key field oninput clears BOTH keyFromPaste and pastedKeyBaseUrl')
}

// ── 8. the COPY the user actually reads ───────────────────────────────────
// The previous version tested the boolean and never the sentence, so swapping
// the two dialog strings -- re-introducing the "wrong key named" bug this
// commit series already shipped once -- passed clean. These render the real
// functions out of copy.js.
{
  const copySrc = fs.readFileSync(path.join(ROOT, 'onboarding/public/js/copy.js'), 'utf8')
  const grab = (name) => {
    const m = copySrc.match(new RegExp(`\\n    ${name}: (\\([^)]*\\) => \`[^\`]*\`)`))
    if (!m) { console.log(`FAIL  could not extract ${name} from copy.js`); process.exit(1) }
    return new Function(`return ${m[1]}`)()
  }
  const stored = grab('customSwitchConfirmKeyToNewHost')
  const noHost = grab('customSwitchConfirmKeyNoPriorHost')
  const pasted = grab('customSwitchConfirmPastedKeyToNewHost')

  const s1 = stored('m1', 'https://new.example', 'https://old.example')
  assert(s1.includes('https://old.example') && s1.includes('https://new.example'), 'stored-key dialog names both hosts')
  assert(s1.indexOf('https://old.example') < s1.indexOf('https://new.example'),
    'stored-key dialog says CURRENT host first, then the destination -- swapping the two interpolations tells the user the key is going where it already is')
  assert(/stored API key/.test(s1), 'stored-key dialog calls it a stored key')
  assert(!/pasted/i.test(s1), 'stored-key dialog does NOT call it a pasted key')
  // It must describe where the PROXY is saved, not claim the key was stored
  // for that host -- CUSTOM_BASE_URL is the last URL saved, and the save route
  // rewrites it on a blank-key save while leaving the key store untouched, so
  // the two genuinely diverge. A previous revision asserted the provenance.
  assert(!/key was stored for/i.test(s1), 'stored-key dialog does not claim the key was stored FOR that host (the data does not carry provenance)')

  const s2 = noHost('m1', 'https://new.example')
  assert(s2.includes('https://new.example'), 'no-prior-host dialog names the destination')
  assert(/no record/i.test(s2), 'no-prior-host dialog says the prior host is unknown instead of printing an empty one')
  // The old form of this assertion looked for ", " artifacts in a string that
  // has no prior-host slot at all -- it could not fail. What actually
  // regresses is someone giving it one again: called with the arity it has,
  // any extra slot renders as "undefined".
  assert(!/undefined|\bnull\b/.test(s2), 'no-prior-host dialog interpolates nothing it was not given (a reintroduced host slot renders "undefined")')
  assert(!s2.includes('https://old.example'), 'no-prior-host dialog cannot name a prior host -- it does not receive one')

  const s3 = pasted('m1', 'https://new.example', 'https://paste.example')
  assert(/pasted API key/.test(s3), 'pasted-key dialog calls it a pasted key')
  assert(!/stored API key/.test(s3), 'pasted-key dialog does NOT call it a stored key')
  assert(s3.includes('https://paste.example') && s3.includes('https://new.example'), 'pasted-key dialog names both hosts')
  assert(s3.indexOf('https://paste.example') < s3.indexOf('https://new.example'),
    'pasted-key dialog says where the key CAME FROM first, then where it is going')

  // And the call site must route each verdict to the matching string. ORDER
  // matters and is asserted: this is an if/else chain, so the first matching
  // branch wins. Swapping the pasted-key branch below the stored-key one makes
  // a PASTED key render "The stored API key will be sent there" -- verbatim
  // the wrong-key-named bug this file exists to stop -- while every
  // does-this-line-exist assertion stays green.
  const iPasted = SRC.indexOf('customSwitchConfirmPastedKeyToNewHost(model')
  const iStored = SRC.indexOf('customSwitchConfirmKeyToNewHost(model')
  const iNoHost = SRC.indexOf('customSwitchConfirmKeyNoPriorHost(model')
  assert(iPasted > 0 && iStored > 0 && iNoHost > 0, 'call site references all three dialog strings')
  assert(/!verdict\.stored[^\n]*customSwitchConfirmPastedKeyToNewHost/.test(SRC),
    'call site sends the NOT-stored verdict to the pasted-key string')
  assert(iPasted < iStored && iStored < iNoHost,
    'the branches are in the only correct order: pasted-key first (it is the narrower condition), then stored-with-host, then the no-host fallback')
  assert(/else confirmText = C\.customSwitchConfirmKeyNoPriorHost/.test(SRC),
    'the no-prior-host string is the final else, not a condition that could shadow the others')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
