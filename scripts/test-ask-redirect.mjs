// test-ask-redirect.mjs — pins the AskUserQuestion redirect hook
// (hooks/pre-ask-user-question-redirect.mjs, v0.0.41).
//
// WHY: the agent asked a fork-in-the-road question via AskUserQuestion,
// which drew a numbered picker in a terminal the person never sees, and
// stalled silently mid-task until restart (Mino live repro 2026-08-04).
// These fixtures pin:
//   - AskUserQuestion is denied, and the deny reason both names the reply
//     tool and echoes the question + numbered options (a redirect the model
//     can follow by copy-paste, not a bare wall)
//   - every other tool passes through untouched (no output, exit 0)
//   - the kill switch (SCHEHERAZADE_ASK_REDIRECT=0) disables it
//   - malformed stdin fails OPEN (a broken hook must not become a blocker)
//
// The hook is spawned as a real child with stdin JSON, the way Claude Code
// runs it.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, 'hooks', 'pre-ask-user-question-redirect.mjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

function runHook(stdinValue, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof stdinValue === 'string' ? stdinValue : JSON.stringify(stdinValue),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  let decision = null
  try { decision = JSON.parse(r.stdout).hookSpecificOutput } catch { /* no JSON = no decision */ }
  return { code: r.status, stdout: r.stdout, decision }
}

console.log('\n1. AskUserQuestion is denied with a followable redirect')
{
  const r = runHook({
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: '어떤 계정 기준으로 보고할까?',
        header: '메일 계정',
        options: [
          { label: 'danstruct.co 계정으로', description: '지금 있는 계정' },
          { label: 'Gmail 추가하고 싶어', description: '추가 안내' },
        ],
      }],
    },
  })
  assert(r.code === 0, 'exits 0 (refusal is the JSON decision, not the exit code)')
  assert(r.decision && r.decision.permissionDecision === 'deny', 'permissionDecision is deny')
  const reason = (r.decision && r.decision.permissionDecisionReason) || ''
  assert(reason.includes('mcp__agent-channel__reply'), 'reason names the reply tool to use instead')
  assert(reason.includes('어떤 계정 기준으로 보고할까?'), 'reason echoes the question text back')
  assert(reason.includes('1. danstruct.co 계정으로'), 'reason echoes option 1, numbered')
  assert(reason.includes('2. Gmail 추가하고 싶어'), 'reason echoes option 2, numbered')
}

console.log('\n2. string options are echoed too')
{
  const r = runHook({
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which one?', options: ['red', 'blue'] }] },
  })
  assert(r.decision && r.decision.permissionDecision === 'deny', 'denied')
  const reason = (r.decision && r.decision.permissionDecisionReason) || ''
  assert(reason.includes('1. red') && reason.includes('2. blue'), 'plain-string options echoed numbered')
}

console.log('\n3. a question with no parsable options still redirects')
{
  const r = runHook({ tool_name: 'AskUserQuestion', tool_input: {} })
  assert(r.decision && r.decision.permissionDecision === 'deny', 'denied even with empty tool_input')
  const reason = (r.decision && r.decision.permissionDecisionReason) || ''
  assert(reason.includes('mcp__agent-channel__reply'), 'redirect instruction still present')
}

console.log('\n4. other tools pass through untouched')
{
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert(r.code === 0, 'exit 0')
  assert(!r.decision, 'no permission decision emitted for other tools')
}

console.log('\n5. kill switch')
{
  const r = runHook({ tool_name: 'AskUserQuestion', tool_input: {} }, { SCHEHERAZADE_ASK_REDIRECT: '0' })
  assert(r.code === 0 && !r.decision, 'SCHEHERAZADE_ASK_REDIRECT=0 disables the hook entirely')
}

console.log('\n6. malformed stdin fails OPEN')
{
  const r = runHook('this is not json {')
  assert(r.code === 0 && !r.decision, 'garbage stdin -> exit 0, no decision (old behavior, not a spurious block)')
  const empty = runHook('')
  assert(empty.code === 0 && !empty.decision, 'empty stdin -> exit 0, no decision')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
