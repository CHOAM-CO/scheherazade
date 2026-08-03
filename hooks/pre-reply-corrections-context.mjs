#!/usr/bin/env node
// pre-reply-corrections-context.mjs — PreToolUse hook, "reply" tool only.
// ADVISORY ONLY — never blocks. Any internal error is fail-open (empty
// success output), by explicit design contrast with pre-reply-rumination-
// gate.mjs, which is the one blocking/fail-loud gate in this pack.
//
// WHY THIS HOOK EXISTS: memory/server.mjs's `corrections` table carries this
// comment on its own DDL: "distrust productized: hooks READ active rows as
// gating constraints" — the memory schema was designed from day one assuming
// a hook would read `corrections` back out as a standing behavioral
// constraint. No such hook existed until this one. This closes that gap: a
// user-taught correction ("존댓말 썼는데 반말 요청" -> "always 반말") gets
// surfaced again right before every reply, so it doesn't quietly lapse once
// the conversation that produced it scrolls out of context.
//
// Design note (self-contained rewrite): the fleet-scale analog this was
// modeled on used a static, hand-curated JSON reminder list
// (pattern-reminders.json). The product version here is structurally
// different and better for a single-user product: corrections are read
// straight from what the USER actually corrected (memory_write via the
// `corrections` table), not from a hardcoded list someone wrote in advance
// — it is automatically personalized by construction.
//
// Injection policy (open PO call, documented for review): every still-active
// correction is injected on every reply, not keyword-matched against the
// outgoing message. Corrections are meant to function as standing
// constraints ("always X"), not one-off facts to recall only when a keyword
// happens to match — a keyword filter would risk silently NOT reminding the
// agent of "always 반말" on the one reply where it forgets and writes 존댓말
// with no 존댓말-related token in the text to match against. The list is
// capped (CORRECTIONS_LIMIT) so this can't grow into unbounded context
// injection as the table accumulates history.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const HOOK = 'pre-reply-corrections-context'
const REPLY_TOOL = 'mcp__agent-channel__reply'
const CORRECTIONS_LIMIT = 5

// DATA_HOME / DB_PATH resolution mirrors memory/server.mjs exactly, so this
// hook always reads the SAME database the running memory MCP server writes
// to. SCHEHERAZADE_MEMORY_DB is the one deliberate override point (also used
// by memory/smoke.mjs against a disposable temp db).
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')
const DB_PATH = process.env.SCHEHERAZADE_MEMORY_DB || path.join(DATA_HOME, 'memory.db')

// ── PRODUCT COPY — PO 최종화 대기 ──────────────────────────────────────────
// 초안 원칙(설계 문서 §1-3): 존댓말, 이모지/느낌표 금지, "기능"으로 읽히는 톤.
const GATE_COPY = {
  header: '이전에 정정받은 내용이 있습니다. 참고해 주세요.',
  footer: '위 내용과 다르게 답하려는 경우, 의도적인 변경인지 다시 확인해 주세요.',
}

function succeedEmpty() {
  process.exit(0)
}

function succeedWithContext(ctx) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: ctx,
      },
    }),
  )
  process.exit(0)
}

function failOpen(stage, err) {
  process.stderr.write(`[${HOOK}] WARN fail-open (${stage}): ${err && err.message ? err.message : err}\n`)
  process.exit(0)
}

try {
  let raw
  try {
    // fd 0, not '/dev/stdin': that path does not exist on Windows, so the read
    // threw, the catch exited 0, and this hook did NOTHING on that platform --
    // silently, which is the failure mode hooks are least able to report.
    // (Found 2026-08-04 running the suite on the win box.) readFileSync(0) is
    // the portable form and behaves identically on POSIX.
    raw = readFileSync(0, 'utf8').trim()
  } catch (e) {
    failOpen('stdin read', e)
  }
  if (!raw) succeedEmpty()

  let input
  try {
    input = JSON.parse(raw)
  } catch (e) {
    failOpen('stdin JSON parse', e)
  }

  const toolName = (input.tool_name || '').trim()
  if (toolName !== REPLY_TOOL) succeedEmpty()

  if (!existsSync(DB_PATH)) succeedEmpty() // no memory db yet (fresh install) — nothing to inject, not an error

  let rows
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      rows = db
        .prepare(
          'SELECT what_was_wrong, correct_behavior, corrected_at FROM corrections WHERE still_active = 1 ORDER BY corrected_at DESC LIMIT ?',
        )
        .all(CORRECTIONS_LIMIT)
    } finally {
      db.close()
    }
  } catch (e) {
    failOpen('db read', e)
  }

  if (!rows || rows.length === 0) succeedEmpty()

  const lines = [`[기억된 교정] ${GATE_COPY.header}`, ''] // bracket label, not emoji — copy-register rule
  for (const r of rows) {
    const date = typeof r.corrected_at === 'string' ? r.corrected_at.slice(0, 10) : ''
    lines.push(`- ${r.what_was_wrong} -> ${r.correct_behavior}${date ? ` (${date})` : ''}`)
  }
  lines.push('', GATE_COPY.footer)

  succeedWithContext(lines.join('\n'))
} catch (e) {
  failOpen('top-level', e)
}
