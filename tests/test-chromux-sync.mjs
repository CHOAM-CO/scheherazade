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
  check(fs.existsSync(path.join(dst, 'extension', 'manifest.json')), 'live-mode extension lands in DATA_HOME/bin/chromux-portable/extension')
  const vendorVersion = fs.readFileSync(path.join(REPO_ROOT, 'vendor', 'chromux', 'VERSION'), 'utf8').trim()
  const dstVersion = fs.readFileSync(path.join(dst, 'VERSION'), 'utf8').trim()
  check(dstVersion === vendorVersion, `VERSION stamp carried (${dstVersion})`)
  check(!fs.existsSync(`${dst}.tmp`), 'no stray .tmp dir left behind')

  // --- same VERSION, extension missing (an install from before the extension was vendored) --
  console.log('same-version re-sync when extension is missing')
  fs.rmSync(path.join(dst, 'extension'), { recursive: true, force: true })
  harness.syncChromuxPortable()
  check(fs.existsSync(path.join(dst, 'extension', 'manifest.json')), 'extension restored without a VERSION bump')

  // --- wrappers ---------------------------------------------------------
  console.log('wrappers')
  // design-0023 P4: ONE wrapper is written, the platform's own. A mac install
  // used to get a dead .cmd and a Windows install a sh wrapper it cannot
  // execute -- and the agent reads wrapper presence as tool availability.
  const cmdPath = path.join(dataHome, 'bin', 'chromux.cmd')
  const shPath = path.join(dataHome, 'bin', 'chromux')
  const nativePath = process.platform === 'win32' ? cmdPath : shPath
  const foreignPath = process.platform === 'win32' ? shPath : cmdPath
  check(fs.existsSync(nativePath) && fs.statSync(nativePath).isFile(), 'the platform\'s own wrapper exists')
  check(!fs.existsSync(foreignPath), 'the other platform\'s wrapper is NOT written')
  const nativeText = fs.readFileSync(nativePath, 'utf8')
  check(nativeText.includes(path.join(dst, 'chromux.mjs')), 'the wrapper points at the synced entry')
  if (process.platform !== 'win32') {
    check(nativeText.startsWith('#!/bin/sh'), 'sh wrapper execs through /bin/sh')
    check((fs.statSync(shPath).mode & 0o111) !== 0, 'sh wrapper is executable')
  } else {
    check(nativeText.includes('\r\n'), 'chromux.cmd uses CRLF (cmd.exe chokes on bare LF labels/continuations)')
  }
  // Both shapes, from any host: the writer takes the capability table.
  {
    const caps = require(path.join(REPO_ROOT, 'onboarding', 'platform.cjs'))
    const probe = path.join(dataHome, 'launcher-probe')
    for (const platform of ['win32', 'linux']) {
      const hr = createHarnessRender({
        log: () => {}, REPO_ROOT, CONFIG_DIR: configDir, DATA_HOME: dataHome, AGENT_NAME: 'test',
        HOST: caps.capabilities({ platform, arch: 'x64', env: {}, home: '/h', dataHome: '/h/d', existsSync: () => false, hasTmux: () => false }),
      })
      const written = hr.writeLauncher(probe, 'x', '/e/x.mjs', ['--data-home', '/d h'])
      check(written.endsWith(platform === 'win32' ? 'x.cmd' : 'x'), `${platform}: writes ${platform === 'win32' ? 'a .cmd' : 'an extension-less sh wrapper'}`)
      const t = fs.readFileSync(written, 'utf8')
      check(t.includes('--data-home "/d h"'), `${platform}: baked args keep a bare flag and a quoted value`)
      check(t.includes(platform === 'win32' ? '%*' : '"$@"'), `${platform}: the user's argv is forwarded in that shell's spelling`)
      check(t.indexOf('--data-home') < t.indexOf(platform === 'win32' ? '%*' : '"$@"'),
        `${platform}: baked args come BEFORE the user's argv (the two old copies disagreed)`)
      fs.rmSync(written, { force: true })
    }
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
  check(fs.existsSync(nativePath), "the platform's wrapper is still present after re-run")

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
