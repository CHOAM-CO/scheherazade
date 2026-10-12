import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-lane-providers-'))
process.env.HOME = tmp
process.env.AGENT_DATA_HOME = tmp
process.env.CODEX_HOME = path.join(tmp, 'codex')
delete process.env.SCHZ_TEST_LANE_CREDENTIAL
process.env.CODEX_AS_API_AUTH_PATH = path.join(tmp, 'codex', 'auth.json')
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')
const YAML = require('yaml')
const { laneModels, mergeLanePatch, resolveLaneModel } = require('../lane-providers.cjs')
const { buildProviderEnv, decideRouteChange } = require('../provider-env.cjs')
const { createRouteProxy } = require('../route-proxy.cjs')
const home = path.join(tmp, '.dsh-lane-home')
fs.mkdirSync(home)
const secret = 'fixture-lane-secret'
const seen = []
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`
const fixture = [{ id: 'llm-pi-ai', config: { providers: {
  gemini: { baseURL: baseUrl, api: 'openai-completions', apiKeyEnv: 'SCHZ_TEST_LANE_CREDENTIAL', headers: { 'private-header': secret }, models: [{ id: 'shared-model', contextWindow: 123456, input: ['text', 'image'] }, { id: 'second-model' }] },
  other: { baseURL: baseUrl, api: 'openai-completions', models: [{ id: 'shared-model' }] },
} } }]
const patch = path.join(home, 'lane.patch.yml')
const save = () => fs.writeFileSync(patch, YAML.stringify(fixture))
let srv, proxy
const originalFetch = globalThis.fetch
// No discovery network or real account access; only fixture loopback requests.
globalThis.fetch = (url, opts) => String(url).startsWith('http://127.0.0.1:') ? originalFetch(url, opts) : Promise.reject(new Error('offline fixture'))
try {
  assert.deepEqual(laneModels(), [])
  save()
  fs.writeFileSync(path.join(home, '.credentials.yaml'), `SCHZ_TEST_LANE_CREDENTIAL: ${secret}\n`, { mode: 0o600 })
  const rows = laneModels()
  assert.equal(rows.length, 3)
  assert.equal(new Set(rows.map((r) => r.id)).size, 3, 'same model on different providers has distinct picker identity')
  assert.ok(rows.every((r) => r.source === 'lane' && r.label.includes('[lane:')))
  assert.ok(!JSON.stringify(rows).includes(secret))
  assert.ok(!JSON.stringify(rows).includes('apiKeyEnv'))
  // Execute the shipped chat picker functions against a tiny DOM fixture.
  const chat = fs.readFileSync(new URL('../onboarding/public/js/chat.js', import.meta.url), 'utf8')
  const element = () => ({ children: [], appendChild(x) { this.children.push(x) }, replaceChildren() { this.children = [] } })
  const selectEl = element()
  const picker = vm.createContext({ window: { SCHZ_MODEL_CATALOG: rows }, document: { createElement: element }, modelSel: selectEl,
    msModel: 'lane:gemini/shared-model', msProvider: 'lane:gemini', msAvailable: ['lane:gemini', 'lane:other'] })
  vm.runInContext(chat.slice(chat.indexOf('  function msProviderFor('), chat.indexOf('  // Effort chip')), picker)
  vm.runInContext('msPopulate()', picker)
  const options = selectEl.children.flatMap((g) => g.children)
  assert.equal(options.length, 3)
  assert.ok(options.find((o) => o.value === 'lane:gemini/shared-model').selected)
  assert.ok(options.every((o) => o.textContent.includes('[lane:') && !o.disabled))
  assert.equal(vm.runInContext("msProviderFor('lane:other/shared-model')", picker), 'lane:other')

  assert.equal(resolveLaneModel('lane:gemini', 'lane:other/shared-model'), null)
  const config = { PROVIDER: 'lane:gemini', MODEL: 'lane:gemini/shared-model' }
  const built = buildProviderEnv(config.PROVIDER, config, { readProviderKey: () => { throw new Error('must not use UI key') } })
  assert.ok(!built.error)
  const env = built.env
  assert.equal(env.DSH_MODEL, 'shared-model')
  assert.equal(env.DSH_PROVIDER, 'gemini')
  assert.equal(env.DSH_ROUTE_BASE_URL, baseUrl)
  assert.ok(env[env.DSH_ROUTE_KEY_ENV] === secret, 'fixture credential forwarded')
  assert.equal(env.DSH_MODEL_CONTEXT, '123456')
  assert.equal(env.DSH_MODEL_VISION, '1')
  assert.equal(decideRouteChange(env, env).mode, 'restart')
  const originalPatch = fs.readFileSync(patch, 'utf8')
  const generated = YAML.stringify([{ id: 'llm-pi-ai', config: { providers: { gemini: { models: [{ id: 'shared-model' }] } } } }])
  const runtime = YAML.parse(mergeLanePatch(generated, home, { ...env, DSH_ROUTE_BASE_URL: 'http://127.0.0.1:1234/openai/v1' }))[0].config.providers
  assert.equal(runtime.gemini.baseURL, 'http://127.0.0.1:1234/openai/v1')
  assert.equal(runtime.gemini.apiKeyEnv, 'SCHZ_LANE_PROVIDER_KEY')
  assert.equal(runtime.gemini.models.length, 2)
  assert.equal(runtime.gemini.models[0].contextWindow, 123456)
  assert.ok(runtime.other)
  assert.equal(fs.readFileSync(patch, 'utf8'), originalPatch, 'source endpoint/key ref survive restart generation unchanged')
  proxy = await createRouteProxy({ log: () => {} })
  proxy.setRoute('openai', { upstreamBase: env.DSH_ROUTE_BASE_URL, model: env.DSH_MODEL, key: env[env.DSH_ROUTE_KEY_ENV], keyMode: 'api-key', protocol: env.DSH_ROUTE_API })
  const wire = await fetch(`${proxy.baseUrlFor('openai')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'wrong-model', messages: [] }) })
  assert.equal(wire.status, 200)
  assert.equal(seen[0].body.model, 'shared-model')
  assert.ok(seen[0].auth === `Bearer ${secret}`, 'fixture bearer forwarded')
  assert.equal(seen[0].url, '/v1/chat/completions')
  const server = require('../onboarding/http-server.cjs')
  let restarts = 0
  srv = await server.createOnboardingServer(null, { restartAgent: async () => { restarts++ } })
  const url = `http://127.0.0.1:${srv.server.address().port}`
  const headers = { 'x-onboard-token': server.SERVER_TOKEN, 'content-type': 'application/json' }
  const get = async (route) => (await fetch(url + route, { headers })).json()
  const catalog = await get('/api/models')
  assert.equal(catalog.models.filter((r) => r.source === 'lane').length, 3)
  assert.ok(!JSON.stringify(catalog).includes(secret))
  assert.ok((await get('/api/config')).availableProviders.includes('lane:gemini'))
  const select = (body) => fetch(url + '/api/agent/model', { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal((await select({ model: config.MODEL, provider: config.PROVIDER })).status, 202)
  assert.equal(server.readAgentConfig().PROVIDER, 'lane:gemini')
  assert.equal(server.readAgentConfig().MODEL, 'shared-model')
  assert.equal(buildProviderEnv(config.PROVIDER, server.readAgentConfig(), { readProviderKey: () => null }).env.DSH_MODEL, 'shared-model')
  assert.equal(restarts, 1)
  assert.equal((await select({ model: 'lane:gemini/second-model' })).status, 202, 'same-provider UI sends only model')
  assert.equal((await select({ model: config.MODEL, provider: 'custom' })).status, 400)
  assert.equal((await select({ model: 'lane:gemini/undeclared', provider: config.PROVIDER })).status, 400)
  assert.equal((await fetch(url + '/api/agent/route-preview?provider=lane:gemini&model=' + config.MODEL, { headers })).status, 200)
  fixture[0].config.providers.gemini.models.push({ id: 'new-model' }); save()
  assert.equal((await get('/api/models')).models.filter((r) => r.source === 'lane').length, 4, 'source reread without app restart')
  fs.unlinkSync(path.join(home, '.credentials.yaml'))
  assert.equal((await select({ model: config.MODEL, provider: config.PROVIDER })).status, 400)
  assert.ok(buildProviderEnv(config.PROVIDER, config, { readProviderKey: () => null }).error)
  fs.unlinkSync(patch)
  assert.deepEqual(laneModels(), [])
  assert.equal((await get('/api/models')).models.filter((r) => r.source === 'lane').length, 0)
  assert.equal(mergeLanePatch(generated, home, {}), generated)
  fs.writeFileSync(patch, 'not: [valid')
  assert.deepEqual(laneModels(), [])
  assert.throws(() => mergeLanePatch(generated, home, {}), /valid YAML/)
  console.log('PASS lane discovery, distinct identities, authenticated HTTP selection, secret isolation, runtime preservation, and real proxy upstream routing')
} finally {
  globalThis.fetch = originalFetch
  srv?.server.close()
  proxy?.close()
  upstream.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
