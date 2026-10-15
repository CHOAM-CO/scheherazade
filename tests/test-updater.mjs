// test-updater.mjs -- attacks on the self-update wiring (updater.cjs).
// Run: node tests/test-updater.mjs
//
// The updater runs unattended on other people's machines against a public
// GitHub repo anyone can see. The property under attack: can anything that
// comes back from the network (garbage tag, error page, missing field) ever
// produce a false "update available" prompt or an exception that reaches the
// boot path. It must not.

import fs from 'node:fs'
import os from 'node:os'
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

// design-0029: mocked OS process identity, real claim files and updater events.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-updater-profile-'))
  const appData = path.join(home, 'appdata')
  const sibling = path.join(home, 'Documents', 'Scheherazade-work')
  const defaultHome = path.join(home, 'Documents', 'Scheherazade')
  fs.mkdirSync(defaultHome, { recursive: true })
  const command = pid => `sera-main-${pid}`
  function harness(pid = 101, overrides = {}) {
    const events = {}, appEvents = {}, prompts = []
    let installs = 0
    const mock = { on: (event, fn) => { (events[event] ||= []).push(fn) }, checkForUpdates: async () => {}, quitAndInstall: () => installs++ }
    updater.initWindowsUpdater({ app: { getVersion: () => '0.5.0', getPath: () => appData, on: (event, fn) => { appEvents[event] = fn } },
      dialog: { showMessageBox: async options => { prompts.push(options); return { response: 0 } } },
      log: () => {}, updater: mock,
      profileOptions: { home, appData, listCommands: () => [], readCommandLine: () => `${path.resolve('supervisor.mjs')} __loop --profile work` },
      updaterDeps: { pid, kill: () => {}, readCommandLine: command, ...overrides },
    })
    return { mock, prompts, appEvents, get installs() { return installs }, emit: async (event, version) => { for (const fn of events[event] || []) await fn({ version }) } }
  }
  const file = version => path.join(appData, `.scheherazade-update-${version}.pid`)
  try {
    const single = harness(101, { fs: { ...fs, writeFileSync: () => { throw Error('single-profile must not claim') } } })
    await single.emit('update-downloaded', '0.6.0')
    eq('default-only cached download always prompts without claiming', single.prompts.length, 1)
    eq('default-only restart unchanged', single.installs, 1)
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, '.agent.pid'), String(process.pid))
    const guarded = harness()
    await guarded.emit('update-downloaded', '0.6.1')
    eq('downloaded without available acquires claim and prompts', guarded.prompts.length, 1)
    eq('live sibling prompt only offers later', guarded.prompts[0].buttons, ['나중에'])
    ok('live sibling is named', guarded.prompts[0].detail.includes('다른 세라 (work)도 닫혀야 설치돼'))
    eq('live sibling disables install-on-quit', guarded.mock.autoInstallOnAppQuit, false)
    eq('live sibling never installs immediately', guarded.installs, 0)
    ok('claim removed after prompt', !fs.existsSync(file('0.6.1')))
    guarded.appEvents['before-quit']()
    eq('before-quit with live sibling still blocks install', guarded.mock.autoInstallOnAppQuit, false)
    ok('quit clears prompt receipt', !fs.existsSync(`${file('0.6.1')}.shown`))
    fs.writeFileSync(path.join(sibling, '.agent.pid'), '999999999')
    guarded.appEvents['before-quit']()
    eq('last quit re-enables automatic install', guarded.mock.autoInstallOnAppQuit, true)
    await guarded.emit('update-downloaded', '0.6.2')
    eq('dead sibling restores restart option', guarded.prompts[1].buttons, ['지금 재시작', '나중에'])
    eq('restart installs', guarded.installs, 1)

    fs.writeFileSync(file('0.7.0'), JSON.stringify({ pid: 303, command: 'old-recycled-command' }))
    const recycled = harness(202)
    await recycled.emit('update-downloaded', '0.7.0')
    eq('recycled live owner pid cannot suppress prompt', recycled.prompts.length, 1)
    fs.writeFileSync(file('0.7.1'), JSON.stringify({ pid: 303, command: command(303) }))
    const stale = harness(202, { kill: pid => { if (pid === 303) throw Object.assign(Error('gone'), { code: 'ESRCH' }) } })
    await stale.emit('update-downloaded', '0.7.1')
    eq('dead owner claim reclaimed', stale.prompts.length, 1)

    const first = harness(401), second = harness(402)
    await first.emit('update-available', '0.8.0')
    await second.emit('update-available', '0.8.0')
    await second.emit('update-downloaded', '0.8.0')
    eq('competing live claim suppresses sibling prompt', second.prompts.length, 0)
    await first.emit('update-downloaded', '0.8.0')
    await second.emit('update-downloaded', '0.8.0')
    eq('owner prompts once', first.prompts.length, 1)
    eq('late sibling event does not repeat prompt', second.prompts.length, 0)
    await first.emit('update-available', '0.8.1')
    ok('available holds claim', fs.existsSync(file('0.8.1')))
    first.appEvents['before-quit']()
    ok('quit removes outstanding claim', !fs.existsSync(file('0.8.1')))

    let raced = false
    const racer = harness(501, { fs: { ...fs, writeFileSync: (filename, content, options) => {
      if (filename === file('0.9.0') && options?.flag === 'wx') {
        raced = true
        fs.writeFileSync(filename, JSON.stringify({ pid: 502, command: command(502) }))
        throw Object.assign(Error('winner created claim'), { code: 'EEXIST' })
      }
      return fs.writeFileSync(filename, content, options)
    } } })
    await racer.emit('update-downloaded', '0.9.0')
    ok('EEXIST race does not prompt', raced && racer.prompts.length === 0)
    eq('EEXIST never removes winning claim', JSON.parse(fs.readFileSync(file('0.9.0'), 'utf8')).pid, 502)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

console.log(`\ntest-updater: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
