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
let patch
vm.runInNewContext(`(${lane.slice(start, end)})()`, {
  MODEL_CATALOG: catalog, DSH_ROUTE: 'anthropic-catalog', DSH_PROVIDER: 'anthropic',
  DSH_MODEL: 'claude-sonnet-5-5', DSH_MODEL_MAXTOK: 32000, DSH_ROUTE_KEY_ENV: 'ANTHROPIC_API_KEY',
  process: { env: { DSH_ROUTE_BASE_URL: 'http://127.0.0.1:1234' } },
  yamlQuote: JSON.stringify, declaredContextFor: id => catalog.MODELS.find(m => m.id === id)?.contextWindow || 131072,
  MEM: '/fixture', personaRow: () => '', mcpRowsFromClaudeConfig: () => '', MCP_CONFIG_FILE: '', LANE_PRESET_ID: 'test',
  dshHome: () => '/fixture', ensureLanePreset: () => {}, path: require('node:path'),
  require: () => ({ mergeLanePatch: text => text }),
  fs: { mkdirSync: () => {}, writeFileSync: (_p, text) => { patch = text } },
})
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
assert.equal(writes.get('/fixture/.live-route.json').status, 'failed')
const supervisor = fs.readFileSync(new URL('../supervisor.mjs', import.meta.url), 'utf8')
assert(supervisor.includes('if (exitCode === 78)'))
const main = fs.readFileSync(new URL('../main.cjs', import.meta.url), 'utf8')
assert(/if \(code === 78\) \{[\s\S]*?lastFailureMtimeMs = 0[\s\S]*?pollFailureMarker\(\)/.test(main))
console.log('PASS: picker efforts, Claude patch metadata/proxy, terminal selection failure')
