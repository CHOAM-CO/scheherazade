#!/usr/bin/env node
// pre-reply-time-adverb-guard.mjs — PreToolUse hook, "reply" tool only.
// ADVISORY ONLY — never blocks. Any internal error is fail-open (empty
// success output), same as pre-reply-corrections-context.mjs.
//
// WHY THIS HOOK EXISTS (confabulation guard): a relative-time word ("어제",
// "지난주", "3일 전") attached to a specific, checkable claim (a date, a
// version/canon number) is a claim that can be quietly wrong if it was
// estimated rather than looked up. This nudges a verification step before
// the message goes out. Vague, non-falsifiable colloquial time words on
// their own ("아까 그거 봤어") carry nothing to check and are deliberately
// NOT flagged — see COLLOQUIAL_ONLY handling below.
//
// Design note (self-contained rewrite): ported as a heuristic pattern, not
// as code — no shared paths, thresholds, or fleet-specific vocabulary carried
// over. Korean-first, same scope note as the source design doc: English time
// phrases are included here too (they were low-cost to keep and already
// covered in the reference pattern set) but this has NOT been separately
// validated against English usage; treat English coverage as best-effort.

import { readFileSync } from 'node:fs'

const HOOK = 'pre-reply-time-adverb-guard'
const REPLY_TOOL = 'mcp__agent-channel__reply'

// ── PRODUCT COPY — PO 최종화 대기 ──────────────────────────────────────────
// 초안 원칙(설계 문서 §1-3): 존댓말, 이모지/느낌표 금지, "기능"으로 읽히는 톤.
const GATE_COPY = {
  message: (words) =>
    `⏰ 시간 표현이 감지되었습니다: '${words.join("', '")}'. 직접 확인하지 않은 시간 추정은 사실과 다를 수 있습니다. 파일 시각이나 실제 기록을 확인한 뒤 답해 주세요.`,
}

// Claims that carry their own verifiable timestamp — never need the nudge.
const SAFE_PATTERNS = [/\[CRON\]/, /\[SYSTEM\]/, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/]

// Vague/conversational time words with no falsifiable date claim on their
// own — only worth flagging if a real date/version claim rides along with
// them (see DATE_CLAIM_RE below).
const COLLOQUIAL_ONLY = [/아까/, /방금\s*전?/, /최근에?/, /지난주/]

const TIME_PATTERNS = [
  /어제/,
  /그제/,
  /엊그제/,
  /지난달/,
  /지난해/,
  /며칠\s*전/,
  /몇\s*달\s*전/,
  /얼마\s*전/,
  /한\s*달\s*전/,
  /[0-9]+일\s*전/,
  /[0-9]+주\s*전/,
  /[0-9]+달\s*전/,
  /[0-9]+개월\s*전/,
  /[0-9]+년\s*전/,
  /\byesterday\b/i,
  /\blast\s+week\b/i,
  /\blast\s+month\b/i,
  /\b\d+\s+days?\s+ago\b/i,
  /\b\d+\s+weeks?\s+ago\b/i,
  /\b\d+\s+months?\s+ago\b/i,
  /\brecently\b/i,
  /\ba\s+while\s+ago\b/i,
]

// Falsifiable claim signal riding with a colloquial time word: a specific
// date, or a version/build number. A bare topic word ("버전", "canon") with
// no number is not falsifiable on its own.
const DATE_CLAIM_RE =
  /\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d+월\s*\d+일|\d+월|\b(?:v\d+(?:\.\d+)?|(?:버전|version|릴리즈|release|태그|tag)\s*[#:-]?\s*\d+(?:\.\d+)?)\b/i

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

  const toolName = (input.tool_name || '').trim()
  if (toolName !== REPLY_TOOL) succeedEmpty()

  const ti = input.tool_input || {}
  const text = typeof ti.text === 'string' ? ti.text : ''
  if (!text) succeedEmpty()

  for (const safe of SAFE_PATTERNS) {
    if (safe.test(text)) succeedEmpty()
  }

  const matched = []
  for (const pat of TIME_PATTERNS) {
    const m = text.match(pat)
    if (m) matched.push(m[0])
  }

  const colloquialMatched = []
  for (const pat of COLLOQUIAL_ONLY) {
    const m = text.match(pat)
    if (m) colloquialMatched.push(m[0])
  }

  const allMatched = [...matched, ...colloquialMatched]
  if (!allMatched.length) succeedEmpty()

  if (matched.length === 0 && colloquialMatched.length > 0 && !DATE_CLAIM_RE.test(text)) {
    succeedEmpty() // pure colloquial hit, no falsifiable claim attached — suppress
  }

  const unique = [...new Set(allMatched)]
  succeedWithContext(GATE_COPY.message(unique))
} catch (e) {
  failOpen('top-level', e)
}
