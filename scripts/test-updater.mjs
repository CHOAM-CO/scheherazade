// test-updater.mjs -- attacks on the self-update wiring (updater.cjs).
// Run: node scripts/test-updater.mjs
//
// The updater runs unattended on other people's machines against a public
// GitHub repo anyone can see. The property under attack: can anything that
// comes back from the network (garbage tag, error page, missing field) ever
// produce a false "update available" prompt or an exception that reaches the
// boot path. It must not.

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const updater = require(path.join(HERE, '..', 'updater.cjs'))
const { parseVersion, isNewerVersion, pickUpdateMode, fetchLatestTag, initAutoUpdate } = updater

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ── parseVersion ──────────────────────────────────────────────────────────
eq('parseVersion v-prefixed tag', parseVersion('v0.1.5'), [0, 1, 5])
eq('parseVersion bare version', parseVersion('0.1.5'), [0, 1, 5])
eq('parseVersion prerelease suffix ignored', parseVersion('0.2.0-rc1'), [0, 2, 0])
eq('parseVersion whitespace tolerated', parseVersion(' v1.2.3 '), [1, 2, 3])
eq('parseVersion garbage -> null', parseVersion('latest'), null)
eq('parseVersion two-part -> null', parseVersion('1.2'), null)
eq('parseVersion empty -> null', parseVersion(''), null)
eq('parseVersion non-string -> null', parseVersion(null), null)
eq('parseVersion number -> null', parseVersion(0.15), null)

// ── isNewerVersion: the only function allowed to say "prompt the user" ────
ok('newer patch is newer', isNewerVersion('v0.1.5', '0.1.4'))
ok('newer minor is newer', isNewerVersion('0.2.0', '0.1.9'))
ok('newer major is newer', isNewerVersion('1.0.0', '0.9.9'))
ok('equal is NOT newer', !isNewerVersion('v0.1.4', '0.1.4'))
ok('older is NOT newer', !isNewerVersion('0.1.3', '0.1.4'))
ok('numeric compare, not lexicographic', isNewerVersion('0.1.10', '0.1.9'))
// The attack: someone (or a typo) puts a non-semver tag in the releases repo.
ok('garbage remote tag can NEVER prompt', !isNewerVersion('latest', '0.1.4'))
ok('empty remote tag can NEVER prompt', !isNewerVersion('', '0.1.4'))
ok('garbage local version can NEVER prompt', !isNewerVersion('0.2.0', 'dev'))

// ── pickUpdateMode ────────────────────────────────────────────────────────
eq('dev mac -> off', pickUpdateMode({ platform: 'darwin', isPackaged: false }), 'off')
eq('dev win -> off', pickUpdateMode({ platform: 'win32', isPackaged: false }), 'off')
eq('packaged win -> auto', pickUpdateMode({ platform: 'win32', isPackaged: true }), 'auto')
eq('packaged mac -> notify (unsigned build, no auto-install)',
  pickUpdateMode({ platform: 'darwin', isPackaged: true }), 'notify')
eq('packaged linux -> notify (no installer artifact)',
  pickUpdateMode({ platform: 'linux', isPackaged: true }), 'notify')

// ── fetchLatestTag: everything the network can throw at it ────────────────
function mockFetch(status, body) {
  return async (url, opts) => {
    mockFetch.lastUrl = url
    mockFetch.lastOpts = opts
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
}

{
  const tag = await fetchLatestTag(mockFetch(200, { tag_name: 'v0.2.0' }))
  eq('happy path returns tag', tag, 'v0.2.0')
  ok('sends a user-agent (GitHub 403s without one)',
    !!mockFetch.lastOpts?.headers?.['user-agent'])
  ok('hits the releases/latest API', String(mockFetch.lastUrl).includes('/releases/latest'))
}
for (const [name, status, body] of [
  ['HTTP 404 throws', 404, {}],
  ['HTTP 403 (rate limit) throws', 403, {}],
  ['missing tag_name throws', 200, {}],
  ['non-string tag_name throws', 200, { tag_name: 123 }],
  ['non-semver tag_name throws', 200, { tag_name: 'latest' }],
  ['null body throws', 200, null],
]) {
  let threw = false
  try { await fetchLatestTag(mockFetch(status, body)) } catch { threw = true }
  ok(name, threw)
}

// ── initAutoUpdate contract: never throws, never touches UI in dev ────────
{
  const calls = []
  const explodingDialog = { showMessageBox() { throw new Error('dialog must not be touched') } }
  const mode = initAutoUpdate({
    app: { isPackaged: false, getVersion: () => '0.1.5' },
    dialog: explodingDialog,
    shell: { openExternal() { throw new Error('shell must not be touched') } },
    log: (...a) => calls.push(a.join(' ')),
  })
  eq('dev run returns off', mode, 'off')
  ok('dev run logs its mode', calls.some((l) => l.includes('mode=off')))
}
{
  // Packaged non-win path must only SCHEDULE (unref'd timers), never fire
  // network or UI synchronously, and never throw even with hostile deps.
  const calls = []
  const mode = initAutoUpdate({
    app: { isPackaged: true, getVersion: () => '0.1.5' },
    dialog: { showMessageBox() { throw new Error('no sync dialog') } },
    shell: { openExternal() { throw new Error('no sync open') } },
    log: (...a) => calls.push(a.join(' ')),
  })
  ok('packaged non-win init returns a real mode', mode === 'notify' || mode === 'auto')
  ok('init itself never throws / logs mode', calls.some((l) => l.includes('mode=')))
}

console.log(`\ntest-updater: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
