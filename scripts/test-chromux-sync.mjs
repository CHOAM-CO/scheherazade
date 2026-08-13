// test-chromux-sync.mjs — vendored chromux sync (harness-render
// syncChromuxPortable, v0.1.10).
//
// Pins the contract:
//   1. vendor/chromux syncs into DATA_HOME/bin/chromux with its VERSION stamp.
//   2. version-match short-circuit: a second run does NOT re-copy (user-local
//      state inside the dir survives), but wrappers are rewritten every boot.
//   3. wrappers exist on both shapes (chromux.cmd CRLF for Windows, chromux
//      sh exec line, executable bit) and point at the synced chromux.mjs.
//   4. chromux's bundled skills (chromux, chromux-work) seed recursively
//      (SKILL.md + topics/) into CONFIG_DIR/.claude/skills, copy-if-missing:
//      a user-edited SKILL.md survives a re-run.
//   5. missing vendor dir -> returns false, no throw, nothing created.

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-chromux-sync-'))

try {
  const configDir = path.join(tmpRoot, 'config')
  const dataHome = path.join(tmpRoot, 'data')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(dataHome, { recursive: true })
  const harness = createHarnessRender({
    log: () => {}, REPO_ROOT, CONFIG_DIR: configDir,
    DATA_HOME: dataHome, AGENT_NAME: 'test',
  })

  // --- fresh sync -------------------------------------------------------
  console.log('fresh sync')
  const ret = harness.syncChromuxPortable()
  check(ret === true, 'sync returns true with vendor present')
  const dst = path.join(dataHome, 'bin', 'chromux-portable')
  check(fs.existsSync(path.join(dst, 'chromux.mjs')), 'chromux.mjs lands in DATA_HOME/bin/chromux-portable')
  const vendorVersion = fs.readFileSync(path.join(REPO_ROOT, 'vendor', 'chromux', 'VERSION'), 'utf8').trim()
  const dstVersion = fs.readFileSync(path.join(dst, 'VERSION'), 'utf8').trim()
  check(dstVersion === vendorVersion, `VERSION stamp carried (${dstVersion})`)
  check(!fs.existsSync(`${dst}.tmp`), 'no stray .tmp dir left behind')

  // --- wrappers ---------------------------------------------------------
  console.log('wrappers')
  const cmdPath = path.join(dataHome, 'bin', 'chromux.cmd')
  const shPath = path.join(dataHome, 'bin', 'chromux')
  check(fs.existsSync(cmdPath), 'chromux.cmd exists')
  const cmdText = fs.readFileSync(cmdPath, 'utf8')
  check(cmdText.includes(path.join(dst, 'chromux.mjs')), 'chromux.cmd points at the synced entry')
  check(cmdText.includes('\r\n'), 'chromux.cmd uses CRLF (cmd.exe chokes on bare LF labels/continuations)')
  check(fs.existsSync(shPath) && fs.statSync(shPath).isFile(), 'sh wrapper exists')
  const shText = fs.readFileSync(shPath, 'utf8')
  check(shText.startsWith('#!/bin/sh') && shText.includes(path.join(dst, 'chromux.mjs')), 'sh wrapper execs the synced entry')
  if (process.platform !== 'win32') {
    check((fs.statSync(shPath).mode & 0o111) !== 0, 'sh wrapper is executable')
  }

  // --- bundled skills ---------------------------------------------------
  console.log('bundled skills')
  const skillsDir = path.join(configDir, '.claude', 'skills')
  for (const name of ['chromux', 'chromux-work']) {
    check(fs.existsSync(path.join(skillsDir, name, 'SKILL.md')), `${name}/SKILL.md seeded`)
  }
  check(fs.existsSync(path.join(skillsDir, 'chromux', 'topics')), 'chromux skill topics/ copied recursively')

  // --- idempotence + user-edit survival ---------------------------------
  console.log('re-run')
  const sentinel = path.join(dst, 'sentinel-user-state.txt')
  fs.writeFileSync(sentinel, 'survives')
  const editedSkill = path.join(skillsDir, 'chromux', 'SKILL.md')
  fs.writeFileSync(editedSkill, 'user edited')
  harness.syncChromuxPortable()
  check(fs.existsSync(sentinel), 'version-match short-circuit: synced dir not re-copied')
  check(fs.readFileSync(editedSkill, 'utf8') === 'user edited', 'user-edited skill survives re-run')
  check(fs.existsSync(cmdPath), 'wrappers still present after re-run')

  // --- missing vendor ---------------------------------------------------
  console.log('missing vendor')
  const emptyRepo = path.join(tmpRoot, 'empty-repo')
  fs.mkdirSync(emptyRepo, { recursive: true })
  const bare = createHarnessRender({
    log: () => {}, REPO_ROOT: emptyRepo, CONFIG_DIR: path.join(tmpRoot, 'config2'),
    DATA_HOME: path.join(tmpRoot, 'data2'), AGENT_NAME: 'test',
  })
  check(bare.syncChromuxPortable() === false, 'missing vendor returns false, no throw')
  check(!fs.existsSync(path.join(tmpRoot, 'data2', 'bin')), 'nothing created without vendor')
} catch (err) {
  fail(`unexpected throw: ${err.stack || err.message}`)
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${ok} passed, ${bad} failed`)
if (bad > 0) process.exit(1)
