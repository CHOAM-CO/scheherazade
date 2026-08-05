#!/usr/bin/env node
// pre-reply-rumination-gate.mjs — PreToolUse hook, "reply" tool only.
//
// WHY THIS HOOK EXISTS: an agent occasionally asserts a completion/verification
// claim ("보냈어요", "확인했어요") or a memory/absence claim ("기억이 안 나요",
// "기록이 없어요") from recall rather than from having actually looked. This
// gate forces one re-check bounce before that message reaches the user.
//
// Design note (v1.1, self-contained rewrite — this is NOT a copy of any other
// project's rumination gate): the source material this was built from used a
// multi-agent fleet with a peer red-team escalation path (a stronger claim
// tier that required naming another agent's independent catch). That tier
// does not map onto a single-agent consumer product — there is no peer to
// red-team with — so it is dropped entirely here. Only two claim classes
// remain: completion/verification (CLASS_A) and memory/absence (CLASS_B).
//
// ONE-BOUNCE design: first hit on a completion/absence claim -> deny once and
// write a marker file. If the very next reply attempt lands inside the
// BOUNCE_WINDOW_MS window, the marker is treated as consumed and that reply
// passes (whether or not it repeats the same wording) -- the gate does not
// try to verify the RETRY's content, only that a check-your-work beat
// happened. This single-file design intentionally has no separate
// PostToolUse consume step: consumption happens synchronously here, at the
// moment the retry is recognized. That is a simplification versus a
// pre/post-pair design, justified because this hook is currently the only
// blocking gate on this tool (no other PreToolUse hook can block a reply
// AFTER this one allows it, so there is no premature-consume race to guard
// against). If a second blocking gate is ever added to this same tool, this
// tradeoff should be revisited.
//
// EVIDENCE BRANCH (v1.2, design 0017 — deliberately grown INSIDE this gate
// rather than shipped as a sibling, exactly because of the note above: one
// blocking gate total keeps the consume design sound): besides claim-shaped
// TEXT, the gate now also bounces on claim-shaped SILENCE — unacknowledged
// failed commands this turn. post-bash-receipt-ledger.mjs (PostToolUse,
// advisory) records one row per Bash result; rows newer than the cursor
// stamped at the last judged reply are this reply's evidence. Any failed
// row bounces ONCE with the specific receipt (command + exit marker), then
// the same marker/consume machinery applies. The cursor advances on every
// ALLOWED reply — including the consume path, so re-check commands that
// fail again between bounce and retry don't re-bounce the retry — and rows
// are judged exactly once per reply, never re-litigated.
//
// FAIL-LOUD (deliberately the ONE gate in this pack that does NOT fail-open):
// every other gate in this pack is advisory and swallows its own errors
// silently by design. This gate is the only BLOCKING gate, so a bug here
// must never resolve into a silent bypass of the receipt check -- an
// internal error blocks the reply AND writes a clear, loud diagnostic to
// stderr (exit code 2), rather than waving the message through.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

const HOOK = 'pre-reply-rumination-gate'
const REPLY_TOOL = 'mcp__agent-channel__reply' // confirmed: .mcp.json server name "agent-channel" (channel.mjs)

// Kill switch (product-prefixed, mirrors SCHEHERAZADE_MEMORY_DB naming).
if (process.env.SCHEHERAZADE_RUMINATION_GATE === '0') process.exit(0)

// DATA_HOME resolution matches channel.mjs / run.sh / memory/server.mjs:
// AGENT_DATA_HOME env override, else ~/Documents/Scheherazade.
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')
const CACHE_DIR = path.join(DATA_HOME, '.gates')
// Marker is SCOPED per (channelId × claim classes) since 2026-08-05
// (red-team P0-3): the old single global file meant a deny in channel A
// opened a 10-minute pass for a completely different claim in channel B —
// cross-channel bypass. Content is deliberately NOT part of the scope: the
// design contract is "resend the same or a CORRECTED message", so a content
// hash would bounce exactly the corrected retry the window exists for.
// The legacy unscoped marker is deleted on sight (one-time migration).
const LEGACY_MARKER_PATH = path.join(CACHE_DIR, 'rumination.last_deny')
const BOUNCE_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

// Evidence branch state (design 0017): ledger written by
// post-bash-receipt-ledger.mjs; cursor stamped HERE on every allowed reply.
const LEDGER_PATH = path.join(CACHE_DIR, 'receipt-ledger.jsonl')
const CURSOR_PATH = path.join(CACHE_DIR, 'receipt-ledger.cursor')

// ── PRODUCT COPY — PO 최종화 대기 ──────────────────────────────────────────
// 초안 원칙(설계 문서 §1-3): 존댓말, 이모지/느낌표 금지, "버그가 아니라 확인
// 절차"로 읽히도록. 최종 문구는 온보딩 카피(onboarding/public/js/copy.js)와
// 같은 레지스터로 PO가 확정한다.
const GATE_COPY = {
  header: '보내기 전에 확인이 필요합니다.',
  completionClaim:
    '방금 메시지에 "이미 처리했다"는 표현이 있습니다. 실제로 확인한 내용인가요, 아니면 그럴 것이라고 짐작한 내용인가요. 확인한 내용이면 지금 그대로 다시 보내면 통과됩니다. 아직 확인하지 않았다면, 확인한 뒤에 다시 보내 주세요.',
  absenceClaim:
    '방금 메시지에 "기억이 없다" 또는 "기록이 없다"는 표현이 있습니다. 실제로 찾아본 뒤에 하는 말인가요. 아직 찾아보지 않았다면 세션 기록을 먼저 확인한 뒤 다시 보내 주세요.',
  footer:
    '확인을 마쳤다면 같은 내용 그대로, 또는 고친 내용으로 다시 보내 주세요. 이번 한 번은 그대로 전송됩니다 (10분 이내). 이 확인은 오류가 아니라, 에이전트가 사실과 다른 보고를 하지 않도록 돕는 절차입니다.',
  // Evidence branch copy (design 0017): the receipt is SPECIFIC — command +
  // exit marker — because a blind "go check" bounce teaches nothing.
  evidenceClaim: (failedRows, total) =>
    `이번 턴에 실행한 명령 ${total}개 중 ${failedRows.length}개가 실패로 끝났습니다:\n` +
    failedRows.slice(0, 3).map((r) => `  - \`${r.cmd}\` (${r.marker})`).join('\n') +
    (failedRows.length > 3 ? `\n  - 외 ${failedRows.length - 3}개` : '') +
    '\n이 실패가 지금 보내려는 답장에 반영되어 있나요. 반영되어 있다면 그대로 다시 보내면 통과됩니다. 아니라면 실패를 확인하고 답장에 담아 주세요.',
}

// CLASS_A: completion/verification claims. Curated action-verb stems, not a
// bare past-tense suffix — "~했어" alone would match nearly every Korean
// sentence describing something already done, which is not what this gate
// is for (false-positive UX is the top risk named in the source design doc's
// §4). Each stem below names a concrete action a personal agent plausibly
// reports finishing.
const CLASS_A =
  /(보냈어|보냈습니다|보내놨|저장했|저장했습니다|등록했|예약했|취소했|정리했|찾았어|찾아냈|완료했|완료됐|끝냈어|끝났어|처리했|처리됐|반영했|반영됐|적용했|적용됐|수정했|고쳤어|고쳤습니다|바꿔놨|바꿨어|설정했|생성했|만들어놨|만들었어|확인했|검증했|점검했)/

// CLASS_B: memory/absence claims — asserting "no memory of this" or "no
// record of this" without having actually looked. Scoped to claims that are
// FALSIFIABLE BY LOOKUP (a record/memory search can prove them wrong).
// Bare epistemic states ("모르겠어요") and novelty remarks ("처음 들어요")
// were deliberately removed (PO decision, v1.1): they are legitimate
// conversational answers, often true, and bouncing them reads as breakage —
// the exact false-positive UX named as top risk in the design doc §4.
const CLASS_B =
  /(기억\s*안\s*나|기억이\s*안\s*나|기록.{0,3}없|없었어|없더라|그런\s*적\s*없|한\s*적\s*없|안\s*했었)/

function allow() {
  process.exit(0)
}

// Stamp = "every ledger row up to now has been judged against a reply that
// was ALLOWED". Called on every allow path for the reply tool. Fail-loud:
// a cursor that silently stops advancing would re-litigate old failures on
// every future reply — a UX breakage, not a safe degradation.
function stampCursorAndAllow() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(CURSOR_PATH, String(Date.now()), 'utf8')
  } catch (e) {
    failLoud('cursor stamp', e)
  }
  allow()
}

// Rows newer than the cursor = this reply's evidence. Unparseable lines are
// skipped (an interrupted append cannot be proven a failure); a missing
// ledger is simply no evidence — both degrade toward allowing, never toward
// a wrong block, matching the ledger writer's fail-open contract.
function readFreshLedgerRows() {
  let cursor = 0
  try {
    cursor = Number(readFileSync(CURSOR_PATH, 'utf8')) || 0
  } catch { /* never stamped */ }
  let text = ''
  try {
    text = readFileSync(LEDGER_PATH, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row.ts === 'number' && row.ts > cursor) rows.push(row)
    } catch { /* skip torn line */ }
  }
  return rows
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  process.exit(0)
}

function failLoud(stage, err) {
  process.stderr.write(
    `[${HOOK}] FAIL-LOUD (${stage}): ${err && err.stack ? err.stack : err} -- this is the one BLOCKING gate in the pack; it does not fail-open. Fix the hook, do not silence it.\n`,
  )
  process.exit(2)
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
    failLoud('stdin read', e)
  }

  if (!raw) allow() // Claude Code should never fire this hook with empty stdin; treat as no-op, not a failure.

  let input
  try {
    input = JSON.parse(raw)
  } catch (e) {
    failLoud('stdin JSON parse', e)
  }

  const toolName = (input.tool_name || '').trim()
  if (toolName !== REPLY_TOOL) allow() // wired to a matcher that should only ever send us this tool

  const ti = input.tool_input || {}
  const text = typeof ti.text === 'string' ? ti.text : ''

  // A question is not an assertion. Strip trailing-"?" sentences before
  // testing either class, so interrogatives ("보냈나요?", "기록 없나요?")
  // don't bounce.
  const assertText = text
    .split(/(?<=[.!?\n])/)
    .filter((s) => !s.trim().endsWith('?'))
    .join(' ')

  const hitA = CLASS_A.test(assertText)
  const hitB = CLASS_B.test(assertText)

  // Evidence branch (design 0017): unacknowledged failed commands this turn
  // bounce even when the reply text contains no claim wording at all —
  // claim-shaped SILENCE, the smoother half of silent false success.
  const freshRows = readFreshLedgerRows()
  const failedRows = freshRows.filter((r) => r.failed === true)
  const hitC = failedRows.length > 0

  if (!hitA && !hitB && !hitC) stampCursorAndAllow()

  // Scope key: which channel this reply targets × which claim classes fired.
  // See the LEGACY_MARKER_PATH note up top for why content is excluded.
  const channelScope = typeof ti.channelId === 'string' && ti.channelId ? ti.channelId : 'current'
  const scopeKey = createHash('sha256')
    .update(`${channelScope}|${hitA ? 'A' : ''}${hitB ? 'B' : ''}${hitC ? 'C' : ''}`)
    .digest('hex')
    .slice(0, 16)
  const markerPath = path.join(CACHE_DIR, `rumination.last_deny.${scopeKey}`)
  // One-time migration: a pre-scoping global marker is deleted, never
  // honored — honoring it would BE the cross-channel bypass being removed.
  if (existsSync(LEGACY_MARKER_PATH)) {
    try { unlinkSync(LEGACY_MARKER_PATH) } catch { /* best effort */ }
  }

  // ── One-bounce state check ──────────────────────────────────────────────
  if (existsSync(markerPath)) {
    let age
    try {
      age = Date.now() - statSync(markerPath).mtimeMs
    } catch (e) {
      failLoud('marker stat', e)
    }
    if (age < BOUNCE_WINDOW_MS) {
      // This is the retry inside the grace window — consume the marker now
      // (synchronous consume, see file-header note) and allow. Cursor stamps
      // here too: rows created BETWEEN bounce and retry (the agent re-running
      // the failed command to check — often failing again) are part of the
      // judged evidence, not grounds to re-bounce the retry.
      try {
        unlinkSync(markerPath)
      } catch (e) {
        failLoud('marker consume (unlink)', e)
      }
      stampCursorAndAllow()
    }
    // Stale marker (past the window) — fall through and bounce again.
  }

  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(markerPath, String(Date.now()), 'utf8')
  } catch (e) {
    failLoud('marker write', e)
  }
  // Deny does NOT stamp the cursor: the failed rows stay live so the retry
  // is judged against them (and passes via the marker consume above).

  const lines = [`[확인 절차] ${GATE_COPY.header}`, ''] // bracket label, not emoji — copy-register rule (no emoji) applies to gate strings too
  if (hitA) lines.push(GATE_COPY.completionClaim)
  if (hitB) lines.push(GATE_COPY.absenceClaim)
  if (hitC) lines.push(GATE_COPY.evidenceClaim(failedRows, freshRows.length))
  lines.push('', GATE_COPY.footer)

  deny(lines.join('\n'))
} catch (e) {
  failLoud('top-level', e)
}
