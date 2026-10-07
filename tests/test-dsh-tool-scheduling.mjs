// Backport guard for deepseek-harness PR #4595 ("fix(agent-loop): settle
// pending tool results before failed steps close", merge 67f648cf0c) applied
// to the pinned @deepseek-ai/dsh-* 0.1.0-rc.7 packages as patch-package
// patches (patches/@deepseek-ai+dsh-session+0.1.0-rc.7.patch and
// patches/@deepseek-ai+dsh-agent-loop+0.1.0-rc.7.patch).
//
// The bug: when tool-call scheduling fails mid-step, the session is left with
// an assistant message whose tool_calls never receive tool results, so every
// later request replays a dangling-call transcript the provider rejects and
// the conversation cannot continue. The fix: dsh-session exports a
// ToolCallRecovery tracker, and the agent loop observes session/event for the
// duration of each step and, when the step throws, appends a conservative
// error tool/result for every unanswered call BEFORE step/end.
//
// Three things are tested here:
//   1. ToolCallRecovery / interruptedTurnClosers over a plain event list
//      (the pure repair logic from repair.ts).
//   2. The same scenario driven through a real rc.7 Session: the recovered
//      results pass surface validation, land as model-visible tool results,
//      and the next turn can be opened.
//   3. Guards: the agent-loop build carries the ported catch path, and both
//      patch files apply cleanly (patch-package --error-on-fail) to the pinned
//      versions.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(path.join(ROOT, 'package.json'))

let passed = 0
let failed = 0
function assert (cond, msg) {
  if (cond) { passed++; console.log(`  ok   ${msg}`) } else { failed++; console.log(`  FAIL ${msg}`) }
}

const session = await import('@deepseek-ai/dsh-session')
const llm = await import('@deepseek-ai/dsh-llm')
const { Session, SessionId, ToolCallRecovery, interruptedTurnClosers, deriveEventMessage, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } = session
const { createAssistantMessage, createUserMessage, CallId } = llm

const CALL_A = CallId('call_a')
const CALL_B = CallId('call_b')

// A step that failed in the scheduler: the assistant asked for two tools,
// call_a was recorded as started (tool/call), call_b never was, and no
// tool/result exists for either. This is exactly the shape the agent loop
// sees inside its catch block.
function failedStepEvents () {
  let seq = 0
  const time = 1700000000000
  const ev = (type, data, extra = {}) => ({ type, seq: seq++, time, data, ...extra })
  return [
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [
        { type: 'tool-call', id: CALL_A, name: 'bash', arguments: '{"cmd":"ls"}' },
        { type: 'tool-call', id: CALL_B, name: 'read', arguments: '{"path":"x"}' },
      ] }),
    }, { surfaceOp: 'append' }),
    ev('tool/call', { turn: 1, step: 1, callId: CALL_A, name: 'bash', arguments: '{"cmd":"ls"}' }),
  ]
}

console.log('1. ToolCallRecovery over a failed-step event list')
{
  assert(typeof ToolCallRecovery === 'function', 'dsh-session exports ToolCallRecovery (PR #4595 index.ts hunk)')
  const events = failedStepEvents()
  const recovery = new ToolCallRecovery()
  for (const e of events) recovery.observe(e)
  const results = recovery.results()
  assert(results.length === 2, `one recovery result per pending call (got ${results.length})`)
  assert(results.every((r) => r.type === 'tool/result' && r.surfaceOp === 'append'), 'results are append-origin tool/result events')
  const byCall = new Map(results.map((r) => [r.data.message.source.callId, r]))
  const a = byCall.get(CALL_A)
  const b = byCall.get(CALL_B)
  assert(a && b, 'both call ids are answered')
  assert(a.data.error.code === TOOL_OUTCOME_UNKNOWN && Array.isArray(a.sourceEventSeqs) && a.sourceEventSeqs[0] === 4,
    'started call -> ToolOutcomeUnknown, citing its tool/call seq')
  assert(b.data.error.code === TOOL_NOT_STARTED && b.sourceEventSeqs === undefined,
    'never-started call -> ToolNotStarted, no source seq')
  assert(results[0].data.message.source.callId === CALL_A && results[1].data.message.source.callId === CALL_B,
    'results keep assistant (model) order')
  assert(results[0].seq === 5 && results[1].seq === 6 && results.every((r) => r.time === events.at(-1).time),
    'seqs continue the log and timestamps reuse the last observed event')
  assert(results.every((r) => r.data.turn === 1 && r.data.step === 1), 'results carry the owning turn/step')
  const block = a.data.message.content[0]
  assert(block.type === 'tool-result' && block.isError === true && block.toolCallId === CALL_A,
    'rc.7 message shape preserved: user-role message with an isError tool-result block')
  // results() must not consume state: a second call yields the same set.
  assert(recovery.results().length === 2, 'results() does not mutate tracked state')
  // A mismatched tool/result (another step) does not clear a pending call.
  recovery.observe({ type: 'tool/result', seq: 5, time: 1, surfaceOp: 'append',
    data: { turn: 1, step: 2, message: { source: { kind: 'tool', callId: CALL_A }, content: [] } } })
  assert(recovery.results().length === 2, 'a tool/result from a different step does not settle the call')
  recovery.observe({ type: 'tool/result', seq: 6, time: 1, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: CALL_A }, content: [] } } })
  assert(recovery.results().length === 1 && recovery.results()[0].data.message.source.callId === CALL_B,
    'a matching tool/result settles only its own call')
  recovery.observe({ type: 'step/end', seq: 7, time: 1, data: { turn: 1, step: 1 } })
  assert(recovery.results().length === 0, 'step/end discards pending requests')
  assert(new ToolCallRecovery().results().length === 0, 'fresh tracker has nothing to recover')
}

console.log('2. interruptedTurnClosers delegates to the same tracker')
{
  const events = failedStepEvents()
  const closers = interruptedTurnClosers(events)
  assert(closers.map((c) => c.type).join(',') === 'tool/result,tool/result,step/end,turn/end',
    'results first, then step/end, then turn/end')
  assert(closers.map((c) => c.seq).join(',') === '5,6,7,8', 'closer seqs are contiguous after the results')
  assert(closers.at(-1).data.reason.kind === 'interrupted', 'turn/end reason is interrupted')
  assert(interruptedTurnClosers([]).length === 0, 'empty log -> no closers')
  const balanced = [...events, ...closers]
  assert(interruptedTurnClosers(balanced).length === 0, 'balanced log -> no closers')
}

console.log('3. a real rc.7 Session accepts the recovered results and the next turn proceeds')
{
  const s = Session.create(SessionId('test-tool-scheduling'))
  const seed = failedStepEvents()
  for (const e of seed) {
    s.append(e.type, e.data, e.surfaceOp === undefined ? undefined : { surfaceOp: e.surfaceOp })
  }
  // Mirror what the patched agent loop does in its catch path: observe the
  // committed events (the loop subscribes to session/event; detached sessions
  // do not publish, so replay the log) and append each recovery result.
  const recovery = new ToolCallRecovery()
  for (const e of s.events) recovery.observe(e)
  let appendError = null
  try {
    for (const event of recovery.results()) {
      s.append('tool/result', event.data, {
        surfaceOp: 'append',
        ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
      })
    }
  } catch (e) { appendError = e }
  assert(appendError === null, `recovered results pass surface validation (${appendError?.message ?? 'ok'})`)
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'scheduler failed', code: 'UNKNOWN' } } })
  let nextTurn = null
  try {
    s.append('turn/start', { turn: 2 })
    s.append('step/start', { turn: 2, step: 1 })
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'again' }] }), { surfaceOp: 'append' })
    nextTurn = true
  } catch (e) { nextTurn = e }
  assert(nextTurn === true, `next turn can be opened on the repaired session (${nextTurn === true ? 'ok' : nextTurn?.message})`)

  // Model-visible surface: every assistant tool call has a tool-result after it.
  const surfaceMessages = s.surface.nodes.map((seq) => deriveEventMessage(s.events[seq])).filter(Boolean)
  const answered = new Set()
  for (const m of surfaceMessages) {
    for (const block of m.content ?? []) if (block.type === 'tool-result') answered.add(block.toolCallId)
  }
  assert(answered.has(CALL_A) && answered.has(CALL_B), 'the projected transcript holds a tool result for each pending call')
  const after = new ToolCallRecovery()
  for (const e of s.events) after.observe(e)
  assert(after.results().length === 0, 'nothing is left pending after recovery + boundaries')
  assert(interruptedTurnClosers(s.events).length === 0 || interruptedTurnClosers(s.events).every((c) => c.type !== 'tool/result'),
    'crash-repair of the repaired log would not fabricate duplicate results')
}

console.log('4. agent-loop build carries the ported catch path')
{
  const loopSrc = fs.readFileSync(require.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8')
  assert(/import \{[^}]*ToolCallRecovery[^}]*\} from "@deepseek-ai\/dsh-session"/.test(loopSrc),
    'agent-loop imports ToolCallRecovery from dsh-session')
  assert(loopSrc.includes('const toolRecovery = new ToolCallRecovery();') &&
    loopSrc.includes('const stopRecovery = this.ctx.on("session/event", (session, event) => {'),
    'each step observes session/event into a fresh tracker')
  assert(loopSrc.includes('for (const event of toolRecovery.results()) this.session.append("tool/result", event.data, {'),
    'the catch path appends a tool/result per pending call before step/end')
  assert(loopSrc.includes('"Step failed and its pending tool results could not be recorded"'),
    'recovery failure is surfaced as an AggregateError with the step error as cause')
  const idx = loopSrc.indexOf('stopRecovery();')
  const stepEnd = loopSrc.indexOf('this.session.append("step/end"', idx)
  assert(idx > 0 && stepEnd > idx && stepEnd - idx < 80, 'the observer is torn down in finally, right before step/end')
}

console.log('5. patch files apply cleanly to the pinned versions')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert(pkg.scripts.postinstall === 'patch-package', 'package.json postinstall runs patch-package (so npm ci on magi-win applies them)')
  assert(typeof pkg.devDependencies['patch-package'] === 'string', 'patch-package is a devDependency')
  for (const name of ['dsh-agent-loop', 'dsh-session']) {
    const pinned = pkg.dependencies[`@deepseek-ai/${name}`] ?? require(`@deepseek-ai/${name}/package.json`).version
    const file = path.join(ROOT, 'patches', `@deepseek-ai+${name}+${pinned}.patch`)
    assert(fs.existsSync(file), `patches/@deepseek-ai+${name}+${pinned}.patch exists for the installed version ${pinned}`)
  }
  const bin = path.join(ROOT, 'node_modules', 'patch-package', 'index.js')
  if (!fs.existsSync(bin)) {
    assert(false, 'node_modules/patch-package/index.js missing -- run npm install')
  } else {
    const r = spawnSync(process.execPath, [bin, '--error-on-fail', '--patch-dir', 'patches'], { cwd: ROOT, encoding: 'utf8' })
    const out = `${r.stdout}\n${r.stderr}`
    assert(r.status === 0, `patch-package --error-on-fail exits 0 (exit ${r.status})`)
    assert(/dsh-session@0\.1\.0-rc\.7/.test(out) && /dsh-agent-loop@0\.1\.0-rc\.7/.test(out),
      'both patches were checked against 0.1.0-rc.7')
    if (r.status !== 0) console.log(out.split('\n').map((l) => '      ' + l).join('\n'))
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
