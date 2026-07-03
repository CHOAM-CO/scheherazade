// onboarding/http-server.cjs — the real onboarding wizard + memory pane server,
// replacing main.cjs's PLACEHOLDER_HTML. Plain node:http, no bundler, no
// preload/IPC: the BrowserWindow stays sandboxed (contextIsolation, no
// nodeIntegration) and talks to this server purely over same-origin fetch().
//
// FAIL LOUD: every handler is wrapped so a thrown error becomes a real 4xx/5xx
// with the actual error message in the body -- never a silently swallowed
// catch. This matches memory/server.mjs's own convention (see its
// CallToolRequestSchema handler).
//
// AGENT_NAME is a fixed internal identifier ("scheherazade"), independent of
// the user-facing display name collected in the wizard (Step 2, Korean by
// default: "세헤라자드"). Two reasons this is NOT the same field:
//   1. setup.sh's AGENT_NAME feeds directly into filesystem paths
//      ($HOME/Documents/$AGENT_NAME) and a shell PKILL_PATTERN in run.sh --
//      arbitrary user text (Korean, spaces, shell metacharacters) is not
//      safe there.
//   2. memory/server.mjs resolves its DB path from process.env.AGENT_NAME at
//      *module import time* (server.mjs:62-63) with its own default of
//      'scheherazade' -- matching that default keeps the wizard's writes and
//      the live agent's future memory MCP server pointed at the same
//      ~/Documents/scheherazade/memory.db.
// See writeAgentConfig() below for where DISPLAY_NAME (persona-facing) is
// stored alongside AGENT_NAME (filesystem/db-facing).

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(__dirname, 'public')

const AGENT_NAME = 'scheherazade'
const MEM_HOME = path.join(os.homedir(), 'Documents', AGENT_NAME)
const CREDENTIALS_DIR = path.join(MEM_HOME, '.credentials')
const AGENT_CONFIG_PATH = path.join(REPO_ROOT, '.agent-config')
const ENV_PATH = path.join(REPO_ROOT, '.env')
const MCP_JSON_PATH = path.join(REPO_ROOT, '.mcp.json')

function log(...args) {
  console.log(`[scheherazade/onboarding]`, new Date().toISOString(), ...args)
}

// ── fail-loud JSON helpers ──────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readJsonBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error(`request body exceeds ${limitBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject) // fail loud, never swallow a stream error
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`))
      }
    })
  })
}

// ── .agent-config (extends setup.sh's KEY=VALUE format) ─────────────────
// setup.sh today writes exactly one line: AGENT_NAME=$AGENT_NAME (no
// quoting). We extend the format with more keys and add quoting +
// backslash/$-escaping because DISPLAY_NAME and PRIMARY_TASK are arbitrary
// user text (Korean, punctuation) that must round-trip safely through
// `source .agent-config` in bash.
function shellQuote(value) {
  const str = String(value).replace(/\r?\n/g, ' ')
  const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
  return `"${escaped}"`
}

function readAgentConfig() {
  if (!fs.existsSync(AGENT_CONFIG_PATH)) return {}
  const text = fs.readFileSync(AGENT_CONFIG_PATH, 'utf8')
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    let value = m[2]
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\$/g, '$')
        .replace(/\\`/g, '`')
        .replace(/\\\\/g, '\\')
    }
    out[m[1]] = value
  }
  return out
}

function writeAgentConfig(fields) {
  const merged = { ...readAgentConfig(), ...fields }
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${shellQuote(v)}`)
  fs.writeFileSync(AGENT_CONFIG_PATH, lines.join('\n') + '\n')
  return merged
}

// ── .mcp.json AGENT_NAME correction ──────────────────────────────────────
// The checked-in .mcp.json (both the "agent-channel" and "memory" MCP
// server entries) still carries AGENT_NAME=companion, a leftover from the
// agent-portable fork. memory/server.mjs resolves its DB path from
// process.env.AGENT_NAME at import time -- if this wizard writes preference
// rows under AGENT_NAME=scheherazade while .mcp.json still says
// "companion", the live agent's memory MCP server (started later via
// run.sh) would read a *different* database and never see what the wizard
// wrote. This is a silent-failure class bug, not cosmetic -- fix it here as
// part of "config write", not a separate unrelated edit.
function ensureMcpJsonAgentName() {
  let existing = null
  if (fs.existsSync(MCP_JSON_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'))
    } catch (err) {
      throw new Error(`existing .mcp.json is not valid JSON, refusing to overwrite blindly: ${err.message}`)
    }
  }
  // Snapshot the "before" text BEFORE any mutation below. servers (next)
  // aliases existing.mcpServers by reference when existing is non-null, so
  // mutating servers[name].env in place would also mutate `existing` itself
  // -- taking this snapshot afterward would make nextText === currentText
  // by construction and silently never write the fix. Bug found + fixed
  // 2026-07-03: the diff check was comparing a mutated object against
  // itself, so .mcp.json's stale AGENT_NAME=companion was never corrected
  // despite this function running (silently, no error) on every boot.
  const currentText = existing ? JSON.stringify(existing, null, 2) + '\n' : null
  const servers = existing && existing.mcpServers ? existing.mcpServers : {}
  for (const name of Object.keys(servers)) {
    if (servers[name] && servers[name].env) {
      servers[name].env.AGENT_NAME = AGENT_NAME
    }
  }
  // If either expected server entry is missing (fresh clone before any
  // setup.sh run), seed it with the same shape setup.sh / the P0 memory
  // spike already established.
  if (!servers['agent-channel']) {
    servers['agent-channel'] = {
      command: 'node',
      args: ['./channel.mjs'],
      cwd: REPO_ROOT,
      env: { AGENT_NAME },
    }
  }
  if (!servers['memory']) {
    servers['memory'] = {
      command: 'node',
      args: ['./memory/server.mjs'],
      cwd: REPO_ROOT,
      env: { AGENT_NAME },
    }
  }
  const next = { mcpServers: servers }
  const nextText = JSON.stringify(next, null, 2) + '\n'
  if (nextText !== currentText) {
    fs.writeFileSync(MCP_JSON_PATH, nextText)
    log('.mcp.json AGENT_NAME corrected/seeded to', AGENT_NAME)
  }
}

// ── .env (Discord token + home channel) ─────────────────────────────────
// Same three fields, same unquoted KEY=VALUE format setup.sh writes
// (setup.sh:96-100) -- not routed through safeStorage because this file is
// already the established convention channel.mjs's dotenv/config reads at
// boot, and changing that read path is out of scope for this wizard.
function writeEnv({ discordToken, homeChannelId }) {
  const lines = [`DISCORD_BOT_TOKEN=${discordToken}`, `HOME_CHANNEL_ID=${homeChannelId}`, `AGENT_NAME=${AGENT_NAME}`]
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n')
}

// ── safeStorage-backed BYOK credential store ─────────────────────────────
// Keychain-backed encryption via Electron's safeStorage -- no native dep,
// preserving the property node:sqlite already won for the memory layer.
function getElectron() {
  // Required lazily (not at module top) so this file stays requireable/
  // testable outside a running Electron main process if ever needed.
  return require('electron')
}

function storeProviderKey(provider, key) {
  const { safeStorage } = getElectron()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage encryption unavailable on this system (macOS Keychain not reachable) -- refusing to store the key in plaintext.'
    )
  }
  const encrypted = safeStorage.encryptString(key)
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 })
  const filePath = path.join(CREDENTIALS_DIR, `${provider}.key.enc`)
  fs.writeFileSync(filePath, encrypted)
  fs.chmodSync(filePath, 0o600)
  const manifestPath = path.join(CREDENTIALS_DIR, 'provider.json')
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ provider, keyFile: path.basename(filePath), validatedAt: new Date().toISOString() }, null, 2) + '\n'
  )
  return filePath
}

function readProviderKey(provider) {
  const { safeStorage } = getElectron()
  const filePath = path.join(CREDENTIALS_DIR, `${provider}.key.enc`)
  if (!fs.existsSync(filePath)) return null
  return safeStorage.decryptString(fs.readFileSync(filePath))
}

// Store then immediately read back and compare -- same "read-back-verify"
// discipline memory/server.mjs uses on every write (its SILENT FIELD-DROP
// guard). A safeStorage round-trip failure must be loud, not discovered
// later when the live agent tries to use a corrupted credential.
function storeProviderKeyVerified(provider, key) {
  const filePath = storeProviderKey(provider, key)
  const roundTrip = readProviderKey(provider)
  if (roundTrip !== key) {
    throw new Error(
      `safeStorage round-trip verify failed for provider=${provider}: decrypted value does not match what was stored. Refusing to leave an unverified credential on disk.`
    )
  }
  return filePath
}

// ── BYOK live validation pings ───────────────────────────────────────────
async function validateProviderKey(provider, key) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    return { ok: false, reason: '키가 비어 있습니다' }
  }
  try {
    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      if (res.ok) return { ok: true }
      const body = await res.json().catch(() => ({}))
      return { ok: false, reason: (body && body.error && body.error.message) || `HTTP ${res.status}` }
    }
    if (provider === 'chatgpt') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (res.ok) return { ok: true }
      const body = await res.json().catch(() => ({}))
      return { ok: false, reason: (body && body.error && body.error.message) || `HTTP ${res.status}` }
    }
    if (provider === 'ollama') {
      // NOT `GET /v1/models` (the task brief's suggested check) -- verified
      // empirically that endpoint is public and unauthenticated: it returns
      // 200 with the full model catalog for ANY bearer token, including no
      // token at all, which cannot fail loud on a bad key by construction.
      // `POST /v1/chat/completions` (OpenAI-compatible surface, same shape
      // as the Claude 1-token ping) does enforce auth and returns a real
      // 401 {"error":"Unauthorized"} on a bad/garbage key -- confirmed live
      // against api at verification time.
      const res = await fetch('https://ollama.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-oss:20b',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      })
      if (res.ok) return { ok: true }
      const body = await res.json().catch(() => ({}))
      const reason =
        (body && body.error && typeof body.error === 'object' && body.error.message) ||
        (body && typeof body.error === 'string' && body.error) ||
        (body && body.message) ||
        `HTTP ${res.status}`
      return { ok: false, reason }
    }
    return { ok: false, reason: `알 수 없는 제공사: ${provider}` }
  } catch (err) {
    // Network/DNS/etc failure -- fail loud, surface the real cause.
    return { ok: false, reason: err.message }
  }
}

// ── Discord bot token validation (3-check gateway-connect ping) ─────────
// REST-only (no discord.js Gateway websocket needed): the Application
// object's `flags` bitfield exposes whether MESSAGE_CONTENT privileged
// intent is enabled (bits 1<<18 / 1<<19), so we can distinguish all three
// documented failure branches with three plain fetch() calls.
const DISCORD_API = 'https://discord.com/api/v10'
const GATEWAY_MESSAGE_CONTENT = 1 << 18
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19

async function validateDiscordToken(token) {
  if (!token || !token.trim()) {
    return { ok: false, branch: 'invalid_token' }
  }
  const headers = { Authorization: `Bot ${token}` }

  const meRes = await fetch(`${DISCORD_API}/users/@me`, { headers })
  if (!meRes.ok) {
    return { ok: false, branch: 'invalid_token' }
  }

  const appRes = await fetch(`${DISCORD_API}/oauth2/applications/@me`, { headers })
  if (!appRes.ok) {
    // Token authenticated as a user/bot identity but the application
    // lookup failed -- treat as an invalid/unusable token rather than
    // inventing a fourth branch not in the spec.
    return { ok: false, branch: 'invalid_token' }
  }
  const appBody = await appRes.json()
  const flags = appBody.flags || 0
  const hasMessageContentIntent = (flags & GATEWAY_MESSAGE_CONTENT) !== 0 || (flags & GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0
  if (!hasMessageContentIntent) {
    return { ok: false, branch: 'intent_off' }
  }

  const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, { headers })
  if (!guildsRes.ok) {
    throw new Error(`Discord guilds fetch failed: HTTP ${guildsRes.status}`)
  }
  const guilds = await guildsRes.json()
  if (!Array.isArray(guilds) || guilds.length === 0) {
    return { ok: false, branch: 'not_invited' }
  }

  // Pick the first guild the bot is in, then its first text channel, as
  // HOME_CHANNEL_ID. Not specified in the wizard copy (which never collects
  // a channel ID) -- a deliberate, flagged inference: at this point the
  // user has just invited the bot to a single (often freshly-created)
  // server per tutorial step 5, so "first text channel of the first guild"
  // is the only reasonable default for a v0 single-user local install.
  const guild = guilds[0]
  const channelsRes = await fetch(`${DISCORD_API}/guilds/${guild.id}/channels`, { headers })
  if (!channelsRes.ok) {
    throw new Error(`Discord channels fetch failed for guild ${guild.id}: HTTP ${channelsRes.status}`)
  }
  const channels = await channelsRes.json()
  const textChannels = (Array.isArray(channels) ? channels : [])
    .filter((c) => c.type === 0)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  if (textChannels.length === 0) {
    throw new Error(`Guild ${guild.id} (${guild.name || 'unnamed'}) has no text channels -- cannot pick a home channel.`)
  }
  const homeChannel = textChannels[0]
  return { ok: true, guildId: guild.id, guildName: guild.name, channelId: homeChannel.id }
}

// ── memory tool bridge (bypasses MCP stdio, direct dynamic import) ───────
let _memoryModulePromise = null
let _db = null

async function getMemory() {
  if (!_memoryModulePromise) {
    // memory/server.mjs resolves AGENT_NAME/DB_PATH from process.env at
    // module top-level, once, on first import -- must be set before the
    // dynamic import fires.
    if (!process.env.AGENT_NAME) process.env.AGENT_NAME = AGENT_NAME
    const url = pathToFileURL(path.join(REPO_ROOT, 'memory', 'server.mjs')).href
    _memoryModulePromise = import(url)
  }
  const mod = await _memoryModulePromise
  if (!_db) {
    _db = mod.initDb()
  }
  return { mod, db: _db }
}

const CATEGORY_TABLES = ['user_facts', 'open_threads', 'corrections', 'preferences']
const ALL_MEMORY_TABLES = [...CATEGORY_TABLES, 'memory_events']

async function writePersonaPreferences({ tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd }) {
  const { mod, db } = await getMemory()
  const session = `onboarding-${new Date().toISOString().slice(0, 10)}`
  const rows = [
    ['tone', tone],
    ['primary_task', primaryTask],
    ['proactive_enabled', proactiveEnabled ? 'true' : 'false'],
  ]
  if (proactiveEnabled && proactiveWindowStart && proactiveWindowEnd) {
    rows.push(['proactive_window', `${proactiveWindowStart}-${proactiveWindowEnd}`])
  }
  for (const [key, value] of rows) {
    if (value === undefined || value === null || value === '') continue
    mod.memoryWrite(db, { table: 'preferences', data: { key, value, source_session: session } })
  }
}

// "이번 세션에서 기억한 것" -- grouped by calendar date of the most recent
// memory_events row (not the free-text `session` column, which callers may
// leave null). Same date-derivation-over-session-string principle this
// fleet already landed on elsewhere (boot-handoff date-only note filter).
async function getSessionEvents() {
  const { mod, db } = await getMemory()
  const { rows } = mod.memoryQuery(db, { table: 'memory_events' })
  if (rows.length === 0) return { date: null, events: [] }
  const sorted = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const latestDate = sorted[0].at.slice(0, 10)
  const todays = sorted.filter((r) => r.at.slice(0, 10) === latestDate)

  const resolved = []
  for (const ev of todays) {
    let preview = null
    if (ev.event !== 'delete' && CATEGORY_TABLES.includes(ev.table_name)) {
      try {
        const { rows: rowMatch } = mod.memoryQuery(db, { table: ev.table_name, filter: { id: ev.row_id } })
        if (rowMatch.length === 1) preview = rowMatch[0]
      } catch (_err) {
        // Row may have since been deleted/edited out from under this event
        // -- preview stays null, the row content is not load-bearing here.
      }
    }
    resolved.push({
      id: ev.id,
      event: ev.event,
      table: ev.table_name,
      at: ev.at,
      preview,
    })
  }
  return { date: latestDate, events: resolved }
}

// ── static file serving ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function serveStatic(req, res, urlPath) {
  const filePath = path.join(PUBLIC_DIR, urlPath)
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('forbidden')
    return true
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false
  const ext = path.extname(filePath)
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(filePath).pipe(res)
  return true
}

// ── route dispatch ────────────────────────────────────────────────────────
async function handleApi(req, res, pathname) {
  if (pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, readAgentConfig())
    return
  }

  if (pathname === '/api/byok/validate' && req.method === 'POST') {
    const { provider, key } = await readJsonBody(req)
    if (!['claude', 'chatgpt', 'ollama'].includes(provider)) {
      sendJson(res, 400, { error: `unknown provider: ${provider}` })
      return
    }
    const result = await validateProviderKey(provider, key)
    if (!result.ok) {
      sendJson(res, 200, result)
      return
    }
    storeProviderKeyVerified(provider, key) // throws (fail loud) on storage failure -> caught by outer handler -> 500
    sendJson(res, 200, { ok: true })
    return
  }

  if (pathname === '/api/onboarding/complete' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const { displayName, provider, tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd } = body
    if (!displayName || !provider || !tone) {
      sendJson(res, 400, { error: 'displayName, provider, and tone are required' })
      return
    }
    ensureMcpJsonAgentName()
    writeAgentConfig({
      AGENT_NAME,
      DISPLAY_NAME: displayName,
      PROVIDER: provider,
      TONE: tone,
      PRIMARY_TASK: primaryTask || '',
      PROACTIVE: proactiveEnabled ? 'yes' : 'no',
      PROACTIVE_WINDOW_START: proactiveEnabled ? proactiveWindowStart || '' : '',
      PROACTIVE_WINDOW_END: proactiveEnabled ? proactiveWindowEnd || '' : '',
      ONBOARDING_STEP: '3',
    })
    await writePersonaPreferences({ tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd })
    sendJson(res, 200, { ok: true })
    return
  }

  if (pathname === '/api/discord/validate' && req.method === 'POST') {
    const { token } = await readJsonBody(req)
    const result = await validateDiscordToken(token)
    if (!result.ok) {
      sendJson(res, 200, result)
      return
    }
    writeEnv({ discordToken: token, homeChannelId: result.channelId })
    writeAgentConfig({ ONBOARDING_STEP: '4', ONBOARDING_COMPLETE: '1', ONBOARDING_COMPLETED_AT: new Date().toISOString() })
    sendJson(res, 200, result)
    return
  }

  if (pathname === '/api/discord/open' && req.method === 'POST') {
    const { guildId, channelId } = await readJsonBody(req)
    if (!guildId || !channelId) {
      sendJson(res, 400, { error: 'guildId and channelId are required' })
      return
    }
    const { shell } = getElectron()
    await shell.openExternal(`https://discord.com/channels/${guildId}/${channelId}`)
    sendJson(res, 200, { ok: true })
    return
  }

  if (pathname === '/api/memory/session-events' && req.method === 'GET') {
    const result = await getSessionEvents()
    sendJson(res, 200, result)
    return
  }

  const tableMatch = pathname.match(/^\/api\/memory\/([a-z_]+)$/)
  if (tableMatch && req.method === 'GET') {
    const table = tableMatch[1]
    if (!CATEGORY_TABLES.includes(table)) {
      sendJson(res, 400, { error: `not a category table: ${table}` })
      return
    }
    const { mod, db } = await getMemory()
    const { rows } = mod.memoryQuery(db, { table })
    sendJson(res, 200, { table, rows })
    return
  }

  const deleteMatch = pathname.match(/^\/api\/memory\/([a-z_]+)\/(\d+)$/)
  if (deleteMatch && req.method === 'DELETE') {
    const table = deleteMatch[1]
    const id = Number(deleteMatch[2])
    if (!CATEGORY_TABLES.includes(table)) {
      sendJson(res, 400, { error: `not a deletable table: ${table}` })
      return
    }
    const { mod, db } = await getMemory()
    mod.memoryDelete(db, { table, id }) // throws loud on 0-row match -- caught below -> 404/500
    sendJson(res, 200, { ok: true })
    return
  }

  if (pathname === '/api/settings/rename' && req.method === 'POST') {
    const { displayName } = await readJsonBody(req)
    if (!displayName || !displayName.trim()) {
      sendJson(res, 400, { error: 'displayName is required' })
      return
    }
    const merged = writeAgentConfig({ DISPLAY_NAME: displayName.trim() })
    sendJson(res, 200, { ok: true, config: merged })
    return
  }

  sendJson(res, 404, { error: `no such API route: ${req.method} ${pathname}` })
}

const ROUTE_TO_FILE = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/memory': 'memory.html',
  '/settings': 'settings.html',
  '/waiting': 'waiting.html',
}

function createOnboardingServer() {
  ensureMcpJsonAgentName() // correctness fix applied once at boot, independent of wizard progress

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1')
      const pathname = parsedUrl.pathname

      const respondError = (err, status = 500) => {
        console.error(`[scheherazade/onboarding] ERROR ${req.method} ${pathname}:`, err)
        if (!res.headersSent) {
          sendJson(res, status, { error: err.message || String(err) })
        } else {
          res.end()
        }
      }

      if (pathname.startsWith('/api/')) {
        handleApi(req, res, pathname).catch((err) => respondError(err))
        return
      }

      if (pathname in ROUTE_TO_FILE) {
        // Once onboarding is complete, "/" is the wizard's job no longer --
        // land the user in the memory pane, their steady-state home view.
        if (pathname === '/' || pathname === '/index.html') {
          const cfg = readAgentConfig()
          if (cfg.ONBOARDING_COMPLETE === '1') {
            res.writeHead(302, { Location: '/memory' })
            res.end()
            return
          }
        }
        if (serveStatic(req, res, ROUTE_TO_FILE[pathname])) return
      }

      if (serveStatic(req, res, pathname)) return

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    })

    server.on('error', (err) => reject(err))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const url = `http://127.0.0.1:${port}/`
      log(`onboarding server listening on ${url}`)
      resolve({ server, url })
    })
  })
}

module.exports = { createOnboardingServer, AGENT_NAME, MEM_HOME, readAgentConfig }
