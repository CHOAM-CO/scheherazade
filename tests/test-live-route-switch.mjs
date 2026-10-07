// test-live-route-switch.mjs -- POST /api/agent/model and /api/agent/effort
// go through agentControls.applyRoute (route proxy, 2026-10-07) instead of an
// unconditional restartAgent. Over the REAL onboarding server with a stub
// agentControls:
//   - applyRoute -> {mode:'live'}: 202 {ok, mode:'live'}, config written,
//     restartAgent NEVER called (it throws here so a call is loud);
//   - applyRoute -> {mode:'restart'}: 202 {mode:'restart'} (main fires the
//     restart itself; the route does not double-fire);
//   - applyRoute absent: the old unconditional restartAgent, called once;
//   - applyRoute throws: reported as restart, restartAgent fired once.
// Hermetic: env-before-import discipline as test-chat-proxy.mjs.
// Run: node tests/test-live-route-switch.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-liveroute-'))
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
const chk = (n, c, d) => { if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) } }

const readConfig = () => {
  const out = {}
  try {
    for (const line of fs.readFileSync(path.join(process.env.AGENT_DATA_HOME, '.agent-config'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
    }
  } catch {}
  return out
}

// Mutable stub: each section swaps its behaviour.
const calls = { applyRoute: 0, restartAgent: 0 }
let applyRouteImpl = null // null = absent
let restartImpl = async () => { throw new Error('restartAgent must not be called on a live apply') }
const agentControls = {
  get applyRoute() { return applyRouteImpl ? (...a) => { calls.applyRoute++; return applyRouteImpl(...a) } : undefined },
  restartAgent: (...a) => { calls.restartAgent++; return restartImpl(...a) },
  stopAgent: async () => {},
  startAgent: async () => {},
  newConversation: async () => false,
  proxyHealth: async () => ({ running: false }),
  spawnInfo: () => ({ model: 'claude-opus-4-6', effort: 'high', provider: 'claude', at: 'x', live: { model: 'claude-opus-4-6', effort: 'high' } }),
  channelStatus: () => ({}),
  resolveClaudeBin: () => null,
  claudeCliInfo: () => ({}),
}

const srv = await createOnboardingServer(undefined, agentControls)
const base = `http://127.0.0.1:${srv.server.address().port}`
const auth = { 'x-onboard-token': SERVER_TOKEN, 'content-type': 'application/json' }
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const settle = () => new Promise((r) => setTimeout(r, 30))
const reset = () => { calls.applyRoute = 0; calls.restartAgent = 0 }

// ── live ──────────────────────────────────────────────────────────────────
{
  reset()
  applyRouteImpl = async () => ({ mode: 'live', reason: 'model claude-opus-4-6 -> claude-sonnet-4-6' })
  const r = await post('/api/agent/model', { model: 'claude-sonnet-4-6' })
  await settle()
  chk('model (live): 202', r.status === 202, r.status)
  chk('model (live): body carries mode:live and the model', r.json && r.json.ok === true && r.json.mode === 'live' && r.json.model === 'claude-sonnet-4-6', JSON.stringify(r.json))
  chk('model (live): config MODEL written', readConfig().MODEL === 'claude-sonnet-4-6', JSON.stringify(readConfig()))
  chk('model (live): applyRoute called once', calls.applyRoute === 1, calls.applyRoute)
  chk('model (live): restartAgent NEVER called', calls.restartAgent === 0, calls.restartAgent)

  reset()
  const e = await post('/api/agent/effort', { effort: 'low' })
  await settle()
  chk('effort (live): 202 with mode:live', e.status === 202 && e.json && e.json.mode === 'live' && e.json.effort === 'low', JSON.stringify(e.json))
  chk('effort (live): config EFFORT_LEVEL written', readConfig().EFFORT_LEVEL === 'low', readConfig().EFFORT_LEVEL)
  chk('effort (live): applyRoute once, restartAgent never', calls.applyRoute === 1 && calls.restartAgent === 0, JSON.stringify(calls))

  // validation still runs BEFORE applyRoute
  reset()
  const bad = await post('/api/agent/effort', { effort: 'ultra' })
  chk('effort: invalid level -> 400, applyRoute not called', bad.status === 400 && calls.applyRoute === 0, `${bad.status} ${calls.applyRoute}`)
  const badModel = await post('/api/agent/model', { model: 'bad model id!!' })
  chk('model: invalid id -> 400, applyRoute not called', badModel.status === 400 && calls.applyRoute === 0, `${badModel.status} ${calls.applyRoute}`)
}

// ── restart decided by applyRoute (main fires the restart itself) ──────────
{
  reset()
  applyRouteImpl = async () => ({ mode: 'restart', reason: 'credential class api-key -> oauth' })
  const r = await post('/api/agent/model', { model: 'claude-opus-4-7' })
  await settle()
  chk('model (restart via applyRoute): 202 with mode:restart + reason', r.status === 202 && r.json.mode === 'restart' && /credential/.test(r.json.reason), JSON.stringify(r.json))
  chk('model (restart via applyRoute): route does not ALSO call restartAgent', calls.applyRoute === 1 && calls.restartAgent === 0, JSON.stringify(calls))
}

// ── applyRoute absent -> the old unconditional restart, exactly once ───────
{
  reset()
  applyRouteImpl = null
  restartImpl = async () => {}
  const r = await post('/api/agent/model', { model: 'claude-opus-4-6' })
  await settle()
  chk('model (no applyRoute): 202 with mode:restart', r.status === 202 && r.json.mode === 'restart', JSON.stringify(r.json))
  chk('model (no applyRoute): restartAgent called exactly once', calls.restartAgent === 1, calls.restartAgent)
  reset()
  const e = await post('/api/agent/effort', { effort: 'high' })
  await settle()
  chk('effort (no applyRoute): 202 with mode:restart, restartAgent once', e.status === 202 && e.json.mode === 'restart' && calls.restartAgent === 1, `${JSON.stringify(e.json)} ${calls.restartAgent}`)
}

// ── applyRoute throws -> reported as restart, restartAgent fired once ──────
{
  reset()
  applyRouteImpl = async () => { throw new Error('boom') }
  restartImpl = async () => {}
  const r = await post('/api/agent/effort', { effort: 'max' })
  await settle()
  chk('effort (applyRoute throws): 202 mode:restart, restartAgent once, no 500', r.status === 202 && r.json.mode === 'restart' && calls.restartAgent === 1, `${r.status} ${JSON.stringify(r.json)} ${calls.restartAgent}`)
}

// ── spawn-info carries live ────────────────────────────────────────────────
{
  const res = await fetch(base + '/api/agent/spawn-info', { headers: { 'x-onboard-token': SERVER_TOKEN } })
  const j = await res.json()
  chk('spawn-info: passes main\'s live record through', j.spawn && j.spawn.live && j.spawn.live.model === 'claude-opus-4-6', JSON.stringify(j))
}

await new Promise((r) => srv.server.close(() => r()))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
