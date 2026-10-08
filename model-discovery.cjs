// Discovery adds provider receipts; bundled labels/windows remain authoritative.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { resolveDataHome } = require('./data-home.cjs')

// The bundled proxy reports 200000 (/health, empty CODEX_HOME) for any id outside its own
// table, and compacts against that, whatever the backend's models list says (6.1 Sol: 272000
// upstream, 200000 at the proxy). The lane and gauge follow the proxy, like the bundled GPT rows.
const CODEX_PROXY_DEFAULT_WINDOW = 200000
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function codexCachePath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json')
}
function readCodexCache(file = codexCachePath()) { return readJson(file) }
function codexRows(cache) {
  return (Array.isArray(cache?.models) ? cache.models : [])
    .filter((m) => m.visibility === 'list' && /^gpt-/.test(m.slug) && !/^gpt-reserve/.test(m.slug))
    .map((m) => ({ id: m.slug, label: (m.display_name || m.slug).replace(/-/g, ' '), group: 'GPT', providers: ['chatgpt'],
      contextWindow: CODEX_PROXY_DEFAULT_WINDOW, contextWindowSource: 'codex-as-api-default' }))
}
function validRow(m) {
  return m && typeof m.id === 'string' && typeof m.label === 'string' &&
    typeof m.group === 'string' && Array.isArray(m.providers) && m.providers.every((p) => typeof p === 'string')
}
function mergeModels(bundled, discovered, seenAtBuild = []) {
  const rows = new Map(bundled.map((m) => [m.id, { ...m }]))
  const bundledIds = new Set(rows.keys())
  const seen = new Set(seenAtBuild)
  for (const m of discovered.filter(validRow)) {
    if (seen.has(m.id) && !bundledIds.has(m.id)) continue
    const old = rows.get(m.id)
    const window = Number.isInteger(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : undefined
    if (!old || !bundledIds.has(m.id)) rows.set(m.id, { ...old, ...m,
      contextWindow: window || old?.contextWindow,
      contextWindowSource: window ? m.contextWindowSource : old?.contextWindowSource || m.contextWindowSource })
    else if (!old.contextWindow && window) rows.set(m.id, { ...old, contextWindow: window, contextWindowSource: m.contextWindowSource })
  }
  return [...rows.values()]
}
function discoveryCachePath() {
  return path.join(resolveDataHome(), 'model-catalog-cache.json')
}
function initialRows() {
  const saved = readJson(discoveryCachePath())
  return [...(Array.isArray(saved?.models) ? saved.models : []), ...codexRows(readCodexCache())]
}
function saveModels(models) {
  const file = discoveryCachePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ models }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch { /* Read-only data homes still retain the in-process catalog. */ }
}
function parseVersion(raw) {
  const match = String(raw || '').trim().match(/^(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match || match.slice(1, 4).some((s) => s.length > 1 && s[0] === '0')) return null
  if (match[5]?.split('.').some((s) => !s)) return null
  if (match[4]?.split('.').some((s) => !s || (/^\d+$/.test(s) && s.length > 1 && s[0] === '0'))) return null
  return { text: match[0].replace(/^codex-cli\s+/, ''), numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') }
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i]
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y)
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}
function pickCodexVersion(sources) {
  return sources.map(parseVersion).filter(Boolean).sort(compareVersions).at(-1)?.text || null
}
function resolveCodexVersion({ cache = readCodexCache(), run = execFileSync } = {}) {
  let cli
  try { cli = run('codex', ['--version'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { /* No CLI is normal in packaged installs. */ }
  return pickCodexVersion([cli, cache?.client_version])
}

// Claude ids from GET /v1/models (receipt 2026-10-08, subscription OAuth token: 200, fields
// id/display_name/max_input_tokens/lifecycle/deprecated_at/retires_at, paginated via has_more/last_id).
// Same CLAUDE_PROVIDERS value as model-catalog.cjs.
const CLAUDE_PROVIDERS = ['claude', 'claude-cli', 'claude-subscription']
function claudeWindowRule(id) {
  const major = Number(/^claude-[a-z]+-(\d+)/.exec(id)?.[1])
  return major >= 5 ? 1000000 : 200000
}
function claudeRows(body) {
  return (Array.isArray(body?.data) ? body.data : [])
    .filter((m) => m && typeof m.id === 'string' && /^claude-/.test(m.id))
    .filter((m) => (m.lifecycle == null || m.lifecycle === 'active') && !m.deprecated_at && !m.retires_at)
    .map((m) => {
      const api = Number.isInteger(m.max_input_tokens) && m.max_input_tokens > 0 ? m.max_input_tokens : null
      return { id: m.id, label: m.display_name || m.id, group: 'Claude', providers: [...CLAUDE_PROVIDERS],
        contextWindow: api || claudeWindowRule(m.id), contextWindowSource: api ? 'claude-models-api' : 'claude-discovery-rule' }
    })
}
// The token is injected: this file is asarUnpack'd and read by plain node, so it must not require provider-env.
async function fetchClaudeModels({ token, fetch: fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    if (!token || typeof token !== 'string') return []
    const rows = []
    let after = null
    for (let page = 0; page < 10; page++) {
      const url = `https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
      const r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) break
      const body = await r.json()
      rows.push(...claudeRows(body))
      if (!body?.has_more || !body.last_id) break
      after = body.last_id
    }
    return rows
  } catch { return [] }
}

async function discoverModels({ fetchImpl = fetch, claudeToken } = {}) {
  const rows = codexRows(readCodexCache())
  const get = async (url, headers) => {
    try {
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(2500) })
      return r.ok ? await r.json() : null
    } catch { return null }
  }
  const tasks = []
  const authPath = (process.env.CODEX_AS_API_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json')).replace(/^~(?=\/)/, os.homedir())
  const auth = readJson(authPath)
  const version = resolveCodexVersion()
  if (auth?.tokens?.access_token && version) {
    // Receipt 2026-09-30: authenticated /models?client_version returned 200, Sol 6.1 / 272000.
    tasks.push(get(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, {
      authorization: `Bearer ${auth.tokens.access_token}`,
      ...(auth.tokens.account_id ? { 'ChatGPT-Account-Id': auth.tokens.account_id } : {}),
    }).then((body) => rows.push(...codexRows(body))))
  }
  tasks.push(fetchClaudeModels({ token: claudeToken, fetch: fetchImpl }).then((r) => rows.push(...r)))
  await Promise.all(tasks)
  return rows
}
module.exports = { readCodexCache, codexRows, mergeModels, initialRows, saveModels, pickCodexVersion, resolveCodexVersion, discoverModels, claudeRows, fetchClaudeModels, claudeWindowRule }
