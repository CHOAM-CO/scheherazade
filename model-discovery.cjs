// Discovery adds provider receipts; bundled labels/windows remain authoritative.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { resolveDataHome } = require('./data-home.cjs')

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
    .map((m) => ({ id: m.slug, label: m.display_name || m.slug, group: 'GPT', providers: ['chatgpt'],
      contextWindow: m.context_window, contextWindowSource: 'codex-models-cache' }))
}
function validRow(m) {
  return m && typeof m.id === 'string' && typeof m.label === 'string' &&
    typeof m.group === 'string' && Array.isArray(m.providers) && m.providers.every((p) => typeof p === 'string')
}
function mergeModels(bundled, discovered) {
  const rows = new Map(bundled.map((m) => [m.id, { ...m }]))
  const bundledIds = new Set(rows.keys())
  for (const m of discovered.filter(validRow)) {
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

async function discoverModels({ claudeHeaders = null, ollamaUrl = null, fetchImpl = fetch } = {}) {
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
    }).then((body) => rows.push(...codexRows(body).map((m) => ({ ...m, contextWindowSource: 'codex-models-api' })))))
  }
  if (claudeHeaders) tasks.push(get('https://api.anthropic.com/v1/models?limit=1000', claudeHeaders).then((body) => {
    for (const m of body?.data || []) if (/^claude-/.test(m.id)) rows.push({ id: m.id,
      label: m.display_name || m.id, group: 'Claude', providers: ['claude', 'claude-cli', 'claude-subscription'],
      contextWindow: m.context_window, contextWindowSource: 'anthropic-models-api' })
  }))
  if (ollamaUrl) tasks.push(get(new URL('/api/tags', ollamaUrl).href).then((body) => {
    for (const m of body?.models || []) if (typeof m.name === 'string') rows.push({ id: m.name,
      label: m.name, group: 'Ollama', providers: ['dsh'], contextWindowSource: 'ollama-tags' })
  }))
  await Promise.all(tasks)
  return rows
}
module.exports = { readCodexCache, codexRows, mergeModels, initialRows, saveModels, pickCodexVersion, resolveCodexVersion, discoverModels }
