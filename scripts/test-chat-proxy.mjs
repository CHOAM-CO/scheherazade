#!/usr/bin/env node
// test-chat-proxy.mjs -- the /api/chat/* proxy (onboarding/routes/chat.cjs)
// over the REAL server against a FAKE channel listener. The proxy's whole
// job is: discover the channel endpoint from DATA_HOME/local-channel.json,
// attach the bearer token server-side, and translate failures into fixed
// enums -- so the fake channel here records exactly what arrived (auth
// header, body, query) and the assertions read the wire on BOTH sides.
//
// What this file proves that test-route-dispatch-e2e.mjs (binding-level G11
// hits) does not:
//   - the bearer token from the port file rides the loopback hop, and NEVER
//     appears in any response body the browser sees;
//   - `since` is numerically coerced before it enters the upstream URL;
//   - each failure class maps to its named enum: no file -> not_running,
//     dead port -> unreachable, wrong token -> upstream_refused,
//     garbage file -> not_running (mid-write race reads as "down now");
//   - POST /in forwards the text and 202s; the text is never echoed in an
//     error path.
//
// Hermetic: same env-before-import discipline as test-route-dispatch-e2e.mjs.
//
// Run: node scripts/test-chat-proxy.mjs

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-chatproxy-'))

const fixtureHome = path.join(tmp, 'home')
fs.mkdirSync(fixtureHome, { recursive: true })
process.env.HOME = fixtureHome
process.env.AGENT_DATA_HOME = path.join(tmp, 'data')
fs.mkdirSync(process.env.AGENT_DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')

const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createOnboardingServer, SERVER_TOKEN } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))

let pass = 0
let fail = 0
const chk = (n, c, d) => {
  if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) }
}

// ── fake channel: records what the proxy actually sends ────────────────────
const CHANNEL_TOKEN = 'a'.repeat(64)
let lastChannelReq = null
const fakeChannel = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  lastChannelReq = { url: req.url, method: req.method, auth: String(req.headers.authorization || ''), body }
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (lastChannelReq.auth !== `Bearer ${CHANNEL_TOKEN}`) return send(401, { error: 'unauthorized' })
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/health') return send(200, { ok: true, agent: 'fake-agent' })
  if (url.pathname === '/out') return send(200, { items: [{ seq: 4, role: 'agent', text: 'hi from agent', ts: 1 }], latest: 4, missed: false })
  if (url.pathname === '/in' && req.method === 'POST') return send(202, { ok: true })
  return send(404, { error: 'not found' })
})
await new Promise((r) => fakeChannel.listen(0, '127.0.0.1', r))
const channelPort = fakeChannel.address().port

const portFile = path.join(process.env.AGENT_DATA_HOME, 'local-channel.json')
const writePortFile = (obj) => fs.writeFileSync(portFile, typeof obj === 'string' ? obj : JSON.stringify(obj))

const srv = await createOnboardingServer()
const port = srv.server.address().port
const base = `http://127.0.0.1:${port}`

try {
  // Token from the module export — the page-scrape acquisition this block
  // used is exactly the bypass closed 2026-08-07 (pinned in
  // test-route-dispatch-e2e); bare HTML now 403s.
  const auth = { 'x-onboard-token': SERVER_TOKEN, 'content-type': 'application/json' }

  // ── not running: no port file ─────────────────────────────────────────────
  {
    const r = await fetch(`${base}/api/chat/status`, { headers: auth })
    const b = await r.json()
    chk('status with no port file: 200 up:false not_running', r.status === 200 && b.up === false && b.reason === 'not_running', JSON.stringify(b))
    chk('status names the active backend (wizard reads this)', b.backend === 'discord', JSON.stringify(b))
  }
  {
    const r = await fetch(`${base}/api/chat/out`, { headers: auth })
    chk('out with no port file: 503 not_running', r.status === 503 && (await r.json()).reason === 'not_running')
  }
  {
    const marker = 'ZZCHATECHOMARKERZZ'
    const r = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: auth, body: JSON.stringify({ text: marker }) })
    const body = await r.text()
    chk('in with no port file: 503 not_running', r.status === 503 && JSON.parse(body).reason === 'not_running', body)
    chk('in failure does not echo the message text', !body.includes(marker), body.slice(0, 200))
  }

  // ── gate: POST /in is behind the per-launch token like every other POST ───
  {
    const r = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })
    chk('in without the onboard token is refused (403, gate before route)', r.status === 403, r.status)
  }

  // ── live round trip through the fake channel ──────────────────────────────
  writePortFile({ port: channelPort, token: CHANNEL_TOKEN, pid: 1, startedAt: 'x' })
  {
    const r = await fetch(`${base}/api/chat/status`, { headers: auth })
    const b = await r.json()
    chk('status with a live channel: up:true + agent name passthrough', r.status === 200 && b.up === true && b.agent === 'fake-agent', JSON.stringify(b))
  }
  {
    lastChannelReq = null
    const r = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'hello from the page' }) })
    const b = await r.json()
    chk('in forwards and 202s', r.status === 202 && b.ok === true, JSON.stringify(b))
    chk('the channel received the text verbatim', lastChannelReq && JSON.parse(lastChannelReq.body).text === 'hello from the page', JSON.stringify(lastChannelReq))
    chk('the channel received the bearer token from the port file', lastChannelReq && lastChannelReq.auth === `Bearer ${CHANNEL_TOKEN}`)
  }
  {
    lastChannelReq = null
    const r = await fetch(`${base}/api/chat/out?since=3`, { headers: auth })
    const b = await r.json()
    chk('out proxies the channel body through', r.status === 200 && b.latest === 4 && b.items[0].text === 'hi from agent' && b.missed === false, JSON.stringify(b))
    chk('since rides upstream as the number it parsed to', lastChannelReq && lastChannelReq.url === '/out?since=3', lastChannelReq && lastChannelReq.url)
  }
  {
    lastChannelReq = null
    await fetch(`${base}/api/chat/out?since=abc"><script>`, { headers: auth })
    chk('a non-numeric since is coerced to 0, never forwarded as a string', lastChannelReq && lastChannelReq.url === '/out?since=0', lastChannelReq && lastChannelReq.url)
  }

  // ── token containment: the channel token is in NO browser-visible body ────
  {
    const bodies = []
    for (const url of ['/api/chat/status', '/api/chat/out?since=0']) bodies.push(await (await fetch(`${base}${url}`, { headers: auth })).text())
    bodies.push(await (await fetch(`${base}/api/chat/in`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'y' }) })).text())
    chk('no response body carries the channel bearer token', bodies.every((b) => !b.includes(CHANNEL_TOKEN)), bodies.map((b) => b.slice(0, 60)).join(' | '))
  }

  // ── wrong token in the file: upstream 401 -> upstream_refused ─────────────
  writePortFile({ port: channelPort, token: 'b'.repeat(64) })
  {
    const r = await fetch(`${base}/api/chat/out`, { headers: auth })
    chk('upstream 401 maps to 502 upstream_refused (stale-token restart race)', r.status === 502 && (await r.json()).reason === 'upstream_refused')
    const r2 = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'z' }) })
    chk('in against a refusing channel: 502 upstream_refused', r2.status === 502 && (await r2.json()).reason === 'upstream_refused')
  }

  // ── dead port: connection refused -> unreachable ──────────────────────────
  const dead = http.createServer(() => {})
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const deadPort = dead.address().port
  await new Promise((r) => dead.close(r))
  writePortFile({ port: deadPort, token: CHANNEL_TOKEN })
  {
    const r = await fetch(`${base}/api/chat/out`, { headers: auth })
    chk('dead port maps to 502 unreachable (stale file from a dead agent)', r.status === 502 && (await r.json()).reason === 'unreachable')
    const s = await (await fetch(`${base}/api/chat/status`, { headers: auth })).json()
    chk('status probes live, so a stale file still reads as down', s.up === false && s.reason === 'unreachable', JSON.stringify(s))
  }

  // ── file damage reads as "not up right now", never a 500 ──────────────────
  writePortFile('{ this is not json')
  chk('garbage port file: out reads not_running (mid-write race self-heals)', (await (await fetch(`${base}/api/chat/out`, { headers: auth })).json()).reason === 'not_running')
  writePortFile({ port: 99999999, token: CHANNEL_TOKEN })
  chk('out-of-range port in the file: not_running, no fetch attempted', (await (await fetch(`${base}/api/chat/out`, { headers: auth })).json()).reason === 'not_running')
  writePortFile({ port: channelPort, token: '' })
  chk('empty token in the file: not_running, no unauthenticated call goes out', (await (await fetch(`${base}/api/chat/out`, { headers: auth })).json()).reason === 'not_running')

  // ── bad input at the proxy, before anything goes upstream ─────────────────
  writePortFile({ port: channelPort, token: CHANNEL_TOKEN })
  {
    lastChannelReq = null
    const r = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: auth, body: '{}' })
    chk('in without text: 400 text_required', r.status === 400 && (await r.json()).reason === 'text_required')
    chk('...and nothing was sent upstream', lastChannelReq === null, JSON.stringify(lastChannelReq))
    const r2 = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: auth, body: JSON.stringify({ text: '   ' }) })
    chk('in with whitespace-only text: 400 text_required', r2.status === 400 && (await r2.json()).reason === 'text_required')
  }

  // ── image upload (2026-08-04): local save, no channel involvement ─────────
  {
    // 1x1 red PNG, the smallest honest image bytes
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    lastChannelReq = null
    const r = await fetch(`${base}/api/chat/upload`, { method: 'POST', headers: auth, body: JSON.stringify({ filename: 'my shot (1).png', dataBase64: png.toString('base64') }) })
    const b = await r.json()
    chk('upload saves and returns a server-minted name + absolute path', r.status === 200 && b.ok === true && /^\d+_my_shot__1_\.png$/.test(b.name) && b.path.endsWith(b.name), JSON.stringify(b))
    chk('upload touches the channel not at all', lastChannelReq === null)
    const onDisk = fs.readFileSync(path.join(process.env.AGENT_DATA_HOME, 'chat_uploads', b.name))
    chk('the saved bytes are the decoded image, verbatim', onDisk.equals(png))
    // serve it back
    const g = await fetch(`${base}/api/chat/upload/${encodeURIComponent(b.name)}`, { headers: auth })
    chk('GET serves the upload with the right content-type', g.status === 200 && g.headers.get('content-type') === 'image/png' && Buffer.from(await g.arrayBuffer()).equals(png))
    // traversal shapes never reach the filesystem
    // bare '..' is normalized away by the URL layer before dispatch (404 at
    // the router); encoded shapes reach the route and get its 400. Either
    // way the filesystem is never consulted with a traversal name.
    for (const bad of ['..%2F..%2Fsecrets.png', 'a%2Fb.png', '..']) {
      const t = await fetch(`${base}/api/chat/upload/${bad}`, { headers: auth })
      chk(`upload GET rejects traversal shape ${bad}`, t.status === 400 || t.status === 404, t.status)
    }
    chk('missing upload is a 404, not a 500', (await fetch(`${base}/api/chat/upload/${Date.now()}_nope.png`, { headers: auth })).status === 404)
    // type + size gates
    const badType = await fetch(`${base}/api/chat/upload`, { method: 'POST', headers: auth, body: JSON.stringify({ filename: 'evil.svg', dataBase64: png.toString('base64') }) })
    chk('non-whitelisted extension: 400 bad_type (svg = script carrier)', badType.status === 400 && (await badType.json()).reason === 'bad_type')
    const noData = await fetch(`${base}/api/chat/upload`, { method: 'POST', headers: auth, body: JSON.stringify({ filename: 'x.png' }) })
    chk('missing dataBase64: 400 no_data', noData.status === 400 && (await noData.json()).reason === 'no_data')
    const big = await fetch(`${base}/api/chat/upload`, { method: 'POST', headers: auth, body: JSON.stringify({ filename: 'big.png', dataBase64: Buffer.alloc(10_000_001).toString('base64') }) })
    chk('an over-10MB image: 413 too_large', big.status === 413 && (await big.json()).reason === 'too_large')
    // gate: upload is a POST, so it sits behind the per-launch token
    const noTok = await fetch(`${base}/api/chat/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x.png', dataBase64: png.toString('base64') }) })
    chk('upload without the onboard token is refused', noTok.status === 403, noTok.status)
    chk('upload with no agentControls (unknown lane) carries NO caption -- unknown is never guessed', !('caption' in b), JSON.stringify(b))
  }

  // ── vision policy (0.1.4, Mino: "Unknown이 제일 위험함"): first-party =
  // yes, everything else defaults to NO unless on the known-vision list.
  // 'unknown' no longer exists -- its marker invited a Read-tool image read
  // that poisoned non-vision transcripts (field report 2026-08-11).
  {
    const { laneVision } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
    chk('claude lane -> yes', laneVision({ provider: 'claude-subscription', model: 'claude-fable-5' }) === 'yes')
    chk('chatgpt/codex proxy lane -> yes (first-party)', laneVision({ provider: 'chatgpt', model: 'gpt-5.6' }) === 'yes')
    chk('ollama kimi-k2.7-code -> yes (library pill receipt)', laneVision({ provider: 'ollama', model: 'kimi-k2.7-code' }) === 'yes')
    chk('ollama glm-5.2 -> no', laneVision({ provider: 'ollama', model: 'glm-5.2' }) === 'no')
    chk('ollama deepseek-v4-flash:0731 -> no (tag stripped)', laneVision({ provider: 'ollama', model: 'deepseek-v4-flash:0731' }) === 'no')
    chk('ollama unlisted model -> no (fail-safe default, never unknown)', laneVision({ provider: 'ollama', model: 'brand-new-model' }) === 'no')
    chk('no spawn info -> no (fail-safe default)', laneVision(null) === 'no')
    chk('custom glm-5.2 -> no (capability is the model, not the server)', laneVision({ provider: 'custom', model: 'glm-5.2' }) === 'no')
    chk('custom qwen3.5 -> yes (YES-list works for any provider)', laneVision({ provider: 'custom', model: 'qwen3.5' }) === 'yes')
  }
} finally {
  srv.server.close()
  await new Promise((r) => fakeChannel.close(r))
  // memory service opened by the server import; close via its module if present
  try { (await import('file://' + path.join(ROOT, 'memory', 'service.mjs'))).close() } catch { /* absent in some layouts */ }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
