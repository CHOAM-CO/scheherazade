#!/usr/bin/env node
// persona-reflux.mjs -- weekly pass: grep 🔒 corrections out of
// session_notes/ and journals/, append them as review proposals. Node port
// of persona-reflux.sh (win-port Phase 3). Does NOT judge or apply
// anything -- it surfaces raw material. The agent fills in the "Proposed
// self_persona change" field when it reviews the file with the human; the
// human approves/rejects; the agent (not this script) edits
// self_persona.md.
//
// Safe to run repeatedly (daily, weekly, or by hand) -- .reflux-seen
// dedupes so a given 🔒 line is only ever proposed once.
//
// Two lessons carried over VERBATIM from the bash version (both caught by
// Scheherazade's own boot tests, 07-13, verified raw at the time):
//   1. Anchor to line-lead 🔒 (optional whitespace/bullet first). A bare
//      mid-line mention ("🔒 lines below" quoted in prose) is not a
//      correction; the unanchored grep proposed one.
//   2. Keys are ALWAYS file:line. bash grep without -H drops the filename
//      when only ONE file matches, shifting the parse and corrupting
//      .reflux-seen keys. The port builds keys from its own iteration, so
//      the single-file case is structurally immune -- the test still pins it.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// The pass itself lives in cadence/reflux-pass.cjs so the app's once-a-day
// clock (cadence/daily-clock.cjs) runs the SAME rule in-process instead of a
// copy of it. This file is only the CLI: env, eager dirs, stderr lines.
const require = createRequire(import.meta.url)
const { runRefluxPass, ensureReviewFiles } = require('../cadence/reflux-pass.cjs')

const MEM = process.env.MEM || process.cwd()

ensureReviewFiles(MEM)
fs.mkdirSync(path.join(MEM, 'session_notes'), { recursive: true })
fs.mkdirSync(path.join(MEM, 'journals'), { recursive: true })

const { added, files, proposalsFile } = runRefluxPass({ mem: MEM })
if (files === 0) {
  console.error('no session notes or journals yet')
  process.exit(0)
}

console.error(`${added} new correction(s) added to ${proposalsFile}`)
