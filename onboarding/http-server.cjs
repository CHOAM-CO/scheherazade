// onboarding/http-server.cjs — the real onboarding wizard + memory pane server,
// replacing main.cjs's PLACEHOLDER_HTML. Plain node:http, no bundler, no
// preload/IPC: the BrowserWindow stays sandboxed (contextIsolation, no
// nodeIntegration) and talks to this server purely over same-origin fetch().
//
// FAIL LOUD: every handler is wrapped so a thrown error becomes a real 4xx/5xx
// status -- never a silently swallowed catch. The response BODY, however,
// never carries the raw error message to the client (see respondError below)
// -- only the server-side log does. This matches memory/server.mjs's own
// convention (see its CallToolRequestSchema handler) for the "never
// swallow" half; the "never leak detail onto the wire" half is new
// (model-divergent/GPT security review, confirmed by direct code read,
// 2026-07-03).
//
// AGENT_NAME is a fixed internal identifier ("scheherazade"), independent of
// the user-facing display name collected in the wizard (Step 2, Korean by
// default: "세헤라자드"). Two reasons this is NOT the same field:
//   1. setup.sh's AGENT_NAME feeds directly into filesystem paths
//      ($HOME/Documents/$AGENT_NAME) and a shell PKILL_PATTERN in run.sh --
//      arbitrary user text (Korean, spaces, shell metacharacters) is not
//      safe there. (That's setup.sh's own CLI-launcher deployment path --
//      separate from this file's DATA_HOME, see below.)
//   2. memory/server.mjs used to resolve its DB path from AGENT_NAME at
//      *module import time* -- see DATA_HOME below for why neither this
//      file nor memory/server.mjs does that anymore.
// See writeAgentConfig() below for where DISPLAY_NAME (persona-facing) is
// stored alongside AGENT_NAME (internal identifier).

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(__dirname, 'public')
const PUBLIC_DIR_RESOLVED = path.resolve(PUBLIC_DIR)

const AGENT_NAME = 'scheherazade'

// ── DATA_HOME: fixed, product-keyed data directory ──────────────────────
// PO correction (2026-07-03), overriding this file's earlier draft: DATA_HOME
// must NOT be keyed on AGENT_NAME, and definitely not on DISPLAY_NAME.
// DISPLAY_NAME is user-renameable from the Settings page (see
// /api/settings/rename below) -- if the on-disk data path were keyed on it,
// a rename would orphan memory.db (silent total memory loss, the exact
// opposite of this product's "remembers you" promise). AGENT_NAME today
// happens to be a fixed internal literal too, but DATA_HOME is pinned
// independently to the literal product name so it stays stable even if
// AGENT_NAME itself ever changes (e.g. this codebase gets forked again for
// another agent). A rename in Settings only ever edits the DISPLAY_NAME
// *value* inside .agent-config -- it NEVER moves, renames, or otherwise
// touches DATA_HOME. v1 has no live users, so no migration path is needed.
//
// memory/server.mjs's DB_PATH resolves from this exact same fixed
// directory now (not AGENT_NAME) -- see its own top-of-file comment. Its
// SCHEHERAZADE_MEMORY_DB env override (used by memory/smoke.mjs) still
// works unchanged.
const DATA_HOME = path.join(os.homedir(), 'Documents', 'Scheherazade')

// CONFIG_DIR: where every *writable* runtime config file lives -- the same
// directory as DATA_HOME/memory.db, kept as a separate name below purely
// for readability at each call site (config vs. credentials vs. db).
// Packaged builds ship REPO_ROOT inside app.asar, which is READ-ONLY at
// runtime -- writing .agent-config/.env/.mcp.json there (the old behavior)
// was boot-fatal the moment this app was ever actually packaged, since
// ensureMcpJsonAgentName() below writes .mcp.json unconditionally on every
// boot. CONFIG_DIR is always a real, writable, unpackaged directory on the
// user's own disk.
const CONFIG_DIR = DATA_HOME
const CREDENTIALS_DIR = path.join(CONFIG_DIR, '.credentials')

// Read-only TEMPLATES checked into the repo (and therefore inside app.asar
// once packaged -- see package.json's build.files, which now explicitly
// includes .mcp.json for exactly this reason). Seeded into CONFIG_DIR on
// first run only, by seedConfigFromTemplates() below; every write after
// that targets CONFIG_DIR exclusively, and these template paths are never
// written to. .env and .agent-config have no checked-in template today
// (both are gitignored, deliberately -- shipping a real .env would leak
// whatever secrets the person who ran `npm run dist` happened to have on
// their own machine into every distributed build). Their seed step below
// is a safe no-op until/unless that changes; first real content comes from
// the wizard itself (writeAgentConfig / writeEnv).
const TEMPLATE_MCP_JSON_PATH = path.join(REPO_ROOT, '.mcp.json')
const TEMPLATE_ENV_PATH = path.join(REPO_ROOT, '.env')
const TEMPLATE_AGENT_CONFIG_PATH = path.join(REPO_ROOT, '.agent-config')

const AGENT_CONFIG_PATH = path.join(CONFIG_DIR, '.agent-config')
const ENV_PATH = path.join(CONFIG_DIR, '.env')
const MCP_JSON_PATH = path.join(CONFIG_DIR, '.mcp.json')

const PROVIDERS = ['claude', 'chatgpt', 'ollama']

function log(...args) {
  console.log(`[scheherazade/onboarding]`, new Date().toISOString(), ...args)
}

// ── per-launch localhost-auth secret ─────────────────────────────────────
// Generated fresh every time this module is loaded (= every server boot).
// Required as the `X-Onboard-Token` header on every mutating (POST/DELETE)
// /api/ route; injected into every served HTML page as a <meta> tag so
// client-side JS can read it back and attach it to its own fetch() calls
// (see public/js/copy.js's getOnboardToken() + each page's api() helper).
// Paired with the Host/Origin checks in createOnboardingServer() below --
// together these close the "no auth of any kind on a mutating localhost
// server" gap (security review, 2026-07-03): before this, any other local
// process, or a DNS-rebinding page in a browser tab, could POST directly
// to this server's ephemeral port and, e.g., overwrite .agent-config,
// trigger a Discord bot-token validation, or delete memory rows.
const SERVER_TOKEN = crypto.randomBytes(32).toString('hex')

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function safeOriginHost(origin) {
  try {
    return new URL(origin).host
  } catch (err) {
    log(`malformed Origin header "${origin}": ${err.message}`)
    return null
  }
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
}

// Seeds a writable CONFIG_DIR file from its checked-in (read-only, asar-
// safe) template the first time this app ever runs on a machine. No-op if
// the target already exists (never clobbers a user's live config) or if
// there is no template to seed from (see TEMPLATE_* comment above).
function seedConfigFromTemplate(templatePath, targetPath) {
  if (fs.existsSync(targetPath)) return
  if (!fs.existsSync(templatePath)) return
  ensureConfigDir()
  fs.copyFileSync(templatePath, targetPath)
  log(`seeded ${path.basename(targetPath)} into CONFIG_DIR from bundled template`)
}

function seedConfigFromTemplates() {
  seedConfigFromTemplate(TEMPLATE_MCP_JSON_PATH, MCP_JSON_PATH)
  seedConfigFromTemplate(TEMPLATE_ENV_PATH, ENV_PATH)
  seedConfigFromTemplate(TEMPLATE_AGENT_CONFIG_PATH, AGENT_CONFIG_PATH)
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
  ensureConfigDir()
  const merged = { ...readAgentConfig(), ...fields }
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${shellQuote(v)}`)
  fs.writeFileSync(AGENT_CONFIG_PATH, lines.join('\n') + '\n')
  return merged
}

// ── unpacked-path mapping for spawned (ELECTRON_RUN_AS_NODE) children ────
// Packaging bugfix (model-divergent/GPT review, 2026-07-03, high-severity):
// the bundled Claude CLI reads this .mcp.json and spawns each server as a
// child process. A child spawned with ELECTRON_RUN_AS_NODE does NOT get
// Electron's asar fs patch -- that patch lives in Electron's own process,
// not in a bare-node child -- so channel.mjs / memory/server.mjs and every
// node_modules import they make must resolve to REAL files on disk, never
// a path inside app.asar. package.json's build.asarUnpack mirrors
// memory/**, channel.mjs, and node_modules/** into
// <app>/Contents/Resources/app.asar.unpacked/... at build time (a REAL
// directory); this maps any REPO_ROOT-relative absolute path to that
// unpacked twin. No-op in dev -- REPO_ROOT never contains the literal
// "app.asar" path segment there, so dev keeps working unchanged.
function toUnpackedPath(p) {
  const marker = `${path.sep}app.asar${path.sep}`
  if (!p.includes(marker)) return p
  return p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
}

const CHANNEL_SCRIPT_PATH = toUnpackedPath(path.join(REPO_ROOT, 'channel.mjs'))
const MEMORY_SERVER_SCRIPT_PATH = toUnpackedPath(path.join(REPO_ROOT, 'memory', 'server.mjs'))

// ── .mcp.json AGENT_NAME + command/args/cwd correction ──────────────────
// The checked-in .mcp.json (both the "agent-channel" and "memory" MCP
// server entries) still carries AGENT_NAME=companion, a leftover from the
// agent-portable fork. memory/server.mjs resolves its DB path from
// process.env.AGENT_NAME at import time -- if this wizard writes preference
// rows under AGENT_NAME=scheherazade while .mcp.json still says
// "companion", the live agent's memory MCP server would read a *different*
// database and never see what the wizard wrote. This is a silent-failure
// class bug, not cosmetic -- fix it here as part of "config write", not a
// separate unrelated edit.
//
// command/args/cwd get the same "correct on every boot" treatment, for two
// packaging bugs found in the same model-divergent review (2026-07-03,
// both high-severity, confirmed by direct code read):
//   BUG 1 (cwd): the old cwd=REPO_ROOT is inside app.asar once packaged --
//     not a real OS directory, so a plain spawned process can't read files
//     there. cwd is now DATA_HOME, which is always a real, writable
//     directory (also happens to fix channel.mjs's HOME_CHANNEL_ID pickup:
//     its `dotenv/config` import loads .env relative to cwd, and
//     DATA_HOME/.env is exactly where writeEnv() below puts it).
//   BUG 2 (command/args): command was the literal string "node" with no
//     bundled node runtime -- ENOENT on a clean Mac with no system node.
//     command is now process.execPath (the bundled Electron binary itself)
//     with ELECTRON_RUN_AS_NODE:'1' in env, the same pattern main.cjs's
//     child-process supervision already uses -- see main.cjs's comment on
//     that env var. args now point at the absolute UNPACKED path of the
//     target .mjs (see toUnpackedPath above) instead of a REPO_ROOT-
//     relative "./channel.mjs" that only ever resolved correctly when cwd
//     was REPO_ROOT.
function ensureMcpJsonAgentName() {
  ensureConfigDir()
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
  const KNOWN_SERVERS = { 'agent-channel': CHANNEL_SCRIPT_PATH, memory: MEMORY_SERVER_SCRIPT_PATH }
  for (const name of Object.keys(KNOWN_SERVERS)) {
    if (!servers[name]) continue
    servers[name].command = process.execPath
    servers[name].args = [KNOWN_SERVERS[name]]
    servers[name].cwd = DATA_HOME
    servers[name].env = { ...(servers[name].env || {}), AGENT_NAME, ELECTRON_RUN_AS_NODE: '1' }
  }
  // If either expected server entry is missing (fresh clone before any
  // setup.sh run), seed it with the same corrected shape.
  if (!servers['agent-channel']) {
    servers['agent-channel'] = {
      command: process.execPath,
      args: [CHANNEL_SCRIPT_PATH],
      cwd: DATA_HOME,
      env: { AGENT_NAME, ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  if (!servers['memory']) {
    servers['memory'] = {
      command: process.execPath,
      args: [MEMORY_SERVER_SCRIPT_PATH],
      cwd: DATA_HOME,
      env: { AGENT_NAME, ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  // BUG 3 (bot-token seam, security review 2026-07-03): DISCORD_BOT_TOKEN
  // must NEVER be written here. It is safeStorage-only (see
  // storeDiscordTokenVerified / readDiscordToken below) -- writing it into
  // this on-disk JSON file would reintroduce the exact plaintext-at-rest
  // gap that fix closed. Whatever spawns the real `claude` CLI child
  // (main.cjs) decrypts it at spawn time and injects it into THAT child's
  // own env -- the CLI inherits it, and inherits it again down to
  // channel.mjs when the CLI spawns this .mcp.json's "agent-channel"
  // entry as an MCP server. Never add a token field to KNOWN_SERVERS' env
  // above.
  const next = { mcpServers: servers }
  const nextText = JSON.stringify(next, null, 2) + '\n'
  if (nextText !== currentText) {
    fs.writeFileSync(MCP_JSON_PATH, nextText)
    log('.mcp.json AGENT_NAME/command/args/cwd corrected/seeded')
  }
}

// ── .env (home channel only) ─────────────────────────────────────────────
// channel.mjs's dotenv/config read path is the established convention for
// HOME_CHANNEL_ID (setup.sh:96-100 shape) -- changing that read path is out
// of scope for this wizard. DISCORD_BOT_TOKEN used to be written here too,
// in plaintext; as of the 2026-07-03 security review it is safeStorage-only
// (see storeDiscordTokenVerified / readDiscordToken below) and is never
// written to this file.
function writeEnv({ homeChannelId }) {
  ensureConfigDir()
  const lines = [`HOME_CHANNEL_ID=${homeChannelId}`, `AGENT_NAME=${AGENT_NAME}`]
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n')
}

// Read-back for HOME_CHANNEL_ID, mirroring readAgentConfig()'s simple
// KEY=VALUE parse (no quoting needed -- writeEnv() never quotes;
// HOME_CHANNEL_ID is always a plain numeric snowflake). Added for the
// BOT-TOKEN SEAM (main.cjs P1 wiring, security review 2026-07-03):
// whatever spawns the real agent child needs HOME_CHANNEL_ID injected into
// its env alongside the decrypted token, so main.cjs can validate it's
// present (and skip the spawn with a clear log line if not) rather than
// spawning blind and letting channel.mjs FATAL-exit deep in the child.
function readHomeChannelId() {
  if (!fs.existsSync(ENV_PATH)) return null
  const text = fs.readFileSync(ENV_PATH, 'utf8')
  const m = text.match(/^HOME_CHANNEL_ID=(.*)$/m)
  return m ? m[1].trim() : null
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
  // Per-provider manifest filename (fixed 2026-07-03): this used to be a
  // single shared CREDENTIALS_DIR/provider.json, which meant validating a
  // second provider -- or, now, the Discord bot token (see
  // storeDiscordTokenVerified, which reuses this exact function) -- would
  // silently clobber the previous provider's record. Each provider now
  // gets its own manifest file.
  const manifestPath = path.join(CREDENTIALS_DIR, `${provider}.meta.json`)
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

// ── Discord bot token: safeStorage-backed, same mechanism as BYOK keys ──
// Security review (2026-07-03): the bot token used to be written to .env
// in plaintext alongside HOME_CHANNEL_ID. It now goes through the exact
// same encrypt -> write -> read-back-verify path as provider keys above,
// keyed as a pseudo-"provider" named 'discord-bot' so it shares
// CREDENTIALS_DIR's layout (0o700 dir, 0o600 files, per-name manifest)
// without inventing a second storage mechanism.
//
// SEAM (documented, not wired to a real child process yet -- see main.cjs's
// P1 wiring notes, item 1: nothing in this repo spawns the `claude`
// CLI/channel.mjs child yet, that's still open work). Whatever eventually
// does spawn it must call readDiscordToken() at the moment of spawn and
// inject the result directly into that child's own `env: {...}` -- it must
// NEVER be written back out to a .env file or any other on-disk config.
function storeDiscordTokenVerified(token) {
  return storeProviderKeyVerified('discord-bot', token)
}

function readDiscordToken() {
  return readProviderKey('discord-bot')
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
  const resolved = path.resolve(filePath)
  // Separator-aware containment check (fixed 2026-07-03, security review).
  // The old check was `filePath.startsWith(PUBLIC_DIR)`, a raw string
  // prefix test that (a) never resolved `..` traversal itself -- it relied
  // entirely on path.join happening to normalize it away first -- and (b)
  // would wrongly ALLOW a sibling directory whose name happens to start
  // with PUBLIC_DIR's own path as a string, e.g. a request that resolves
  // into ".../onboarding/public-evil/secret" passes a naive
  // startsWith(".../onboarding/public") check even though it is a
  // different directory entirely. Comparing against the fully resolved
  // path, requiring either an exact match or a match immediately followed
  // by path.sep, closes both holes.
  if (resolved !== PUBLIC_DIR_RESOLVED && !resolved.startsWith(PUBLIC_DIR_RESOLVED + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('forbidden')
    return true
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false
  const ext = path.extname(resolved)
  if (ext === '.html') {
    // Inject the per-launch onboard token as a <meta> tag so client JS can
    // read it back and attach it to mutating fetch() calls (see
    // public/js/copy.js's getOnboardToken()). Every page here has a
    // literal `<head>` opening tag (verified against all 4 templates), so
    // a plain string replace is exact and doesn't need a real HTML parser.
    const html = fs.readFileSync(resolved, 'utf8')
    if (!html.includes('<head>')) {
      throw new Error(`${resolved} has no literal "<head>" tag to inject the onboard token into -- refusing to serve it without auth wiring`)
    }
    const injected = html.replace('<head>', `<head>\n    <meta name="onboard-token" content="${SERVER_TOKEN}">`)
    res.writeHead(200, { 'Content-Type': MIME[ext] })
    res.end(injected)
    return true
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(resolved).pipe(res)
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
    if (!PROVIDERS.includes(provider)) {
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
    if (!PROVIDERS.includes(provider)) {
      sendJson(res, 400, { error: `unknown provider: ${provider}` })
      return
    }
    // Onboarding-complete gate (security review, 2026-07-03): completing
    // setup used to accept ANY provider string with no check that its key
    // was ever actually validated. readProviderKey(provider) can only
    // return non-null if storeProviderKeyVerified() previously succeeded
    // for this exact provider -- the only code path that ever writes
    // CREDENTIALS_DIR/${provider}.key.enc is the /api/byok/validate
    // success branch above -- so this single check proves BOTH "the key
    // was validated" AND "a safeStorage credential exists" at once.
    let credential
    try {
      credential = readProviderKey(provider)
    } catch (err) {
      console.error('[scheherazade/onboarding] readProviderKey failed during onboarding-complete gate:', err)
      credential = null // a corrupt/unreadable Keychain entry reads as "not validated yet", not a 500
    }
    if (!credential) {
      sendJson(res, 400, { error: `no validated ${provider} key on file -- validate a key in step 1 before completing setup` })
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
    storeDiscordTokenVerified(token) // safeStorage only -- never written to .env in plaintext (security review, 2026-07-03)
    writeEnv({ homeChannelId: result.channelId })
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
  seedConfigFromTemplates() // first-run only; no-op once CONFIG_DIR has real files
  ensureMcpJsonAgentName() // correctness fix applied every boot, independent of wizard progress

  return new Promise((resolve, reject) => {
    let allowedHosts = null // populated once listen() resolves and the real ephemeral port is known

    const server = http.createServer((req, res) => {
      const respondError = (err, status = 500) => {
        // Fail loud SERVER-SIDE (full error incl. stack logged here), but
        // NEVER put err.message on the wire (security review, 2026-07-03):
        // it can carry provider-key/token fragments (a safeStorage/
        // Keychain error, a fetch() failure body, an fs ENOENT path with
        // credentials in it) that a local HTTP client should never see.
        console.error(`[scheherazade/onboarding] ERROR ${req.method} ${req.url}:`, err)
        if (!res.headersSent) {
          sendJson(res, status, { error: 'internal error -- see server log' })
        } else {
          res.end()
        }
      }

      try {
        const parsedUrl = new URL(req.url, 'http://127.0.0.1')
        const pathname = parsedUrl.pathname

        // ── localhost-auth gate (Host / Origin / per-launch token) ──────
        // Security review, 2026-07-03: before this, the server had no auth
        // of any kind. Any other local process, or a page in a browser tab
        // doing DNS rebinding, could reach every route on this ephemeral
        // port -- including mutating ones.
        if (!allowedHosts) {
          respondError(new Error('server not ready'), 503)
          return
        }
        const hostHeader = req.headers.host
        if (!hostHeader || !allowedHosts.has(hostHeader)) {
          log(`REJECT bad Host="${hostHeader}" ${req.method} ${pathname}`)
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('forbidden: bad host')
          return
        }

        const isMutating = req.method === 'POST' || req.method === 'DELETE'
        if (isMutating) {
          const origin = req.headers.origin
          if (origin) {
            const originHost = safeOriginHost(origin)
            if (!originHost || !allowedHosts.has(originHost)) {
              log(`REJECT cross-origin Origin="${origin}" ${req.method} ${pathname}`)
              res.writeHead(403, { 'Content-Type': 'text/plain' })
              res.end('forbidden: bad origin')
              return
            }
          }
          if (!safeTokenEqual(req.headers['x-onboard-token'], SERVER_TOKEN)) {
            log(`REJECT missing/invalid X-Onboard-Token ${req.method} ${pathname}`)
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('forbidden: missing or invalid onboard token')
            return
          }
        }

        if (pathname.startsWith('/api/')) {
          handleApi(req, res, pathname).catch((err) => respondError(err))
          return
        }

        if (pathname in ROUTE_TO_FILE) {
          // Once onboarding is complete, "/" is the wizard's job no longer
          // -- land the user in the memory pane, their steady-state home
          // view.
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
      } catch (err) {
        respondError(err)
      }
    })

    server.on('error', (err) => reject(err))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
      const url = `http://127.0.0.1:${port}/`
      log(`onboarding server listening on ${url}`)
      resolve({ server, url })
    })
  })
}

module.exports = { createOnboardingServer, AGENT_NAME, DATA_HOME, readAgentConfig, readDiscordToken, readHomeChannelId }
