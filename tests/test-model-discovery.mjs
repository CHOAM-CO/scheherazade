// New ids must carry their provider window through the picker, lane and gauge.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-discovery-'))
process.env.AGENT_DATA_HOME = data
process.env.CODEX_AS_API_AUTH_PATH = path.join(data, 'no-auth.json')
process.env.CODEX_HOME = path.join(data, 'codex')
fs.mkdirSync(process.env.CODEX_HOME)
fs.copyFileSync(path.join(root, 'tests/fixtures/models_cache.json'), path.join(process.env.CODEX_HOME, 'models_cache.json'))
const d = require('../model-discovery.cjs')
try {
  const fixture = d.readCodexCache()
  assert.equal(fixture.client_version, '0.159.2')
  assert.equal(d.readCodexCache(path.join(data, 'missing')), null)
  fs.writeFileSync(path.join(data, 'broken'), '{')
  assert.equal(d.readCodexCache(path.join(data, 'broken')), null)
  const rows = d.codexRows(fixture)
  assert.equal(rows.length, 10)
  assert.equal(rows.find((m) => m.id === 'gpt-7-test').label, 'GPT 7 Test')
  assert.ok(!rows.some((m) => m.id === 'codex-auto-review' || m.id === 'gpt-reserve'))
  const mergeInputs = rows.filter((m) => ['gpt-6.1-sol', 'gpt-6-astra'].includes(m.id))
  mergeInputs.find((m) => m.id === 'gpt-6-astra').contextWindow = 999999
  const bundled = [{ id: 'gpt-6-astra', label: 'Curated', group: 'GPT', providers: ['chatgpt'], contextWindow: 200000, contextWindowSource: 'bundled' }]
  const merged = d.mergeModels(bundled, mergeInputs)
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0], bundled[0])
  assert.equal(merged[1].contextWindow, 272000)
  assert.equal(d.mergeModels([{ ...bundled[0], contextWindow: undefined }], mergeInputs)[0].contextWindow, 999999)
  assert.equal(d.mergeModels([], [{ id: 'bad' }, null]).length, 0)
  assert.equal(d.pickCodexVersion(['codex-cli 0.159.2\n', '0.160.0', 'garbage']), '0.160.0')
  assert.equal(d.pickCodexVersion(['0.159.2', '0.159.10']), '0.159.10')
  assert.equal(d.pickCodexVersion(['0.159.2-rc.1', '0.159.2']), '0.159.2')
  assert.equal(d.pickCodexVersion(['', null, '01.159.2', 'v0.159.2', '0.159.2+..']), null)
  assert.equal(d.resolveCodexVersion({ cache: fixture, run: () => 'codex-cli 0.160.0' }), '0.160.0')
  assert.equal(d.resolveCodexVersion({ cache: fixture, run: () => { throw Error('no binary') } }), '0.159.2')
  assert.equal(d.resolveCodexVersion({ cache: null, run: () => { throw Error('no binary') } }), null)

  // A pre-upgrade cache must not resurrect retired GPT or unverified provider rows.
  d.saveModels([...rows, { id: 'claude-old-cache', label: 'Old', group: 'Claude', providers: ['claude'] },
    { id: 'local-old-cache', label: 'Old', group: 'Ollama', providers: ['dsh'] }])
  const catalog = require('../onboarding/public/js/model-catalog.cjs')
  assert.deepEqual(catalog.MODELS.map((m) => m.id), [...catalog.BUNDLED_MODELS.map((m) => m.id), 'gpt-7-test'])
  assert.equal(catalog.byId('gpt-5.6-sol'), null)
  assert.equal(catalog.byId('claude-old-cache'), null)
  assert.equal(catalog.byId('local-old-cache'), null)
  assert.equal(catalog.byId('gpt-6.1-sol').label, 'GPT 6.1 Sol')
  const actualCache = d.readCodexCache(path.join(os.homedir(), '.codex/models_cache.json'))
  if (actualCache) assert.deepEqual(d.mergeModels(catalog.BUNDLED_MODELS, d.codexRows(actualCache), catalog.SEEN_AT_BUILD), catalog.BUNDLED_MODELS)
  assert.equal(catalog.dshContextWindowFor('gpt-7-test'), 310000)
  assert.equal(catalog.byId('gpt-6.1-sol').contextWindow, 272000)
  assert.equal(catalog.dshContextWindowFor('gpt-6.1-sol'), 272000)
  assert.equal(catalog.byId('gpt-6-astra').contextWindow, 200000)
  const { buildProviderEnv } = require('../provider-env.cjs')
  assert.equal(buildProviderEnv('chatgpt', { MODEL: 'gpt-6.1-sol' }, {}).env.DSH_MODEL_CONTEXT, '272000')
  const { contextCapForModel, createOnboardingServer, SERVER_TOKEN } = require('../onboarding/http-server.cjs')
  assert.deepEqual(contextCapForModel('gpt-6.1-sol'), { cap: 272000, capSource: 'codex-models-cache' })
  catalog.mergeDiscovered([{ ...rows[0], id: 'gpt-discovered-fixture', contextWindow: 310000 }])
  assert.equal(contextCapForModel('gpt-discovered-fixture').cap, 310000)
  assert.equal(catalog.dshContextWindowFor('gpt-discovered-fixture'), 310000)

  // A fresh lane process sees persisted rows without waiting for a provider call.
  const child = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(root, 'onboarding/public/js/model-catalog.cjs'))}).dshContextWindowFor('gpt-discovered-fixture'))`], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: path.join(data, 'absent') } })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), '310000')
  const win = { api: async (endpoint) => { assert.equal(endpoint, '/api/models'); return { models: catalog.MODELS } } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'onboarding/public/js/model-catalog.cjs'), 'utf8'), { window: win })
  const original = win.SCHZ_MODEL_CATALOG
  assert.equal(original.some((m) => m.id === 'gpt-7-test'), false)
  assert.equal(original.some((m) => m.id === 'gpt-6.1-sol'), true)
  await win.SCHZ_CATALOG.refresh()
  assert.equal(win.SCHZ_MODEL_CATALOG, original)
  assert.equal(win.SCHZ_CATALOG.byId('gpt-6.1-sol').contextWindow, 272000)
  win.api = async () => { throw Error('offline') }
  await win.SCHZ_CATALOG.refresh()
  assert.equal(win.SCHZ_CATALOG.byId('gpt-6.1-sol').contextWindow, 272000)
  fs.writeFileSync(process.env.CODEX_AS_API_AUTH_PATH, JSON.stringify({ tokens: { access_token: 'fixture-token', account_id: 'fixture-account' } }))
  const discovered = await d.discoverModels({ fetchImpl: async (url, options) => {
    assert.ok(url.startsWith('https://chatgpt.com/backend-api/codex/models?client_version='))
    assert.equal(options.headers.authorization, 'Bearer fixture-token')
    return { ok: true, json: async () => fixture }
  } })
  assert.equal(discovered.find((m) => m.id === 'gpt-7-test').label, 'GPT 7 Test')
  fs.unlinkSync(process.env.CODEX_AS_API_AUTH_PATH)
  catalog.mergeDiscovered(discovered)
  catalog.mergeDiscovered([{ ...rows[0], contextWindow: 280000 }])
  assert.equal(catalog.byId('gpt-6.1-sol').contextWindow, 272000)
  assert.equal(catalog.byId('gpt-6-astra').contextWindow, 200000)
  const { server, url } = await createOnboardingServer()
  try {
    assert.equal((await fetch(new URL('/api/models', url))).status, 403)
    const response = await fetch(new URL('/api/models', url), { headers: { 'x-onboard-token': SERVER_TOKEN } })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.models.find((m) => m.id === 'gpt-6.1-sol').contextWindow, 272000)
    assert.equal(contextCapForModel('gpt-6.1-sol').cap, 272000)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  console.log('PASS model discovery: merge, fixture, context, snapshot, persisted lane, browser, endpoint, version')
} finally {
  fs.rmSync(data, { recursive: true, force: true })
}
