// test-updater.mjs -- attacks on the self-update wiring (updater.cjs).
// Run: node scripts/test-updater.mjs
//
// The updater runs unattended on other people's machines against a public
// GitHub repo anyone can see. The property under attack: can anything that
// comes back from the network (garbage tag, error page, missing field) ever
// produce a false "update available" prompt or an exception that reaches the
// boot path. It must not.

import fs from 'node:fs'
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

// ── pickUpdateMode: the whole table, all three platforms ──────────────────
// Written as a TABLE for 0.3 (design-0023 P1): mac and win were rows here and
// linux was the else-branch nobody had named. pickUpdateMode takes its platform
// as an ARGUMENT, so every row is exercised on every host -- the linux
// expectation below is checked on this Mac, not skipped as "not our platform".
// These rows pin CURRENT behavior, including the parts 0.3 may want to change.
for (const [platform, isPackaged, expected, why] of [
  ['darwin', false, 'off', 'unpackaged (electron:dev): never check, never prompt'],
  ['win32', false, 'off', 'unpackaged'],
  ['linux', false, 'off', 'unpackaged'],
  ['win32', true, 'auto', 'NSIS + electron-updater over latest.yml + blockmap'],
  ['darwin', true, 'notify', 'ad-hoc signature: Squirrel.Mac would refuse the install; dmg is not an updater artifact'],
  ['linux', true, 'notify', 'AppImage: latest-linux*.yml is generated but never uploaded or read, so linux runs the SAME GitHub-tag notifier as mac'],
]) {
  eq(`${isPackaged ? 'packaged' : 'dev'} ${platform} -> ${expected} (${why})`,
    pickUpdateMode({ platform, isPackaged }), expected)
}
// The feed each mode reads, so "linux -> notify" means something concrete.
// notify (mac AND linux) hits the public releases API and offers the releases
// page; auto (win only) is the one path that loads electron-updater, which
// reads app-update.yml/latest.yml instead. If a Linux auto-update lane ever
// lands, these three rows are what has to change with it.
ok('the notify feed is the public releases repo API',
  updater.LATEST_API === 'https://api.github.com/repos/Mino-is-me/scheherazade-releases/releases/latest', updater.LATEST_API)
ok('the notify prompt offers that repo\'s releases page',
  updater.RELEASES_PAGE === 'https://github.com/Mino-is-me/scheherazade-releases/releases/latest', updater.RELEASES_PAGE)
{
  const src = fs.readFileSync(new URL('../updater.cjs', import.meta.url), 'utf8')
  ok('electron-updater is loaded ONLY on the auto row (win32) -- linux and mac never touch it',
    /if \(mode === 'auto'\) initWindowsUpdater/.test(src) &&
    /function initWindowsUpdater[\s\S]*?require\('electron-updater'\)/.test(src) &&
    !/initMacNotifier[\s\S]*?require\('electron-updater'\)/.test(src.slice(src.indexOf('function initMacNotifier'))))
}

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
