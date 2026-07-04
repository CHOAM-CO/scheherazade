#!/usr/bin/env node
// stop-skill-extraction-nudge.mjs — Stop hook, advisory only.
// ADVISORY ONLY — never blocks. Any internal error is fail-open (silent
// exit 0, no output), same posture as pre-reply-corrections-context.mjs /
// pre-reply-time-adverb-guard.mjs (the two OTHER advisory hooks in this
// pack) rather than the one blocking gate (pre-reply-rumination-gate.mjs).
//
// WHY THIS HOOK EXISTS (design doc R1, post-task skill extraction): a
// session that worked out a reusable approach (a fix pattern, a workaround,
// a "here's how you actually do X in this repo") has nowhere to land that
// pattern once the session ends — session_notes/journals capture what
// happened emotionally and factually, not "here is a recipe future-me
// should reuse." This nudges toward writing one when the session looks like
// it earned one. It never writes the skill file itself and never judges
// whether a specific pattern is worth keeping — that stays the agent's call
// (design doc §principles: "유저 강제 없음").
//
// Consumption pairing: this is the WRITE side only. session-start.sh
// (extended separately) is the READ side — it lists skills/ at boot so a
// file written here is not a dead drawer.
//
// HEURISTIC for "substantive work happened" (documented per task spec,
// this is a judgment call — open for PO calibration, see file-end note):
// counts tool_use invocations in this session's transcript (transcript_path,
// a Claude Code common hook field) and fires only if EITHER:
//   - file-editing tool calls (Edit/Write/MultiEdit/NotebookEdit) >= MIN_FILE_EDITS, or
//   - total tool_use calls (any tool) >= MIN_TOOL_CALLS
// File edits are the strongest signal that something was actually built/
// changed (not just read/discussed), so that threshold is kept low (2 --
// a single one-off edit is more likely a typo fix than a pattern worth
// extracting). Total tool calls covers substantive investigation-only
// sessions (heavy Bash/Read/Grep loops that surfaced a reusable approach
// without touching a file), so that threshold is kept higher (8) to avoid
// firing on a short "read two files and answer a question" session. Both
// are OR'd, not AND'd, biasing toward the false-negative side per the task
// spec's explicit instruction to bias toward FEWER false positives (silence
// on trivial/Q&A/no-tool-use sessions is the safe failure mode here, not a
// missed nudge).
//
// The transcript JSONL record shape used below (type: "assistant", tool
// calls at message.content[].type === "tool_use") is NOT a documented/
// stable Claude Code contract (Claude Code's own docs describe the
// transcript file format as internal and subject to change). Every line is
// parsed inside its own try/catch and unexpected shapes are silently
// skipped, so a future format change degrades this hook to "never nudges"
// (fail-open), never to a crash or a block.
//
// stop_hook_active handling: if Claude Code reports this Stop event as
// already mid-continuation from a prior hook signal, this hook stays
// silent rather than nudging again -- a repeated nudge across the same
// stop chain would read as a loop, and a single advisory beat is enough.

import { readFileSync, existsSync } from 'node:fs'

const HOOK = 'stop-skill-extraction-nudge'

const MIN_FILE_EDITS = 2
const MIN_TOOL_CALLS = 8
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// ── PRODUCT COPY — PO 최종화 대기 ──────────────────────────────────────────
// 초안 원칙(설계 문서 §1-3): 존댓말, 이모지/느낌표 금지, "기능"으로 읽히는 톤.
const GATE_COPY = {
  header: '이번 세션에서 실질적인 작업이 있었습니다.',
  body: '재사용할 수 있는 패턴이 나왔다면, skills/ 아래에 파일 하나로 남겨 두는 것을 고려해 주세요. frontmatter(name/trigger/extracted_from/date) 다음에 Approach와 Constraints를 적으면 됩니다.',
  footer: '해당하지 않는 세션이면 그냥 넘어가도 됩니다. 자동으로 만들어지지 않습니다.',
}

function succeedEmpty() {
  process.exit(0)
}

function succeedWithContext(ctx) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
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

function countToolUse(transcriptPath) {
  let toolCalls = 0
  let fileEdits = 0
  let raw
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return { toolCalls, fileEdits } // unreadable transcript -> treat as "nothing counted", not an error
  }
  const lines = raw.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue // malformed/partial line -- skip, don't fail the whole hook over one bad line
    }
    if (!rec || rec.type !== 'assistant') continue
    const content = rec.message && Array.isArray(rec.message.content) ? rec.message.content : []
    for (const item of content) {
      if (!item || item.type !== 'tool_use') continue
      toolCalls += 1
      if (item.name && FILE_EDIT_TOOLS.has(item.name)) fileEdits += 1
    }
  }
  return { toolCalls, fileEdits }
}

try {
  let raw
  try {
    raw = readFileSync('/dev/stdin', 'utf8').trim()
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

  // Already continuing from a prior Stop-hook signal this chain -- don't
  // nudge a second time (avoids a nag loop; one advisory beat is enough).
  if (input.stop_hook_active === true) succeedEmpty()

  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  if (!transcriptPath || !existsSync(transcriptPath)) succeedEmpty() // no transcript to inspect -- nothing to base a nudge on

  const { toolCalls, fileEdits } = countToolUse(transcriptPath)

  const substantive = fileEdits >= MIN_FILE_EDITS || toolCalls >= MIN_TOOL_CALLS
  if (!substantive) succeedEmpty()

  const lines = [`[스킬 노트] ${GATE_COPY.header}`, '', GATE_COPY.body, '', GATE_COPY.footer]
  succeedWithContext(lines.join('\n'))
} catch (e) {
  failOpen('top-level', e)
}
