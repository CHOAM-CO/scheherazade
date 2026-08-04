#!/usr/bin/env node
// pre-ask-user-question-redirect.mjs -- PreToolUse hook, AskUserQuestion only.
//
// WHY THIS HOOK EXISTS (v0.0.41, Mino live repro 2026-08-04): the agent asked
// "which mail account should the briefing use?" via AskUserQuestion, which
// renders a numbered picker IN THE TERMINAL and blocks on Enter. In a channel
// session the person never sees that terminal -- from the in-app chat the
// agent simply went silent mid-task, and stayed silent until the agent was
// restarted (the picker is not a turn end, so even stop-reply-guard never
// fires). Weaker models reach for this tool often; strong ones do too when a
// task genuinely forks.
//
// The fix is a REDIRECT, not a plain block: the deny reason hands the model
// its own question back and tells it to re-ask through the reply tool as
// plain text, then end the turn and wait for the person's next channel
// message. stop-reply-guard already guarantees that turn ends with a reply.
//
// Advisory-pack conventions: readFileSync(0) not '/dev/stdin' (Windows),
// fail-open on internal errors (a broken hook must not spuriously block a
// tool -- the cost of failing open is only the old, pre-hook behavior),
// product-prefixed kill switch.

import { readFileSync } from 'node:fs'

if (process.env.SCHEHERAZADE_ASK_REDIRECT === '0') process.exit(0)

function allow() {
  process.exit(0)
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

try {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8').trim()
  } catch {
    allow()
  }
  if (!raw) allow()

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    allow()
  }

  if ((input.tool_name || '').trim() !== 'AskUserQuestion') allow()

  // Echo the model's own question(s) back so the redirect costs nothing to
  // follow -- it can lift the text straight into the reply call.
  const lines = []
  const questions = Array.isArray(input.tool_input && input.tool_input.questions)
    ? input.tool_input.questions
    : []
  for (const q of questions) {
    if (q && typeof q.question === 'string' && q.question.trim()) lines.push(q.question.trim())
    const options = Array.isArray(q && q.options) ? q.options : []
    options.forEach((opt, i) => {
      const label = typeof opt === 'string' ? opt : (opt && typeof opt.label === 'string' ? opt.label : '')
      if (label.trim()) lines.push(`  ${i + 1}. ${label.trim()}`)
    })
  }
  const echoed = lines.length ? `\n\nYour question, ready to send:\n${lines.join('\n')}` : ''

  deny(
    'AskUserQuestion is disabled in this session: its picker renders in a ' +
    'terminal your person cannot see, so they would wait forever while you ' +
    'wait for an Enter that never comes. Ask the SAME question through the ' +
    'mcp__agent-channel__reply tool instead -- plain text, options as a ' +
    'numbered list -- then end your turn and wait for their answer in the ' +
    'next message.' + echoed,
  )
} catch {
  process.exit(0) // fail-open
}
