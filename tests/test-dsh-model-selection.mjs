import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const catalog = require('../onboarding/public/js/model-catalog.cjs')
const lane = fs.readFileSync(new URL('../dsh-lane.mjs', import.meta.url), 'utf8')
for (const effort of catalog.EFFORT_LEVELS) assert(catalog.DSH_REASONING_EFFORTS.includes(effort), `undeclared picker effort: ${effort}`)
assert(catalog.DSH_REASONING_EFFORTS.includes('off'))
const start = lane.indexOf('function buildPatch ()')
const end = lane.indexOf('\n}', start) + 2
function buildTestPatch (env, models = catalog.MODELS) {
let patch
vm.runInNewContext(`(${lane.slice(start, end)})()`, {
  MODEL_CATALOG: { ...catalog, MODELS: models }, DSH_ROUTE: 'anthropic-catalog', DSH_PROVIDER: 'anthropic',
  DSH_MODEL: 'claude-sonnet-5-5', DSH_MODEL_MAXTOK: 32000, DSH_ROUTE_KEY_ENV: 'ANTHROPIC_API_KEY',
  process: { env },
  yamlQuote: JSON.stringify, declaredContextFor: id => catalog.MODELS.find(m => m.id === id)?.contextWindow || 131072,
  MEM: '/fixture', personaRow: () => '', mcpRowsFromClaudeConfig: () => '', MCP_CONFIG_FILE: '', LANE_PRESET_ID: 'test',
  dshHome: () => '/fixture', ensureLanePreset: () => {}, path: require('node:path'),
  require: () => ({ mergeLanePatch: text => text }),
  fs: { mkdirSync: () => {}, writeFileSync: (_p, text) => { patch = text } },
})
return patch
}
const patch = buildTestPatch({ DSH_ROUTE_BASE_URL: 'http://127.0.0.1:1234' })
assert(patch.includes('api: anthropic-messages'))
assert(patch.includes('baseURL: "http://127.0.0.1:1234"'))
for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5']) assert(patch.includes(`id: "${id}"`))
assert(patch.includes('input: [text, image]'))
assert(patch.includes('contextWindow: 1000000'))
const selection = lane.slice(lane.indexOf('  try { await client.selectModel(sessionId'), lane.indexOf('  // Skill-catalog nudge'))
assert(!selection.includes('selectModel skipped'))
assert(selection.includes('errLog(') && !selection.includes('.slice('))
assert(selection.includes("'.agent-failed.json'"))
assert(selection.includes('process.exit(78)'))
const writes = new Map()
const message = 'unsupported reasoning: ' + 'x'.repeat(250)
let logged
await assert.rejects(vm.runInNewContext(`(async () => { ${selection} })()`, {
  client: { selectModel: async () => { throw new Error(message) } }, sessionId: 's',
  DSH_PROVIDER: 'ollama-cloud', DSH_MODEL: 'glm-5.3-flash', DSH_EFFORT: 'medium',
  MEM: '/fixture', path: require('node:path'), liveRouteFile: () => '/fixture/.live-route.json',
  fs: { writeFileSync: (p, text) => writes.set(p, JSON.parse(text)) },
  errLog: text => { logged = text }, killEngine: () => {}, child: {},
  process: { exit: code => { throw new Error(`exit ${code}`) } },
}), /exit 78/)
assert(logged.includes(message))
assert.equal(writes.get('/fixture/.agent-failed.json').code, 'model_selection_failed')
assert(!writes.has('/fixture/.live-route.json'), 'failure is reported only through the consumed agent marker')
console.log('PASS: picker efforts, Claude patch metadata/proxy, terminal selection failure')

const direct = buildTestPatch({})
assert(!direct.includes('baseURL:'), 'bare Anthropic uses the adapter catalog endpoint')
assert(direct.includes('api: anthropic-messages'))
for (const model of catalog.MODELS.filter(m => m.id.startsWith('claude-'))) assert(direct.includes(`id: "${model.id}"`))
const metadata = buildTestPatch({}, [{ id: 'claude-sonnet-5-5', vision: false, maxTokens: 12345 }])
assert(metadata.includes('input: [text]'))
assert(metadata.includes('maxTokens: 12345'))
const main = fs.readFileSync(new URL('../main.cjs', import.meta.url), 'utf8')
const pollStart = main.indexOf('function pollFailureMarker()')
const pollEnd = main.indexOf('\n}', pollStart) + 2
const { setAgentStatus, getAgentStatus } = require('../onboarding/agent-status.cjs')
vm.runInNewContext(`(${main.slice(pollStart, pollEnd)})()`, {
  fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(writes.get('/fixture/.agent-failed.json')) },
  AGENT_FAILFILE: '/fixture/.agent-failed.json', lastFailureMtimeMs: 0, setAgentStatus, console: { error: () => {} },
})
assert.equal(getAgentStatus().code, 'model_selection_failed')
assert(getAgentStatus().detail.includes(message))
const server = fs.readFileSync(new URL('../onboarding/http-server.cjs', import.meta.url), 'utf8')
const computeStart = server.indexOf('function computeAgentStatus()')
const computeEnd = server.indexOf('\n}', computeStart) + 2
const statusResponse = vm.runInNewContext(`(${server.slice(computeStart, computeEnd)})()`, {
  getAgentStatus, readLivenessMarker: () => ({ lastHeartbeat: Date.now() }),
})
assert.equal(statusResponse.code, 'model_selection_failed')
assert(statusResponse.detail.includes(message), 'GET status retains full reason despite an old live heartbeat')

const window = {}
vm.runInNewContext(fs.readFileSync(new URL('../onboarding/public/js/copy.js', import.meta.url), 'utf8'), {
  window, document: { querySelector: () => null, documentElement: { lang: 'en' } },
})
const wizard = fs.readFileSync(new URL('../onboarding/public/js/wizard.js', import.meta.url), 'utf8')
const renderStart = wizard.indexOf('  function renderStep5Failed(')
const renderEnd = wizard.indexOf('\n  }', renderStart) + 4
const elements = { 's5-title': {}, 's5-body': {} }
let buttons
vm.runInNewContext(`(${wizard.slice(renderStart, renderEnd)})('model_selection_failed', detail)`, {
  C: window.COPY, state: { displayName: 'Sera' }, detail: statusResponse.detail, $: id => elements[id],
  renderStep5Buttons: rows => { buttons = rows }, window,
})
assert(elements['s5-body'].textContent.includes(message))
assert(/different model.*effort/i.test(elements['s5-body'].textContent))
assert(buttons.some(b => !b.disabled), 'Engine navigation remains enabled')
const connectors = fs.readFileSync(new URL('../onboarding/public/js/connectors.js', import.meta.url), 'utf8')
const controlStart = connectors.indexOf('  async function fireControl(')
const controlEnd = connectors.indexOf('\n  }', controlStart) + 4
const picker = { disabled: false }
await vm.runInNewContext(`(${connectors.slice(controlStart, controlEnd)})('model', {model:'claude-opus-5-5'})`, {
  agentConfigBusy: false, setAgentConfigDisabled: disabled => { picker.disabled = disabled },
  api: async () => { throw new Error('model selection failed') }, console: { error: () => {} },
  showToast: () => {}, GEN: x => x,
})
assert.equal(picker.disabled, false, 'failed state/request leaves picker usable')
console.log('PASS: bare Anthropic, per-row metadata, status detail rendering and picker recovery')
