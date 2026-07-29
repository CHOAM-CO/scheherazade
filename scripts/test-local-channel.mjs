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
  enqueueOutbound, readOutbound, resetQueueForTest, deliverInbound,
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
  assert(all.items.every((m) => m.role === 'agent'), 'queued messages are tagged as the agent')
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
  assert((await call(handler, { method: 'POST', url: '/in', body: '{not json' })).code === 400, 'malformed json -> 400')
  assert((await call(handler, { method: 'POST', url: '/in', body: '{}' })).code === 400, 'missing text -> 400')
  assert((await call(handler, { method: 'POST', url: '/in', body: JSON.stringify({ text: '  ' }) })).code === 400,
    'blank text -> 400 at the HTTP edge (the agent is never woken for nothing)')
  assert((await call(handler, { method: 'GET', url: '/nope' })).code === 404, 'unknown path -> 404')
}

console.log('\n8. an oversized body is refused rather than buffered')
{
  const handler = createRequestHandler({ notify: async () => {}, token: TOKEN })
  const big = JSON.stringify({ text: 'x'.repeat(200_000) })
  const r = await call(handler, { method: 'POST', url: '/in', body: big })
  assert(r.code === 413, 'over the cap -> 413')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
