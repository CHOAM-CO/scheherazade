#!/usr/bin/env node
// test-hook-lane-path.mjs -- the v0.0.21 fix for the hook-dead bash lane,
// attacked at two levels. Context (live receipt, Mino 07-16 18:01 log paste
// via the /logs viewer): v0.0.15's ensureNodeShim lived only in the NODE
// supervisor lane; production spawns the BASH lane (run.sh), so packaged
// installs ran every Claude Code hook into `/bin/sh: node: command not
// found` -- stop-reply-guard included, which is why a promised Discord
// reply could die as terminal text with nothing bouncing it back.
//
// The promises:
//   1. END-TO-END: with a node-less PATH (verified by negative control),
//      appending the shim dir makes `/bin/sh -c "node ..."` actually run --
//      the exact resolution path Claude Code hooks use.
//   2. WIRING TRIPWIRE: main.cjs patches supervisorEnv.PATH through
//      ensureNodeShim at the SHARED env layer (both lanes). If someone
//      un-hoists it back into one lane, this fails by name.
//
// Run: node scripts/test-hook-lane-path.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ensureNodeShim } = await import(pathToFileURL(path.join(ROOT, 'supervisor.mjs')).href)

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── 1. end-to-end: /bin/sh resolves node via the shim dir ──────────────────
console.log('hook-lane resolution:')
const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-hooklane-'))
const BARE_PATH = '/usr/bin:/bin'

// Negative control FIRST: if the bare PATH already has node, every later
// assertion is vacuous -- skip loudly rather than pass falsely.
const control = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: BARE_PATH } })
if (control.status === 0) {
  console.log(`  SKIP end-to-end: ${BARE_PATH} already resolves node on this machine (${String(control.stdout).trim()}) -- control invalid`)
} else {
  check('negative control: bare PATH has no node', control.status !== 0)
  const patched = ensureNodeShim({ mem }, { env: { PATH: BARE_PATH } })
  check('shim dir appended, base preserved', patched.startsWith(BARE_PATH) && patched.includes(path.join(mem, 'bin')), patched)
  const hookScript = path.join(mem, 'fake-hook.mjs')
  fs.writeFileSync(hookScript, 'console.log("hook-ran:" + (7 * 6))\n')
  // ensureNodeShim writes bin/node (sh) on POSIX and bin/node.cmd on Windows --
  // see its IS_WIN branch. This file assumed the POSIX name and shape, so on
  // the win box it died on ENOENT reading bin/node before asserting anything
  // (2026-08-04 win suite). Both lanes are checked on their own terms now.
  if (process.platform === 'win32') {
    const run = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', `node "${hookScript}"`],
      { env: { ...process.env, PATH: patched, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' }, timeout: 15000 })
    check('cmd /c "node hook.mjs" runs via shim', run.status === 0 && String(run.stdout).includes('hook-ran:42'),
      `status=${run.status} stdout=${String(run.stdout).trim()} stderr=${String(run.stderr).trim().slice(0, 200)}`)
    const shimBody = fs.readFileSync(path.join(mem, 'bin', 'node.cmd'), 'utf8')
    check('shim sets ELECTRON_RUN_AS_NODE for the app lane', shimBody.includes('ELECTRON_RUN_AS_NODE=1'))
  } else {
    // The EXACT shape Claude Code uses for hook commands: /bin/sh -c "node <script>"
    const run = spawnSync('/bin/sh', ['-c', `node "${hookScript}"`], { env: { PATH: patched }, timeout: 15000 })
    check('sh -c "node hook.mjs" runs via shim', run.status === 0 && String(run.stdout).includes('hook-ran:42'),
      `status=${run.status} stdout=${String(run.stdout).trim()} stderr=${String(run.stderr).trim().slice(0, 200)}`)
    const shimBody = fs.readFileSync(path.join(mem, 'bin', 'node'), 'utf8')
    check('shim sets ELECTRON_RUN_AS_NODE for the app lane', shimBody.includes('ELECTRON_RUN_AS_NODE=1'))
  }
}

// ── 2. wiring tripwire: the patch lives at the SHARED env layer ────────────
console.log('main.cjs wiring:')
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
check('supervisorEnv.PATH patched via ensureNodeShim', /supervisorEnv\.PATH\s*=\s*ensureNodeShim\(/.test(mainSrc))
check('shim fed the child env, not bare process.env', /ensureNodeShim\(\{ mem: DATA_HOME \}, \{ env: supervisorEnv/.test(mainSrc))
check('failure branch stays loud + nonfatal', mainSrc.includes('node shim setup failed at the shared env layer'))

fs.rmSync(mem, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
