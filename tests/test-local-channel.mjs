#!/usr/bin/env node
// test-local-channel.mjs — pins the in-app chat backend (channel-local.mjs).
// Run: node tests/test-local-channel.mjs
//
// WHAT THIS COVERS: the notification/reply round trip that IS the feature, the
// outbound queue's cursor semantics, and the HTTP surface's auth and Host
// gates. It imports the module rather than booting it — the isMainModule guard
// means no stdio transport is connected and no port is bound here.
//
// WHAT IT DOES NOT COVER: that Claude Code actually delivers
// notifications/claude/channel to the model (that is the SDK's contract, and
// the other three backends depend on it identically), and the browser page.
//
// Mirrors tests/test-provider-env.mjs's assert()/pass/fail convention.

import fsBoot from 'node:fs'
import osBoot from 'node:os'
import pathBoot from 'node:path'

// HERMETIC (P1, design-0023). channel-local.mjs resolves
//   DATA_HOME = AGENT_DATA_HOME || ~/Documents/<AGENT_NAME || 'agent'>
// AT IMPORT TIME (channel-local.mjs:63-66), sweeps stale atomic tmp files
// there, and §12's send_file_to_discord copies into <DATA_HOME>/chat_uploads.
// With a STATIC import of that module there is no statement this file can run
// first -- ESM hoists and evaluates imports before any module body -- so every
// run of this test wrote into the REAL ~/Documents/agent/ of whoever ran the
// suite. (Verified 2026-09-07: chat_uploads/ mtime tracked the run.) A test
// that touches a real user's data home is not a test you can put in a gate.
//
// So: set the env, THEN import dynamically. The dynamic import cannot be
// hoisted above these lines, which is the whole point.
const TEST_DATA_HOME = fsBoot.mkdtempSync(pathBoot.join(osBoot.tmpdir(), 'sched-local-home-'))
process.env.AGENT_DATA_HOME = TEST_DATA_HOME
process.env.AGENT_NAME = 'local-channel-test'

const {
  enqueueOutbound, enqueueInbound, enqueueReaction, enqueueActivity, readOutbound, resetQueueForTest,
  deliverInbound, deliverReaction, transcriptState, handleToolCall,
  createRequestHandler, LOCAL_CHANNEL_ID, MAX_QUEUE, USER_REACTIONS,
  enableTranscriptPersistence, flushTranscript, clearTranscript,
  enqueueTurnEnd, enqueueAbort,
  upsertBgTask, retireBgTask, listBgTasks,
} = await import('../channel-local.mjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

const TOKEN = 'a'.repeat(64)

// Minimal res double: records what the handler sent.
function makeRes() {
  const res = { code: null, headers: null, body: null, ended: false }
  res.writeHead = (c, h) => { res.code = c; res.headers = h }
  res.end = (b) => { res.body = b; res.ended = true }
  return res
}
function makeReq({ method = 'GET', url = '/', host = '127.0.0.1:1234', token = TOKEN, body = null } = {}) {
  const headers = { host }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body !== null) yield body }
  return req
}
async function call(handler, reqOpts) {
  const res = makeRes()
  await handler(makeReq(reqOpts), res)
  return { code: res.code, json: res.body ? JSON.parse(res.body) : null }
}

console.log('\n1. the round trip: inbound becomes a notification, reply becomes queue')
{
  resetQueueForTest()
  const seen = []
  const notify = async (n) => { seen.push(n) }
  await deliverInbound('hello there', { notify, now: () => 'TS' })
  assert(seen.length === 1, 'inbound emits exactly one notification')
  assert(seen[0].method === 'notifications/claude/channel',
    'uses the SAME method string as the other backends (hooks match it)')
  assert(seen[0].params.content === 'hello there', 'carries the text')
  assert(seen[0].params.meta.channelId === LOCAL_CHANNEL_ID, 'meta carries a stable channelId')
  assert(typeof seen[0].params.meta.sender === 'string' && seen[0].params.meta.sender.length > 0,
    'meta carries a sender (downstream consumers read it unconditionally)')
  assert(seen[0].params.meta.timestamp === 'TS', 'meta carries a timestamp')
}

console.log('\n2. empty inbound is never dropped silently')
{
  const seen = []
  const notify = async (n) => { seen.push(n) }
  // A message that is only whitespace still has to reach the agent as
  // SOMETHING: dropping it would make the UI look broken (user pressed send,
  // nothing happened, no error).
  await deliverInbound('   ', { notify })
  assert(seen.length === 1, 'whitespace-only inbound still notifies')
  assert(seen[0].params.content === '[empty message]', '...as an explicit placeholder, not an empty string')
}

console.log('\n3. outbound cursor semantics')
{
  resetQueueForTest()
  enqueueOutbound('one'); enqueueOutbound('two'); enqueueOutbound('three')
  const all = readOutbound(0)
  assert(all.items.length === 3, 'since=0 returns everything')
  assert(all.latest === 3, 'latest is the newest sequence')
  assert(all.items.map((m) => m.text).join(',') === 'one,two,three', 'order preserved')
  const after = readOutbound(2)
  assert(after.items.length === 1 && after.items[0].text === 'three', 'since=N returns only newer')
  assert(readOutbound(3).items.length === 0, 'a caught-up cursor returns nothing')
  assert(readOutbound(3).missed === false, 'caught up is not "missed"')
  assert(all.items.every((m) => m.role === 'agent'), 'reply-queued messages are tagged as the agent')
}

console.log('\n3b. the queue is a TRANSCRIPT: both roles, one sequence, arrival order')
// The page replays this on every load -- if user messages did not live here
// (v0.0.31), navigation erased the user's half of the conversation and any
// reply landing while the page was away was swallowed by the reload's
// cursor seed. Both 07-30 live-repro symptoms pin on this contract.
{
  resetQueueForTest()
  enqueueInbound('ping')
  enqueueOutbound('pong')
  enqueueInbound('again')
  const all = readOutbound(0)
  assert(all.items.map((m) => m.role).join(',') === 'user,agent,user', 'roles interleave in arrival order')
  assert(all.items.map((m) => m.text).join(',') === 'ping,pong,again', 'one monotonic sequence covers both sides')
  assert(all.latest === 3, 'user messages advance the same cursor agent messages do')
}

console.log('\n3c. presence state: read/typing derive from ONE value (DM interactions, v0.0.34)')
// awaitingReplySince = ts of the OLDEST user message no agent message has
// followed. The page renders both "Read" and the typing dots from it; if
// this value lies, both affordances lie together.
{
  resetQueueForTest()
  assert(transcriptState().awaitingReplySince === null, 'empty transcript: not awaiting')
  assert(readOutbound(0).state && readOutbound(0).state.awaitingReplySince === null,
    '/out carries the state field')
  enqueueInbound('first', { now: () => 111 })
  enqueueInbound('second', { now: () => 222 })
  assert(transcriptState().awaitingReplySince === 111,
    'two unanswered user messages: since = the OLDEST (the wait started there)')
  enqueueOutbound('answered')
  assert(transcriptState().awaitingReplySince === null, 'an agent reply clears the wait')
  enqueueInbound('again', { now: () => 333 })
  assert(transcriptState().awaitingReplySince === 333, 'a new user message reopens it')
  enqueueReaction('agent', '👍', 4)
  assert(transcriptState().awaitingReplySince === null,
    'an agent REACTION clears the wait -- the react tool is a valid whole response, and dots after it would fake activity (07-30 screenshot catch)')
  enqueueInbound('one more', { now: () => 444 })
  assert(transcriptState().awaitingReplySince === 444,
    'a user message AFTER an agent reaction reopens the wait (the walk stops at the reaction)')
  enqueueOutbound('now answered')
  enqueueReaction('user', '❤️', 7)
  assert(transcriptState().awaitingReplySince === null,
    'a user REACTION does not reopen it -- a tap is not a question')
}

// Stop must stay lit through a turn's tool calls even after a mid-turn agent
// message, or in a turn no user message opened (0.3.11 win32/ollama: Send
// only, no Stop, while read/grep/pwsh/edit kept landing).
{
  resetQueueForTest()
  enqueueInbound('fix the draft', { now: () => 100 })
  enqueueOutbound('on it')
  assert(transcriptState().awaitingReplySince === null, 'agent reply alone settles the wait')
  enqueueActivity('read', { now: () => 200 })
  enqueueActivity('pwsh: verify', { now: () => 300 })
  assert(transcriptState().awaitingReplySince === 200,
    'tool calls AFTER a mid-turn agent message keep the turn in flight (since = first trailing work)')
  enqueueOutbound('done')
  assert(transcriptState().awaitingReplySince === null, 'the final reply settles it')
  resetQueueForTest()
  enqueueActivity('pwsh: back up checkpoint', { now: () => 500 })
  assert(transcriptState().awaitingReplySince === 500, 'a background turn with no user message still reads in flight')
  enqueueTurnEnd()
  assert(transcriptState().awaitingReplySince === null, 'the lane turn-end settles a background turn')
  resetQueueForTest()
}

console.log('\n3d. reactions are transcript items: same cursor, replayable, self-describing')
{
  resetQueueForTest()
  enqueueInbound('nice work')
  const rSeq = enqueueReaction('agent', '👍', 1)
  const all = readOutbound(0)
  assert(all.latest === 2 && rSeq === 2, 'a reaction advances the same monotonic cursor')
  const item = all.items[1]
  assert(item.kind === 'reaction' && item.role === 'agent' && item.emoji === '👍' && item.targetSeq === 1,
    'the item names its kind, reactor, emoji and target')
  assert(item.text === '👍', 'text mirrors the emoji so a kind-blind consumer still shows something true')
}

console.log('\n4. the queue is bounded, and falling behind is REPORTED not hidden')
{
  resetQueueForTest()
  for (let i = 0; i < MAX_QUEUE + 50; i++) enqueueOutbound(`m${i}`)
  const r = readOutbound(0)
  assert(r.items.length === MAX_QUEUE, `queue trims to MAX_QUEUE (${MAX_QUEUE})`)
  assert(r.latest === MAX_QUEUE + 50, 'sequence numbers keep counting across a trim')
  assert(r.items[r.items.length - 1].text === `m${MAX_QUEUE + 49}`, 'the NEWEST survive, not the oldest')
  // The whole point of monotonic sequences: a client that slept through a trim
  // must be able to tell it lost messages. Array indices cannot express this.
  assert(readOutbound(1).missed === true, 'a stale cursor is told it missed messages')
  assert(readOutbound(MAX_QUEUE + 49).missed === false, 'a fresh cursor is not')
}

console.log('\n5. HTTP: the auth gate')
{
  resetQueueForTest()
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })
  assert((await call(handler, { url: '/out' })).code === 200, 'correct token passes')
  assert((await call(handler, { url: '/out', token: 'b'.repeat(64) })).code === 401, 'wrong token of the SAME LENGTH is rejected')
  assert((await call(handler, { url: '/out', token: 'short' })).code === 401, 'wrong-length token is rejected (no timingSafeEqual throw)')
  assert((await call(handler, { url: '/out', token: null })).code === 401, 'missing Authorization is rejected')
  assert((await call(handler, { url: '/health', token: null })).code === 200, '/health stays open (liveness probe, leaks nothing)')
  // /health answers with the name the USER set (2026-09-28): the shell header
  // and the chat sender row render DISPLAY_NAME, and a probe that answered
  // AGENT_NAME made the same agent have two names depending on who asked.
  // The source is DATA_HOME/.agent-config -- the KEY="value" file the
  // supervisor parses; AGENT_NAME is the build default and the fallback.
  const cfgPath = pathBoot.join(TEST_DATA_HOME, '.agent-config')
  fsBoot.writeFileSync(cfgPath, 'DISPLAY_NAME="밤의도시"\n')
  assert((await call(handler, { url: '/health', token: null })).json.agent === '밤의도시',
    '/health answers DISPLAY_NAME when .agent-config has one')
  fsBoot.rmSync(cfgPath, { force: true })
  assert((await call(handler, { url: '/health', token: null })).json.agent === 'local-channel-test',
    '/health falls back to AGENT_NAME with no .agent-config (the build default, never an error)')
}

console.log('\n6. HTTP: the Host gate (DNS rebinding resolves to 127.0.0.1 too)')
{
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })
  assert((await call(handler, { url: '/out', host: 'evil.example.com' })).code === 403, 'foreign Host is rejected')
  assert((await call(handler, { url: '/out', host: 'localhost:5000' })).code === 200, 'localhost is accepted')
  assert((await call(handler, { url: '/out', host: '[::1]:5000' })).code === 200, 'IPv6 loopback is accepted')
  // Rejected BEFORE auth: otherwise a rebinding page learns whether its guess
  // at the token was length-correct from the difference between 401 and 403.
  assert((await call(handler, { url: '/out', host: 'evil.example.com', token: null })).code === 403,
    'Host is checked before auth, so the two cannot be distinguished by a rebinder')
}

console.log('\n7. HTTP: posting a message')
{
  resetQueueForTest()
  const seen = []
  const handler = createRequestHandler({ notify: async (n) => seen.push(n), token: TOKEN })
  const ok = await call(handler, { method: 'POST', url: '/in', body: JSON.stringify({ text: 'hi' }) })
  assert(ok.code === 202, 'a valid post is accepted')
  assert(seen.length === 1 && seen[0].params.content === 'hi', '...and reaches the agent as a notification')
  const echoed = readOutbound(0)
  assert(echoed.items.length === 1 && echoed.items[0].role === 'user' && echoed.items[0].text === 'hi',
    '...and lands in the transcript as the user, so a reload can replay it')
  assert((await call(handler, { method: 'POST', url: '/in', body: '{not json' })).code === 400, 'malformed json -> 400')
  assert((await call(handler, { method: 'POST', url: '/in', body: '{}' })).code === 400, 'missing text -> 400')
  assert((await call(handler, { method: 'POST', url: '/in', body: JSON.stringify({ text: '  ' }) })).code === 400,
    'blank text -> 400 at the HTTP edge (the agent is never woken for nothing)')
  assert((await call(handler, { method: 'GET', url: '/nope' })).code === 404, 'unknown path -> 404')
}

console.log('\n7a. HTTP: POST /interrupt (turn-level STOP, 0.3.1)')
// The stop seam's contract at the channel edge: the interrupter's fixed
// reason enum is passed through UNCHANGED (the proxy above maps one
// vocabulary, and lane prose must never enter it), a 'no_turn' becomes a
// 409 rather than an error, and NOTHING is written to the transcript -- a
// user cancelling their own question is not a message to the agent.
{
  resetQueueForTest()
  const calls = []
  const ok = createRequestHandler({ notify: async () => {}, token: TOKEN, interrupt: async () => { calls.push(1); return { ok: true } } })
  const r = await call(ok, { method: 'POST', url: '/interrupt', body: '{}' })
  assert(r.code === 200, 'a stop with a turn in flight -> 200')
  assert(calls.length === 1, '...and reaches the lane interrupter exactly once')
  assert(readOutbound(0).items.length === 0, '...and writes NOTHING to the transcript')

  const noTurn = createRequestHandler({ notify: async () => {}, token: TOKEN, interrupt: async () => ({ ok: false, reason: 'no_turn' }) })
  const r2 = await call(noTurn, { method: 'POST', url: '/interrupt', body: '{}' })
  assert(r2.code === 409, "'no_turn' -> 409 (the turn ended while the click was in flight)")
  assert(r2.json.reason === 'no_turn', '...with the reason passed through unchanged')

  const dead = createRequestHandler({ notify: async () => {}, token: TOKEN, interrupt: async () => ({ ok: false, reason: 'unreachable' }) })
  const r3 = await call(dead, { method: 'POST', url: '/interrupt', body: '{}' })
  assert(r3.code === 502 && r3.json.reason === 'unreachable', 'a failed stop -> 502 with its own reason')

  // A host that wired no lane seam (attach topology) must read as
  // 'not_running', not as a 404 the page cannot interpret.
  const unwired = createRequestHandler({ notify: async () => {}, token: TOKEN })
  const r4 = await call(unwired, { method: 'POST', url: '/interrupt', body: '{}' })
  assert(r4.code === 503 && r4.json.reason === 'not_running',
    'no interrupt seam wired -> 503 not_running (never a bare 404)')

  // same gates as every other mutating route
  assert((await call(ok, { method: 'POST', url: '/interrupt', body: '{}', token: null })).code === 401, 'tokenless stop -> 401')
  assert((await call(ok, { method: 'POST', url: '/interrupt', body: '{}', host: 'evil.example.com' })).code === 403, 'foreign Host stop -> 403')
  assert((await call(ok, { method: 'GET', url: '/interrupt' })).code === 404, 'GET /interrupt -> 404 (stop is mutating)')
}

// Stop on a trailing-work turn (after a mid-turn reply): an honoured stop
// leaves the turn-abort that settles the pane; a lane 'no_turn' settles it too.
{
  resetQueueForTest()
  enqueueInbound('go'); enqueueOutbound('on it'); enqueueActivity('pwsh: x')
  const h = createRequestHandler({ notify: async () => {}, token: TOKEN, interrupt: async () => ({ ok: true }) })
  assert((await call(h, { method: 'POST', url: '/interrupt', body: '{}' })).code === 200, 'stop mid tool-call after a reply -> 200')
  assert(readOutbound(0).items.some((m) => m.kind === 'turn-abort' && m.reason === 'stop') && transcriptState().awaitingReplySince === null,
    '...writes the turn-abort and settles the wait')
  resetQueueForTest()
  enqueueActivity('pwsh: y')
  const n = createRequestHandler({ notify: async () => {}, token: TOKEN, interrupt: async () => ({ ok: false, reason: 'no_turn' }) })
  assert((await call(n, { method: 'POST', url: '/interrupt', body: '{}' })).code === 409, 'no_turn over trailing work -> 409')
  assert(transcriptState().awaitingReplySince === null, '...and the trailing work is settled (Stop does not stay lit)')
  resetQueueForTest()
}

// Stop during OUTPUT ("Out이든"): a turn that is only streaming its reply
// (mid-turn reply already sent, no tool line) reads in flight; Stop settles it.
{
  resetQueueForTest()
  enqueueInbound('go'); enqueueOutbound('on it')
  const h = createRequestHandler({ notify: async () => {}, token: TOKEN, interrupt: async () => ({ ok: true }) })
  assert(transcriptState().awaitingReplySince === null, 'before the stream: settled')
  assert((await call(h, { method: 'POST', url: '/activity', body: JSON.stringify({ kind: 'stream', label: 'Here is the' }) })).code === 202, 'stream chunk accepted')
  assert(transcriptState().awaitingReplySince !== null, 'a live draft keeps the turn in flight (Stop shown during output)')
  assert((await call(h, { method: 'POST', url: '/interrupt', body: '{}' })).code === 200, 'stop mid-stream -> 200')
  assert(transcriptState().awaitingReplySince === null && readOutbound(0).draft === null, '...settles the turn and retires the draft')
  await call(h, { method: 'POST', url: '/activity', body: JSON.stringify({ kind: 'stream', label: 'x' }) })
  await call(h, { method: 'POST', url: '/activity', body: JSON.stringify({ kind: 'stream', done: true }) })
  assert(transcriptState().awaitingReplySince === null, 'a stream done-post settles it too')
  resetQueueForTest()
}

console.log('\n7b. a failed delivery never fakes a transcript entry')
// enqueueInbound runs only after deliverInbound resolves: if the notify
// throws, the client gets its error (and keeps the input text), and the
// transcript must not claim the agent received something it did not.
{
  resetQueueForTest()
  const handler = createRequestHandler({ notify: async () => { throw new Error('dead pipe') }, token: TOKEN })
  const r = await call(handler, { method: 'POST', url: '/in', body: JSON.stringify({ text: 'lost' }) })
  assert(r.code === 500, 'a failed delivery surfaces as an error, not a 202')
  assert(readOutbound(0).items.length === 0, '...and the transcript records nothing')
}

console.log('\n7c. the react tool: agent -> emoji on the user bubble')
{
  resetQueueForTest()
  const none = await handleToolCall('react', { emoji: '👍' })
  assert(none.isError === true, 'reacting before the user wrote anything is a named error, not a crash')
  enqueueInbound('did you see it?')
  enqueueOutbound('looking now')
  enqueueInbound('take your time')
  const r = await handleToolCall('react', { emoji: '👍' })
  assert(!r.isError && r.content[0].text.includes('#3'), "default target is the user's LATEST message")
  const items = readOutbound(0).items
  const reaction = items[items.length - 1]
  assert(reaction.kind === 'reaction' && reaction.role === 'agent' && reaction.targetSeq === 3,
    '...and it lands in the transcript pointing at that message')
  const explicit = await handleToolCall('react', { emoji: '❤️', targetSeq: 1 })
  assert(!explicit.isError && readOutbound(0).items.pop().targetSeq === 1, 'explicit targetSeq is honored')
  assert((await handleToolCall('react', { emoji: '' })).isError === true, 'empty emoji is refused')
  assert((await handleToolCall('react', { emoji: 'x'.repeat(20) })).isError === true,
    'a paragraph riding the reaction lane is refused (length cap)')
  assert((await handleToolCall('react', { emoji: '👍', targetSeq: 999 })).isError === true,
    'a targetSeq that does not exist is refused')
}

console.log('\n7d. HTTP /react: user tap -> injected like a MAGI reaction, recorded only after delivery')
{
  resetQueueForTest()
  const seen = []
  const handler = createRequestHandler({ notify: async (n) => seen.push(n), token: TOKEN })
  enqueueOutbound('here is the plan')
  const ok = await call(handler, { method: 'POST', url: '/react', body: JSON.stringify({ emoji: '❤️', targetSeq: 1 }) })
  assert(ok.code === 202, 'a valid tap is accepted')
  assert(seen.length === 1 && seen[0].params.content.startsWith('[reaction]'),
    'the agent sees it as a [reaction] injection (the prefix stop-reply-guard exempts)')
  assert(seen[0].params.content.includes('❤️') && seen[0].params.content.includes('here is the plan'),
    '...naming the emoji and quoting the target')
  const items = readOutbound(0).items
  const rec = items[items.length - 1]
  assert(rec.kind === 'reaction' && rec.role === 'user' && rec.targetSeq === 1, 'and it lands in the transcript')
  assert((await call(handler, { method: 'POST', url: '/react', body: JSON.stringify({ emoji: '🔥', targetSeq: 1 }) })).code === 400,
    `an emoji outside the fixed menu (${USER_REACTIONS.join(' ')}) is refused`)
  assert((await call(handler, { method: 'POST', url: '/react', body: JSON.stringify({ emoji: '👍', targetSeq: 99 }) })).code === 404,
    'a seq that does not exist is refused')
  enqueueInbound('my own message')
  assert((await call(handler, { method: 'POST', url: '/react', body: JSON.stringify({ emoji: '👍', targetSeq: 3 }) })).code === 404,
    "the page only reacts to AGENT bubbles; a crafted request can't decorate the user's own")
  // Delivered-then-recorded, same contract as /in (§7b):
  const dead = createRequestHandler({ notify: async () => { throw new Error('dead pipe') }, token: TOKEN })
  const before = readOutbound(0).items.length
  const failed = await call(dead, { method: 'POST', url: '/react', body: JSON.stringify({ emoji: '👍', targetSeq: 1 }) })
  assert(failed.code === 500, 'a failed delivery surfaces as an error, not a 202')
  assert(readOutbound(0).items.length === before, '...and the transcript records no reaction the agent never saw')
}

console.log('\n8. an oversized body is refused rather than buffered')
{
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })
  const big = JSON.stringify({ text: 'x'.repeat(200_000) })
  const r = await call(handler, { method: 'POST', url: '/in', body: big })
  assert(r.code === 413, 'over the cap -> 413')
}

console.log('\n9. orphan guard: parent death (stdin EOF) takes the process AND the port file down')
// The one section that boots the real file as a child instead of importing
// it -- the guard lives in boot(), which the isMainModule guard keeps out of
// every import-based section above. Found live 2026-07-30: a killed parent
// left the channel orphaned, /health stayed green, and the chat page said
// "listening" while notifications went into a dead pipe. stdin EOF is the
// signal every dying parent sends; the port file must go FIRST so the proxy
// reads an honest not_running instead of probing a corpse.
{
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-orphan-'))
  const portFile = path.join(tmp, 'local-channel.json')

  const child = spawn(process.execPath, [path.join(ROOT, 'channel-local.mjs')], {
    env: { ...process.env, AGENT_NAME: 'orphan-test', AGENT_DATA_HOME: tmp },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // MCP handshake so boot() completes (the transport awaits nothing, but a
  // real parent always sends this; keeping it makes the fixture honest).
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n')

  const deadline = Date.now() + 10_000
  while (!fs.existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert(fs.existsSync(portFile), 'child boots and writes the port file')

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  child.stdin.end() // parent death, as the child sees it
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 5_000))])
  assert(code === 0, `stdin EOF exits the process cleanly (got ${code})`)
  assert(!fs.existsSync(portFile), 'the port file is deleted on the way out')
  if (code === 'TIMEOUT') child.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n10. boot greeting: no direct startup system line')
// Real child and marker exercise the shared startup path without a model.
{
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-announce-'))
  // Marker BEFORE spawn, the way the supervisor writes it before each leaf.
  fs.writeFileSync(path.join(tmp, '.boot-event.json'), JSON.stringify({ ts: Date.now(), iteration: 1 }))

  const child = spawn(process.execPath, [path.join(ROOT, 'channel-local.mjs')], {
    env: { ...process.env, AGENT_NAME: 'announce-test', AGENT_DATA_HOME: tmp },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutLines = []
  let outBuf = ''
  child.stdout.on('data', (c) => {
    outBuf += c
    let nl
    while ((nl = outBuf.indexOf('\n')) >= 0) { stdoutLines.push(outBuf.slice(0, nl)); outBuf = outBuf.slice(nl + 1) }
  })

  const portFile = path.join(tmp, 'local-channel.json')
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert(fs.existsSync(portFile), 'child boots and writes the port file')
  const ep = JSON.parse(fs.readFileSync(portFile, 'utf8'))

  let out = { items: [] }
  while (!stdoutLines.some(line => line.includes('notifications/claude/channel')) && Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${ep.port}/out`, { headers: { authorization: `Bearer ${ep.token}` } })
      if (r.status === 200) out = await r.json()
    } catch { /* listener racing up */ }
    if (out.items.length === 0) await new Promise((r) => setTimeout(r, 150))
  }
  assert(out.items.length === 0, 'startup sends no system line to the conversation')
  const greetInject = stdoutLines
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .find((m) => m && m.method === 'notifications/claude/channel' && m.params && m.params.meta && m.params.meta.sender === 'SYSTEM')
  assert(Boolean(greetInject), 'the greeting inject reaches the model as a SYSTEM notification')
  assert(greetInject && greetInject.params.meta.channelId === 'in-app', 'the inject points the model at the in-app conversation')
  assert(!fs.existsSync(path.join(tmp, '.boot-event.json')), 'the marker is consumed (no double-announce within one life)')

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  child.stdin.end()
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 5_000))])
  if (code === 'TIMEOUT') child.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── activity hook: per-tool labels (2026-08-13 widening) ───────────────────
// The hook was Bash-only; a research turn of 20 WebSearch/WebFetch/subagent
// calls showed NOTHING in the chat fold (Mino field report). Pins the label
// each covered tool produces and that uncovered tools stay OFF the feed.
{
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const hookTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-activity-hook-'))
  const seen = []
  const { createServer } = await import('node:http')
  const srv = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { seen.push(JSON.parse(b).label); res.end('{}') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  fs.writeFileSync(path.join(hookTmp, 'local-channel.json'), JSON.stringify({ port: srv.address().port, token: 't' }))
  const fire = (tool_name, tool_input) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'pre-tool-activity.mjs')], {
    input: JSON.stringify({ tool_name, tool_input }),
    env: { ...process.env, AGENT_DATA_HOME: hookTmp },
    timeout: 5000,
  })
  fire('Bash', { description: 'Install package dependencies' })
  fire('PowerShell', { command: 'Get-Process Scheherazade' })
  fire('WebSearch', { query: 'GPT 5.6 SOL how to use' })
  fire('WebFetch', { url: 'https://platform.openai.com/docs/codex?x=1' })
  fire('Agent', { description: 'Codex research', subagent_type: 'researcher' })
  fire('Task', { subagent_type: 'researcher' })
  fire('Read', { file_path: '/etc/hosts' })
  await new Promise((r) => setTimeout(r, 200))
  srv.close()
  assert(seen[0] === 'Install package dependencies', 'Bash label stays bare (model-written description)')
  assert(seen[1] === 'Get-Process Scheherazade', 'PowerShell (Windows shell tool name) rides the Bash path, command fallback')
  assert(seen[2] === 'WebSearch: GPT 5.6 SOL how to use', 'WebSearch label carries the query')
  assert(seen[3] === 'WebFetch: platform.openai.com/docs/codex', 'WebFetch label is host+path, query string dropped')
  assert(seen[4] === 'Subagent: Codex research', 'Agent spawn prefers the description')
  assert(seen[5] === 'Subagent: researcher', 'Task (pre-2.1 tool name) falls back to subagent_type')
  assert(seen.length === 6, 'uncovered tools (Read) stay OFF the feed')
  fs.rmSync(hookTmp, { recursive: true, force: true })
}

// ── memory reads: the same hook, the OTHER destination (2026-09-28) ─────────
// A memory read has to reach the channel (it arms the mark the next reply
// carries) and must NOT become an activity label: that feed is a status line,
// and a recall happens at nearly every boot — one row saying nothing, forever.
// Asserted over a real server, so the ROUTE is what is pinned, not a string in
// the source: a read that quietly started posting labels again would still
// pass a source grep.
{
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const hookTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-memmark-hook-'))
  const hits = []
  const { createServer } = await import('node:http')
  const srv = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { hits.push({ url: req.url, auth: req.headers.authorization, body: b }); res.end('{}') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  fs.writeFileSync(path.join(hookTmp, 'local-channel.json'), JSON.stringify({ port: srv.address().port, token: 'tok' }))
  const fire = (tool_name, tool_input) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'pre-tool-activity.mjs')], {
    input: JSON.stringify({ tool_name, tool_input }),
    env: { ...process.env, AGENT_DATA_HOME: hookTmp },
    timeout: 5000,
  })
  const readStatus = fire('mcp__memory__memory_query', { table: 'user_facts' })
  fire('mcp__memory__journal_read', { limit: 3 })
  fire('mcp__memory__memory_recall_material', {})
  fire('mcp__memory__memory_write', { table: 'user_facts', data: { subject: 'a', predicate: 'b', value: 'c' } })
  await new Promise((r) => setTimeout(r, 200))
  srv.close()
  assert(readStatus.status === 0 && !readStatus.stderr.toString().trim(),
    'the memory branch stays fail-open and silent (exit 0, nothing on stderr)')
  assert(hits.length === 3, `only the three READ-class calls post, got ${hits.length}`)
  assert(hits.every((h) => h.url === '/memory-read'),
    '...and they post to /memory-read, never to /activity (a read is not a status line)')
  assert(hits.every((h) => h.auth === 'Bearer tok'), 'the memory post carries the same bearer token as the feed')
  assert(hits.every((h) => h.body === ''), 'no body: the signal is the call itself, so no label can be invented from it')
  fs.rmSync(hookTmp, { recursive: true, force: true })
}

// ── activity items: presence of WORK, not an answer (Codex §7 steal) ───────
{
  resetQueueForTest()
  enqueueInbound('do the thing')
  const before = transcriptState()
  assert(before.awaitingReplySince !== null, 'user message opens the awaiting state')

  enqueueActivity('Install package dependencies')
  const during = transcriptState()
  assert(during.awaitingReplySince === before.awaitingReplySince,
    'an activity item does NOT clear awaiting (running a command is not answering)')

  const drained = readOutbound(0)
  assert(drained.items.some((m) => m.kind === 'activity' && m.text === 'Install package dependencies'),
    'the activity item rides the same queue the page already drains')

  enqueueOutbound('done')
  assert(transcriptState().awaitingReplySince === null, 'a real reply still clears awaiting')

  // over the wire: auth required, label required, cap enforced
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })
  {
    const res = makeRes()
    await handler(makeReq({ method: 'POST', url: '/activity', token: null, body: JSON.stringify({ label: 'x' }) }), res)
    assert(res.code === 401, 'POST /activity without the bearer token is refused')
  }
  {
    const res = makeRes()
    await handler(makeReq({ method: 'POST', url: '/activity', body: JSON.stringify({}) }), res)
    assert(res.code === 400, 'POST /activity without a label is refused')
  }
  {
    const res = makeRes()
    await handler(makeReq({ method: 'POST', url: '/activity', body: JSON.stringify({ label: 'z'.repeat(500) }) }), res)
    assert(res.code === 202, 'POST /activity with a label lands')
    const tail = readOutbound(0).items.at(-1)
    assert(tail.kind === 'activity' && tail.text.length === 160, 'oversized labels are truncated to 160, not rejected')
  }
}

// ── memory mark: the flag one memory read arms for the NEXT reply (2026-09-28) ─
// The agent's memory is a separate MCP process, so the only witness to a read
// is the hook's POST /memory-read. What that post does is ARM A FLAG; the next
// outbound agent message carries it as `fromMemory` and the flag is consumed.
// Pinned here: the gate, the one-shot, the field surviving the outbound read
// and the durable transcript, and the false-mark guard (a read whose turn never
// produced a reply must not stamp the next turn).
{
  resetQueueForTest()
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })

  assert((await call(handler, { method: 'POST', url: '/memory-read', token: null })).code === 401,
    'POST /memory-read without the bearer token is refused')
  assert((await call(handler, { method: 'POST', url: '/memory-read', token: 'b'.repeat(64) })).code === 401,
    'POST /memory-read refuses a wrong token of the SAME length (the shared timingSafeEqual gate)')
  assert((await call(handler, { method: 'POST', url: '/memory-read', host: 'evil.example.com' })).code === 403,
    'POST /memory-read keeps the Host gate (no second auth path was invented)')

  assert((await call(handler, { method: 'POST', url: '/memory-read' })).code === 202, 'a memory read lands as 202')
  assert(readOutbound(0).items.length === 0,
    'the read itself enqueues NOTHING -- it is a flag, not an activity item or a draft')
  assert(readOutbound(0).draft === null && transcriptState().awaitingReplySince === null,
    'the read adds no presence either -- no draft, no awaiting state')

  enqueueOutbound('the reply that came out of memory')
  assert(readOutbound(0).items.at(-1).fromMemory === true, 'the NEXT agent message carries fromMemory: true')
  enqueueOutbound('the reply after that')
  assert(readOutbound(0).items.at(-1).fromMemory === undefined,
    '...and the message after it does NOT inherit the mark (consumed in the same breath)')
  assert(readOutbound(0).items.filter((m) => m.fromMemory === true).length === 1,
    'exactly one item in the drained transcript is marked')

  // The flag is turn-scoped: a read that never got a reply (a mute turn, a
  // background turn) must not stamp an answer written from thin air later.
  assert((await call(handler, { method: 'POST', url: '/memory-read' })).code === 202, 'a second read arms again')
  enqueueInbound('a new question')
  assert(readOutbound(0).items.at(-1).fromMemory === undefined, 'the inbound message is never marked')
  enqueueOutbound('answered from thin air')
  assert(readOutbound(0).items.at(-1).fromMemory === undefined,
    'a read left unspent by its own turn does not mark the next turn (new inbound closes the window)')

  // The user's own bubbles can never carry it (the flag only rides agent
  // messages -- enqueueInbound has no path to it at all).
  assert(!readOutbound(0).items.some((m) => m.role === 'user' && m.fromMemory !== undefined),
    'no user message can be marked as coming from memory')
}

// ── memory mark survives the restart: it rides the persisted message item ────
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-memmark-'))
  resetQueueForTest()
  await enableTranscriptPersistence({ dataHome: tmp })
  enqueueInbound('what do you remember about me?')
  enqueueOutbound('you prefer short answers') // unflagged
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })
  await call(handler, { method: 'POST', url: '/memory-read' })
  enqueueOutbound('and you keep a night journal') // flagged
  await flushTranscript()

  resetQueueForTest()
  const { restored } = await enableTranscriptPersistence({ dataHome: tmp })
  assert(restored === 3, `the flagged transcript restores whole, got ${restored}`)
  const replay = readOutbound(0)
  assert(replay.items[2].fromMemory === true,
    'fromMemory is a field of the kind:\'message\' item, so it survives into the durable transcript')
  assert(replay.items[1].fromMemory === undefined, 'and the unflagged reply in the same file stays unflagged')
  assert(replay.items[0].fromMemory === undefined, 'the restored user message is unflagged')

  await flushTranscript()
  resetQueueForTest()
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── answer-stream draft (0.2.4 두두두둑): grows BESIDE the queue, never in it ──
{
  resetQueueForTest()
  enqueueInbound('question')
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })
  const post = async (body) => {
    const res = makeRes()
    await handler(makeReq({ method: 'POST', url: '/activity', body: JSON.stringify(body) }), res)
    return res
  }

  assert((await post({ kind: 'stream', label: 'Hello ' })).code === 202, 'stream chunk lands as 202')
  await post({ kind: 'stream', label: ' world' })
  const out = readOutbound(0)
  assert(out.draft === 'Hello  world', 'stream chunks append UNTRIMMED (mid-sentence whitespace is content)')
  assert(!out.items.some((m) => m.kind === 'stream'), 'a draft is not a queue item and consumes no seq')
  assert(out.state.awaitingReplySince !== null, 'a draft does NOT clear awaiting (half an answer is not an answer)')

  assert((await post({ kind: 'stream', done: true })).code === 202, 'done post (no label) is accepted')
  assert(readOutbound(0).draft === null, 'done retires the draft (reply-less turn path)')

  assert((await post({ kind: 'stream' })).code === 400, 'stream with neither label nor done is refused')

  await post({ kind: 'stream', label: 'draft again' })
  enqueueOutbound('the real reply')
  assert(readOutbound(0).draft === null, 'the authoritative reply supersedes and clears its own draft')

  await post({ kind: 'stream', label: 'stale half-answer' })
  await clearTranscript()
  assert(readOutbound(0).draft === null, 'clearTranscript drops the draft with the thread')

  // promote: a convicted mute turn's composed text BECOMES the message
  // (lane-side rationale: opus-4-6 refused a live nudge as prompt
  // injection, E2E 2026-08-20 -- promotion is deterministic delivery).
  await post({ kind: 'stream', label: '그리는 중...' })
  assert((await post({ kind: 'stream', promote: true, label: '완성된 답변이야.' })).code === 202, 'promote post lands')
  const after = readOutbound(0)
  assert(after.draft === null, 'promotion retires the draft in the same breath')
  const lastMsg = after.items.filter((m) => m.kind === 'message').at(-1)
  assert(lastMsg && lastMsg.role === 'agent' && lastMsg.text === '완성된 답변이야.',
    'the promoted text enqueues as a normal agent message (clears awaiting, persists, renders)')
  assert(after.state.awaitingReplySince === null, 'a promoted message answers the user like a reply does')
}

console.log('\n10b. clearTranscript: the "New conversation" clean break (2026-08-18)')
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-clear-'))
  resetQueueForTest()
  await enableTranscriptPersistence({ dataHome: tmp })
  enqueueInbound('one')
  enqueueOutbound('two')
  enqueueInbound('three')
  await flushTranscript()
  const before = readOutbound(0)
  assert(before.items.length === 3, 'precondition: three items queued')
  assert(before.latest === 3, 'precondition: cursor at 3')

  const durable = await clearTranscript()
  assert(durable === true, 'clearTranscript resolves to the durability boolean (empty state reached disk)')
  const after = readOutbound(0)
  assert(after.items.length === 0, 'clearTranscript empties the in-memory queue')
  assert(after.latest === 3, 'clearTranscript keeps seq MONOTONIC (no rewind for a page holding a cursor)')

  const file = path.join(tmp, 'chat-transcript.json')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert(Array.isArray(onDisk.queue) && onDisk.queue.length === 0, 'the cleared state is persisted (empty queue survives a reload)')
  assert(onDisk.seq === 3, 'the persisted seq stays monotonic across the clear')

  // A restart-style restore reads back the empty transcript, and the next
  // message continues the sequence past the pre-clear high-water mark.
  resetQueueForTest()
  const { restored } = await enableTranscriptPersistence({ dataHome: tmp })
  assert(restored === 0, 'a restart after clear restores an empty conversation')
  const next = enqueueInbound('fresh')
  assert(next === 4, `post-clear enqueue continues at seq 4 (monotonic), got ${next}`)

  await flushTranscript()
  resetQueueForTest()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n10c. HTTP /clear: token-gated, empties the transcript, keeps seq')
{
  resetQueueForTest()
  const handler = createRequestHandler({ notify: () => {}, token: TOKEN })
  enqueueInbound('keep the cursor honest')
  enqueueOutbound('sure')
  assert(readOutbound(0).items.length === 2, 'precondition: two items before clear')

  // Auth gate: a tokenless /clear must be refused like every other mutating route.
  const noAuth = await call(handler, { method: 'POST', url: '/clear', token: null })
  assert(noAuth.code === 401, '/clear without a token is rejected (401)')
  assert(readOutbound(0).items.length === 2, 'a rejected /clear does NOT touch the transcript')

  const ok = await call(handler, { method: 'POST', url: '/clear' })
  assert(ok.code === 200, 'authorized POST /clear returns 200')
  assert(ok.json && ok.json.ok === true, '/clear reports ok')
  const after = readOutbound(0)
  assert(after.items.length === 0, 'POST /clear empties the transcript')
  assert(after.latest === 2, 'POST /clear keeps seq monotonic')

  // Only POST clears; a stray GET /clear is a 404, not an accidental wipe.
  enqueueOutbound('still here')
  const getClear = await call(handler, { method: 'GET', url: '/clear' })
  assert(getClear.code === 404, 'GET /clear is not a route (404), only POST clears')
  assert(readOutbound(0).items.length === 1, 'GET /clear left the transcript intact')
  resetQueueForTest()
}

// ── transcript persistence: the app-relaunch path (Mino, 2026-08-04) ───────
// Before this existed, the queue died with the process and reopening the app
// showed an empty chat. Persistence is OPT-IN (boot() enables it) precisely
// so THIS file's other sections -- which import the module and enqueue
// fixture chatter -- never write into a real user's DATA_HOME.
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-transcript-'))
  resetQueueForTest()
  await enableTranscriptPersistence({ dataHome: tmp })
  enqueueInbound('remember me')
  enqueueOutbound('I will')
  enqueueReaction('agent', '👍', 1)
  enqueueActivity('running npm test') // must NOT survive the restart below
  await flushTranscript()

  const file = path.join(tmp, 'chat-transcript.json')
  assert(fs.existsSync(file), 'the transcript file exists after a flush')
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777
    assert(mode === 0o600, `transcript file is 0600 (conversation content), got ${mode.toString(8)}`)
  }

  // "restart": wipe the in-memory queue the way a dead process does, then
  // restore the way boot() does.
  resetQueueForTest()
  assert(readOutbound(0).items.length === 0, 'reset really emptied the queue (restart simulated)')
  const { restored } = await enableTranscriptPersistence({ dataHome: tmp })
  assert(restored === 3, `restore reports 3 items (activity excluded), got ${restored}`)
  const replay = readOutbound(0)
  assert(replay.items.length === 3, 'a cursor-0 drain replays the whole restored conversation')
  assert(replay.items[0].text === 'remember me' && replay.items[0].role === 'user', 'user half survives the restart')
  assert(replay.items[1].text === 'I will' && replay.items[1].role === 'agent', 'agent half survives the restart')
  assert(replay.items[2].kind === 'reaction' && replay.items[2].targetSeq === 1, 'reactions keep pointing at their bubble')
  assert(!replay.items.some((m) => m.kind === 'activity'), 'activity items are presence, not conversation: NOT persisted')
  assert(replay.latest === 4, 'seq is restored monotonic INCLUDING the dropped activity slot (page cursors stay valid)')
  const next = enqueueOutbound('and new messages continue the sequence')
  assert(next === 5, `post-restore enqueue continues at seq 5, got ${next}`)

  // corrupt file: fail-soft to an empty transcript, never a dead channel.
  resetQueueForTest()
  fs.writeFileSync(file, '{"seq": 4, "queue": [truncated-mid-wr')
  const corrupt = await enableTranscriptPersistence({ dataHome: tmp })
  assert(corrupt.restored === 0, 'a corrupt transcript restores as empty instead of throwing')

  // Drain any fire-and-forget flush BEFORE tearing the directory down --
  // otherwise the pending write races rmSync and logs a (harmless, fail-soft)
  // ENOENT after the summary line.
  await flushTranscript()
  resetQueueForTest()
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── reply receipt gates on durability (Mino field report, Windows v0.1.7) ───
// The bug: `reply` returned "sent (#n)" the instant the item hit the in-memory
// queue, while the disk write was fire-and-forget. Teardown (stdin EOF ->
// process.exit) could then abandon the write AND drop the memory queue, so a
// reply the model was told it had sent vanished from both -- and the restart
// restore had nothing to replay. Length-correlated (bigger write = wider race
// window; 1KB+ lost 3/3). Fix: reply awaits the flush, so by the time "sent"
// returns the item is already on disk and survives any later teardown.
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-durable-'))
  resetQueueForTest()
  await enableTranscriptPersistence({ dataHome: tmp })
  const file = path.join(tmp, 'chat-transcript.json')

  // A long reply -- the size class Mino lost 3/3. The receipt must not come
  // back until this is on disk.
  const long = 'x'.repeat(4096)
  const res = await handleToolCall('reply', { text: long })
  const receipt = res.content[0].text
  assert(receipt.startsWith('sent (#'), 'reply still reports sent on the happy path')
  assert(receipt.includes(`delivered_channel=${LOCAL_CHANNEL_ID}`), 'reply still stamps delivered_channel')
  assert(!receipt.includes('warning'), 'no not-saved warning when the disk write succeeded')
  // The load-bearing assertion: the file ALREADY holds it the moment reply
  // returned -- no await flushTranscript() in the test. This is exactly what a
  // teardown-right-after-reply would restore from.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert(onDisk.queue.some((m) => m.text === long), 'reply does not return "sent" until the message is durably on disk (no teardown-race loss)')

  await flushTranscript()
  resetQueueForTest()
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── reply tells the truth when the durable write fails ──────────────────────
// A failed write must NOT masquerade as a clean "sent". Point persistence at a
// dataHome whose parent is a FILE, so writeTranscriptOnce's mkdir throws: the
// item stays live in memory (the page still renders it this process), but the
// receipt must carry the not-saved warning instead of a bare success the model
// would treat as durably delivered.
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-failwrite-'))
  const asFile = path.join(base, 'iam-a-file')
  fs.writeFileSync(asFile, 'not a directory')
  resetQueueForTest()
  // dataHome under a file -> mkdir(dataHome) fails inside writeTranscriptOnce.
  await enableTranscriptPersistence({ dataHome: path.join(asFile, 'sub') })
  const res = await handleToolCall('reply', { text: 'unwritable' })
  const receipt = res.content[0].text
  assert(receipt.startsWith('sent (#'), 'a failed-persist reply still reports the item entered the live queue')
  assert(receipt.includes('warning: not yet saved to disk'), 'a failed durable write is reported honestly, not as a clean sent')
  assert(!res.isError, 'the warning rides a normal result, not isError (an error would invite the retry loop)')
  const replay = readOutbound(0)
  assert(replay.items.some((m) => m.text === 'unwritable'), 'the item is still live in memory for the page despite the failed write')

  resetQueueForTest()
  fs.rmSync(base, { recursive: true, force: true })
}

console.log('\n11b. turn-abort: the honest end of a turn that never got an answer (design-0025)')
// The pane derives BOTH the run fold and Stop/Read from awaitingReplySince. A
// Stop that does not clear it, or a mid-turn death that leaves the transcript
// ending on the unanswered question, shows a live-looking turn over no work.
// One persisted, non-skipped item kind settles it -- these sections pin that
// item, its durability and the record that produces it on the next boot.
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  // (a) the derivation: a turn-abort clears awaiting; its siblings do not.
  resetQueueForTest()
  enqueueInbound('did you finish?', { now: () => 1000 })
  assert(transcriptState().awaitingReplySince === 1000, 'a user message arms the awaiting state')
  enqueueTurnEnd() // ephemeral presence: must NOT clear it
  assert(transcriptState().awaitingReplySince === 1000, 'turn-end is skipped by the derivation (still awaiting)')
  enqueueAbort('death', 60_000, { now: () => 61_000, at: 61_500 })
  assert(transcriptState().awaitingReplySince === null,
    'a turn-abort CLEARS the awaiting state -- Stop and Read stop being re-derived from the stale user message')
  const item = readOutbound(0).items.find((m) => m.kind === 'turn-abort')
  assert(!!item, 'the item is in the transcript /out drains')
  assert(item.role === 'agent' && item.text === '', 'role agent, text empty (the sentence is client-side)')
  assert(item.reason === 'death' && item.elapsedMs === 60_000 && item.at === 61_500,
    'carries {reason, elapsedMs, at} from the contract shape')
  assert(item.ts === 61_000 && Number.isFinite(item.seq), 'still a normal queue item: ts and seq')

  // (b) durability: it survives a reload; its ephemeral siblings do not.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-localchan-abort-'))
  const transcriptFile = path.join(tmp, 'chat-transcript.json')
  resetQueueForTest()
  await enableTranscriptPersistence({ dataHome: tmp })
  enqueueInbound('stuck question', { now: () => 5 })
  enqueueTurnEnd() // must be dropped by the durable filter
  enqueueAbort('stop', 1234, { now: () => 6 })
  await flushTranscript()
  resetQueueForTest()
  const { restored } = await enableTranscriptPersistence({ dataHome: tmp })
  assert(restored === 2, `restore keeps the user message AND the turn-abort, drops turn-end (got ${restored})`)
  const replay = readOutbound(0)
  assert(replay.items.some((m) => m.kind === 'turn-abort'), 'turn-abort survives the reload (a reload must not resurrect the stuck state)')
  assert(!replay.items.some((m) => m.kind === 'turn-end'), 'turn-end stays ephemeral')
  assert(transcriptState().awaitingReplySince === null, 'the reloaded transcript is settled, not awaiting')

  // (c) the record consumer: exactly-once, and only when it should fire.
  const recordFile = path.join(tmp, '.last-turn-abort.json')
  const writeRecord = (o) => fs.writeFileSync(recordFile, JSON.stringify(o))
  // boot(): restore like boot() does, then DRAIN the fire-and-forget flush the
  // consumer's push may have kicked -- a pending write landing after the next
  // hand-written fixture would clobber it and make these assertions flaky.
  const boot = async () => { await enableTranscriptPersistence({ dataHome: tmp }); await flushTranscript() }

  // clean start: no record on disk -> nothing appended (no phantom line).
  resetQueueForTest()
  fs.writeFileSync(transcriptFile, JSON.stringify({ seq: 1, queue: [{ seq: 1, kind: 'message', role: 'user', text: 'q', ts: 111 }] }))
  await boot() // no record file yet
  assert(readOutbound(0).items.filter((m) => m.kind === 'turn-abort').length === 0,
    'no record -> no phantom turn-abort on a clean start')
  assert(transcriptState().awaitingReplySince === 111, 'and the transcript honestly stays awaiting')

  // the record lands once, and is stamped (not deleted).
  writeRecord({ at: 5000, reason: 'death', tail: 'tool_result', elapsedMs: null })
  resetQueueForTest()
  await boot()
  let aborts = readOutbound(0).items.filter((m) => m.kind === 'turn-abort')
  assert(aborts.length === 1 && aborts[aborts.length - 1].reason === 'death',
    'a record newer than the tail, with an unanswered message, becomes exactly one turn-abort')
  assert(aborts[aborts.length - 1].elapsedMs === 5000 - 111,
    'the elapsed is at - awaitingReplySince: how long HER TURN ran, so it stops at `at` (never the dead time since the kill)')
  const stamped = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  assert(stamped.consumedAt, 'the record is STAMPED consumed')
  assert(stamped.at === 5000 && stamped.reason === 'death', '...without losing the fact it recorded')

  // second boot: no duplicate (the transcript is settled anyway), and even a
  // hand-reverted awaiting transcript cannot re-consume a stamped record.
  resetQueueForTest()
  await boot()
  assert(readOutbound(0).items.filter((m) => m.kind === 'turn-abort').length === 1,
    'a second boot does not duplicate the line')
  fs.writeFileSync(transcriptFile, JSON.stringify({ seq: 1, queue: [{ seq: 1, kind: 'message', role: 'user', text: 'q', ts: 111 }] }))
  resetQueueForTest()
  await boot()
  assert(readOutbound(0).items.filter((m) => m.kind === 'turn-abort').length === 0,
    'an already-consumed record is NOT re-consumed even when the transcript still looks awaiting')
  assert(transcriptState().awaitingReplySince === 111, '...so the transcript stays awaiting: the stamp, not the transcript, is what stops the second line')

  // the elapsed's two fallbacks. The record's own elapsedMs is null by
  // construction (both producers live in another process from this transcript),
  // so when the arithmetic has no usable pair the line must say so rather than
  // print a number nobody measured.
  fs.rmSync(recordFile, { force: true })
  // A restored transcript whose ts is not a number: enableTranscriptPersistence
  // filters on seq, not ts, so this shape reaches transcriptState() intact and
  // there is nothing finite to subtract.
  fs.writeFileSync(transcriptFile, JSON.stringify({ seq: 1, queue: [{ seq: 1, kind: 'message', role: 'user', text: 'q', ts: '111' }] }))
  writeRecord({ at: 5000, reason: 'stall', tail: null, elapsedMs: 777 })
  resetQueueForTest()
  await boot()
  aborts = readOutbound(0).items.filter((m) => m.kind === 'turn-abort')
  assert(aborts.length === 1 && aborts[aborts.length - 1].elapsedMs === 777,
    'no usable awaiting ts -> the record\'s own elapsedMs rides the line instead')
  fs.rmSync(recordFile, { force: true })
  fs.writeFileSync(transcriptFile, JSON.stringify({ seq: 1, queue: [{ seq: 1, kind: 'message', role: 'user', text: 'q', ts: '111' }] }))
  writeRecord({ at: 5000, reason: 'stall', tail: null, elapsedMs: null })
  resetQueueForTest()
  await boot()
  aborts = readOutbound(0).items.filter((m) => m.kind === 'turn-abort')
  assert(aborts.length === 1 && aborts[aborts.length - 1].elapsedMs === null,
    'neither number usable -> null, never a fabricated duration (the line renders without the clause)')

  // an abort OLDER than the newest item is yesterday's news.
  fs.rmSync(recordFile, { force: true })
  fs.writeFileSync(transcriptFile, JSON.stringify({ seq: 1, queue: [{ seq: 1, kind: 'message', role: 'user', text: 'newer question', ts: 9000 }] }))
  writeRecord({ at: 1000, reason: 'death', tail: 'tool_result', elapsedMs: null })
  resetQueueForTest()
  await boot()
  assert(readOutbound(0).items.filter((m) => m.kind === 'turn-abort').length === 0,
    'a record older than the newest retained item is not replayed')

  // a settled transcript consumes nothing.
  fs.rmSync(recordFile, { force: true })
  fs.writeFileSync(transcriptFile, JSON.stringify({ seq: 2, queue: [
    { seq: 1, kind: 'message', role: 'user', text: 'q', ts: 1000 },
    { seq: 2, kind: 'message', role: 'agent', text: 'a', ts: 2000 },
  ] }))
  writeRecord({ at: 5000, reason: 'stall', tail: null, elapsedMs: null })
  resetQueueForTest()
  await boot()
  assert(readOutbound(0).items.filter((m) => m.kind === 'turn-abort').length === 0,
    'a settled transcript (agent already answered) consumes nothing')

  await flushTranscript()
  resetQueueForTest()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n11c. HTTP /interrupt writes exactly one turn-abort, and only with a turn in flight')
{
  const mkHandler = (interrupt) => createRequestHandler({ notify: async () => {}, token: TOKEN, interrupt })
  const abortCount = () => readOutbound(0).items.filter((m) => m.kind === 'turn-abort').length

  resetQueueForTest()
  enqueueInbound('stop me', { now: () => 2000 })
  const handler = mkHandler(async () => ({ ok: true }))
  const r1 = await call(handler, { method: 'POST', url: '/interrupt' })
  assert(r1.code === 200 && r1.json.ok === true, 'a successful stop still answers 200 ok')
  assert(abortCount() === 1, 'a successful stop pushes EXACTLY one turn-abort')
  const stop = readOutbound(0).items.find((m) => m.kind === 'turn-abort')
  assert(stop.reason === 'stop', 'reason is stop')
  assert(Number.isFinite(stop.elapsedMs) && stop.elapsedMs > 0, 'elapsedMs is wall time from the awaiting user message')
  assert(transcriptState().awaitingReplySince === null, 'the awaiting state is cleared by the stop')
  // a second press with nothing in flight pushes nothing new.
  await call(handler, { method: 'POST', url: '/interrupt' })
  assert(abortCount() === 1, 'a second stop with no awaiting turn pushes none')

  // no awaiting turn at all -> no item, even on a 200.
  resetQueueForTest()
  const r2 = await call(mkHandler(async () => ({ ok: true })), { method: 'POST', url: '/interrupt' })
  assert(r2.code === 200 && readOutbound(0).items.length === 0, 'a stop with no in-flight turn pushes nothing')

  // a refused stop (lane says no_turn) -> 409 and no item.
  resetQueueForTest()
  enqueueInbound('still waiting', { now: () => 7 })
  const r3 = await call(mkHandler(async () => ({ ok: false, reason: 'no_turn' })), { method: 'POST', url: '/interrupt' })
  assert(r3.code === 409 && abortCount() === 0, 'a refused stop records nothing')
}

console.log('\n12. send_file_to_discord: copies into chat_uploads, marker the page can render (0.1.18)')
// In-process is fine here: handleToolCall's copy path resolves DATA_HOME at
// import time, so we point the assertions at THAT resolved home and clean up
// our own artifacts. A child-process variant would re-resolve env, but the
// contract under test (marker form, served_as receipt, honest failures) is
// identical either way.
{
  const fsx = await import('node:fs')
  const osx = await import('node:os')
  const pathx = await import('node:path')
  const src = pathx.join(osx.tmpdir(), `sched-sendfile-${Date.now()}.png`)
  fsx.writeFileSync(src, Buffer.from('89504e470d0a1a0a', 'hex'))

  resetQueueForTest()
  const ok = await handleToolCall('send_file_to_discord', { filePath: src, comment: 'here' })
  const okText = ok.content[0].text
  assert(!ok.isError && /sent \(#\d+\)/.test(okText), 'send succeeds with a numbered receipt')
  const served = (okText.match(/served_as=(.+)/) || [])[1]
  assert(!!served, 'receipt names the served basename (served_as=)')
  const q = readOutbound(0).items.filter((i) => i.kind === 'message')
  const msg = q[q.length - 1]
  // The marker path is the copy's ground truth (DATA_HOME resolved at the
  // module's import, not ours) -- assert against what the page will fetch.
  const copied = (msg.text.match(/\[image attached: (.+?) \u2014 /) || [])[1]
  assert(copied && fsx.existsSync(copied), 'file is COPIED to the marker path')
  assert(copied && pathx.dirname(copied).endsWith('chat_uploads') && pathx.basename(copied) === served,
    'copy lives in chat_uploads under the served_as basename (the serve route\u2019s only root)')
  assert(/^here\n\[image attached: .+ \u2014 sent by the agent\]$/.test(msg.text), `comment + image marker form the page lifts (got: ${msg.text.slice(0, 80)})`)
  assert(fsx.existsSync(src), 'source file is untouched (copy, not move)')

  const missing = await handleToolCall('send_file_to_discord', { filePath: '/nonexistent/nope.bin' })
  assert(missing.isError === true && /file not found/.test(missing.content[0].text), 'missing file fails honestly, never a silent path-as-text fallback')

  const noArg = await handleToolCall('send_file_to_discord', {})
  assert(noArg.isError === true, 'missing filePath is an error')

  // cleanup our artifacts only
  try { fsx.unlinkSync(src) } catch {}
  try { copied && fsx.unlinkSync(copied) } catch {}
  resetQueueForTest()
}

// ── background-subagent roster (0.2.15, Mino 08-24 "서브 스폰하면 서브도
// working 정보에 띄우게") ────────────────────────────────────────────────
{
  resetQueueForTest()
  assert(Array.isArray(readOutbound(0).bg) && readOutbound(0).bg.length === 0,
    '/out carries an empty bg roster by default')
  upsertBgTask('job-1', 'research MZ slang', { now: () => 1000 })
  const one = readOutbound(0).bg
  assert(one.length === 1 && one[0].id === 'job-1' && one[0].label === 'research MZ slang' && one[0].since === 1000,
    'an upserted bg task appears in /out with id/label/since')
  upsertBgTask('job-1', 'research MZ slang (round 2)', { now: () => 2000 })
  const re = readOutbound(0).bg
  assert(re.length === 1 && re[0].label === 'research MZ slang (round 2)' && re[0].since === 1000,
    're-upsert refreshes the label but keeps the original since (still ONE task)')
  upsertBgTask('sub-2', '', { now: () => 3000 })
  assert(readOutbound(0).bg.length === 2 && readOutbound(0).bg.find((t) => t.id === 'sub-2').label === 'background task',
    'an empty label falls back to a generic one instead of an empty pill')
  assert(retireBgTask('job-1') === true && readOutbound(0).bg.length === 1,
    'retire removes exactly the named task')
  assert(retireBgTask('job-1') === false, 'retiring an unknown id reports false, no throw')
  assert(listBgTasks().length === 1 && listBgTasks()[0].id === 'sub-2', 'listBgTasks mirrors the roster')
  resetQueueForTest()
  assert(listBgTasks().length === 0, 'resetQueueForTest clears the roster')
}

// bg roster over the HTTP surface: POST /activity kind:'bg' add + done
{
  resetQueueForTest()
  const token = 'bg-test-token'
  const handler = createRequestHandler({ token, notify: async () => {}, onInbound: () => {} })
  const { createServer } = await import('node:http')
  const srv = createServer(handler)
  await new Promise((res) => srv.listen(0, '127.0.0.1', res))
  const port = srv.address().port
  const post = (body) => fetch(`http://127.0.0.1:${port}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  let r = await post({ kind: 'bg', id: 'child-9', label: 'summarize the docs' })
  assert(r.status === 202, 'bg add returns 202')
  assert(readOutbound(0).bg.length === 1 && readOutbound(0).bg[0].id === 'child-9',
    'bg add lands in the roster')
  r = await post({ kind: 'bg', id: 'child-9', done: true })
  assert(r.status === 202 && readOutbound(0).bg.length === 0, 'bg done retires the task (202, roster empty)')
  r = await post({ kind: 'bg', done: true })
  assert(r.status === 400, 'bg post without id is refused (400)')
  await new Promise((res) => srv.close(res))
  resetQueueForTest()
}

// The scratch data home this file pointed the module at (see the header).
try { fsBoot.rmSync(TEST_DATA_HOME, { recursive: true, force: true }) } catch { /* best effort */ }

console.log(`\n${pass} passed, ${fail} failed`)
// exitCode, not process.exit() -- see the long note at the bottom of
// tests/test-codex-proxy-model.mjs for the measured reason. Short version:
// on Windows (node 24.18.1 / libuv 1.52.1), process.exit() after >=3
// fetch()-to-a-local-server round trips aborts the process with
// `!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94` -- after every
// assertion has already passed. This file did it about 1 run in 5, which is
// the worst kind: a flaky failure whose own output says 78 passed, 0 failed.
//
// This file spawns children. If it ever hangs here instead of exiting, one of
// them outlived its teardown -- fix the leak rather than restoring
// process.exit(), which only converted the leak into an abort.
process.exitCode = fail === 0 ? 0 : 1
