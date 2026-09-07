// test-agent-tools-sync.mjs — first-party agent helpers sync (harness-render
// syncAgentTools, v0.1.18 같이보기).
//
// Pins the contract:
//   1. onboarding/agent-tools syncs into DATA_HOME/bin/agent-tools every boot
//      (no VERSION gate — unconditional re-copy, tmp+rename, no stray .tmp).
//   2. wrappers exist on both shapes (windowshot.cmd CRLF, windowshot sh exec
//      line, executable bit), point at the synced windowshot.cjs, and bake
//      --data-home with the actual DATA_HOME (the skill cannot know it).
//   3. every-boot refresh: a modified synced copy is overwritten on re-run
//      (first-party tree, unlike chromux's version-gated short-circuit).
//   4. missing source dir -> returns false, no throw, nothing created.
//   5. the windowshot skill template exists and is hash-pinned (seeding
//      itself is covered by test-skill-seeding).
//   6. design-0023 P4: windowshot is a CAPABILITY, not a given -- an OS
//      built-in on mac and Windows, a probe over installed tools on Linux.
//      The wrapper (which the agent reads as "this tool is available") and the
//      skill (which tells it to reach for the tool) are decided by the SAME
//      capability row, driven for all three platforms from this Mac. They
//      disagreeing is the failure this pins: a promise on PATH with no skill,
//      or a skill naming a command that is not there.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createHarnessRender } = require(path.join(REPO_ROOT, 'onboarding', 'harness-render.cjs'))

let ok = 0, bad = 0
const pass = (m) => { ok++; console.log(`  ok: ${m}`) }
const fail = (m) => { bad++; console.log(`  FAIL: ${m}`) }
const check = (cond, m) => (cond ? pass(m) : fail(m))

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-agent-tools-sync-'))

try {
  const configDir = path.join(tmpRoot, 'config')
  const dataHome = path.join(tmpRoot, 'data')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(dataHome, { recursive: true })
  const harness = createHarnessRender({
    log: () => {}, REPO_ROOT, CONFIG_DIR: configDir,
    DATA_HOME: dataHome, AGENT_NAME: 'test',
  })

  console.log('fresh sync')
  const ret = harness.syncAgentTools()
  check(ret === true, 'sync returns true with source present')
  const dst = path.join(dataHome, 'bin', 'agent-tools')
  const entry = path.join(dst, 'windowshot.cjs')
  check(fs.existsSync(entry), 'windowshot.cjs lands in DATA_HOME/bin/agent-tools')
  check(!fs.existsSync(`${dst}.tmp`), 'no stray .tmp dir left behind')

  console.log('wrappers')
  // design-0023 P4: one wrapper, the platform's own (see test-chromux-sync
  // for the writer driven across all three platforms from any host).
  const cmdPath = path.join(dataHome, 'bin', 'windowshot.cmd')
  const shPath = path.join(dataHome, 'bin', 'windowshot')
  const nativePath = process.platform === 'win32' ? cmdPath : shPath
  const foreignPath = process.platform === 'win32' ? shPath : cmdPath
  check(fs.existsSync(nativePath), "the platform's own wrapper exists")
  check(!fs.existsSync(foreignPath), "the other platform's wrapper is NOT written")
  const nativeText = fs.readFileSync(nativePath, 'utf8')
  check(nativeText.includes(entry), 'the wrapper points at the synced entry')
  check(nativeText.includes(`--data-home "${dataHome}"`), 'the wrapper bakes --data-home')
  if (process.platform === 'win32') {
    check(nativeText.includes('\r\n'), 'windowshot.cmd uses CRLF')
  } else {
    // The exec bit is meaningless on Windows (test-chromux-sync guarded this
    // check; this file did not, and would have been red on a Windows run).
    check((fs.statSync(shPath).mode & 0o111) !== 0, 'sh wrapper is executable')
  }

  console.log('every-boot refresh')
  fs.writeFileSync(entry, '// user-local mutation that must NOT survive\n')
  harness.syncAgentTools()
  const refreshed = fs.readFileSync(entry, 'utf8')
  check(!refreshed.startsWith('// user-local mutation'), 'modified synced copy is overwritten on re-run (first-party tree, no version gate)')

  console.log('missing source')
  const harness2 = createHarnessRender({
    log: () => {}, REPO_ROOT: path.join(tmpRoot, 'nowhere'), CONFIG_DIR: configDir,
    DATA_HOME: path.join(tmpRoot, 'data2'), AGENT_NAME: 'test',
  })
  const ret2 = harness2.syncAgentTools()
  check(ret2 === false, 'missing source returns false, no throw')
  check(!fs.existsSync(path.join(tmpRoot, 'data2', 'bin', 'agent-tools')), 'nothing created without source')

  // --- the three-platform matrix, from this Mac -------------------------
  console.log('platform matrix: wrapper and skill decided by one row')
  const caps = require(path.join(REPO_ROOT, 'onboarding', 'platform.cjs'))
  const mkHost = (platform, arch) => caps.capabilities({
    platform, arch, env: {},
    home: platform === 'win32' ? 'C:\\Users\\t' : '/home/t',
    dataHome: platform === 'win32' ? 'C:\\Users\\t\\Documents\\Scheherazade' : '/home/t/Documents/Scheherazade',
    existsSync: () => false,
    accessSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    hasTmux: () => false,
  })
  // Spelled out, not derived: mac (osascript + screencapture) and Windows
  // (PrintWindow) capture with OS built-ins, so the platform alone settles
  // it. The Linux row is a probe over wmctrl/xdotool + import, and this host
  // resolves no binary at all (accessSync throws for every candidate), which
  // is the stock-desktop answer -- the installed-tools case is the block
  // below.
  for (const [platform, arch, capable] of [['darwin', 'arm64', true], ['win32', 'x64', true], ['linux', 'x64', false]]) {
    const home = path.join(tmpRoot, `matrix-${platform}`)
    const cfg = path.join(home, 'config')
    const h = createHarnessRender({
      log: () => {}, REPO_ROOT, CONFIG_DIR: cfg, DATA_HOME: home, AGENT_NAME: 'test',
      HOST: mkHost(platform, arch),
    })
    check(h.syncAgentTools() === true, `${platform}: sync returns true`)
    check(fs.existsSync(path.join(home, 'bin', 'agent-tools', 'windowshot.cjs')),
      `${platform}: the helper TREE still lands (a portable helper added later must not be gated on this row)`)
    const cmd = fs.existsSync(path.join(home, 'bin', 'windowshot.cmd'))
    const sh = fs.existsSync(path.join(home, 'bin', 'windowshot'))
    check((platform === 'win32' ? cmd : sh) === capable,
      `${platform}: the wrapper is ${capable ? 'written' : 'NOT written'} (window capture ${capable ? 'exists' : 'does not exist'} here)`)
    check((platform === 'win32' ? sh : cmd) === false,
      `${platform}: the other platform's wrapper shape is never written`)
    h.seedSkillDefinitions()
    const skill = fs.existsSync(path.join(cfg, '.claude', 'skills', 'windowshot', 'SKILL.md'))
    check(skill === capable, `${platform}: the windowshot skill is ${capable ? 'seeded' : 'withheld'}`)
    check(skill === (platform === 'win32' ? cmd : sh),
      `${platform}: skill and wrapper agree -- neither a tool with no instructions nor instructions with no tool`)
  }

  // Linux is the row that is a PROBE, not a constant: wmctrl/xdotool +
  // import are ordinary packages, so the same box answers differently before
  // and after an apt install. Injected permissively here (every candidate
  // resolves) so this stays true whatever the probe's exact term list is --
  // the contract under test is that the wrapper and the skill both follow it.
  {
    const home = path.join(tmpRoot, 'matrix-linux-capable')
    const cfg = path.join(home, 'config')
    const h = createHarnessRender({
      log: () => {}, REPO_ROOT, CONFIG_DIR: cfg, DATA_HOME: home, AGENT_NAME: 'test',
      HOST: caps.capabilities({
        platform: 'linux', arch: 'x64', env: {}, home: '/home/t', dataHome: '/home/t/d',
        existsSync: () => true, accessSync: () => {}, hasTmux: () => false,
      }),
    })
    h.syncAgentTools()
    h.seedSkillDefinitions()
    check(fs.existsSync(path.join(home, 'bin', 'windowshot')),
      'linux with the capture tools installed: the wrapper IS written')
    check(fs.existsSync(path.join(cfg, '.claude', 'skills', 'windowshot', 'SKILL.md')),
      'linux with the capture tools installed: the skill IS seeded (one row, both artifacts)')
    // ...and the upgrade direction: the box that had one from an older build
    // (or before the user removed xdotool) must not keep it.
    const noCapture = createHarnessRender({
      log: () => {}, REPO_ROOT, CONFIG_DIR: cfg, DATA_HOME: home, AGENT_NAME: 'test',
      HOST: mkHost('linux', 'x64'),
    })
    fs.writeFileSync(path.join(home, 'bin', 'windowshot.cmd'), 'from an older build\r\n')
    noCapture.syncAgentTools()
    check(!fs.existsSync(path.join(home, 'bin', 'windowshot')) && !fs.existsSync(path.join(home, 'bin', 'windowshot.cmd')),
      'capture row off: BOTH stale wrapper shapes are removed, not just left unwritten')
  }

  console.log('skill template')
  check(fs.existsSync(path.join(REPO_ROOT, 'onboarding', 'templates', 'skills', 'windowshot', 'SKILL.md')), 'windowshot SKILL.md template exists')
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'onboarding', 'templates', 'skill-hashes.json'), 'utf8'))
  const pinned = JSON.stringify(manifest).includes('windowshot')
  check(pinned, 'windowshot skill is pinned in skill-hashes.json (regen tools/gen-skill-hashes.mjs if this fails)')
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${ok} passed, ${bad} failed`)
process.exit(bad ? 1 : 0)
