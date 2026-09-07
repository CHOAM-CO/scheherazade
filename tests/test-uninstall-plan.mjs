#!/usr/bin/env node
// test-uninstall-plan.mjs — pins the clean-uninstall plan (v0.0.35, Task:
// 클린테스트 in-app). Run: node tests/test-uninstall-plan.mjs
//
// WHAT gets deleted is the security-sensitive part of this feature, so it is
// asserted as DATA (buildUninstallPlan's dirs array), not scraped out of a
// shell string. The two invariants that must survive every refactor:
//   1. ~/.claude.json and ~/.claude are NEVER on the list (the user's own
//      Claude Code state; the app is merge-only there — 07-30 guide line).
//   2. the ~/.claude/projects entry is OUR slug only, never the parent dir.
// Plus one functional pass: the generated script actually removes a fake
// residue set (and nothing beside it) once the watched pid dies.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { buildUninstallPlan, createRoutes } = require_(path.join(ROOT, 'onboarding', 'routes', 'settings.cjs'))

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

// ── 0. the platform table, exercised on EVERY host ────────────────────────
// design-0023 P4 (deliverable 5): /api/uninstall used to answer 501
// `unsupported_platform` off macOS while settings.js rendered the danger-zone
// button on every platform -- so the whole feature was an error toast for two
// thirds of users, for a promise the rendered manual makes in writing.
// buildUninstallPlan is a pure function of (dataHome, home, {platform, env,
// exePath, pid}) now, so all three plans are asserted from any host, as DATA.
//
// The route handler is deliberately NOT called here any more. It used to be
// safe to call under a linux override precisely because it refused; now it
// performs a real uninstall on every platform (a detached reaper that waits
// for this pid to die, then rm -rf's and pkills). The old comment warned
// about exactly that for darwin -- it applies to all three now, so the route
// is pinned by source and the behavior by the plan.
console.log('\n0. three plans, one shape')
const PLATFORM_CASES = {
  darwin: { home: '/Users/testuser', dataHome: '/Users/testuser/Documents/Scheherazade', exePath: '/Applications/Scheherazade.app/Contents/MacOS/Scheherazade' },
  linux: { home: '/home/testuser', dataHome: '/home/testuser/Documents/Scheherazade', exePath: '/tmp/.mount_x/Scheherazade' },
  win32: { home: 'C:\\Users\\testuser', dataHome: 'C:\\Users\\testuser\\Documents\\Scheherazade', exePath: 'C:\\Users\\testuser\\AppData\\Local\\Programs\\Scheherazade\\Scheherazade.exe' },
}
const plans = {}
for (const [platform, c] of Object.entries(PLATFORM_CASES)) {
  plans[platform] = buildUninstallPlan(c.dataHome, c.home, { platform, env: {}, exePath: c.exePath, pid: 4242 })
}
{
  assert(plans.darwin.mode === 'bundle-trash', 'darwin: trash the .app after the residue')
  assert(plans.win32.mode === 'nsis', 'win32: hand off to the NSIS uninstaller electron-builder wrote')
  assert(plans.linux.mode === 'script', 'linux: unlink the AppImage; there is no bundle and no package entry')
  // The interpreter is the part that used to crash: spawn('/bin/bash') on a
  // Windows box is an ENOENT, and an unhandled 'error' event there is
  // app.exit(1) via main.cjs's uncaughtException handler.
  assert(plans.darwin.runner.cmd === '/bin/bash', 'darwin runs bash')
  assert(plans.linux.runner.cmd === '/bin/sh', 'linux runs sh (POSIX, not a bashism -- Debian /bin/sh is dash)')
  assert(/powershell\.exe$/i.test(plans.win32.runner.cmd), 'win32 runs PowerShell, never bash')
  assert(plans.win32.runner.args[0] === '-NoProfile', 'the PowerShell child skips the user profile')
  // The four invariants that are platform-INDEPENDENT, on all three.
  for (const [platform, plan] of Object.entries(plans)) {
    const c = PLATFORM_CASES[platform]
    const norm = (p) => String(p).split('\\').join('/')
    const dirs = plan.dirs.map(norm)
    const home = norm(c.home)
    assert(dirs.includes(norm(c.dataHome)), `${platform}: DATA_HOME is on the list (the agent itself)`)
    assert(!dirs.some((d) => d === `${home}/.claude`), `${platform}: ~/.claude itself is NEVER on the list`)
    assert(!dirs.some((d) => d.endsWith('.claude.json')), `${platform}: ~/.claude.json is NEVER on the list`)
    assert(!dirs.some((d) => d === `${home}/.claude/projects`), `${platform}: the projects PARENT dir is never on the list`)
    assert(dirs.every((d) => d.startsWith(home)), `${platform}: every target lives under the user home -- nothing system-wide`)
    assert(plan.dirs.length >= 4, `${platform}: all three residue classes are covered (${plan.dirs.length} paths)`)
  }
  // The CLI transcript slug, per platform. Windows munges the drive colon and
  // the backslashes the same way POSIX munges slashes.
  assert(plans.darwin.dirs.includes('/Users/testuser/.claude/projects/-Users-testuser-Documents-Scheherazade'),
    'darwin: our slug only')
  assert(plans.linux.dirs.includes('/home/testuser/.claude/projects/-home-testuser-Documents-Scheherazade'),
    'linux: our slug only')
  assert(plans.win32.dirs.some((d) => d.endsWith('C--Users-testuser-Documents-Scheherazade')),
    'win32: the drive letter and backslashes munge into the same one-segment slug the CLI writes')
  // No mixed separators: a plan built for Windows on a Mac used to come out
  // as C:\Users\t/AppData/Roaming/... -- unrunnable, and the reason nobody
  // could test this lane.
  assert(plans.win32.dirs.every((d) => !d.includes('/')), 'win32 paths are pure backslash even when built from a Mac')
  assert(plans.linux.dirs.every((d) => !d.includes('\\')), 'linux paths are pure forward-slash even when built from Windows')
}

console.log('\n0b. the Linux residue classes the mac list never had')
{
  const dirs = plans.linux.dirs
  assert(dirs.includes('/home/testuser/.config/Scheherazade'), 'Electron userData on linux is ~/.config/Scheherazade')
  assert(dirs.includes('/home/testuser/.cache/Scheherazade'), '...and the cache dir goes too')
  assert(!dirs.some((d) => d.includes('/Library/')), 'no macOS ~/Library paths leak into the linux plan')
  assert(!plans.linux.script.includes('security delete-generic-password'),
    'no `security` (a macOS binary) in the linux script -- the keyring has no portable one-item CLI, and the sealed blobs go with DATA_HOME')
  assert(plans.linux.script.includes('$APPIMAGE'), 'the AppImage itself is unlinked -- it IS the application')
  assert(/if \[ -n "\$APPIMAGE" \] && \[ -f "\$APPIMAGE" \]/.test(plans.linux.script),
    'the unlink is guarded: an unpacked/dev run has no $APPIMAGE and must not rm -f ""')
  // XDG overrides are honored, because a user who moved them expects us to
  // clean where we actually wrote.
  const xdg = buildUninstallPlan('/home/t/d', '/home/t', { platform: 'linux', env: { XDG_CONFIG_HOME: '/home/t/cfg', XDG_CACHE_HOME: '/home/t/cch' }, pid: 1 })
  assert(xdg.dirs.includes('/home/t/cfg/Scheherazade') && xdg.dirs.includes('/home/t/cch/Scheherazade'),
    'XDG_CONFIG_HOME / XDG_CACHE_HOME are honored')
}

console.log('\n0c. the Windows lane: PowerShell, the uninstaller, and no bash')
{
  const plan = plans.win32
  assert(plan.uninstaller === 'C:\\Users\\testuser\\AppData\\Local\\Programs\\Scheherazade\\Uninstall Scheherazade.exe',
    'the NSIS uninstaller is derived from the running exe, not a guessed install root')
  assert(plan.script.includes('Wait-Process -Id 4242'), 'the script waits for THIS process to die before touching anything')
  assert(plan.script.includes('Remove-Item -LiteralPath'), '-LiteralPath: a path with [] is not a wildcard')
  assert(/Test-Path -LiteralPath .* \{ Start-Process/.test(plan.script),
    'the uninstaller is launched only if it is really there -- half a clean uninstall beats a crash')
  assert(!/\bbash\b|rm -rf/.test(plan.script), 'not one POSIX construct survives in the Windows script')
  // A default install path when Electron cannot tell us the exe.
  const noExe = buildUninstallPlan('C:\\d', 'C:\\Users\\t', { platform: 'win32', env: {}, pid: 1 })
  assert(noExe.uninstaller.includes('AppData\\Local\\Programs\\Scheherazade'),
    'no exePath falls back to electron-builder oneClick per-user default, never to nothing')
  // Single quotes in a home path must not break out of the PowerShell string.
  const hostile = buildUninstallPlan("C:\\Users\\o'brien\\d", "C:\\Users\\o'brien", { platform: 'win32', env: {}, pid: 1 })
  assert(hostile.script.includes("'C:\\Users\\o''brien\\d'"), "a single quote is doubled, PowerShell's own escape")
}

console.log('\n0d. the route no longer refuses off-mac')
{
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'settings.cjs'), 'utf8')
  const handler = settingsSrc.slice(settingsSrc.indexOf("pathname === '/api/uninstall'"))
  assert(!/if \(process\.platform !== 'darwin'\)/.test(handler),
    'the darwin-only early return is gone')
  assert(!/sendJson\(res, 501/.test(handler) && !/unsupported_platform/.test(handler),
    'and with it the 501 the danger-zone button turned into an error toast on two platforms')
  assert(/spawn\(plan\.runner\.cmd, plan\.runner\.args/.test(handler),
    'the interpreter comes from the plan, not a hardcoded /bin/bash')
  assert(/reaper\.on\('error'/.test(handler),
    "the reaper spawn still carries an 'error' listener (an unhandled one reaches uncaughtException -> app.exit(1))")
  assert(/plan\.mode === 'bundle-trash'/.test(handler),
    'trashing the .app is gated on the mac plan rather than assumed')
  assert(/confirm !== 'DELETE'/.test(handler), 'the typed-confirm gate is untouched')
}

// Sections 0-0d above run everywhere and are the whole contract. What follows
// needs a real POSIX shell to EXECUTE a generated script against fake residue,
// so it runs on mac and Linux and is skipped (loudly) on Windows -- the
// PowerShell lane's equivalent needs a Windows host and is named in the report
// rather than faked here.
const POSIX_SHELL = process.platform !== 'win32'

console.log('\n1. the mac list: four residue classes in, the protected paths out')
{
  const home = '/Users/testuser'
  const dataHome = '/Users/testuser/Documents/Scheherazade'
  // Explicit platform (P4): the builder used to read process.platform, so this
  // section only tested anything on a Mac. It is a pure function now.
  const { dirs, script } = buildUninstallPlan(dataHome, home, { platform: 'darwin' })
  assert(dirs.includes(dataHome), 'DATA_HOME is on the list (the agent itself)')
  assert(dirs.includes('/Users/testuser/Library/Application Support/Scheherazade'), 'Electron userData is on the list')
  assert(dirs.includes('/Users/testuser/Library/Preferences/com.choam.scheherazade.plist'), 'prefs plist is on the list')
  assert(dirs.includes('/Users/testuser/.claude/projects/-Users-testuser-Documents-Scheherazade'),
    'the CLI transcript slug for OUR workspace is on the list')
  assert(!dirs.includes('/Users/testuser/.claude'), '~/.claude itself is NEVER on the list')
  assert(!dirs.some((d) => d.endsWith('.claude.json')), '~/.claude.json is NEVER on the list (user-shared, merge-only)')
  assert(!dirs.includes('/Users/testuser/.claude/projects'), 'the projects PARENT dir is never on the list, only our slug')
  assert(dirs.every((d) => d.startsWith(home)), 'every target lives under the user home — nothing system-wide')
  assert(script.includes(`kill -0 ${process.pid}`), 'the script waits for THIS process to die before touching anything')
  assert(script.includes('Scheherazade Safe Storage'), 'the Keychain Safe Storage entry is cleaned')
  assert(script.includes("tmux.*-L scheherazade"), 'a leftover attach-lane tmux server is killed')
}

console.log('\n2. quoting: a hostile-looking path cannot escape its rm')
{
  const { script } = buildUninstallPlan("/Users/o'brien/Documents/Scheherazade", "/Users/o'brien", { platform: 'darwin' })
  assert(script.includes(`'/Users/o'\\''brien/Documents/Scheherazade'`), "single quotes in a home path are shell-escaped")
  const rmLines = script.split('\n').filter((l) => l.startsWith('rm -rf '))
  assert(rmLines.length > 0 && rmLines.every((l) => /^rm -rf '/.test(l) && l.endsWith("'")),
    'every rm target is single-quoted end to end')
}

console.log('\n3. the scripts actually clean (functional, fake residue, real shell)')
if (!POSIX_SHELL) {
  console.log('  SKIP functional shell runs -- this host has no POSIX shell; the PowerShell lane needs a Windows host (see the report); NOT a pass')
} else for (const platform of ['darwin', 'linux']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-uninst-'))
  const fakeHome = path.join(tmp, 'home')
  const dataHome = path.join(fakeHome, 'Documents', 'Scheherazade')
  const survivor = path.join(fakeHome, '.claude.json')
  const slugDir = path.join(fakeHome, '.claude', 'projects', dataHome.replaceAll('/', '-'))
  const otherProject = path.join(fakeHome, '.claude', 'projects', '-some-other-project')
  // The per-platform Electron dir, so each run proves ITS OWN residue class
  // gets removed and not just the shared ones.
  const electronDir = platform === 'linux'
    ? path.join(fakeHome, '.config', 'Scheherazade')
    : path.join(fakeHome, 'Library', 'Application Support', 'Scheherazade')
  for (const d of [dataHome, slugDir, otherProject, electronDir]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'x'), 'residue')
  }
  fs.writeFileSync(survivor, '{}')
  // A fake AppImage: the linux plan's last act unlinks $APPIMAGE, and this
  // proves the guard fires on a real file rather than only parsing.
  const fakeAppImage = path.join(tmp, 'Scheherazade.AppImage')
  fs.writeFileSync(fakeAppImage, 'ELF')

  // A short-lived watched process stands in for the app; strip the
  // security/pkill lines (they touch the REAL keychain/process table).
  const watched = spawn('/bin/sleep', ['0.5'])
  const plan = buildUninstallPlan(dataHome, fakeHome, { platform, env: {}, pid: watched.pid })
  const testScript = plan.script
    .split('\n').filter((l) => !l.startsWith('security') && !l.startsWith('pkill')).join('\n')
  const runner = spawn(plan.runner.cmd, [plan.runner.args[0], testScript], { env: { ...process.env, APPIMAGE: fakeAppImage } })
  await new Promise((resolve) => runner.on('exit', resolve))
  assert(!fs.existsSync(dataHome), `${platform}: DATA_HOME is gone`)
  assert(!fs.existsSync(slugDir), `${platform}: our transcript slug is gone`)
  assert(!fs.existsSync(electronDir), `${platform}: the Electron per-app dir is gone`)
  assert(fs.existsSync(survivor), `${platform}: ~/.claude.json SURVIVES`)
  assert(fs.existsSync(otherProject), `${platform}: another project's transcripts SURVIVE`)
  assert(fs.existsSync(fakeAppImage) === (platform !== 'linux'),
    platform === 'linux' ? 'linux: $APPIMAGE is unlinked' : 'darwin: nothing touches $APPIMAGE')
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n4. wiring pins')
{
  const src = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'settings.cjs'), 'utf8')
  assert(src.includes("confirm !== 'DELETE'"), 'the route refuses without the typed-confirm literal')
  assert(src.includes("pathname === '/api/uninstall'") && src.includes("method: 'POST'"),
    'uninstall is a POST (rides the X-Onboard-Token gate)')
  assert(src.includes('detached: true'), 'cleanup runs detached from the dying app')
  const page = fs.readFileSync(path.join(ROOT, 'onboarding', 'public', 'js', 'settings.js'), 'utf8')
  assert(page.includes('confirmDialog') && page.includes("confirm: 'DELETE'"),
    'the page gates the call behind its own dialog before sending the literal')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
