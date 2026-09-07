#!/usr/bin/env node
// post-tool-file-ledger.mjs — PostToolUse hook, file-writing tools only
// (Write|Edit|MultiEdit|NotebookEdit).
//
// WHY (같이보기 batch, the owner 2026-08-19 11:21: "세라가 최근에 건드린 파일들
// 리스트도 볼 수 있게"): nothing recorded which files the agent touched —
// design-0017 v1 explicitly scoped Edit/Write coverage out, and the
// activity feed deliberately excludes them (a busy turn floods it). This
// ledger is the missing record: one JSONL row per file-writing tool result,
// consumed by GET /api/files/recent for the settings-side panel.
//
// Modeled verbatim on post-bash-receipt-ledger.mjs: ADVISORY, FAIL-OPEN
// (any internal error exits 0 silently — a missing ledger degrades to an
// empty panel, never a wrong block), fd-0 stdin read (Windows has no
// /dev/stdin), AGENT_DATA_HOME resolution, size-capped rotation. Separate
// file from receipt-ledger.jsonl on purpose: that one has a cursor-consuming
// gate whose rotation drops cursor+file together; entangling a UI panel
// with gate state would couple two consumers with different lifetimes.

import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Kill switch (product-prefixed, mirrors SCHEHERAZADE_RECEIPT_LEDGER).
if (process.env.SCHEHERAZADE_FILE_LEDGER === '0') process.exit(0)

const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')
const GATES_DIR = path.join(DATA_HOME, '.gates')
const LEDGER_PATH = path.join(GATES_DIR, 'file-ledger.jsonl')
// Rotation differs from the receipt ledger: this history HAS a consumer (the
// recent-files panel), so instead of dropping everything, keep the newest
// half by moving the current file to .1 and starting fresh — the reader
// merges both. Cheap, no cursor to desync.
const MAX_LEDGER_BYTES = 512 * 1024

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

try {
  const raw = readFileSync(0, 'utf8').trim()
  if (!raw) process.exit(0)
  const input = JSON.parse(raw)
  const tool = String(input.tool_name || '')
  if (!FILE_TOOLS.has(tool)) process.exit(0)

  // Same field the vision guard reads (pre-tool-vision-guard.mjs);
  // NotebookEdit uses notebook_path.
  const filePath = String(input.tool_input?.file_path || input.tool_input?.notebook_path || '')
  if (!filePath) process.exit(0)

  // Success detection is best-effort textual (PostToolUse has no structured
  // rc — same finding as the receipt ledger, docs check 2026-07-30). A row
  // is recorded either way; failed writes carry failed:true so the panel
  // can dim them rather than hide them.
  const resp = input.tool_response
  let failed = false
  if (resp && typeof resp === 'object' && (resp.interrupted === true || resp.is_error === true)) failed = true
  else if (typeof resp === 'string' && /^Error:/.test(resp.trim())) failed = true

  const row = { ts: Date.now(), tool, path: filePath }
  if (failed) row.failed = true

  mkdirSync(GATES_DIR, { recursive: true })
  try {
    if (statSync(LEDGER_PATH).size > MAX_LEDGER_BYTES) {
      renameSync(LEDGER_PATH, `${LEDGER_PATH}.1`) // clobbers the previous .1: two windows of history is the contract
    }
  } catch { /* ledger may not exist yet */ }
  appendFileSync(LEDGER_PATH, JSON.stringify(row) + '\n', 'utf8')
} catch {
  // fail-open by contract
}
process.exit(0)
