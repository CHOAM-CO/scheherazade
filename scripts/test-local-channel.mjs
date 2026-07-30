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
  enqueueOutbound, enqueueInbound, readOutbound, resetQueueForTest, deliverInbound,
  createRequestHandler, LOCAL_CHANNEL_ID, MAX_QUEUE,
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
