#!/usr/bin/env node
// post-bash-receipt-ledger.mjs — PostToolUse hook, Bash tool only.
//
// WHY THIS HOOK EXISTS (design 0017, backlog B): silent false success — the
// agent reporting work it never verified — is the field's #3 universal pain
// (docs/research-harness-pains-2026-07.md). The rumination gate already
// bounces completion-CLAIM wording once, but it is text-triggered: it knows
// nothing about what actually ran, so a reply that simply glosses over a
// failed command (no claim words at all) sails through. This hook records
// the EVIDENCE side: one JSONL row per Bash result, so the gate can hold a
// reply against what the turn actually did (see the evidence branch in
// pre-reply-rumination-gate.mjs).
//
// ADVISORY, FAIL-OPEN: pack convention — only the rumination gate blocks.
// Any internal error exits 0 silently. A missing or broken ledger degrades
// to "no evidence", never to a wrong block.
//
// FAILURE DETECTION IS TEXTUAL BY NECESSITY: the PostToolUse payload has no
// structured exit-code field (docs check 2026-07-30,
// code.claude.com/docs/en/hooks.md — tool_response carries output text/
// stdout/stderr, not rc). Discriminator: the harness's own "Exit code N"
// marker plus the `interrupted` flag. Known residual: stdout that ITSELF
// contains "Exit code 3"-shaped text false-positives a row — acceptable for
// an advisory ledger whose worst case is one extra check-your-work bounce.
// If the marker format ever changes upstream, rows degrade to all-success:
// fail-open, never fail-wrong.

import { readFileSync, appendFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Kill switch (product-prefixed, mirrors SCHEHERAZADE_RUMINATION_GATE).
if (process.env.SCHEHERAZADE_RECEIPT_LEDGER === '0') process.exit(0)

// DATA_HOME resolution matches channel.mjs / run.sh / the gate pack.
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')
const GATES_DIR = path.join(DATA_HOME, '.gates')
const LEDGER_PATH = path.join(GATES_DIR, 'receipt-ledger.jsonl')
const CURSOR_PATH = path.join(GATES_DIR, 'receipt-ledger.cursor')
// Rotation: the gate only ever reads rows newer than its cursor, so history
// has no consumer — drop the whole file (and the cursor with it, so the two
// can never disagree) once it outgrows the cap.
const MAX_LEDGER_BYTES = 1024 * 1024

try {
  const raw = readFileSync('/dev/stdin', 'utf8').trim()
  if (!raw) process.exit(0)
  const input = JSON.parse(raw)
  if ((input.tool_name || '') !== 'Bash') process.exit(0)

  const cmd = String(input.tool_input?.command || '').slice(0, 120)

  // Liberal payload scan, same shape-tolerance as the permission translator:
  // string or object tool_response, stdout+stderr+content merged.
  const resp = input.tool_response
  let output = ''
  let interrupted = false
  if (typeof resp === 'string') output = resp
  else if (resp && typeof resp === 'object') {
    if (typeof resp.output === 'string') output += resp.output
    if (typeof resp.stdout === 'string') output += `\n${resp.stdout}`
    if (typeof resp.stderr === 'string') output += `\n${resp.stderr}`
    if (Array.isArray(resp.content)) output += '\n' + resp.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
    if (resp.interrupted === true) interrupted = true
  }

  const m = output.match(/Exit code:?\s*(\d+)/i)
  const exitCode = m ? Number(m[1]) : 0
  const failed = interrupted || exitCode !== 0

  const row = { ts: Date.now(), cmd, failed }
  if (failed) {
    row.marker = interrupted ? 'interrupted' : `exit ${exitCode}`
    row.tail = output.trim().slice(-200)
  }

  mkdirSync(GATES_DIR, { recursive: true })
  try {
    if (statSync(LEDGER_PATH).size > MAX_LEDGER_BYTES) {
      unlinkSync(LEDGER_PATH)
      try { unlinkSync(CURSOR_PATH) } catch { /* cursor may not exist */ }
    }
  } catch { /* ledger may not exist yet */ }
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + '\n', 'utf8')
} catch {
  // fail-open by contract
}
process.exit(0)
