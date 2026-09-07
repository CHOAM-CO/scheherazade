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
// design-0023 P1: linux was never a row here -- it fell into "not darwin",
// which on a Linux box meant the file asserted two source-text pins and
// exited. The route decides at CALL time (process.platform inside the
// handler), so the linux row can be driven from any host by overriding
// process.platform around one call. Both sections below pin CURRENT behavior;
// P4/R6 changes it, and these are what will notice.
console.log('\n0. linux row: the in-app uninstall REFUSES through the real route')
{
  const sent = []
  const routes = createRoutes({
    sendJson: (res, code, body) => { sent.push({ code, body }) },
    readJsonBody: async () => ({ confirm: 'DELETE' }), // past the fat-finger gate
    writeAgentConfig: () => ({}),
    DATA_HOME: '/home/testuser/Documents/Scheherazade',
    getElectron: () => { throw new Error('no Electron in a test') },
  })
  const route = routes.find((r) => r.method === 'POST' && r.match('/api/uninstall'))
  assert(Boolean(route), 'the uninstall route is registered')
  const realPlatform = process.platform
  let overridden = false
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    overridden = process.platform === 'linux'
    // The handler is called ONLY once the override is confirmed. On darwin its
    // very next move is a DETACHED /bin/bash reaper that rm -rf's this
    // machine's real residue paths and deletes the Keychain entry. A test in
    // the default gate must not be one failed defineProperty away from running
    // a real uninstall -- so a failed override skips the section, loudly.
    if (overridden) await route.handler({}, {}, {})
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  }
  if (!overridden) {
    console.log('  SKIP linux route row -- process.platform is not overridable on this runtime; the handler is NOT called on a real host; NOT a pass')
  } else {
    assert(sent.length === 1, 'the handler answers exactly once')
    assert(sent[0] && sent[0].code === 501, 'linux: 501, not a half-run cleanup (the mac plan is ~/Library + security + pkill top to bottom)')
    assert(sent[0] && sent[0].body && sent[0].body.reason === 'unsupported_platform',
      "linux: the refusal carries reason 'unsupported_platform' (the UI switches on it)")
    // CURRENT, and wrong for a Linux user: the message names only the Windows
    // remedy, and settings.js renders the danger-zone button on every platform,
    // so a Linux user gets this text as an error toast (read-C G9).
    assert(sent[0] && /Windows/i.test(sent[0].body.error) && !/Linux/i.test(sent[0].body.error),
      'CURRENT: the 501 message names only the Windows NSIS path -- nothing for Linux (design-0023 P4/R6)')
  }
  assert(process.platform === realPlatform, 'process.platform is restored for the rest of the file')
}

console.log('\n0b. linux row: buildUninstallPlan has no Linux form yet')
{
  // Separator-agnostic: path.join returns backslashes on Windows, which is the
  // 2026-08-04 lesson this file's header records.
  const norm = (p) => String(p).split('\\').join('/')
  const home = '/home/testuser'
  const dataHome = '/home/testuser/Documents/Scheherazade'
  const dirs = buildUninstallPlan(dataHome, home).dirs.map(norm)
  assert(dirs.includes(dataHome), 'DATA_HOME is on the list for a linux home too (the agent itself)')
  assert(dirs.includes('/home/testuser/.claude/projects/-home-testuser-Documents-Scheherazade'),
    'the CLI transcript slug for OUR workspace is on the list on any platform')
  assert(!dirs.includes('/home/testuser/.claude'), '~/.claude itself is NEVER on the list, on any platform')
  assert(!dirs.some((d) => d.endsWith('.claude.json')), '~/.claude.json is NEVER on the list, on any platform')
  assert(dirs.every((d) => d.startsWith(home)), 'every target lives under the user home -- nothing system-wide')
  // The gap, pinned as data rather than left implied.
  assert(dirs.some((d) => d.includes('/Library/')),
    'CURRENT: the residue list is macOS-shaped (~/Library/...) even for a linux home')
  assert(!dirs.some((d) => d.includes('/.config/Scheherazade')),
    'CURRENT: no ~/.config/Scheherazade (Electron userData on linux) on the list -- P4/R6 adds it')
  assert(!buildUninstallPlan(dataHome, home).script.includes('APPIMAGE'),
    'CURRENT: nothing removes the AppImage itself ($APPIMAGE) -- P4/R6 adds it')
}

// darwin only from here down. buildUninstallPlan emits macOS residue classes (~/Library/...,
// a .plist, `security delete-generic-password`) and this file asserts them as
// literal POSIX paths; path.join inside the builder returns backslashes on
// Windows, so every includes() missed (2026-08-04 win suite). The Windows
// uninstall path is the NSIS uninstaller, and the route now refuses with 501
// there -- which is what gets asserted below instead, so this file still
// tests something real on Windows rather than being skipped whole.
if (process.platform !== 'darwin') {
  console.log('\n1. non-darwin: the in-app uninstall must REFUSE, not half-run')
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'settings.cjs'), 'utf8')
  assert(/process\.platform !== 'darwin'/.test(settingsSrc) && /unsupported_platform/.test(settingsSrc),
    'the /api/uninstall handler refuses on non-darwin')
  assert(/reaper\.on\('error'/.test(settingsSrc),
    "the reaper spawn carries an 'error' listener (an unhandled one reaches uncaughtException -> app.exit(1))")
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

console.log('\n1. the list: four residue classes in, the protected paths out')
{
  const home = '/Users/testuser'
  const dataHome = '/Users/testuser/Documents/Scheherazade'
  const { dirs, script } = buildUninstallPlan(dataHome, home)
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
  const { script } = buildUninstallPlan("/Users/o'brien/Documents/Scheherazade", "/Users/o'brien")
  assert(script.includes(`'/Users/o'\\''brien/Documents/Scheherazade'`), "single quotes in a home path are shell-escaped")
  const rmLines = script.split('\n').filter((l) => l.startsWith('rm -rf '))
  assert(rmLines.length > 0 && rmLines.every((l) => /^rm -rf '/.test(l) && l.endsWith("'")),
    'every rm target is single-quoted end to end')
}

console.log('\n3. the script actually cleans (functional, fake residue, real bash)')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-uninst-'))
  const fakeHome = path.join(tmp, 'home')
  const dataHome = path.join(fakeHome, 'Documents', 'Scheherazade')
  const survivor = path.join(fakeHome, '.claude.json')
  const slugDir = path.join(fakeHome, '.claude', 'projects', dataHome.replaceAll('/', '-'))
  const otherProject = path.join(fakeHome, '.claude', 'projects', '-some-other-project')
  for (const d of [dataHome, slugDir, otherProject, path.join(fakeHome, 'Library', 'Application Support', 'Scheherazade')]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'x'), 'residue')
  }
  fs.writeFileSync(survivor, '{}')

  // A short-lived watched process stands in for the app; strip the
  // security/pkill lines (they touch the REAL keychain/process table).
  const watched = spawn('/bin/sleep', ['0.5'])
  const { script } = buildUninstallPlan(dataHome, fakeHome)
  const testScript = script
    .replace(`kill -0 ${process.pid}`, `kill -0 ${watched.pid}`)
    .split('\n').filter((l) => !l.startsWith('security') && !l.startsWith('pkill')).join('\n')
  const runner = spawn('/bin/bash', ['-c', testScript])
  await new Promise((resolve) => runner.on('exit', resolve))
  assert(!fs.existsSync(dataHome), 'DATA_HOME is gone')
  assert(!fs.existsSync(slugDir), 'our transcript slug is gone')
  assert(fs.existsSync(survivor), '~/.claude.json SURVIVES')
  assert(fs.existsSync(otherProject), "another project's transcripts SURVIVE")
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
