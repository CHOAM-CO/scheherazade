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
// Every /api request needs the onboard token since 2026-08-04 (GETs
// included) -- hit() attaches it by default once the scrape below fills it.
let defaultAuth = {}
async function hit(name, url, expect, init) {
  const r = await fetch(`${base}${url}`, { ...init, headers: { ...defaultAuth, ...(init && init.headers) } })
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
  defaultAuth = { 'x-onboard-token': token }

  // The 2026-08-04 boundary: reads are gated too, and the gate fires BEFORE
  // route dispatch (no route-existence oracle for tokenless callers).
  const noTokGet = await fetch(`${base}/api/config`)
  chk('GET /api/* without the onboard token is REFUSED (reads gated since 2026-08-04)', noTokGet.status === 403, noTokGet.status)

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
  // custom-provider/preview (2026-07-29): the group's one genuinely
  // side-effect-free POST -- it resolves a pasted provider definition and
  // writes nothing (no credential store, no .agent-config, no restart), so
  // unlike its sibling save route it is safe to fire here for real.
  const pv = await hit('G2 POST /api/agent/custom-provider/preview (valid paste)', '/api/agent/custom-provider/preview', 200,
    { method: 'POST', headers: auth, body: JSON.stringify({ json: JSON.stringify({ providers: { mine: { baseUrl: 'http://127.0.0.1:18080', apiKey: 'sk-preview', models: [{ id: 'some-model' }] } } }) }) })
  const pvBody = await pv.json()
  chk('G2 preview resolves the paste to baseUrl+model', pvBody.baseUrl === 'http://127.0.0.1:18080' && pvBody.model === 'some-model', JSON.stringify(pvBody))
  chk('G2 preview returns the key the SAME request sent (fills the write-only field; never a stored key)', pvBody.apiKey === 'sk-preview', JSON.stringify(pvBody))
  // The route must not have touched config -- proving "preview writes
  // nothing" rather than asserting it in a comment. PROVIDER is whatever the
  // fixture had before; the paste above never becomes live.
  const afterPreview = await (await hit('G2 GET /api/config (after preview)', '/api/config', 200)).json()
  chk('G2 preview left PROVIDER alone (no write)', afterPreview.PROVIDER !== 'custom', `PROVIDER=${afterPreview.PROVIDER}`)
  chk('G2 preview left CUSTOM_BASE_URL alone (no write)', !afterPreview.CUSTOM_BASE_URL, `CUSTOM_BASE_URL=${afterPreview.CUSTOM_BASE_URL}`)
  // A paste this app cannot honestly run comes back 400 with a reason, never
  // narrowed-and-accepted (see parseCustomProviderJson's header).
  await hit('G2 POST .../preview (two providers in one paste)', '/api/agent/custom-provider/preview', 400,
    { method: 'POST', headers: auth, body: JSON.stringify({ json: JSON.stringify({ providers: { a: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'x' }] }, b: { baseUrl: 'http://127.0.0.1:2', models: [{ id: 'y' }] } } }) }) })
  await hit('G2 POST .../preview (dialect we cannot speak)', '/api/agent/custom-provider/preview', 400,
    { method: 'POST', headers: auth, body: JSON.stringify({ json: JSON.stringify({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', model: 'm' }) }) })
  // The route's OWN model-id gate, which the parser deliberately does not
  // apply (it returns the raw id so both call sites gate identically). Without
  // this case that branch is unexercised -- the parser accepts the id, so only
  // a live request proves the route rejects it.
  await hit('G2 POST .../preview (model id the pattern rejects)', '/api/agent/custom-provider/preview', 400,
    { method: 'POST', headers: auth, body: JSON.stringify({ json: JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: 'bad model/../id!' }) }) })
  // Response-size bound, asserted on the WIRE. readJsonBody accepts 1MB and
  // refusal text quotes user input, and the settings page drops these bodies
  // into a one-line status element. Deleting the route's own .slice() used to
  // leave every suite green, so the cap that actually holds the response had
  // no test at all. Named model ids are what get echoed back, so 20 of them
  // at 60KB each is the shape that maximizes it.
  {
    // Sized to stay UNDER readJsonBody's 1MB cap on the outer request: past
    // it the server destroys the socket (correctly), which tests the body
    // limit rather than the response bound this case is about.
    const huge = JSON.stringify({ baseUrl: 'http://127.0.0.1:1', models: Array.from({ length: 12 }, (_, i) => ({ id: `${'M'.repeat(50_000)}-${i}` })) })
    const r = await hit('G2 POST .../preview (a paste built to maximize the error body)', '/api/agent/custom-provider/preview', 400,
      { method: 'POST', headers: auth, body: JSON.stringify({ json: huge }) })
    const body = await r.text()
    chk('G2 preview bounds its 400 body regardless of input size', body.length < 800, `body was ${body.length} bytes for a ${huge.length}-byte paste`)
  }
  // /api/byok/validate IS reachable here (it is hit above), so its bound gets
  // a real case. An earlier version of this comment claimed both routes were
  // unreachable -- false, and in the very file that calls one of them.
  {
    const r = await hit('G2 POST /api/byok/validate (900KB base URL)', '/api/byok/validate', 200,
      { method: 'POST', headers: auth, body: JSON.stringify({ provider: 'custom', key: 'k', baseUrl: `http://x.example/${'A'.repeat(900_000)}` }) })
    const body = await r.text()
    chk('G2 byok/validate bounds its body for a 900KB base URL', body.length < 300, `body was ${body.length} bytes`)
  }
  // NOT tested here: POST /api/agent/custom-provider. Its `agentControls not
  // wired` 500 fires before any URL validation in this harness, so a case
  // written against it would go green on a 500 body and prove nothing. Their
  // fix is in resolveCustomBaseUrl itself (a length gate BEFORE anything
  // quotes the value), which is where every one of those routes gets its
  // error string; scripts/test-provider-env.mjs asserts it at that source.

  // ── G3 channels ───────────────────────────────────────────────────────────
  const ch = await hit('G3 GET /api/channels/status', '/api/channels/status', 200)
  const chBody = await ch.json()
  chk('G3 channels/status has active+backends shape', 'active' in chBody && 'backends' in chBody, JSON.stringify(chBody).slice(0, 200))
  chk('G3 backends map carries the local entry (readiness; its absence 500d the switch route)',
    chBody.backends.local && chBody.backends.local.configured === true, JSON.stringify(chBody.backends).slice(0, 200))

  // Switch to local: safe to fire for real here (no agentControls in this
  // harness -> no restart), and it is the exact call that 500'd on
  // readiness['local'].configured before the readiness entry existed
  // (in-app chat slice 5 catch) -- the 202 is the whole proof.
  const sw = await hit('G3 POST /api/channels/switch to local', '/api/channels/switch', 202,
    { method: 'POST', headers: auth, body: JSON.stringify({ backend: 'local' }) })
  chk('G3 switch reports local active', (await sw.json()).active === 'local')

  // The in-app onboarding completer (slice 5). Fresh fixture -> stamps now;
  // the second call must NOT re-stamp (ONBOARDING_COMPLETED_AT is a record
  // of when onboarding happened, same falsification rule as the discord
  // reconnect routes). onOnboardingComplete is absent in this harness, so
  // no spawn fires.
  const lc = await hit('G3 POST /api/channels/local/complete', '/api/channels/local/complete', 202,
    { method: 'POST', headers: auth, body: '{}' })
  const lcBody = await lc.json()
  chk('G3 local complete stamps a fresh fixture (completedNow:true)', lcBody.ok === true && lcBody.active === 'local' && lcBody.completedNow === true, JSON.stringify(lcBody))
  const cfgAfterLocal = await (await hit('G3 GET /api/config (after local complete)', '/api/config', 200)).json()
  chk('G3 the stamp landed in config', cfgAfterLocal.CHANNEL_BACKEND === 'local' && cfgAfterLocal.ONBOARDING_COMPLETE === '1',
    JSON.stringify({ backend: cfgAfterLocal.CHANNEL_BACKEND, complete: cfgAfterLocal.ONBOARDING_COMPLETE }))
  const lc2 = await hit('G3 POST local/complete again (already onboarded)', '/api/channels/local/complete', 202,
    { method: 'POST', headers: auth, body: '{}' })
  chk('G3 re-complete does not re-stamp (completedNow:false)', (await lc2.json()).completedNow === false)

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

  // ── G10 setup-token (in-app `claude setup-token` capture) ────────────────
  // POST /api/setup-token/start is SKIPPED for the same reason G4's login
  // POST is: it spawns a real claude CLI child. The other three routes have
  // no side effects before a session exists, and between them they still
  // exercise the thing this file was written to catch -- the
  // getSetupTokenSession staticCtx binding, which is runtime-only and would
  // surface as a 500 on first hit.
  const st = await hit('G10 GET /api/setup-token/status', '/api/setup-token/status', 200)
  const stBody = await st.json()
  chk('G10 status is idle before anything starts',
    stBody.state === 'idle' && stBody.provider === 'claude-subscription', JSON.stringify(stBody))
  chk('G10 status carries no credential-shaped field',
    !('token' in stBody) && !('raw' in stBody) && !('output' in stBody), JSON.stringify(stBody))

  // The manual-code route with no session running: 400 by name, and -- the
  // assertion that matters -- the rejected value is NOT echoed back. This is
  // the unbounded-echo class that has bitten this server repeatedly, checked
  // here on the wire rather than trusted from the handler's source.
  const marker = 'ZZUNIQUECODEMARKERZZ'
  const badCode = await hit('G10 POST /api/setup-token/code (no session)', '/api/setup-token/code', 400,
    { method: 'POST', headers: auth, body: JSON.stringify({ code: marker }) })
  const badBody = await badCode.text()
  chk('G10 code rejection names a fixed reason', JSON.parse(badBody).reason === 'not_running', badBody.slice(0, 200))
  chk('G10 code rejection does NOT echo the submitted code', !badBody.includes(marker), badBody.slice(0, 200))
  chk('G10 code rejection stays small (no buffer/prose smuggled in)', badBody.length < 300, `len=${badBody.length}`)

  // Cancel with nothing running is a no-op, not an error -- a user who backs
  // out of a flow that already ended must not see a failure.
  const cx = await hit('G10 POST /api/setup-token/cancel (nothing running)', '/api/setup-token/cancel', 200,
    { method: 'POST', headers: auth, body: '{}' })
  const cxBody = await cx.json()
  chk('G10 cancel is a clean no-op when idle', cxBody.ok === true, JSON.stringify(cxBody).slice(0, 200))

  // Mutating routes must be behind the per-launch token like every other POST
  // in this server -- an unauthenticated caller must not be able to spawn a
  // CLI child or drive a pty.
  const noTok = await fetch(`${base}/api/setup-token/start`, { method: 'POST' })
  chk('G10 start without the onboard token is refused', noTok.status === 403, noTok.status)
  const noTokCode = await fetch(`${base}/api/setup-token/code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abcd1234' }),
  })
  chk('G10 code without the onboard token is refused', noTokCode.status === 403, noTokCode.status)

  // ── G11 chat proxy (binding-level only; behavior lives in ────────────────
  // scripts/test-chat-proxy.mjs against a real fake channel). No
  // local-channel.json exists in this fixture, so every route takes its
  // not-running branch -- which still proves the staticCtx bindings (fs,
  // path, DATA_HOME, activeChannelBackend) this file exists to catch.
  const chs = await hit('G11 GET /api/chat/status', '/api/chat/status', 200)
  const chsBody = await chs.json()
  chk('G11 status reads not_running on a fresh fixture', chsBody.up === false && chsBody.reason === 'not_running', JSON.stringify(chsBody))
  // Plain fetch, not hit(): these two routes PROMISE a 503 here (chat channel
  // not running), so hit()'s blanket never-≥500 check would fail the correct
  // answer. "Exactly 503, not 500" is itself the binding-intact proof -- a
  // missed staticCtx binding surfaces as 500, never as this named 503.
  const chOut = await fetch(`${base}/api/chat/out`, { headers: defaultAuth })
  chk('G11 GET /api/chat/out (no channel) -> exactly 503, not a binding 500', chOut.status === 503, chOut.status)
  const chIn = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x' }) })
  chk('G11 POST /api/chat/in (no channel) -> exactly 503, not a binding 500', chIn.status === 503, chIn.status)
  const chNoTok = await fetch(`${base}/api/chat/in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })
  chk('G11 in without the onboard token is refused', chNoTok.status === 403, chNoTok.status)

  // ── dispatch-contract edges (the old chain's exact fall-through) ──────────
  // 'chatgpt' IS in LOGIN_PROVIDERS (login-status.cjs), so the allowlist
  // passes and PUT hits none of the GET/POST/DELETE branches -- the old
  // chain fell through to the 404; the dispatch loop must do the same.
  const put = await fetch(`${base}/api/onboarding/login/chatgpt`, { method: 'PUT', headers: defaultAuth })
  chk('login regex + unsupported verb (PUT) falls through to the 404, not a hang',
    put.status === 404, put.status)
  const nf = await fetch(`${base}/api/no/such/route`, { headers: defaultAuth })
  chk('unmatched path gets the verbatim 404 line', nf.status === 404, nf.status)
  chk("...with today's error shape", (await nf.json()).error === 'no such API route: GET /api/no/such/route')
} finally {
  srv.server.close()
  service.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
