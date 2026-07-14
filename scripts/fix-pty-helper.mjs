#!/usr/bin/env node
// fix-pty-helper.mjs -- npm postinstall: repair node-pty's two upstream
// defects that both end in "posix_spawnp failed". Both were found by
// EXECUTING the ABI probe (scripts/probe-pty.mjs), not by reading.
//
// Defect 1 -- exec bit: node-pty 1.1.0's PUBLISHED npm tarball ships
// prebuilds/darwin-*/spawn-helper as 0644 (verified against the registry
// tarball directly, 2026-07-14: `tar -tvzf $(npm view node-pty@1.1.0
// dist.tarball)` -> -rw-r--r--). A non-executable helper cannot be spawned.
//
// Defect 2 -- helperPath double-replace: lib/unixTerminal.js does
//   helperPath.replace('app.asar', 'app.asar.unpacked')
// which, when node-pty is require()d from a path ALREADY inside
// app.asar.unpacked (exactly what our plain-node children do -- channel.mjs
// and the supervisor run from the unpacked tree, not from inside Electron),
// corrupts the path to "app.asar.unpacked.unpacked" -> ENOENT ->
// posix_spawnp failed. Verified minimal repro:
//   '/x/app.asar.unpacked/y'.replace('app.asar','app.asar.unpacked')
//     === '/x/app.asar.unpacked.unpacked/y'
// The patch makes both replaces conditional (skip when the path is already
// unpacked). Idempotent: patched lines are recognized and skipped.
//
// Exit 0 always: npm runs this on every install, and the HARD gate for the
// shipped artifact lives in test-packaging.mjs. This script prints what it
// did so a silent no-op and a fix are distinguishable in install logs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  console.log('[fix-pty-helper] win32: no spawn-helper on this platform, nothing to do')
  process.exit(0)
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const prebuilds = path.join(repoRoot, 'node_modules', 'node-pty', 'prebuilds')

let touched = 0
let already = 0
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper')
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode
    if (mode & 0o111) { already++; continue }
    fs.chmodSync(helper, 0o755)
    touched++
    console.log(`[fix-pty-helper] exec bit restored: ${path.relative(repoRoot, helper)}`)
  }
} catch (err) {
  console.log(`[fix-pty-helper] WARN: could not scan ${prebuilds}: ${err.message} (packaging test is the hard gate)`)
  process.exit(0)
}

// ── defect 2: the helperPath double-replace in lib/unixTerminal.js ──────────
const unixTerminal = path.join(repoRoot, 'node_modules', 'node-pty', 'lib', 'unixTerminal.js')
try {
  let src = fs.readFileSync(unixTerminal, 'utf8')
  const patches = [
    ["helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
     "if (!helperPath.includes('app.asar.unpacked')) helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');"],
    ["helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
     "if (!helperPath.includes('node_modules.asar.unpacked')) helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');"],
  ]
  let applied = 0
  let alreadyPatched = 0
  for (const [orig, patched] of patches) {
    if (src.includes(patched)) { alreadyPatched++; continue }
    if (!src.includes(orig)) {
      console.log(`[fix-pty-helper] WARN: expected line not found in unixTerminal.js (upstream changed?): ${orig.slice(0, 60)}...`)
      continue
    }
    src = src.replace(orig, patched)
    applied++
  }
  if (applied > 0) {
    fs.writeFileSync(unixTerminal, src)
    console.log(`[fix-pty-helper] helperPath double-replace patched (${applied} line(s)) in lib/unixTerminal.js`)
  }
  console.log(`[fix-pty-helper] helperPath patch state: ${applied} applied, ${alreadyPatched} already patched`)
} catch (err) {
  console.log(`[fix-pty-helper] WARN: could not patch unixTerminal.js: ${err.message} (packaging test is the hard gate)`)
}

console.log(`[fix-pty-helper] done: ${touched} fixed, ${already} already executable`)
