#!/usr/bin/env node
// test-route-dispatch-e2e.mjs -- the PR-2 route-grouping dispatch table over
// the REAL server (issue #9, PR-2). handleApi's if-chain became a table of
// onboarding/routes/*.cjs entries bound once via staticCtx -- and a MISSED
// staticCtx binding is a runtime-only ReferenceError (500 on first hit,
// invisible to node --check and to require()). So this file boots
// createOnboardingServer the way test-memory-routes-e2e.mjs does and hits at
// least one side-effect-free route from EVERY group (G1..G9), asserting the
// wire status each route actually promises -- never a 500.
//
// Deliberately SKIPPED (side effects a test must not fire):
//   G1 login/bootstrap POSTs        -- spawn codex/ollama login children
//   G2 (has no side-effect-free GET) -- covered by POST /api/byok/validate
//                                      with an UNKNOWN provider: the 400
//                                      fires before any validation/storage
//   G3 apply/switch/open POSTs      -- restart the agent / call live APIs
//   G4 login POST                   -- spawns a claude CLI child
//   G5 stop/start/restart/model/effort POSTs -- lifecycle side effects
//                                      (and 500 'not wired' without Electron)
//   G7 permissions/status GET       -- getElectron() (no Electron here) +
//                                      system probes + snapshot write;
//      probe-automation POST        -- SENDS an Apple event (consent dialog);
//      fda/open + relaunch POSTs    -- open System Settings / relaunch app
//
// Hermetic: HOME/AGENT_DATA_HOME/SCHEHERAZADE_MEMORY_DB point at a temp dir
// BEFORE anything is imported (http-server resolves DATA_HOME and the memory
// service resolves DB_PATH at module load). G9's rename writes DISPLAY_NAME
// only into the fixture .agent-config -- gone with the tmpdir.
//
// Run: node scripts/test-route-dispatch-e2e.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-dispatch-'))

const fixtureHome = path.join(tmp, 'home')
fs.mkdirSync(fixtureHome, { recursive: true })
process.env.HOME = fixtureHome
process.env.AGENT_DATA_HOME = path.join(tmp, 'data')
fs.mkdirSync(process.env.AGENT_DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')

// require() AFTER the env block above -- same discipline as
// test-memory-routes-e2e.mjs, and the same singleton the routes run on.
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createOnboardingServer } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
const service = await import(pathToFileURL(path.join(ROOT, 'memory', 'service.mjs')).href)

let pass = 0
let fail = 0
const chk = (n, c, d) => {
  if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) }
}

const srv = await createOnboardingServer()
const port = srv.server.address().port
const base = `http://127.0.0.1:${port}`

// One helper: assert an exact wire status AND that no route 500s -- a missed
// staticCtx binding surfaces as exactly that 500.
async function hit(name, url, expect, init) {
  const r = await fetch(`${base}${url}`, init)
  chk(`${name} -> ${expect}`, r.status === expect, `got ${r.status}`)
  chk(`${name} never 500s (staticCtx binding intact)`, r.status < 500, `got ${r.status}`)
  return r
}

try {
  // The per-launch token, the way the browser gets it (mutating routes only).
  const page = await (await fetch(`${base}/memory`)).text()
  const m = page.match(/name="onboard-token" content="([a-f0-9]+)"/)
  chk('the page carries an onboard token', Boolean(m), page.slice(0, 120))
  const token = m ? m[1] : ''
  const auth = { 'x-onboard-token': token, 'content-type': 'application/json' }

  // ── G1 onboarding-meta ────────────────────────────────────────────────────
  const cfg = await hit('G1 GET /api/config', '/api/config', 200)
  const cfgBody = await cfg.json()
  chk('G1 config carries the live computed fields', 'routerWired' in cfgBody && 'availableProviders' in cfgBody, JSON.stringify(cfgBody).slice(0, 200))
  await hit('G1 GET /api/onboarding/bootstrap/status', '/api/onboarding/bootstrap/status', 200)
  // login regex, any-method allowlist branch: a GARBAGE provider 400s for GET
  // too -- proves the method:null regex entry dispatches at all.
  await hit('G1 GET /api/onboarding/login/nope/status (unknown provider)', '/api/onboarding/login/nope/status', 400)

  // ── G2 provider (no side-effect-free GET in the group) ────────────────────
  // Unknown provider = the 400 fires BEFORE any validation/storage path.
  await hit('G2 POST /api/byok/validate (garbage provider)', '/api/byok/validate', 400,
    { method: 'POST', headers: auth, body: JSON.stringify({ provider: 'garbage-provider', key: 'x' }) })

  // ── G3 channels ───────────────────────────────────────────────────────────
  const ch = await hit('G3 GET /api/channels/status', '/api/channels/status', 200)
  const chBody = await ch.json()
  chk('G3 channels/status has active+backends shape', 'active' in chBody && 'backends' in chBody, JSON.stringify(chBody).slice(0, 200))

  // ── G4 mcp-connectors ─────────────────────────────────────────────────────
  const mc = await hit('G4 GET /api/mcp-connector/status?name=github', '/api/mcp-connector/status?name=github', 200)
  const mcBody = await mc.json()
  chk('G4 unknown connector reads as idle (default status map)', mcBody.state === 'idle', JSON.stringify(mcBody))
  // list GET: agentControls is absent in this harness -> cli_missing branch,
  // still 200 and still exercises connectorLaneWarning + readAgentConfig.
  const ml = await hit('G4 GET /api/mcp-connectors', '/api/mcp-connectors', 200)
  const mlBody = await ml.json()
  chk('G4 list without a CLI reports cli_missing (no shell-out)', mlBody.ok === false && mlBody.reason === 'cli_missing', JSON.stringify(mlBody))

  // ── G5 agent-lifecycle (read-only routes only; POSTs skipped, see header) ─
  await hit('G5 GET /api/agent/status', '/api/agent/status', 200)
  const ph = await hit('G5 GET /api/proxy/health', '/api/proxy/health', 200)
  chk('G5 proxy/health without controls reports running:false', (await ph.json()).running === false)
  const cs = await hit('G5 GET /api/context-status', '/api/context-status', 200)
  chk('G5 context-status without a snapshot reports available:false', (await cs.json()).available === false)
  const si = await hit('G5 GET /api/agent/spawn-info', '/api/agent/spawn-info', 200)
  chk('G5 spawn-info without controls reports spawn:null', (await si.json()).spawn === null)
  await hit('G5 GET /api/agent/mute-status', '/api/agent/mute-status', 200)

  // ── G6 autonomy ───────────────────────────────────────────────────────────
  const au = await hit('G6 GET /api/autonomy', '/api/autonomy', 200)
  const auBody = await au.json()
  chk('G6 autonomy carries enabled+cap+today', 'enabled' in auBody && 'cap' in auBody && 'today' in auBody, JSON.stringify(auBody).slice(0, 200))

  // ── G7 permissions/sudo/topology (probe-firing routes skipped, see header) ─
  await hit('G7 GET /api/logs', '/api/logs?since=0', 200)
  const sc = await hit('G7 GET /api/sudo/config', '/api/sudo/config', 200)
  const scBody = await sc.json()
  chk('G7 sudo/config reports disabled+no-password on a fresh home', scBody.enabled === false && scBody.hasPassword === false, JSON.stringify(scBody))
  // sudo/password without the askpass token: the fail-closed 403 branch --
  // exercises the LIVE callCtx.getAskpassToken() getter end to end.
  await hit('G7 GET /api/sudo/password (no askpass token)', '/api/sudo/password', 403)
  const tp = await hit('G7 GET /api/topology', '/api/topology', 200)
  const tpBody = await tp.json()
  chk('G7 topology defaults to spawn and carries the bootstrap cmd', tpBody.topology === 'spawn' && typeof tpBody.bootstrapCmd === 'string', JSON.stringify(tpBody).slice(0, 200))
  await hit('G7 GET /api/onboarding/fda/status (heuristic read)', '/api/onboarding/fda/status', 200)

  // ── G8 memory & journal ───────────────────────────────────────────────────
  const jr = await hit('G8 GET /api/journal', '/api/journal', 200)
  const jrBody = await jr.json()
  chk('G8 journal has rows+gaps shape', Array.isArray(jrBody.rows) && Array.isArray(jrBody.gaps), JSON.stringify(jrBody).slice(0, 200))
  await hit('G8 GET /api/memory/user_facts', '/api/memory/user_facts', 200)

  // ── G9 settings ───────────────────────────────────────────────────────────
  const rn = await hit('G9 POST /api/settings/rename', '/api/settings/rename', 200,
    { method: 'POST', headers: auth, body: JSON.stringify({ displayName: 'e2e-디스패치' }) })
  const rnBody = await rn.json()
  chk('G9 rename echoes the merged config (DISPLAY_NAME landed in the fixture)', rnBody.ok === true && rnBody.config.DISPLAY_NAME === 'e2e-디스패치', JSON.stringify(rnBody).slice(0, 200))

  // ── dispatch-contract edges (the old chain's exact fall-through) ──────────
  // 'chatgpt' IS in LOGIN_PROVIDERS (login-status.cjs), so the allowlist
  // passes and PUT hits none of the GET/POST/DELETE branches -- the old
  // chain fell through to the 404; the dispatch loop must do the same.
  const put = await fetch(`${base}/api/onboarding/login/chatgpt`, { method: 'PUT' })
  chk('login regex + unsupported verb (PUT) falls through to the 404, not a hang',
    put.status === 404, put.status)
  const nf = await fetch(`${base}/api/no/such/route`)
  chk('unmatched path gets the verbatim 404 line', nf.status === 404, nf.status)
  chk("...with today's error shape", (await nf.json()).error === 'no such API route: GET /api/no/such/route')
} finally {
  srv.server.close()
  service.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
