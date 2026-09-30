// test-codex-proxy-model.mjs -- the chatgpt lane's model passthrough is REAL.
// Run: node tests/test-codex-proxy-model.mjs
//
// Caught live (Mino's second-device test, 2026-07-14): codex-as-api's
// anthropic route sends its MODULE-LEVEL default model and only echoes
// body.model, so the dropdown's gpt-5.6-* pick never reached the engine.
// main.cjs's fix = set CODEX_AS_API_MODEL before require + evict the require
// cache per rebuild + gate on the proxy's own /health model report.
//
// This test executes the REAL module through the exact mechanics main.cjs
// uses -- no mocks: (1) default load reports the bundled default; (2) env +
// cache-evict reloads with the picked model; (3) /health is a truthful
// receipt for both. No ChatGPT call is made -- /health reads config only.

import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

function loadFresh() {
  try { delete require_.cache[require_.resolve('codex-as-api')] } catch {}
  return require_('codex-as-api')
}

async function healthOf(createApp) {
  const srv = await new Promise((resolve, reject) => {
    const s = createApp().listen(0, '127.0.0.1')
    s.once('listening', () => resolve(s))
    s.once('error', reject)
  })
  try {
    const { port } = srv.address()
    return await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).json()
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
}

async function healthModel(createApp) {
  const srv = await new Promise((resolve, reject) => {
    const s = createApp().listen(0, '127.0.0.1')
    s.once('listening', () => resolve(s))
    s.once('error', reject)
  })
  try {
    const { port } = srv.address()
    const health = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).json()
    return health.model
  } finally {
    // Awaited rather than fire-and-forget. Tried first as the fix for the
    // Windows abort described at the bottom of this file, and it was NOT the
    // cause -- the abort reproduced 5/5 with this in place. Kept anyway
    // because abandoning a server mid-close is wrong on its own terms, but
    // recorded as a falsified hypothesis so nobody re-tries it.
    await new Promise((resolve) => srv.close(resolve))
  }
}

console.log('\n-- codex-as-api model passthrough (the main.cjs lever, executed for real)')

// Sentinel ids, deliberately fake: the default model is MACHINE-DEPENDENT
// (env || ~/.codex/config.toml || bundled "gpt-5.5" -- on this dev Mac the
// toml says gpt-5.6-terra, so asserting any specific default is asserting
// someone's dotfile; first run of this test did exactly that and convicted
// the machine, not the code). What IS machine-independent: a sentinel no
// config could plausibly contain must come back verbatim when injected,
// and must never appear without injection.
const SENTINEL_A = 'gpt-test-sentinel-sol'
const SENTINEL_B = 'gpt-test-sentinel-luna'

delete process.env.CODEX_AS_API_MODEL
const defaultModel = await healthModel(loadFresh().createApp)
ok('default load reports SOME model (machine config or bundled default)', typeof defaultModel === 'string' && defaultModel.length > 0, String(defaultModel))
ok('...and never a sentinel we did not inject', defaultModel !== SENTINEL_A && defaultModel !== SENTINEL_B, defaultModel)

process.env.CODEX_AS_API_MODEL = SENTINEL_A
const pickedModel = await healthModel(loadFresh().createApp)
ok('env + cache-evict reload serves the PICKED model verbatim', pickedModel === SENTINEL_A, String(pickedModel))

process.env.CODEX_AS_API_MODEL = SENTINEL_B
const swappedModel = await healthModel(loadFresh().createApp)
ok('a second swap takes too (eviction really reloads the constant)', swappedModel === SENTINEL_B, String(swappedModel))

delete process.env.CODEX_AS_API_MODEL
const backToDefault = await healthModel(loadFresh().createApp)
ok('clearing the env returns to the proxy default (non-gpt picks leave it alone)', backToDefault === defaultModel, String(backToDefault))

// main.cjs wiring pins: the lever is only real if main.cjs actually pulls it.
import fs from 'node:fs'
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
ok('main.cjs sets CODEX_AS_API_MODEL BEFORE the require', mainSrc.indexOf('process.env.CODEX_AS_API_MODEL = desiredModel') < mainSrc.indexOf("({ createApp } = require('codex-as-api'))"))
ok('main.cjs evicts the require cache per rebuild', mainSrc.includes("delete require.cache[require.resolve('codex-as-api')]"))
ok('main.cjs gates on the /health model receipt (fail closed on mismatch)', mainSrc.includes('model passthrough FAILED'))
ok('a model swap rebuilds the live proxy (codexProxyModel compared on ensure)', mainSrc.includes('codexProxyModel === desiredModel') && mainSrc.includes('codexProxyModel = desiredModel'))

// ── ephemeral port wiring (2026-08-04) ────────────────────────────────────
// The proxy binds port 0 by default, so the port EXISTS ONLY AFTER THE BIND.
// buildProviderEnv runs before that and clears DSH_ROUTE_BASE_URL (asserted in
// test-provider-env.mjs); main.cjs is what fills it in. That handoff is the
// whole risk of the change: if it is ever dropped, the agent spawns with no
// route base URL at all.
//
// It fails LOUD in that case rather than misrouting -- the old hardcoded
// localhost:18080 default would have handed the conversation stream to
// whatever owned that port -- but loud is still broken, so the wiring is
// pinned here.
//
// (The field is DSH_ROUTE_BASE_URL, not ANTHROPIC_BASE_URL, since the 0.2.2
// dsh swap turned the chatgpt row into a declared anthropic-messages route;
// and the bind goes through startShimmedProxy since 2026-08-20, whose OUTER
// server is what takes the requested port.)
ok('the default bind is ephemeral, not a fixed port', mainSrc.includes("const requestedPort = explicitPort ? Number(portResult.port) : 0"))
ok('the ephemeral request reaches the shim\'s outer server', /startShimmedProxy\(\{ app: createApp\(\), port: requestedPort/.test(mainSrc))
ok('the bound port is read back from the socket, never assumed', /const bound = codexProxyServer\.address\(\)/.test(mainSrc) && mainSrc.includes('port = bound.port'))
ok('ensureCodexProxy hands the caller the port it actually bound', /return \{ ok: true, port \}/.test(mainSrc))
ok('the caller fills DSH_ROUTE_BASE_URL with that port', mainSrc.includes('providerEnvResult.env.DSH_ROUTE_BASE_URL = `http://localhost:${proxy.port}`'))
ok('the caller refuses to spawn on a port it cannot use', mainSrc.includes('Number.isInteger(proxy.port)'))
// The reuse path and the health reporter both have to read the LIVE port, not
// recompute one from config -- config does not know it any more.
ok('the live bound port is remembered for reuse/health (codexProxyPort)', mainSrc.includes('let codexProxyPort = null') && mainSrc.includes('codexProxyPort = port'))
ok('...and cleared when the proxy goes down', /codexProxyServer = null\s*\n\s*codexProxyModel = null\s*\n\s*codexProxyPort = null/.test(mainSrc))
ok('proxyHealth prefers the live bound port over config', mainSrc.indexOf('let port = codexProxyPort') < mainSrc.indexOf('portResult = resolveChatgptProxyPort(raw)'))
// The old "default port is occupied -> refuse to spawn" branch must be GONE,
// not merely unreachable: an ephemeral bind cannot collide, and leaving the
// branch would invite someone to reinstate a default to feed it.
ok('the occupied-default-port blocker is gone with the default that caused it', !mainSrc.includes('already listen on the default proxy port'))
// ...and provider-env must not quietly reinstate one either.
{
  const penvSrc = fs.readFileSync(path.join(ROOT, 'provider-env.cjs'), 'utf8')
  ok('provider-env clears the route base URL rather than defaulting it',
    penvSrc.includes('DSH_ROUTE_BASE_URL: values.port ? `http://localhost:${values.port}` : undefined'))
}

// ── context-cap drift guard (task #6, 2026-08-13) ───────────────────────────
// codex-as-api ships no model-list export and no /v1/models route, so the
// picker's GPT rows can't be fetched at runtime -- they stay a static catalog
// (connectors.js) and the context caps stay hand-pinned (http-server.cjs
// contextCapForModel). A hand-pin rots silently when a proxy bump moves the
// table -- which is exactly what the old 372_000 pin did (0.5.2 had no window
// numbers to check it against). This guard ties the pin to the LIVE proxy: it
// boots each catalog GPT model in-process and asserts the proxy's OWN /health
// context_window equals our pinned cap. CODEX_HOME points at an empty temp dir
// so a machine's ~/.codex/config.toml (this dev Mac overrides model + effort)
// can't skew the reading toward a per-machine override -- we want the package
// default. No network, no ChatGPT call: /health reads config only.
console.log('\n-- context-cap drift guard (proxy /health vs the hand-pinned cap)')
{
  const { contextCapForModel } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-neutral-home-'))
  const prevHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = emptyHome
  try {
    // Every gpt-* row the static catalog offers for the chatgpt provider,
    // DERIVED from the catalog rather than hand-typed (0.3 P4). The old
    // literal list was a fourth copy of the model list: adding a GPT row to
    // the picker left it unproven against the live proxy, and this guard
    // would have kept passing while saying nothing about the new model.
    const catalog = require_(path.join(ROOT, 'onboarding', 'public', 'js', 'model-catalog.cjs'))
    // Bundled rows are proxy-table receipts; discovered rows use provider receipts instead.
    const CATALOG_GPT = catalog.BUNDLED_MODELS.filter((m) => m.contextWindowSource === 'codex-as-api-table' && m.providers.includes('chatgpt')).map((m) => m.id)
    ok('the catalog offers chatgpt rows to check (an empty loop always passes)', CATALOG_GPT.length > 0, CATALOG_GPT.join(','))
    for (const model of CATALOG_GPT) {
      process.env.CODEX_AS_API_MODEL = model
      const health = await healthOf(loadFresh().createApp)
      const pinned = contextCapForModel(model)
      ok(`${model}: proxy /health context_window === hand-pinned cap`,
        health.context_window === pinned.cap,
        `proxy=${health.context_window} pin=${pinned.cap} (a mismatch means the 0.6.x bump moved the table -- re-verify contextCapForModel)`)
      ok(`${model}: cap source labeled codex-as-api-table`, pinned.capSource === 'codex-as-api-table', String(pinned.capSource))
      // The same receipt, applied to the number the dsh lane DECLARES to its
      // engine. Until 0.3 P4 the lane declared a blanket 131072 for every
      // hand-declared route including this one, so the engine compacted a
      // ChatGPT lane against less than half its real window while the gauge
      // in front of the user divided by the proxy's 272000. One live source,
      // both consumers.
      const row = catalog.MODELS.find((m) => m.id === model)
      ok(`${model}: catalog contextWindow === proxy /health context_window`,
        row && row.contextWindow === health.context_window,
        `catalog=${row && row.contextWindow} proxy=${health.context_window}`)
    }
    for (const row of catalog.MODELS.filter((m) => m.providers.includes('chatgpt') && m.contextWindowSource !== 'codex-as-api-table')) {
      ok(`${row.id}: discovered provider window reaches gauge and lane`,
        contextCapForModel(row.id).cap === row.contextWindow && catalog.dshContextWindowFor(row.id) === row.contextWindow)
    }
    delete process.env.CODEX_AS_API_MODEL
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevHome
    fs.rmSync(emptyHome, { recursive: true, force: true })
  }
}


// ── explicit-port change rebuilds the proxy (gpt-6-astra review P2, 2026-09-08) ──
// BEHAVIOURAL, not a source grep: the reuse branch used to compare only the
// live port's liveness and the model, so with a proxy already up on port A a
// user who set CHATGPT_PROXY_PORT=B (model unchanged) got {ok:true, port:A}
// and the new agent was routed at the OLD port. ensureCodexProxy lives in
// main.cjs (Electron main, not importable here), so the function is lifted
// out of the source and run in a vm context whose require/fetch/bind seams
// are stubs -- the control flow under test is the shipped one, character for
// character.
import vm from 'node:vm'
console.log('\n-- ensureCodexProxy reuse: explicit port change rebuilds')
{
  const fnSrc = (name) => {
    const start = mainSrc.indexOf(`function ${name}(`)
    const from = mainSrc.lastIndexOf('async ', start) === start - 6 ? start - 6 : start
    const tail = mainSrc.slice(from)
    const end = tail.indexOf('\n}')
    return end === -1 ? null : tail.slice(0, end + 2)
  }
  const ensureSrc = fnSrc('ensureCodexProxy')
  const killSrc = fnSrc('killCodexProxy')
  ok('ensureCodexProxy/killCodexProxy lift cleanly out of main.cjs', Boolean(ensureSrc && killSrc))

  const { resolveChatgptProxyPort } = require_(path.join(ROOT, 'provider-env.cjs'))
  const logs = []
  const bound = new Set() // ports our fake proxies are "listening" on
  let ephemeral = 45000
  const ctx = {
    console, AbortSignal, URL, Number, String, JSON,
    log: (m) => logs.push(String(m)),
    proc: { listenerPids: () => [] },
    resolveChatgptProxyPort,
    startShimmedProxy: async ({ port }) => {
      const p = port === 0 ? ++ephemeral : port
      if (bound.has(p)) { const e = new Error('EADDRINUSE'); e.code = 'EADDRINUSE'; throw e }
      bound.add(p)
      const srv = {
        listening: true,
        address: () => ({ port: p }),
        on: () => {},
        close: () => { srv.listening = false; bound.delete(p) },
      }
      return srv
    },
    // Any HTTP answer = alive, same contract as the real probe.
    fetch: async (u) => {
      const p = Number(new URL(u).port)
      if (!bound.has(p)) throw new Error('connection refused')
      // the /health receipt main.cjs gates on: report exactly the model the
      // (stubbed) env injection asked for, so the gate passes honestly.
      return { json: async () => ({ model: ctx.process.env.CODEX_AS_API_MODEL ?? null }) }
    },
    require: Object.assign((id) => id === './model-discovery.cjs' ? { resolveCodexVersion: () => '0.159.2' } : ({ createApp: () => ({}) }), { cache: {}, resolve: (id) => id }),
    process: { env: {} },
  }
  vm.createContext(ctx)
  vm.runInContext(
    `let codexProxyServer = null\nlet codexProxyModel = null\nlet codexProxyPort = null\n${ensureSrc}\n${killSrc}\n` +
    'globalThis.__ensure = ensureCodexProxy',
    ctx,
  )
  const ensure = ctx.__ensure
  const since = (n) => logs.slice(n).join('\n')

  // 1. live proxy on explicit port A
  let mark = logs.length
  const a = await ensure({ CHATGPT_PROXY_PORT: '50123', MODEL: 'claude-sonnet-4-6' })
  ok('explicit port A: proxy comes up on A', a.ok === true && a.port === 50123, JSON.stringify(a))

  // 2. same model, explicit port B -> MUST rebuild on B (the review finding)
  mark = logs.length
  const b = await ensure({ CHATGPT_PROXY_PORT: '19999', MODEL: 'claude-sonnet-4-6' })
  ok('explicit port change (A -> B) routes the agent at B, not the old A', b.ok === true && b.port === 19999, JSON.stringify(b))
  ok('...and says so: "port changed (50123 -> 19999) -- rebuilding proxy"',
    since(mark).includes('port changed (50123 -> 19999) -- rebuilding proxy'), since(mark))
  ok('...by rebuilding, not by reusing the live proxy', !since(mark).includes('already serves'), since(mark))
  ok('...and the old port A is no longer bound by us', !bound.has(50123))

  // 3. same explicit port again, same model -> reuse (no needless rebuild)
  mark = logs.length
  const c = await ensure({ CHATGPT_PROXY_PORT: '19999', MODEL: 'claude-sonnet-4-6' })
  ok('the same explicit port B reuses the live proxy', c.ok === true && c.port === 19999 && since(mark).includes('already serves'), `${JSON.stringify(c)} :: ${since(mark)}`)

  // 4. no explicit port at all -> an ephemeral request accepts any live bind
  mark = logs.length
  const d = await ensure({ MODEL: 'claude-sonnet-4-6' })
  ok('no explicit port: any live bind still satisfies the request (reuse)', d.ok === true && d.port === 19999 && since(mark).includes('already serves'), `${JSON.stringify(d)} :: ${since(mark)}`)

  // 5. and the model check still rebuilds, port equal or not
  mark = logs.length
  const e = await ensure({ CHATGPT_PROXY_PORT: '19999', MODEL: 'gpt-test-sentinel-sol' })
  ok('a model change on the SAME port still rebuilds', e.ok === true && since(mark).includes('model changed'), `${JSON.stringify(e)} :: ${since(mark)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
// NOT process.exit() -- exitCode, and let the loop drain (2026-08-04).
//
// On Windows this file printed "9 passed, 0 failed" and then exited
// -1073740791 (0xC0000409, __fastfail), with:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
//   file src\win\async.c, line 94
//
// i.e. uv_async_send() reaching an already-closing handle. A test that fails
// while reporting every assertion green costs more to diagnose than the thing
// it tests, so it was worth chasing to the bottom.
//
// It is NOT our bug. Minimal reproducer, node 24.18.1 / libuv 1.52.1 on
// Windows, no dependency on anything in this repo:
//
//   import http from 'node:http'
//   for (let i = 0; i < 3; i++) {
//     const s = http.createServer((q, r) => r.end('{}')).listen(0, '127.0.0.1')
//     await new Promise((r) => s.once('listening', r))
//     await (await fetch(`http://127.0.0.1:${s.address().port}/`)).json()
//     await new Promise((r) => s.close(r))
//   }
//   process.exit(0)
//
// Measured, each variant run 3-4 times:
//   iterations 1, 2  -> exit 0.  iterations 3, 4, 5 -> abort, every run.
//   drop process.exit(), let it drain -> exit 0 at every iteration count.
//   drop AbortSignal.timeout -> still aborts (not the timer).
//   await srv.close() -> still aborts (not the abandoned handle).
//
// So the trigger is process.exit() while undici's pool still holds handles
// from >=3 completed fetches, and the fix available to us is to stop calling
// it. macOS (node 24.7 / libuv 1.51) never reproduced this at any count.
//
// If a future edit makes this file hang instead of exiting, that is a handle
// this test forgot to close -- find it rather than restoring process.exit(),
// which only hid it behind an abort.
process.exitCode = fail === 0 ? 0 : 1
