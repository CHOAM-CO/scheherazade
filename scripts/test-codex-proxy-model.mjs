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
    srv.close()
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
