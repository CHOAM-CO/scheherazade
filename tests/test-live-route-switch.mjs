// test-live-route-switch.mjs -- POST /api/agent/model and /api/agent/effort
// go through agentControls.applyRoute (route proxy, 2026-10-07) instead of an
// unconditional restartAgent. Over the REAL onboarding server with a stub
// agentControls:
//   - applyRoute -> {mode:'live'}: 202 {ok, mode:'live'}, config written,
//     restartAgent NEVER called (it throws here so a call is loud);
//   - applyRoute -> {mode:'restart'}: 202 {mode:'restart'} (main fires the
//     restart itself; the route does not double-fire);
//   - applyRoute absent: the old unconditional restartAgent, called once;
//   - applyRoute throws: reported as restart, restartAgent fired once;
//   - GET /api/agent/route-preview (0.3.14): previewRoute's {mode, reason}
//     with the query overrides, config NOT written, nothing restarted;
//     absent previewRoute -> mode restart; bad query -> 400.
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
const calls = { applyRoute: 0, restartAgent: 0, previewRoute: 0 }
let applyRouteImpl = null // null = absent
let previewRouteImpl = null // null = absent
let previewSeen = null
let restartImpl = async () => { throw new Error('restartAgent must not be called on a live apply') }
const agentControls = {
  get applyRoute() { return applyRouteImpl ? (...a) => { calls.applyRoute++; return applyRouteImpl(...a) } : undefined },
  restartAgent: (...a) => { calls.restartAgent++; return restartImpl(...a) },
  get previewRoute() { return previewRouteImpl ? (o) => { calls.previewRoute++; previewSeen = o; return previewRouteImpl(o) } : undefined },
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
const reset = () => { calls.applyRoute = 0; calls.restartAgent = 0; calls.previewRoute = 0; previewSeen = null }
const get = async (p) => {
  const res = await fetch(base + p, { headers: { 'x-onboard-token': SERVER_TOKEN } })
  return { status: res.status, json: await res.json().catch(() => null) }
}

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

// ── route-preview: decision only, nothing written ─────────────────────────
{
  reset()
  restartImpl = async () => { throw new Error('restartAgent must not be called by a preview') }
  const before = JSON.stringify(readConfig())
  previewRouteImpl = (o) => (o.model === 'gpt-5.4' ? { mode: 'live', reason: 'model gpt-5.5 -> gpt-5.4' } : { mode: 'restart', reason: 'unknown codex model gpt-6-astra' })
  const live = await get('/api/agent/route-preview?model=gpt-5.4&provider=chatgpt')
  chk('preview (live): 200 {mode:live, reason}', live.status === 200 && live.json && live.json.mode === 'live' && /gpt-5.4/.test(live.json.reason), JSON.stringify(live.json))
  chk('preview: overrides reach previewRoute', previewSeen && previewSeen.model === 'gpt-5.4' && previewSeen.provider === 'chatgpt' && !('effort' in previewSeen), JSON.stringify(previewSeen))
  const restart = await get('/api/agent/route-preview?model=gpt-6-astra')
  chk('preview (restart): 200 {mode:restart, reason}', restart.status === 200 && restart.json.mode === 'restart' && /unknown codex model/.test(restart.json.reason), JSON.stringify(restart.json))
  const eff = await get('/api/agent/route-preview?effort=low')
  chk('preview (effort only): effort override alone', eff.status === 200 && previewSeen && previewSeen.effort === 'low' && !('model' in previewSeen), JSON.stringify(previewSeen))
  chk('preview: config NOT written', JSON.stringify(readConfig()) === before, `${before} -> ${JSON.stringify(readConfig())}`)
  chk('preview: applyRoute and restartAgent never called', calls.applyRoute === 0 && calls.restartAgent === 0 && calls.previewRoute === 3, JSON.stringify(calls))
  const badEffort = await get('/api/agent/route-preview?effort=ultra')
  const badModel = await get('/api/agent/route-preview?model=bad%20id!!')
  const badProvider = await get('/api/agent/route-preview?provider=nope')
  chk('preview: invalid effort / model / provider -> 400', badEffort.status === 400 && badModel.status === 400 && badProvider.status === 400, `${badEffort.status} ${badModel.status} ${badProvider.status}`)
  previewRouteImpl = () => { throw new Error('boom') }
  const threw = await get('/api/agent/route-preview?effort=low')
  chk('preview: previewRoute throws -> 200 mode:restart (dialog falls back to the restart wording)', threw.status === 200 && threw.json.mode === 'restart', JSON.stringify(threw.json))
  previewRouteImpl = null
  const absent = await get('/api/agent/route-preview?effort=low')
  chk('preview: previewRoute absent -> 200 mode:restart', absent.status === 200 && absent.json.mode === 'restart' && /not wired/.test(absent.json.reason), JSON.stringify(absent.json))
}

// ── spawn-info carries live ────────────────────────────────────────────────
{
  const res = await fetch(base + '/api/agent/spawn-info', { headers: { 'x-onboard-token': SERVER_TOKEN } })
  const j = await res.json()
  chk('spawn-info: passes main\'s live record through', j.spawn && j.spawn.live && j.spawn.live.model === 'claude-opus-4-6', JSON.stringify(j))
}

// ── source pins: lane /select-model effort path on declared routes (0.3.15) ──
// Mino 10-07 19:12: after a live effort switch the agent's $DSH_EFFORT (spawn
// value) said high while the proxy served low. The lane now applies effort on
// ANY route via client.selectModel(sessionId, <current provider>, <current
// model>, effort), moves DSH_EFFORT + process.env.DSH_EFFORT, and writes
// DATA_HOME/.live-route.json. Model on declared routes stays applied:false.
{
  const lane = fs.readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')
  const sel = lane.slice(lane.indexOf("if (req.url === '/select-model') {"), lane.indexOf("if (req.url !== '/inbound')"))
  chk('lane: DSH_EFFORT is `let` (a live switch moves it)', /\nlet DSH_EFFORT = process\.env\.DSH_EFFORT/.test(lane))
  const declared = sel.slice(sel.indexOf("if (DSH_ROUTE !== 'anthropic-catalog') {"), sel.indexOf("client.selectModel(sessionId, 'anthropic', model"))
  chk('lane: declared route applies effort via selectModel(sessionId, DSH_PROVIDER, DSH_MODEL, effort)', /client\.selectModel\(sessionId, DSH_PROVIDER, DSH_MODEL, effort !== 'off' \? effort : undefined\)/.test(declared))
  chk('lane: declared route keeps applied:false for the model but reports effortApplied', /applied: false, effortApplied: effortChanged/.test(declared))
  chk('lane: declared route moves DSH_EFFORT and process.env.DSH_EFFORT', /DSH_EFFORT = effort\s*\n\s*process\.env\.DSH_EFFORT = effort/.test(declared))
  chk('lane: declared route writes .live-route.json', /writeLiveRoute\(model, effort \|\| DSH_EFFORT\)/.test(declared))
  const catalog = sel.slice(sel.indexOf("client.selectModel(sessionId, 'anthropic', model"))
  chk('lane: catalog route also moves DSH_EFFORT + env and writes .live-route.json', /if \(effort\) \{ DSH_EFFORT = effort; process\.env\.DSH_EFFORT = effort \}/.test(catalog) && /writeLiveRoute\(model, effort \|\| DSH_EFFORT\)/.test(catalog))
  chk('lane: .live-route.json lives in the data home with {model, effort, since}', /path\.join\(MEM, '\.live-route\.json'\)/.test(lane) && /JSON\.stringify\(\{ model: model \|\| null, effort: effort \|\| null, since: new Date\(\)\.toISOString\(\) \}\)/.test(lane))
  chk('lane: .live-route.json written at session start too (file always exists)', /process\.exit\(78\)[\s\S]{0,200}writeLiveRoute\(DSH_MODEL, DSH_EFFORT\)/.test(lane))
  const main = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  chk('main: applyRouteInner passes effort to the lane on every live apply (effort-only included)', /notifyLaneSelectModel\(next\.DSH_MODEL, next\.DSH_EFFORT\)/.test(main))
  const prompt = fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'agent-system-prompt.md'), 'utf8')
  chk('prompt: agent is pointed at .live-route.json, not env, for the applied effort', prompt.includes('.live-route.json') && /\$DSH_EFFORT/.test(prompt))
}

await new Promise((r) => srv.server.close(() => r()))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
