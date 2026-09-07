#!/usr/bin/env node
// tests/test-platform.mjs -- the capability table, all three platforms, from
// any host. Run: node tests/test-platform.mjs
//
// WHY THIS FILE EXISTS. onboarding/platform.cjs replaced 24 binary
// mac-vs-Windows tests whose Linux behavior was whatever else-branch they
// happened to fall into. That class of bug is INVISIBLE on a Mac: the
// darwin branch is right, the suite is green, and the Linux user gets an
// Apple Silicon tarball. So the table takes every input as a parameter, and
// this file asserts the FULL matrix -- one expected value per flag per
// platform, spelled out, not derived from the same expression the module
// uses (a derivation would agree with any bug).
//
// The second half is the two things a wrong table costs at runtime: a Linux
// answer that contains a mac-only value, and a Windows spawn that forgets
// .cmd shims need a shell.

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const platformMod = require_(path.join(ROOT, 'onboarding', 'platform.cjs'))
const { capabilities, PLATFORMS, SKILL_REQUIREMENTS } = platformMod

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++ } else { fail++; console.error(`  FAIL ${label}`) }
}

// Every table below is built with the SAME injected host so the only
// variable is (platform, arch): a fake home, a fake data home, a filesystem
// where nothing exists, and a tmux probe that says yes. "Nothing exists" is
// deliberate -- it proves the rows are platform facts and not accidents of
// this Mac's disk.
const mk = (platform, arch, over = {}) => capabilities({
  platform,
  arch,
  env: {},
  home: platform === 'win32' ? 'C:\\Users\\t' : '/home/t',
  dataHome: platform === 'win32' ? 'C:\\Users\\t\\Documents\\Scheherazade' : '/home/t/Documents/Scheherazade',
  existsSync: () => false,
  accessSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  hasTmux: () => true,
  ...over,
})

console.log('1. the matrix: one expected value per flag per platform')
// Columns: darwin+arm64, darwin+x64 (Intel Mac), win32+x64, linux+x64.
// Read a row across and you have the whole product decision for that
// capability, which is the thing that did not exist before this file.
const MATRIX = {
  //                       darwin/arm64      darwin/x64        win32/x64    linux/x64
  managedInstall:         [true,             false,            false,       false],
  claudeCliInstall:       ['curl-bash',      'curl-bash',      false,       'curl-bash'],
  inAppUninstall:         ['bundle-trash',   'bundle-trash',   'nsis',      'script'],
  permissionsPanel:       [true,             true,             false,       false],
  attachTopology:         [true,             true,             false,       false],
  sudo:                   [true,             true,             false,       true],
  windowMaterial:         ['vibrancy',       'vibrancy',       'acrylic',   'none'],
  supportsBlur:           [true,             true,             true,        false],
  calendarMcp:            [true,             true,             false,       false],
  cliCredentialKeychain:  [true,             true,             false,       false],
  appleApps:              [true,             true,             false,       false],
  unixTools:              [true,             true,             false,       true],
  execBit:                [true,             true,             false,       true],
  windowCapture:          [true,             true,             true,        false],
  shellName:              ['Terminal',       'Terminal',       'PowerShell', 'Terminal'],
  machineWord:            ['this Mac',       'this Mac',       'this PC',   'this computer'],
}
const COLUMNS = [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']]
const tables = COLUMNS.map(([p, a]) => mk(p, a))
for (const [flag, expected] of Object.entries(MATRIX)) {
  expected.forEach((want, i) => {
    const got = tables[i][flag]
    assert(got === want,
      `${COLUMNS[i][0]}/${COLUMNS[i][1]} ${flag}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  })
}
// Non-vacuity: a typo in a flag name would make every row above compare
// undefined === undefined and pass in silence.
for (const flag of Object.keys(MATRIX)) {
  assert(tables[0][flag] !== undefined, `${flag} is a real field on the table (not a typo that compares undefined)`)
}
assert(Object.keys(MATRIX).length >= 16, 'the matrix covers the whole product surface, not two flags')

console.log('2. attachTopology is a PROBE, not a constant (mac ships tmux; nobody else does)')
assert(mk('darwin', 'arm64', { hasTmux: () => false }).attachTopology === false,
  'a Mac with no tmux anywhere reports attachTopology false -- the vendored copy is what makes it true')
assert(mk('linux', 'x64', { hasTmux: () => true }).attachTopology === false,
  'a Linux box WITH a system tmux still gets false: no vendored binary ships there and the lane is unverified (locked scope)')

console.log('3. a Linux answer never contains a mac-only value')
const linux = mk('linux', 'x64')
const linuxJson = JSON.stringify(linux.clientView())
for (const macWord of ['Mac', 'Keychain', 'vibrancy', 'bundle-trash', 'nsis', 'PowerShell']) {
  assert(!linuxJson.includes(macWord), `linux clientView contains no ${JSON.stringify(macWord)} (got: ${linuxJson})`)
}
const win = mk('win32', 'x64')
const winJson = JSON.stringify(win.clientView())
for (const macWord of ['Mac', 'Keychain', 'vibrancy', 'curl-bash']) {
  assert(!winJson.includes(macWord), `win32 clientView contains no ${JSON.stringify(macWord)}`)
}
// clientView is what rides the <meta> tag and /api/config: no functions, no
// user home paths.
const view = linux.clientView()
assert(Object.values(view).every((v) => typeof v !== 'function' && typeof v !== 'object'),
  'clientView is flat scalars only (it is serialized into an HTML attribute)')
assert(!JSON.stringify(view).includes('/home/t'), 'clientView leaks no filesystem paths')

console.log('4. binCandidates: the Linux dirs that were missing are on the list')
{
  const l = mk('linux', 'x64', { env: { npm_config_prefix: '/opt/npm' } })
  const cands = l.binCandidates('codex')
  const dirs = cands.map((c) => path.posix.dirname(c))
  for (const want of ['/usr/bin', '/usr/local/bin', '/home/t/.local/bin', '/snap/bin', '/opt/npm/bin', '/home/t/Documents/Scheherazade/bin']) {
    assert(dirs.includes(want), `linux candidates include ${want} (a fresh apt/npm/snap install lands in one of these)`)
  }
  assert(cands.every((c) => c.endsWith('/codex')), 'no extension is appended off Windows')
  assert(!dirs.includes('/opt/homebrew/bin'), 'the mac brew dir is NOT probed on linux')
  const m = mk('darwin', 'arm64').binCandidates('codex').map((c) => path.posix.dirname(c))
  assert(m.includes('/opt/homebrew/bin') && m.includes('/usr/local/bin'), 'mac keeps both brew prefixes (unchanged behavior)')
  assert(!m.includes('/snap/bin'), 'mac does not grow Linux dirs')
}

console.log('5. Windows resolution goes through PATHEXT, not a bare name')
{
  const w = mk('win32', 'x64', { env: { PATHEXT: '.COM;.EXE;.CMD', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' } })
  const base = (c) => String(c).split(/[\\/]/).pop()
  const names = w.binCandidates('codex').map(base)
  assert(names.includes('codex.exe') && names.includes('codex.EXE'), 'both PATHEXT spellings are tried (registry is upper, disk is lower)')
  assert(names.includes('codex.cmd'), 'the npm .cmd shim is a candidate')
  assert(w.binCandidates('codex').some((c) => /AppData[\\/]Roaming[\\/]npm/.test(c)), 'npm global bin is on the Windows list')
  // A PATHEXT the host does not set must not collapse the list to nothing.
  const noExt = mk('win32', 'x64', { env: {} }).binCandidates('codex').map(base)
  assert(noExt.includes('codex.exe') && noExt.includes('codex.cmd'), 'a missing PATHEXT falls back to the documented default set')
}

console.log('6. spawnBin: .cmd shims get a shell and lose detached; exes do not')
{
  const calls = []
  const fakeChild = () => ({ on() { return this } })
  const spawnImpl = (bin, args, opts) => { calls.push({ bin, args, opts }); return fakeChild() }
  const winExists = (p) => /\.(exe|cmd)$/i.test(String(p))
  const w = capabilities({
    platform: 'win32', arch: 'x64', env: { PATHEXT: '.EXE;.CMD' },
    home: 'C:\\Users\\t', dataHome: 'C:\\Users\\t\\Documents\\Scheherazade',
    existsSync: winExists,
    accessSync: (p) => { if (!winExists(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    spawnImpl,
  })
  w.spawnBin('C:\\Users\\t\\AppData\\Roaming\\npm\\codex.cmd', ['login'], { detached: true })
  assert(calls[0].opts.shell === true, '.cmd is spawned through a shell (CreateProcess cannot exec it)')
  assert(calls[0].opts.detached === false, 'detached is dropped for the shell path (they are incompatible on Windows; taskkill /T still reaps the tree)')
  assert(calls[0].opts.windowsHide === true, 'windowsHide is set so no console flashes')
  w.spawnBin('C:\\Users\\t\\Documents\\Scheherazade\\bin\\codex.exe', ['login'], { detached: true })
  assert(calls[1].opts.shell === false, 'a real .exe needs no shell')
  assert(calls[1].opts.detached === true, '...and keeps its own process group')

  // POSIX: never a shell, detached honored.
  const posixCalls = []
  const l = capabilities({
    platform: 'linux', arch: 'x64', env: {}, home: '/home/t', dataHome: '/home/t/Documents/Scheherazade',
    existsSync: (p) => p === '/usr/bin/codex',
    accessSync: (p) => { if (p !== '/usr/bin/codex') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    spawnImpl: (bin, args, opts) => { posixCalls.push({ bin, args, opts }); return fakeChild() },
  })
  l.spawnBin('codex', ['login'], { detached: true })
  assert(posixCalls[0].bin === '/usr/bin/codex', 'a bare name resolves against the fixed Linux dirs (/usr/bin was never on the old list)')
  assert(posixCalls[0].opts.shell === false && posixCalls[0].opts.detached === true, 'linux: no shell, own process group')

  // The failure that used to reach main.cjs's uncaughtException handler.
  let threw = null
  try { l.spawnBin('nothing-here', []) } catch (err) { threw = err }
  assert(threw && threw.code === 'ENOENT', 'an unresolvable bin THROWS synchronously instead of spawning nothing')

  let seen = null
  const boom = capabilities({
    platform: 'linux', arch: 'x64', env: {}, home: '/home/t', dataHome: '/d',
    existsSync: () => true, accessSync: () => {},
    spawnImpl: () => ({ handlers: {}, on(ev, fn) { if (ev === 'error') setTimeout(() => fn(new Error('EACCES')), 0); return this } }),
  })
  boom.spawnBin('codex', [], { onError: (e) => { seen = e } })
  await new Promise((r) => setTimeout(r, 5))
  assert(seen && seen.message === 'EACCES', "spawnBin always attaches an 'error' listener (an unhandled one is app.exit(1) via main.cjs)")
}

console.log('7. no PATH walk unless a caller asks for one')
{
  let walked = false
  const l = capabilities({
    platform: 'linux', arch: 'x64', env: { PATH: '/evil' }, home: '/home/t', dataHome: '/d',
    existsSync: (p) => { if (String(p).startsWith('/evil')) walked = true; return String(p).startsWith('/evil') },
    accessSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  })
  assert(l.resolveBin('codex') === null, 'a binary that exists ONLY on PATH does not resolve (the security posture http-server has carried since its Codex review)')
  assert(walked === false, '...and PATH is not even read')
  assert(l.resolveBin('codex', { allowPath: true }) === '/evil/codex', 'the opt-in seam exists and is explicit at the call site')
}

console.log('8. seeded-skill allowlist is data, and it excludes what cannot run')
{
  const m = mk('darwin', 'arm64')
  const w = mk('win32', 'x64')
  const l = mk('linux', 'x64')
  for (const name of ['calendar', 'mail-briefing', 'reminders']) {
    assert(SKILL_REQUIREMENTS[name] === 'appleApps', `${name} is marked Apple-only`)
    assert(m.skillAllowed(name) && !w.skillAllowed(name) && !l.skillAllowed(name),
      `${name} seeds on mac only (it is osascript + an Apple app)`)
  }
  assert(!w.skillAllowed('file-organizer') && l.skillAllowed('file-organizer') && m.skillAllowed('file-organizer'),
    'file-organizer is unix find/mv: mac + linux, not Windows')
  assert(m.skillAllowed('windowshot') && w.skillAllowed('windowshot') && !l.skillAllowed('windowshot'),
    'windowshot has a mac and a Windows implementation and no Linux one')
  assert(m.skillAllowed('coding') && w.skillAllowed('coding') && l.skillAllowed('coding'),
    'a skill with no requirement seeds everywhere (the default is portable)')
}

console.log('9. the table is frozen and the platform list is complete')
{
  const t = mk('darwin', 'arm64')
  let mutated = false
  try { t.sudo = false; mutated = t.sudo === false } catch { mutated = false }
  assert(!mutated, 'the descriptor is frozen -- a caller cannot flip a capability under everyone else')
  assert(PLATFORMS.length === 3 && ['darwin', 'win32', 'linux'].every((p) => PLATFORMS.includes(p)),
    'PLATFORMS names all three, so a future row cannot forget one')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
