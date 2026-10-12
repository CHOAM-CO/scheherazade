'use strict'
const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const { resolveDataHome } = require('./data-home.cjs')
const ID = /^[A-Za-z0-9._:/-]+$/
const PROVIDER = /^[A-Za-z0-9._-]+$/
function laneHome() { return path.join(resolveDataHome({ allowMem: false }), '.dsh-lane-home') }
function readLaneProviders(home = laneHome()) {
  let text
  try { text = fs.readFileSync(path.join(home, 'lane.patch.yml'), 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw new Error('lane.patch.yml is unreadable')
  }
  try {
    const doc = YAML.parse(text, { maxAliasCount: 0, logLevel: 'silent' })
    if (!Array.isArray(doc)) throw new Error('shape')
    const providers = Object.create(null)
    for (const row of doc) {
      if (row?.id !== 'llm-pi-ai' || row.disabled === true) continue
      const entries = row.config?.providers
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
      for (const [id, spec] of Object.entries(entries)) {
        if (PROVIDER.test(id) && spec && typeof spec === 'object' && !Array.isArray(spec)) providers[id] = spec
      }
    }
    return providers
  } catch { throw new Error('lane.patch.yml must be a valid YAML patch list') }
}
function laneModelId(provider, model) { return `lane:${provider}/${model}` }
// Public projection is allowlisted: never return raw YAML, headers or credential values.
function laneModels(home = laneHome()) {
  let providers
  try { providers = readLaneProviders(home) } catch { return [] }
  const rows = []
  for (const [provider, spec] of Object.entries(providers)) {
    for (const model of Array.isArray(spec.models) ? spec.models : []) {
      if (!model || typeof model.id !== 'string' || !ID.test(model.id)) continue
      const id = laneModelId(provider, model.id)
      if (id.length > 200) continue
      rows.push({ id, modelId: model.id, label: `${model.id} [lane: ${provider}]`, group: 'Lane',
        providers: [`lane:${provider}`], source: 'lane',
        ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow, contextWindowSource: 'dsh-lane-declared' } : {}) })
    }
  }
  return rows
}
function resolveLaneModel(provider, id, home = laneHome()) {
  if (typeof provider !== 'string' || !provider.startsWith('lane:')) return null
  const name = provider.slice(5)
  const spec = readLaneProviders(home)[name]
  if (!spec || !Array.isArray(spec.models)) return null
  const model = spec.models.find((m) => m && (m.id === id || laneModelId(name, m.id) === id))
  return model ? { provider: name, spec, model } : null
}
// lane.patch.yml is user input. The launcher writes a DIFFERENT runtime file,
// overriding only the active route's transport (which main may proxy).
function mergeLanePatch(generated, home, env) {
  const providers = readLaneProviders(home)
  if (!Object.keys(providers).length) return generated
  const rows = YAML.parse(generated)
  const row = rows.find((r) => r.id === 'llm-pi-ai')
  const generatedProviders = row.config.providers
  const merged = { ...providers, ...generatedProviders }
  if (env.DSH_LANE_REGISTERED === '1') {
    const name = env.DSH_PROVIDER
    if (!providers[name]) throw new Error('selected lane provider was removed before startup')
    merged[name] = { ...providers[name], api: providers[name].api || env.DSH_ROUTE_API, baseURL: env.DSH_ROUTE_BASE_URL, apiKeyEnv: env.DSH_ROUTE_KEY_ENV }
  }
  row.config.providers = merged
  return YAML.stringify(rows)
}
module.exports = { laneHome, readLaneProviders, laneModels, laneModelId, resolveLaneModel, mergeLanePatch }
