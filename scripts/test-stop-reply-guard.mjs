#!/usr/bin/env node
// test-stop-reply-guard.mjs — pins the Stop-hook reply guard against crafted
// transcripts. Run: node scripts/test-stop-reply-guard.mjs
//
// WHY THIS EXISTS (v0.0.34): the guard matched channelId="digits" only, so it
// was silently INERT on the in-app backend (channelId="in-app") — the exact
// silent-agent class it was ported to catch (0.0.31, Mino's live repro) had
// no net on the one channel a fresh install starts with. These fixtures pin:
//   - non-numeric channel ids now trigger the guard
//   - a react-only turn satisfies it (an emoji IS an answer in DM terms)
//   - a "[reaction] ..." injection carries no reply obligation
//   - the numeric/receipt paths kept their old behavior
//
// The hook is spawned as a real child with stdin JSON, the way Claude Code
// runs it; AGENT_DATA_HOME points at a scratch dir so the mute-strike ledger
// never touches a live install.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, 'hooks', 'stop-reply-guard.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-replyguard-'))

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

function userText(text) {
  return { type: 'user', message: { content: [{ type: 'text', text }] } }
}
function toolUse(name, input = {}, id = 'tu1') {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }
}
function toolResult(text, id = 'tu1') {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }
}
function channelTag(channelId, body) {
  return `<channel source="x" sender="user" channelId="${channelId}">${body}</channel>`
}

let n = 0
function runGuard(entries, { stopActive = false } = {}) {
  const transcript = path.join(TMP, `t${n++}.jsonl`)
  fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: transcript, stop_hook_active: stopActive }),
    env: { ...process.env, AGENT_DATA_HOME: TMP },
    encoding: 'utf8',
  })
  return { code: r.status, stderr: r.stderr }
}

console.log('\n1. the in-app backend is GUARDED now (the v0.0.34 fix)')
{
  const silent = runGuard([userText(channelTag('in-app', '이거 어떻게 생각해?'))])
  assert(silent.code === 2, 'in-app trigger with no reply call -> exit 2 (was silently 0 before the id-charset fix)')
  assert(silent.stderr.includes('in-app'), 'the bounce names the channel it is about')

  const replied = runGuard([
    userText(channelTag('in-app', '이거 어떻게 생각해?')),
    toolUse('mcp__agent-channel__reply', { text: '좋아' }),
    toolResult('sent (#2)'),
  ])
  assert(replied.code === 0, 'a reply with omitted channelId satisfies it (the local backend has one conversation)')
}

console.log('\n2. a react-only turn is an answered turn')
{
  const reacted = runGuard([
    userText(channelTag('in-app', '고마워!')),
    toolUse('mcp__agent-channel__react', { emoji: '❤️' }),
    toolResult('reacted ❤️ to #1 (#2)'),
  ])
  assert(reacted.code === 0, 'react counts as a reply-class call -- an emoji answer is not bounced into forced words')
}

console.log('\n3. a [reaction] injection carries no reply obligation')
{
  const tap = runGuard([userText(channelTag('in-app', '[reaction] user put 👍 on your message: "plan looks good"'))])
  assert(tap.code === 0, 'a user emoji tap never drafts the agent into a forced 고마워요')
  const realQuestion = runGuard([userText(channelTag('in-app', '아 그리고 [reaction] 얘기가 나와서 말인데, 이거 뭐야?'))])
  assert(realQuestion.code === 2, 'the exemption is prefix-anchored -- mentioning the word mid-message still obliges a reply')
}

console.log('\n4. the pre-existing paths kept their behavior')
{
  assert(runGuard([userText(channelTag('123456', 'hello?'))]).code === 2, 'numeric (Discord) trigger with no reply -> still exit 2')
  const receipt = runGuard([
    userText(channelTag('123456', 'hello?')),
    toolUse('mcp__agent-channel__reply', { text: 'hi', channelId: '999' }, 'tuX'),
    toolResult('delivered_channel=123456', 'tuX'),
  ])
  assert(receipt.code === 0, 'the delivered_channel receipt still outranks wrong args (double-send fix intact)')
  assert(runGuard([userText(channelTag('-100777', 'group ping'))]).code === 2, 'negative Telegram ids still match the trigger regex')
  assert(runGuard([userText(channelTag('123456', '이건 대답하지마'))]).code === 0, 'explicit silence requests still skip')
  assert(runGuard([userText('no channel tag anywhere')]).code === 0, 'no channel trigger -> not applicable')
  const capped = runGuard([userText(channelTag('in-app', 'hello?'))], { stopActive: true })
  assert(capped.code === 0, 'retry cap (stop_hook_active) still allows instead of looping')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
