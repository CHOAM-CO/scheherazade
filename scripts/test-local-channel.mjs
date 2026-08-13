#!/usr/bin/env node
// test-local-channel.mjs — pins the in-app chat backend (channel-local.mjs).
// Run: node scripts/test-local-channel.mjs
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
// Mirrors scripts/test-provider-env.mjs's assert()/pass/fail convention.

import {
  enqueueOutbound, enqueueInbound, enqueueReaction, enqueueActivity, readOutbound, resetQueueForTest,
  deliverInbound, deliverReaction, transcriptState, handleToolCall,
  createRequestHandler, LOCAL_CHANNEL_ID, MAX_QUEUE, USER_REACTIONS,
  enableTranscriptPersistence, flushTranscript,
} from '../channel-local.mjs'

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

console.log('\n10. boot announce: the greeting is the first thing the chat pane shows')
// Slice 5's "setup ends at the agent's first message" depends on this:
// wizard lands on /chat, and the boot announce unit (channel-runtime,
// same rule as every backend: direct line -> ts advance -> greeting
// inject) puts the first content into the queue. Real child, real marker,
// real HTTP -- the same boot path production takes.
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
  while (out.items.length === 0 && Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${ep.port}/out`, { headers: { authorization: `Bearer ${ep.token}` } })
      if (r.status === 200) out = await r.json()
    } catch { /* listener racing up */ }
    if (out.items.length === 0) await new Promise((r) => setTimeout(r, 150))
  }
  assert(out.items.length === 1, 'exactly one announce line lands in the queue')
  assert(out.items[0] && out.items[0].text.includes('🔁') && out.items[0].text.includes('기동'),
    'the queue item is the boot direct line (first thing the pane shows)')
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
  fire('WebSearch', { query: 'GPT 5.6 SOL how to use' })
  fire('WebFetch', { url: 'https://platform.openai.com/docs/codex?x=1' })
  fire('Agent', { description: 'Codex research', subagent_type: 'researcher' })
  fire('Task', { subagent_type: 'researcher' })
  fire('Read', { file_path: '/etc/hosts' })
  await new Promise((r) => setTimeout(r, 200))
  srv.close()
  assert(seen[0] === 'Install package dependencies', 'Bash label stays bare (model-written description)')
  assert(seen[1] === 'WebSearch: GPT 5.6 SOL how to use', 'WebSearch label carries the query')
  assert(seen[2] === 'WebFetch: platform.openai.com/docs/codex', 'WebFetch label is host+path, query string dropped')
  assert(seen[3] === 'Subagent: Codex research', 'Agent spawn prefers the description')
  assert(seen[4] === 'Subagent: researcher', 'Task (pre-2.1 tool name) falls back to subagent_type')
  assert(seen.length === 5, 'uncovered tools (Read) stay OFF the feed')
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

console.log(`\n${pass} passed, ${fail} failed`)
// exitCode, not process.exit() -- see the long note at the bottom of
// scripts/test-codex-proxy-model.mjs for the measured reason. Short version:
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
