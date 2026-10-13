import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createRoutes } = createRequire(import.meta.url)('../onboarding/routes/stt.cjs')
let cfg = {}, body = {}, result
const routes = createRoutes({ DATA_HOME: '.', readAgentConfig: () => cfg, writeAgentConfig: fields => Object.assign(cfg, fields), readJsonBody: async () => body, sendJson: (_res, status, data) => { result = { status, data } } })
const get = routes.find(r => r.method === 'GET' && r.match('/api/call'))
const post = routes.find(r => r.method === 'POST' && r.match('/api/call'))
await get.handler({}, {}); assert.equal(result.data.enabled, false)
body = { enabled: 'true' }; await post.handler({}, {}); assert.equal(result.status, 400)
body = { enabled: true }; await post.handler({}, {}); assert.equal(result.status, 409)
cfg = { STT_ENABLED: 'true', TTS_ENABLED: 'true' }; await post.handler({}, {}); assert.equal(result.status, 200); assert.equal(cfg.CALL_ENABLED, 'true')
cfg.STT_ENABLED = 'false'; await get.handler({}, {}); assert.equal(result.data.enabled, false)
body = { enabled: false }; await post.handler({}, {}); assert.equal(cfg.CALL_ENABLED, 'false')
console.log('call route: default off, validation, prerequisite gate, persisted off passed')
