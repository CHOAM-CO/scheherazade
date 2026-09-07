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
