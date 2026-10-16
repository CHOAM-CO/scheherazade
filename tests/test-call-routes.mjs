import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createRoutes } = createRequire(import.meta.url)('../onboarding/routes/stt.cjs')
let cfg = {}, body = {}, result
const notices = []
const routes = createRoutes({ sendCallNotice: async content => { notices.push(content); return true }, DATA_HOME: '.', readAgentConfig: () => cfg, writeAgentConfig: fields => Object.assign(cfg, fields), readJsonBody: async () => body, sendJson: (_res, status, data) => { result = { status, data } } })
const get = routes.find(r => r.method === 'GET' && r.match('/api/call'))
const post = routes.find(r => r.method === 'POST' && r.match('/api/call'))
await get.handler({}, {}); assert.equal(result.data.enabled, false)
body = { enabled: 'true' }; await post.handler({}, {}); assert.equal(result.status, 400)
body = { enabled: true }; await post.handler({}, {}); assert.equal(result.status, 409)
cfg = { STT_ENABLED: 'true', TTS_ENABLED: 'true' }; await post.handler({}, {}); assert.equal(result.status, 200); assert.equal(cfg.CALL_ENABLED, 'true')
cfg.STT_ENABLED = 'false'; await get.handler({}, {}); assert.equal(result.data.enabled, false)
body = { enabled: false }; await post.handler({}, {}); assert.equal(cfg.CALL_ENABLED, 'false')
console.log('call route: default off, validation, prerequisite gate, persisted off passed')

const hud = []
const call = { agentControls: { companion: () => ({ setCallEnabled: value => hud.push(value) }) } }
cfg = { STT_ENABLED: 'true', TTS_ENABLED: 'true' }
body = { enabled: true }; await post.handler({}, {}, call)
body = { enabled: false }; await post.handler({}, {}, call)
assert.deepEqual(hud, [true, false])
console.log('Authenticated call route opens and restores native HUD via controller bridge')

const copy = createRequire(import.meta.url)('../onboarding/call-context.cjs')
notices.length = 0
body = { enabled: true }; await post.handler({}, {}, call)
await post.handler({}, {}, call)
assert.deepEqual(notices, [copy.en.start], 'one start notice per transition')
body = { enabled: false }; await post.handler({}, {}, call)
assert.equal(notices.at(-1), copy.en.stop)
body = { enabled: true, lang: 'ko' }; await post.handler({}, {}, call)
assert.equal(notices.at(-1), copy.ko.start)
body = { enabled: false, lang: 'ko' }; await post.handler({}, {}, call)
assert.equal(notices.at(-1), copy.ko.stop)
console.log('call context: single English start/off notices and explicit Korean gate passed')

const { createServer } = await import('node:http')
const received = []
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) })
  res.writeHead(202, { 'content-type': 'application/json' }); res.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  cfg = { STT_ENABLED: 'true', TTS_ENABLED: 'true' }
  const live = createRoutes({ DATA_HOME: '.', fs: { readFileSync: () => JSON.stringify({ port: server.address().port, token: 'fixture-secret' }) }, readAgentConfig: () => cfg, writeAgentConfig: fields => Object.assign(cfg, fields), readJsonBody: async () => body, sendJson: (_res, status, data) => { result = { status, data } } }).find(r => r.method === 'POST' && r.match('/api/call'))
  body = { enabled: true }; await live.handler({}, {}, call)
  assert.equal(result.data.noticeDelivered, true)
  assert.deepEqual(received, [{ url: '/system-turn', authorization: 'Bearer fixture-secret', body: { content: copy.en.start } }])
  const before = notices.length
  body = { enabled: false }
  await post.handler({}, {}, { agentControls: { companion: () => ({ setCallEnabled() { throw new Error('native failed') } }) } })
  assert.equal(result.status, 500)
  assert.equal(cfg.CALL_ENABLED, 'true', 'native failure rolls back config')
  assert.equal(notices.length, before)
  console.log('call context authenticated HTTP system-turn delivery and native rollback passed')
} finally { await new Promise(resolve => server.close(resolve)) }
