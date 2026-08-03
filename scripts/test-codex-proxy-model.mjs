// test-codex-proxy-model.mjs -- the chatgpt lane's model passthrough is REAL.
// Run: node scripts/test-codex-proxy-model.mjs
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
// buildProviderEnv runs before that and clears ANTHROPIC_BASE_URL (asserted in
// test-provider-env.mjs); main.cjs is what fills it in. That handoff is the
// whole risk of the change: if it is ever dropped, the agent spawns with no
// base URL at all.
//
// It fails LOUD in that case rather than misrouting -- the old hardcoded
// localhost:18080 default would have handed the conversation stream to
// whatever owned that port -- but loud is still broken, so the wiring is
// pinned here.
ok('the default bind is ephemeral, not a fixed port', mainSrc.includes("const requestedPort = explicitPort ? Number(portResult.port) : 0"))
ok('the bound port is read back from the socket, never assumed', /const bound = codexProxyServer\.address\(\)/.test(mainSrc) && mainSrc.includes('port = bound.port'))
ok('ensureCodexProxy hands the caller the port it actually bound', /return \{ ok: true, port \}/.test(mainSrc))
ok('the caller overwrites ANTHROPIC_BASE_URL with that port', mainSrc.includes('providerEnvResult.env.ANTHROPIC_BASE_URL = `http://localhost:${proxy.port}`'))
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
