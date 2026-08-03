#!/usr/bin/env node
// test-credential-store.mjs — pins the safeStorage-backed credential store's
// security contract. Run: node scripts/test-credential-store.mjs
//
// WHY THIS FILE EXISTS: scripts/test-custom-provider-validate.mjs closes with
// "no Electron, no safeStorage here. It does NOT prove the /api/byok/validate
// route's storage gate itself." That gap stayed open, and storeProviderKey /
// storeProviderKeyVerified / readProviderKey are the code that decides whether
// a user's API key lands on disk encrypted, in plaintext, or not at all. On
// 2026-07-25 the whole path had still never executed anywhere but a packaged
// build in a user's hands, because dev-serve-ui.mjs runs in plain node where
// require('electron') has no safeStorage.
//
// The functions are reachable without Electron on purpose: getElectron() in
// http-server.cjs requires 'electron' LAZILY, and its own comment says that is
// "so this file stays requireable/testable outside a running Electron main
// process if ever needed." This is that need. A stub module is injected into
// the CJS require cache before http-server.cjs is loaded, so every call goes
// through the real store/read/verify code with a controllable safeStorage.
//
// WHAT IT PROVES
//   1. a stored key is encrypted at rest -- the plaintext appears in NO file
//      anywhere under the data home (the actual security property, not just
//      "encryptString was called")
//   2. file modes: 0600 on the blob, 0700 on the directory
//   3. the per-provider manifest split holds (2026-07-03 fix) -- storing a
//      second provider does not clobber the first
//   4. encryption unavailable => throws AND writes nothing (the refusal is
//      what keeps a key out of plaintext on a machine with no Keychain)
//   5. a corrupted round trip throws instead of leaving an unverified
//      credential on disk
//
// SCOPE: the store/read/verify functions. It does NOT exercise the HTTP route
// that calls them, does NOT prove macOS Keychain behaves as the stub does, and
// does NOT run inside Electron. Real safeStorage semantics remain an OS-level
// guarantee this cannot re-test.

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

// Sandbox FIRST. http-server.cjs resolves DATA_HOME at require time and seeds
// config on first boot, so pointing this at the live install would write into
// the user's real Scheherazade directory. Same guard shape as dev-serve-ui.mjs.
const LIVE_HOME = path.join(os.homedir(), 'Documents', 'Scheherazade')
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'sch-credtest-'))
if (path.resolve(SANDBOX) === path.resolve(LIVE_HOME)) {
  console.error('refusing to run against the live data home')
  process.exit(2)
}
process.env.AGENT_DATA_HOME = SANDBOX

// ── the safeStorage stub ────────────────────────────────────────────────────
// Deliberately NOT a no-op passthrough: encryptString prefixes and reverses so
// that a plaintext-leak assertion below is meaningful. If the code under test
// ever wrote the raw key instead of the blob, assertion 1 would see it.
const stub = {
  available: true,
  corrupt: false,
  encryptCalls: 0,
  safeStorage: {
    isEncryptionAvailable: () => stub.available,
    encryptString(s) {
      stub.encryptCalls++
      return Buffer.from('ENC:' + [...s].reverse().join(''), 'utf8')
    },
    decryptString(buf) {
      const raw = Buffer.from(buf).toString('utf8')
      if (stub.corrupt) return 'not-what-was-stored'
      return [...raw.replace(/^ENC:/, '')].reverse().join('')
    },
  },
  shell: { openExternal: async () => {} },
}
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: stub,
}

const server = require('../onboarding/http-server.cjs')
const { storeProviderKeyVerified, readProviderKey } = server

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

function walk(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function finish() {
  rmSync(SANDBOX, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

if (typeof storeProviderKeyVerified !== 'function') {
  console.log('  FAIL storeProviderKeyVerified is not exported from http-server.cjs')
  fail++
  finish()
}

const SECRET = 'sk-ant-do-not-write-me-in-plaintext-0731'
const CRED_DIR = path.join(SANDBOX, '.credentials')

console.log('\n1. a stored key is encrypted at rest')
const blobPath = storeProviderKeyVerified('anthropic', SECRET)
assert(existsSync(blobPath), 'the encrypted blob exists on disk')
assert(stub.encryptCalls === 1, 'encryptString ran exactly once for one store')
assert(readProviderKey('anthropic') === SECRET, 'the key reads back intact')
const leaking = walk(SANDBOX).filter((f) => {
  try { return readFileSync(f, 'utf8').includes(SECRET) } catch { return false }
})
assert(leaking.length === 0,
  `the plaintext key appears in no file under the data home${leaking.length ? ` (leaked in: ${leaking.join(', ')})` : ''}`)

console.log('\n2. file modes')
// POSIX only, and SAID OUT LOUD rather than silently skipped. Node on Windows
// maps only the read-only bit, so chmod(0o600) there is a no-op that throws
// nothing: asserting it would fail forever, and dropping the assert without a
// line would quietly retire a real security property on one platform.
//
// CORRECTED 2026-08-04. An earlier version of this comment said the Windows
// fallback is "the profile directory's inherited ACL, which is weaker than
// what this comment block claims". The no-op is real; that conclusion was
// not. The mode was always defence in depth on top of the actual protection:
// the blob is safeStorage.encryptString'd before it is written, which on
// Windows is DPAPI (CryptProtectData) scoped to the logged-in user account.
// A file another account could read still does not decrypt.
//
// And that protection IS asserted on every platform -- section 1's
// "plaintext key appears in no file" sweep above runs here too, and it is
// the assertion that would catch encryption silently not happening. An
// icacls /inheritance:r /grant:r pass is still worth doing; it is hardening,
// not a hole.
if (process.platform === 'win32') {
  console.log('  n/a  0600/0700 blob+dir modes -- fs.chmod is a no-op on Windows. What protects the blob there is DPAPI (asserted in section 1, on every platform); the mode was defence in depth.')
} else {
  assert((statSync(blobPath).mode & 0o777) === 0o600, 'the blob is 0600')
  assert((statSync(CRED_DIR).mode & 0o777) === 0o700, 'the credentials dir is 0700')
}

console.log('\n3. per-provider manifests do not clobber each other')
// Regression guard for the 2026-07-03 fix: a single shared provider.json meant
// validating a second provider silently overwrote the first one's record.
storeProviderKeyVerified('openai', 'sk-openai-second-provider')
assert(readProviderKey('anthropic') === SECRET, 'the first provider survives a second store')
assert(readProviderKey('openai') === 'sk-openai-second-provider', 'the second provider reads back')
assert(existsSync(path.join(CRED_DIR, 'anthropic.meta.json')) &&
       existsSync(path.join(CRED_DIR, 'openai.meta.json')),
  'both providers have their own manifest file')

console.log('\n4. encryption unavailable: refuse, and write nothing')
stub.available = false
const beforeRefusal = walk(CRED_DIR).length
let threw = null
try { storeProviderKeyVerified('gemini', 'sk-gemini-must-not-land') }
catch (err) { threw = err }
assert(threw !== null, 'storing throws when safeStorage encryption is unavailable')
assert(threw && /plaintext/i.test(threw.message), 'the error names the plaintext refusal')
assert(walk(CRED_DIR).length === beforeRefusal, 'the refusal left no new file behind')
assert(!walk(SANDBOX).some((f) => {
  try { return readFileSync(f, 'utf8').includes('sk-gemini-must-not-land') } catch { return false }
}), 'the refused key is nowhere on disk')
stub.available = true

console.log('\n5. a corrupted round trip is loud')
stub.corrupt = true
let rtThrew = null
try { storeProviderKeyVerified('vertex', 'sk-vertex-roundtrip') }
catch (err) { rtThrew = err }
assert(rtThrew !== null, 'a decrypt that does not match what was stored throws')
assert(rtThrew && /round-trip/i.test(rtThrew.message), 'the error names the round-trip verify')
stub.corrupt = false

finish()
