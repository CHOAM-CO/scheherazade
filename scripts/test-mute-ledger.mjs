#!/usr/bin/env node
// test-mute-ledger.mjs -- fixtures for the mute-strike ledger in
// hooks/stop-reply-guard.mjs (the post-swap convicter that replaced the killed
// swap-time smoke test; see that file's header for the receipts).
//
// Drives the REAL hook as a child process with a REAL transcript jsonl and a
// scratch AGENT_DATA_HOME, and asserts on the ledger file it writes. Nothing
// is stubbed -- the thing under test is the thing that ships.
//
// Run: node scripts/test-mute-ledger.mjs

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'stop-reply-guard.mjs')
const CHANNEL_ID = '1495311473847828652'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-mute-'))
  fs.writeFileSync(path.join(home, '.agent-config'), 'MODEL=kimi-k2.7-code:cloud\nPROVIDER=ollama\n')
  return home
}

// A transcript where a Discord message arrived. `replied` controls whether/how
// the agent called the reply tool afterwards:
//   true      -> explicit channelId matching the trigger
//   'omitted' -> reply with NO channelId (v0.0.11 recommended path; server
//                routes it to the current conversation channel)
//   'wrong'   -> explicit channelId that is NOT the trigger channel
//   false     -> composed text, never called the tool (the 돌연사 shape)
// `deliveredTo` (optional): append the tool_result with channel.mjs's
// `delivered_channel=` receipt stamped to that id -- the guard's
// authoritative match since the 2026-07-15 double-send fix.
function makeTranscript(home, { replied, deliveredTo }) {
  const p = path.join(home, 'transcript.jsonl')
  const rows = [
    { type: 'user', message: { content: `<channel source="x" channelId="${CHANNEL_ID}">안녕</channel>` } },
  ]
  if (replied === true || replied === 'omitted' || replied === 'wrong') {
    const input = replied === 'omitted' ? { text: 'hi' }
      : replied === 'wrong' ? { channelId: '999999999999999999', text: 'hi' }
      : { channelId: CHANNEL_ID, text: 'hi' }
    rows.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_test1', name: 'mcp__agent-channel__reply', input }] },
    })
    if (deliveredTo) {
      rows.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_test1', content: [{ type: 'text', text: `sent to ${deliveredTo} (1 message)\ndelivered_channel=${deliveredTo}` }] }] },
      })
    }
  } else {
    rows.push({ type: 'assistant', message: { content: [{ type: 'text', text: '안녕! (never sent)' }] } })
  }
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return p
}

// Returns { code, ledger }
function runHook(home, { replied, capHit, deliveredTo }) {
  const transcript = makeTranscript(home, { replied, deliveredTo })
  let code = 0
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ transcript_path: transcript, stop_hook_active: Boolean(capHit) }),
      env: { ...process.env, AGENT_DATA_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    code = err.status
  }
  const lp = path.join(home, '.mute-strikes.json')
  const ledger = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf8')) : null
  return { code, ledger }
}

console.log('mute-strike ledger fixtures\n')

// 1. First silent turn (no retry yet) -> BLOCK (exit 2), and NO strike.
//    A single quiet turn is not evidence; forcing the retry is the whole point.
{
  const home = makeHome()
  const { code, ledger } = runHook(home, { replied: false, capHit: false })
  check('first silent turn blocks the stop (exit 2)', code === 2, `got exit ${code}`)
  check('first silent turn scores NO strike', ledger === null || !ledger.strikes, JSON.stringify(ledger))
}

// 2. Retried and STILL silent -> allow (exit 0), strike scored. The mute signature.
{
  const home = makeHome()
  const { code, ledger } = runHook(home, { replied: false, capHit: true })
  check('cap-hit allows the stop (exit 0)', code === 0, `got exit ${code}`)
  check('cap-hit scores strike 1', ledger?.strikes === 1, JSON.stringify(ledger))
  check('strike is stamped with the model', ledger?.model === 'kimi-k2.7-code:cloud', JSON.stringify(ledger))
}

// 3. Strikes accumulate to the threshold (2) across turns.
{
  const home = makeHome()
  runHook(home, { replied: false, capHit: true })
  const { ledger } = runHook(home, { replied: false, capHit: true })
  check('strikes accumulate to threshold', ledger?.strikes === 2, JSON.stringify(ledger))
}

// 4. The agent speaks -> ledger resets. Recovery must clear the alarm, or the
//    revert banner would haunt a model that started working.
{
  const home = makeHome()
  runHook(home, { replied: false, capHit: true })
  runHook(home, { replied: false, capHit: true })
  const { code, ledger } = runHook(home, { replied: true, capHit: false })
  check('a real reply exits 0', code === 0, `got exit ${code}`)
  check('a real reply resets strikes to 0', ledger?.strikes === 0, JSON.stringify(ledger))
}

// 4b. OMITTED channelId reply -> counts as answered (v0.0.11 regression fix,
//     2026-07-15). Since v0.0.11 omitting channelId is the RECOMMENDED path
//     (server routes to the current conversation channel = the trigger).
//     Before the fix this shape drew a spurious exit-2 every turn and false
//     strikes if the model kept omitting.
{
  const home = makeHome()
  runHook(home, { replied: false, capHit: true }) // dirty ledger first
  const { code, ledger } = runHook(home, { replied: 'omitted', capHit: false })
  check('omitted-channelId reply exits 0 (no spurious block)', code === 0, `got exit ${code}`)
  check('omitted-channelId reply resets strikes', ledger?.strikes === 0, JSON.stringify(ledger))
}

// 4c. Explicit WRONG channelId with NO delivery receipt -> blocks. This is
//     the true-failure shape: the tool threw (no fallback available), nothing
//     reached the user. The fix must not blanket-accept every reply-tool call.
{
  const home = makeHome()
  const { code } = runHook(home, { replied: 'wrong', capHit: false })
  check('wrong channelId without delivery receipt blocks (exit 2)', code === 2, `got exit ${code}`)
}

// 4d. Explicit WRONG channelId but the RECEIPT says the server fallback
//     delivered to the trigger channel -> answered (double-send fix,
//     2026-07-15 Melchior catch). Since v0.0.11 the server delivers
//     confabulated ids via fallback + correction note; judging by ARGS here
//     made the guard demand a resend of an already-delivered answer -> the
//     user got the same message twice. Receipt beats aim.
{
  const home = makeHome()
  runHook(home, { replied: false, capHit: true }) // dirty ledger first
  const { code, ledger } = runHook(home, { replied: 'wrong', capHit: false, deliveredTo: CHANNEL_ID })
  check('wrong args but delivered-to-trigger receipt exits 0', code === 0, `got exit ${code}`)
  check('receipt match resets strikes', ledger?.strikes === 0, JSON.stringify(ledger))
}

// 4e. Receipt delivered to a DIFFERENT channel, args also wrong -> the trigger
//     channel wasn't answered, but the agent DID deliver a message somewhere,
//     so it is demonstrably not mute -> allow (exit 0) and clear strikes.
//     REVERSAL (2026-08-13, dual-channel storm fix, hooks/stop-reply-guard.mjs
//     `deliveredAnywhere`): the old contract blocked here (exit 2) and forced a
//     cross-channel resend. With Discord + in-app both live and pings
//     interleaving, that re-convicted on every Stop and the agent spammed 4-5
//     dupes per message (Mino's live repro). The guard's job is muteness, not
//     cross-channel completeness: a delivery anywhere is proof of life. See the
//     matching pins in test-stop-reply-guard.mjs section 5.
{
  const home = makeHome()
  runHook(home, { replied: false, capHit: true }) // dirty the ledger first
  const { code, ledger } = runHook(home, { replied: 'wrong', capHit: false, deliveredTo: '888888888888888888' })
  check('receipt to a different channel is not mute -> exits 0', code === 0, `got exit ${code}`)
  check('delivery elsewhere clears strikes (not mute)', ledger?.strikes === 0, JSON.stringify(ledger))
}

// 5. Model changed under a dirty ledger -> count restarts, does not inherit.
//    Otherwise a swap would carry the old model's guilt onto the new one.
{
  const home = makeHome()
  runHook(home, { replied: false, capHit: true })
  fs.writeFileSync(path.join(home, '.agent-config'), 'MODEL=glm-5.2:cloud\nPROVIDER=ollama\n')
  const { ledger } = runHook(home, { replied: false, capHit: true })
  check('model change restarts the count at 1', ledger?.strikes === 1, JSON.stringify(ledger))
  check('ledger re-stamps the new model', ledger?.model === 'glm-5.2:cloud', JSON.stringify(ledger))
}

// 6. Corrupt ledger must not trap the agent (fail-open contract).
{
  const home = makeHome()
  fs.writeFileSync(path.join(home, '.mute-strikes.json'), '{ this is not json')
  const { code, ledger } = runHook(home, { replied: false, capHit: true })
  check('corrupt ledger still exits cleanly', code === 0, `got exit ${code}`)
  check('corrupt ledger is overwritten, not inherited', ledger?.strikes === 1, JSON.stringify(ledger))
}

// 7. No Discord trigger in the transcript -> hook is not applicable, and must
//    NOT touch the ledger (an agent doing non-Discord work isn't "mute").
{
  const home = makeHome()
  fs.writeFileSync(path.join(home, '.mute-strikes.json'), JSON.stringify({ strikes: 1, model: 'kimi-k2.7-code:cloud' }))
  const tp = path.join(home, 'transcript.jsonl')
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', message: { content: 'just a local task, no channel tag' } }) + '\n')
  let code = 0
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ transcript_path: tp, stop_hook_active: true }),
      env: { ...process.env, AGENT_DATA_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) { code = err.status }
  const ledger = JSON.parse(fs.readFileSync(path.join(home, '.mute-strikes.json'), 'utf8'))
  check('no-Discord-trigger exits 0', code === 0, `got exit ${code}`)
  check('no-Discord-trigger leaves the ledger untouched', ledger.strikes === 1, JSON.stringify(ledger))
}

// 8. Explicit silence request ("답장하지마") -> skip, no strike. The user asked
//    for quiet; punishing the agent for obeying would be the guard eating itself.
{
  const home = makeHome()
  const tp = path.join(home, 'transcript.jsonl')
  fs.writeFileSync(tp, JSON.stringify({
    type: 'user',
    message: { content: `<channel source="x" channelId="${CHANNEL_ID}">답장하지마 그냥 생각만 해</channel>` },
  }) + '\n')
  let code = 0
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ transcript_path: tp, stop_hook_active: true }),
      env: { ...process.env, AGENT_DATA_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) { code = err.status }
  const lp = path.join(home, '.mute-strikes.json')
  check('silence request exits 0', code === 0, `got exit ${code}`)
  check('silence request scores NO strike', !fs.existsSync(lp), 'ledger was written')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
