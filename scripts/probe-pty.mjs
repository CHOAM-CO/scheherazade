#!/usr/bin/env node
// probe-pty.mjs -- can THIS runtime spawn a working pty via node-pty?
//
// The dual-ABI question (docs/supervisor-design.md, Runtime/ABI section):
// node-pty is a native module, so "it works" is a per-runtime fact, not a
// per-repo fact. This probe is run under BOTH runtimes to convert the
// design's highest-risk UNVERIFIED assumption into receipts:
//   dev lane:      node scripts/probe-pty.mjs
//   packaged lane: ELECTRON_RUN_AS_NODE=1 <built .app's Electron binary> \
//                    <unpacked>/scripts/probe-pty.mjs
// (On Windows later: same two lanes, cmd /c echo instead of /bin/echo.)
//
// PASS = a real pty child echoed our marker back through the pty AND exited.
// Anything else = FAIL with the reason on stdout. Exit code is the verdict.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const MARKER = `pty-probe-${process.pid}`
const isWin = process.platform === 'win32'

let pty
try {
  pty = require('node-pty')
} catch (err) {
  console.log(`FAIL: node-pty did not load under this runtime (${process.version}, electron=${process.versions.electron || 'no'}): ${err.message}`)
  process.exit(1)
}

const shell = isWin ? 'cmd.exe' : '/bin/echo'
const args = isWin ? ['/c', 'echo', MARKER] : [MARKER]

let out = ''
let exited = false
const child = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24 })

child.onData((d) => { out += d })
child.onExit(({ exitCode }) => {
  exited = true
  const echoed = out.includes(MARKER)
  if (echoed && exitCode === 0) {
    console.log(`PASS: pty child echoed marker and exited 0 (runtime ${process.version}, electron=${process.versions.electron || 'no'}, abi=${process.versions.modules})`)
    process.exit(0)
  }
  console.log(`FAIL: exitCode=${exitCode} markerEchoed=${echoed} rawLen=${out.length}`)
  process.exit(1)
})

setTimeout(() => {
  if (!exited) {
    console.log(`FAIL: pty child did not exit within 10s (markerEchoed=${out.includes(MARKER)})`)
    try { child.kill() } catch {}
    process.exit(1)
  }
}, 10_000)
