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
// (confirmed by direct code read).
//
// AGENT_NAME is a fixed internal identifier ("scheherazade"), independent of
// the user-facing display name collected in the wizard (Step 2, Korean by
// default: "세헤라자드"). Two reasons this is NOT the same field:
//   1. setup.sh's AGENT_NAME feeds directly into filesystem paths
//      ($HOME/Documents/$AGENT_NAME) and a shell PKILL_PATTERN in run.sh --
//      arbitrary user text (Korean, spaces, shell metacharacters) is not
//      safe there. (That's setup.sh's own CLI-launcher deployment path --
//      separate from this file's DATA_HOME, see below.)
//   2. the memory data layer (memory/service.mjs) used to resolve its DB
//      path from AGENT_NAME at *module import time* (back when it lived
//      inside memory/server.mjs) -- see DATA_HOME below for why neither
//      this file nor the memory layer does that anymore.
// See writeAgentConfig() below for where DISPLAY_NAME (persona-facing) is
// stored alongside AGENT_NAME (internal identifier).

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
// Single source of truth for "which PROVIDERS values need a stored
// credential before onboarding-complete", "which local URL each mode's
// liveness ping checks", and "which base-URL/port values are valid" --
// shared with main.cjs's spawn-time env building and this file's own
// liveness pings below, so neither can drift out of sync with
// provider-env.cjs's buildProviderEnv(). Zero Electron dependency, safe to
// require from here. (history: docs/HISTORY.md)
const { PROVIDERS_REQUIRING_STORED_CREDENTIAL, resolveChatgptProxyPort, resolveCustomBaseUrl, parseCustomProviderJson, OLLAMA_BASE_URL } = require('../provider-env.cjs')
// Login shell-out (2026-07-07): spawn/execFile for `codex login` /
// `ollama signin` children -- the ONLY non-claude binary spawn sites in
// this codebase (verified by repo-wide grep at design time; the chatgpt
// proxy runs IN-PROCESS via the codex-as-api package, no spawn). Rule for
// any FUTURE external-binary spawn (Codex security review, 2026-07-07):
// resolve via resolveBin() below and use a FIXED argv -- the LOGIN_SPECS
// table is the single existing site.
const { spawn, execFile, execFileSync } = require('node:child_process')

// Kill a detached child AND its descendants. Negative-pid process-group signals
// do not exist on Windows, so every group-kill below threw straight into its
// catch and killed nothing: detached `codex login` / `claude mcp login`
// children outlived app quit, and an orphaned OAuth flow can still finish its
// exchange and write credentials after the app is gone -- the exact Codex
// finding #3 these call sites exist to prevent. (Found 2026-08-03.)
function killTree(pid, signal) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  process.kill(-pid, signal)
}

// The autonomous cycle's meter and decision logic. The SAME modules the
// channel.mjs watcher enforces against -- the settings page must not compute
// the user's token count a second, subtly different way. One implementation,
// two callers.
const autonomyBudget = require(path.join(__dirname, '..', 'autonomy', 'budget.cjs'))
const autonomyCycle = require(path.join(__dirname, '..', 'autonomy', 'cycle.cjs'))
const { LOGIN_PROVIDERS, setLoginStatus, getLoginStatus } = require('./login-status.cjs')
const logBuffer = require('./log-buffer.cjs') // /api/logs read side; main.cjs owns the write side + sink init
const attachTopology = require('../attach-topology.cjs') // /api/topology read side (0.1.0 prep); no Electron deps, safe here
// In-app `claude setup-token` capture. Pure-JS state machine; node-pty is
// required lazily inside it, so importing this here cannot fail the server
// boot on a box where the native module did not build.
const { createSetupTokenSession, killSetupTokenChildOnShutdown } = require('../setup-token-session.cjs')

// sudo askpass per-boot token (0.1.0 prep): generated in createOnboardingServer's
// listen callback, checked by GET /api/sudo/password. Module-level on purpose --
// the route handler and the listen callback live in different closures. null =
// fail closed (endpoint refuses everything).
let askpassToken = null
const permissionProbes = require('./permission-probes.cjs')
// Fresh-Mac dependency bootstrap (2026-07-07): app-managed download/install
// of the codex/ollama CLIs into DATA_HOME/bin + sha256 manifest. See
// bootstrap.cjs's header for the full design (brew-free, 0 admin prompts).
const { BOOTSTRAP_DEPS, startBootstrap, getBootstrapStatus, verifyManagedBin, MANAGED_INSTALL_SUPPORTED, MANUAL_INSTALL_PAGES } = require('./bootstrap.cjs')

const REPO_ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(__dirname, 'public')
const PUBLIC_DIR_RESOLVED = path.resolve(PUBLIC_DIR)

const AGENT_NAME = 'scheherazade'

// ── DATA_HOME: fixed, product-keyed data directory ──────────────────────
// DATA_HOME must NOT be keyed on AGENT_NAME, and definitely not on
// DISPLAY_NAME. DISPLAY_NAME is user-renameable from the Settings page (see
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
// memory/service.mjs's DB_PATH resolves from this exact same fixed
// directory now (not AGENT_NAME) -- see its DATA_HOME comment. Its
// SCHEHERAZADE_MEMORY_DB env override (used by memory/smoke.mjs) still
// works unchanged.
//
// AGENT_DATA_HOME override: channel.mjs and run.sh (MEM=) have always
// honored this env var; production is unaffected -- main.cjs passes
// AGENT_DATA_HOME into the env of the children it spawns, never into its
// own process.env, and http-server runs inside main. (history: docs/HISTORY.md)
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')

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

const AGENT_CONFIG_PATH = path.join(CONFIG_DIR, '.agent-config')
const ENV_PATH = path.join(CONFIG_DIR, '.env')
const MCP_JSON_PATH = path.join(CONFIG_DIR, '.mcp.json')

// Process-side liveness status (spawned/failed), written by main.cjs's
// child-process lifecycle. See onboarding/agent-status.cjs's own header for
// why this is a plain shared require() rather than IPC.
const { getAgentStatus } = require('./agent-status.cjs')

// Discord-side liveness marker (agent-lifecycle fix, 2026-07-03, PART 4):
// channel.mjs writes this file to DATA_HOME (its cwd, per .mcp.json's
// agent-channel entry) on the discord.js ClientReady event, and refreshes
// it as a heartbeat afterward -- see channel.mjs's own
// writeLivenessMarker()/LIVENESS_HEARTBEAT_MS. Read-side lives here, not in
// agent-status.cjs, because it's a filesystem fact (DATA_HOME/.agent-live),
// not process-lifecycle state; agent-status.cjs deliberately has no fs
// dependency. Filename/shape is a plain documented convention shared
// between the two files (one is ESM, one CJS -- not worth a shared module
// for a two-field JSON contract).
const LIVENESS_MARKER_PATH = path.join(DATA_HOME, '.agent-live')
// Generous vs. channel.mjs's 60s heartbeat interval -- tolerates one missed
// beat before calling the marker stale, without ever letting a real dead
// agent's LAST marker read as perpetually "live".
const LIVENESS_FRESH_MS = 150_000

function readLivenessMarker() {
  try {
    const text = fs.readFileSync(LIVENESS_MARKER_PATH, 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed.lastHeartbeat !== 'string') return null
    return parsed
  } catch (err) {
    if (err.code !== 'ENOENT') log(`readLivenessMarker: unexpected error reading ${LIVENESS_MARKER_PATH}: ${err.message}`)
    return null
  }
}

// Fix D: the marker's timestamp freshness alone is not enough -- a
// dead/replaced process's last
// recent heartbeat can outlive it by up to LIVENESS_FRESH_MS (150s) and get
// reported "live" for a broken agent. channel.mjs's writeLivenessMarker()
// stamps its own process.pid into the marker (see channel.mjs); this checks
// that pid is actually still alive on this machine before trusting the
// timestamp at all. Uses the same kill(pid, 0)-probe idiom run.sh's own
// is_alive() uses, just from Node -- ESRCH means dead, EPERM means alive but
// owned by another user (still "alive" for our purposes, just not ours).
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function isMarkerFresh(marker) {
  if (!marker) return false
  if (!isPidAlive(marker.pid)) return false
  const ageMs = Date.now() - Date.parse(marker.lastHeartbeat)
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= LIVENESS_FRESH_MS
}

// Timeout backstop (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 2): a
// silent hang (e.g. a broken promise somewhere in the claude boot / MCP
// handshake / discord.js gateway-connect chain that never rejects) used to
// leave the UI on 'connecting' forever -- no deadline existed. TIMEOUT_MS
// is the single tunable ceiling for how long 'connecting' is allowed to
// stay 'connecting' with no fresh liveness marker, counted from the START
// of the CURRENT spawn attempt (agent-status.cjs's `since`, re-stamped by
// main.cjs's spawnRealAgentChild() at the moment of each spawn -- see that
// function's own comment). A named const so it's a one-line tune, not a
// buried magic number.
const TIMEOUT_MS = 60_000

// GET /api/agent/status -- REQUIREMENT 4 (PO, agent-lifecycle fix,
// 2026-07-03): combines the process-side state (agent-status.cjs, written
// by main.cjs) with the Discord-side heartbeat marker (this file's own
// read) into ONE state the Step 5 UI can poll and gate its success screen
// on, instead of showing "waiting in Discord" the instant
// ONBOARDING_COMPLETE flips.
//
// Precedence (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1 + PIECE 2):
// explicit failed > live > timeout > connecting.
//   state: 'failed'     -- proc.state is already 'failed' (main.cjs set it
//          directly, or relayed it from the .agent-failed.json marker via
//          pollFailureMarker()) -- `code`/`detail` carry the cause. Takes
//          priority over marker freshness -- a stale marker plus a dead/
//          blocked process is unambiguously "failed", not "connecting".
//   state: 'live'       -- marker fresh (see isMarkerFresh()). Real,
//          confirmed Discord liveness.
//   state: 'failed', code: 'timeout' -- proc.state is 'connecting' (an
//          actual spawn attempt happened) and it's been sitting there,
//          with no fresh marker, for longer than TIMEOUT_MS since that
//          spawn attempt. Synthesized here at read time, cause-agnostic --
//          it doesn't know (or need to know) WHY nothing ever went live,
//          only that too long has passed. Never applied to proc.state ===
//          'idle' (no spawn attempted yet -- see the "existingPid &&
//          isOurSupervisor" discovery path in main.cjs's
//          spawnRealAgentChild(), which intentionally does not call
//          setAgentStatus('connecting') since it didn't spawn anything)
//          so an app instance that merely discovered an already-alive
//          supervisor is never falsely timed out before it's had any
//          `since` stamp of its own.
//   state: 'connecting' -- process spawned (or not attempted yet), marker
//          absent/stale, timeout not yet exceeded. Normal transient state.
function computeAgentStatus() {
  const proc = getAgentStatus()
  const marker = readLivenessMarker()
  if (proc.state === 'stopped') {
    // Control panel: user turned the agent off (2026-07-09). HIGHEST
    // precedence -- must beat a still-fresh .agent-live marker below: the leaf
    // was just killed, but the marker FILE keeps its last timestamp inside
    // isMarkerFresh()'s window for a while, so without this a just-stopped
    // agent would read back 'live'. main.cjs's stopAgent() stamps 'stopped'.
    return { state: 'stopped', code: null, detail: null, lastHeartbeat: marker ? marker.lastHeartbeat : null }
  }
  if (proc.state === 'failed') {
    return { state: 'failed', code: proc.code || 'unknown', detail: proc.detail, lastHeartbeat: marker ? marker.lastHeartbeat : null }
  }
  if (isMarkerFresh(marker)) {
    return { state: 'live', code: null, detail: null, lastHeartbeat: marker.lastHeartbeat }
  }
  if (proc.state === 'connecting') {
    const connectingSince = Date.parse(proc.since)
    if (Number.isFinite(connectingSince) && Date.now() - connectingSince > TIMEOUT_MS) {
      return {
        state: 'failed',
        code: 'timeout',
        detail: `agent did not reach a confirmed live state within ${TIMEOUT_MS}ms of the last spawn attempt`,
        lastHeartbeat: marker ? marker.lastHeartbeat : null,
      }
    }
  }
  return { state: 'connecting', code: null, detail: null, lastHeartbeat: marker ? marker.lastHeartbeat : null }
}

// claude-subscription (4-provider-mode wiring, 2026-07-04): NEW mode, added
// rather than a rename of the existing 'claude' (BYOK) value -- see
// provider-env.cjs's header for why ADD was chosen over renaming
// 'claude'->'claude-byok' (the rename would have rippled into
// onboarding/public/js/{copy,wizard}.js's hardcoded 'claude' tab id and the
// externally-governed copy-source file copy.js is sourced from verbatim --
// out of scope here, and a materially bigger/riskier diff for the same
// outcome).
//
// custom (generic OpenAI-compatible proxy, 2026-07-25 addition): unlike
// chatgpt/ollama (an app-managed local proxy/daemon -- codex-as-api
// in-process, or the bundled Ollama.app; see main.cjs's ensureCodexProxy()/
// ensureOllamaDaemon()), 'custom' points at WHATEVER OpenAI-compatible
// endpoint the user configures -- this app does not launch or vouch for
// that process, so there is no ensureXProxy()-style gate for it in
// main.cjs. Settings-page-only, same precedent as claude-subscription/
// chatgpt/ollama above (no onboarding-wizard tab): its own two extra
// fields (base URL, optional API key) go through the dedicated POST
// /api/agent/custom-provider below, not /api/onboarding/complete or
// /api/agent/model. See provider-env.cjs's buildProviderEnv() 'custom'
// branch for the env-building contract (base URL + model both required,
// fail loud; API key optional with a placeholder fallback).
const PROVIDERS = ['claude', 'claude-cli', 'claude-subscription', 'chatgpt', 'ollama', 'custom']

// The artifact that proves a Claude Code CLI login exists on this machine.
// Checked for EXISTENCE ONLY and never opened (see computeAvailableProviders).
// This is the same file the CLI itself authenticates from when no API key /
// OAuth token / base-url override is present in its env -- which is exactly
// what provider-env.cjs's 'claude-cli' branch arranges.
const CLAUDE_CLI_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json')

// Effort allowlist for POST /api/agent/effort (Mino 07-13 click-test item 2).
// Values become CLAUDE_CODE_EFFORT_LEVEL in the spawned agent's env via
// main.cjs -> run.sh:56; run.sh's own fallback default is 'high'.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']

// Shared pattern-validation for any model id accepted from the client, no
// matter which route (POST /api/agent/model and POST /api/agent/custom-
// provider both write this into MODEL, which becomes `--model <MODEL>`
// argv at spawn -- run.sh). Extracted to one const (custom-provider
// addition, 2026-07-25) so the two routes can never drift apart on what
// counts as a safe model id.
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/

// ROUTER_WIRED (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 3; flipped
// 2026-07-04, 4-provider-mode wiring): all 4 PROVIDERS values now actually
// spawn -- see main.cjs's spawnRealAgentChild() -> provider-env.cjs's
// buildProviderEnv(), which wires 'claude' (BYOK), 'claude-subscription'
// (OAuth token), 'chatgpt' (local codex-as-api proxy, :18080 default), and
// 'ollama' (local daemon, :11434) -- so the "not yet wired" premise this
// flag encoded is gone for every currently-listed provider. Left in place
// (rather than deleted outright) as a single kill-switch: flipping it back
// to `false` would re-block every non-claude provider at both consumers
// below without touching call sites, e.g. if a future non-claude provider
// gets added to PROVIDERS before its own routing actually exists. Two
// consumers:
//   1. Exposed read-only via GET /api/config (see the routerWired field
//      added to that handler below) so the UI can gray out/enable
//      non-claude provider tabs correctly.
//   2. SERVER-SIDE ENFORCEMENT (the important half, security-relevant, not
//      just UX polish) -- rejectIfRouterNotWired() below, called from every
//      endpoint that accepts a provider choice, so a crafted request (or a
//      future settings-page provider switch) can't select a non-wired
//      provider regardless of what the client-side UI shows/hides.
//
// NOT touched by this flip: onboarding/public/js/{copy,wizard}.js still
// only render a 'claude' tab (chatgpt/ollama show as "곧 지원"/coming-soon,
// framed as needing a REAL platform.openai.com / ollama.com cloud key, and
// there is no wizard UI at all yet for claude-subscription's token-paste
// field or chatgpt/ollama's proxy-port/model-name fields) -- see this
// task's own report, flagged as an explicit out-of-scope conflict, not
// silently forced. Today the only way to actually drive
// chatgpt/ollama/claude-subscription onboarding is a direct API POST, not
// the shipped wizard.
const ROUTER_WIRED = true

// Shared 4xx guard for every endpoint that accepts a `provider` field
// (PIECE 3). Returns true (and has already sent the response) if the
// request was rejected; callers must `return` immediately when this
// returns true. Provider name validity (PROVIDERS.includes(provider)) is a
// SEPARATE, earlier check at each call site -- this only gates the
// router-capability question, not whether the string is a recognized
// provider at all.
function rejectIfRouterNotWired(res, provider) {
  if (ROUTER_WIRED || provider === 'claude') return false
  sendJson(res, 400, {
    error: `provider "${provider}" is not wired yet -- only "claude" can be selected until the local router ships.`,
    code: 'provider_not_wired',
  })
  return true
}

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

// ── substrate rendering / config+harness seeding (issue #9 PR-3) ────────
// The boot-seed layer (seedConfigFromTemplates / ensureClaudeOnboardingDone
// / renderHarnessFiles / refreshHarnessIfOnboarded / renderAgentSubstrate /
// the harness-failure marker trio) moved VERBATIM into
// onboarding/harness-render.cjs -- same bodies-only shape as routes/*.cjs:
// shared singletons (log, toUnpackedPath, readAgentConfig, ensureConfigDir,
// the CONFIG_DIR target paths) keep exactly one owner HERE and bind once
// via createHarnessRender(ctx). That module must never require this file
// back (require-cycle snapshot hazard, same rule as the route files).
// TDZ-safe at this position: every const in the ctx literal is declared
// above, and the function references are hoisted declarations.
// NOTE for source-text-pinned tests: the BASH_HOOK_PORT / DIET_REMOVED_HOOKS
// migration regexes, the GAUGE_HOOK migration, and the attach-bootstrap.sh /
// sudo-askpass.sh render lines now live in THAT file --
// scripts/test-hooks-port.mjs, test-context-gauge.mjs, and
// test-attach-topology.mjs read its raw source.
const harnessRender = require('./harness-render.cjs').createHarnessRender({
  log, toUnpackedPath, readAgentConfig, ensureConfigDir,
  REPO_ROOT, AGENT_NAME, DATA_HOME, CONFIG_DIR,
  AGENT_CONFIG_PATH, ENV_PATH, MCP_JSON_PATH,
})

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

// The autonomous cycle's own state (which night ran, whether it was stopped by
// the cap, whether the morning brief was delivered). Written by channel.mjs's
// watcher via tmp+rename; read here only. A corrupt or missing file reads as
// "no cycle has ever run", which is the safe direction: the settings page will
// say nothing happened rather than claim a night that it cannot substantiate.
const AUTONOMY_STATE_PATH = path.join(DATA_HOME, '.autonomy-state.json')
function readAutonomyState() {
  try {
    return JSON.parse(fs.readFileSync(AUTONOMY_STATE_PATH, 'utf8'))
  } catch {
    return null
  }
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
  // Atomic (tmp + rename), NOT a plain writeFileSync (red-team 2026-07-13).
  // This file has readers in OTHER processes -- run.sh sources it at spawn, and
  // hooks/stop-reply-guard.mjs reads MODEL out of it to stamp the strike ledger.
  // writeFileSync truncates first, so a reader landing inside that window sees a
  // half-written or empty config. For the hook that means a strike attributed to
  // model '' ; for a spawn it means booting with no MODEL at all. rename(2) is
  // atomic within a filesystem, so a reader sees strictly the old file or
  // strictly the new one.
  const tmp = `${AGENT_CONFIG_PATH}.tmp`
  fs.writeFileSync(tmp, lines.join('\n') + '\n')
  fs.renameSync(tmp, AGENT_CONFIG_PATH)
  return merged
}

// ── mute-strike ledger (read side) ───────────────────────────────────────────
// The WRITE side is hooks/stop-reply-guard.mjs -- it runs in the agent's own
// process tree on every Stop, so it is the only thing positioned to see
// whether the agent actually spoke. This file only reads the ledger and clears
// it on a model swap. Path is duplicated (not imported) because the hook is an
// ESM file spawned by the Claude CLI with no access to this CommonJS module;
// both derive it from the same DATA_HOME constant shape. If DATA_HOME ever
// moves: two CODE sites define this path (the const below, and STRIKES_PATH in
// hooks/stop-reply-guard.mjs). A grep returns a third hit -- this sentence.
const MUTE_STRIKES_PATH = path.join(CONFIG_DIR, '.mute-strikes.json')
// 2 strikes = 4 failed attempts to speak (each strike already contains one
// guard-forced retry) -- matches the original silent-turn incident shape.
// (history: docs/HISTORY.md)
const MUTE_STRIKE_THRESHOLD = 2

function readMuteStrikes() {
  try {
    if (!fs.existsSync(MUTE_STRIKES_PATH)) return {}
    const parsed = JSON.parse(fs.readFileSync(MUTE_STRIKES_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    // Corrupt ledger reads as "no strikes", never as a 500. The cost of a
    // false-negative here is one un-offered revert button; the cost of
    // throwing is a dead settings page.
    console.error('[scheherazade/onboarding] mute-strike ledger unreadable (treating as clean):', err.message)
    return {}
  }
}

function clearMuteStrikes() {
  try {
    if (fs.existsSync(MUTE_STRIKES_PATH)) fs.unlinkSync(MUTE_STRIKES_PATH)
  } catch (err) {
    console.error('[scheherazade/onboarding] could not clear mute-strike ledger:', err.message)
  }
}

// ── unpacked-path mapping for spawned (ELECTRON_RUN_AS_NODE) children ────
// Packaging bugfix: the bundled Claude CLI reads this .mcp.json and spawns
// each server as a child process. A child spawned with ELECTRON_RUN_AS_NODE does NOT get
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
  if (p.includes(marker)) return p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
  // REPO_ROOT itself IS the asar root in a packaged app (path.join(__dirname,
  // '..') = ".../app.asar", no trailing separator) -- the marker above never
  // matches it, so a rendered {AGENT_DIR} would point cycle scripts INSIDE
  // the archive, which bash cannot exec.
  if (p.endsWith(`${path.sep}app.asar`)) return `${p}.unpacked`
  return p
}

// ── channel backend scripts (multichannel, v0.0.18) ─────────────────────
// One MCP server script per messenger. Which one .mcp.json's agent-channel
// entry points at is decided by .agent-config's CHANNEL_BACKEND (default
// discord) -- see activeChannelScriptPath() + ensureMcpJsonAgentName().
// All three scripts expose the IDENTICAL tool surface (reply /
// send_file_to_discord / read_channel_history): the allowlist in
// onboarding/templates/claude-settings.local.json and every PreToolUse
// hook match on those exact tool names, so a backend swap must never
// rename a tool -- even though send_file_to_discord is a Discord-flavored
// name on Slack/Telegram. Renaming = silently unapproved tool + dead hooks.
const CHANNEL_SCRIPT_PATHS = {
  discord: toUnpackedPath(path.join(REPO_ROOT, 'channel.mjs')),
  slack: toUnpackedPath(path.join(REPO_ROOT, 'channel-slack.mjs')),
  telegram: toUnpackedPath(path.join(REPO_ROOT, 'channel-telegram.mjs')),
  // 'local' is the in-app chat window (channel-local.mjs). Unlike the other
  // three its "platform" is a loopback HTTP listener, so it needs no account,
  // no bot application and no token -- which is the entire point: it is the
  // backend a brand-new user can reach the agent through before deciding
  // whether they want a messenger at all.
  local: toUnpackedPath(path.join(REPO_ROOT, 'channel-local.mjs')),
}
const CHANNEL_BACKENDS = Object.keys(CHANNEL_SCRIPT_PATHS)
function activeChannelBackend() {
  const v = String(readAgentConfig().CHANNEL_BACKEND || 'discord').toLowerCase()
  // Unknown value falls back to discord rather than throwing: a hand-edited
  // .agent-config must degrade to the backend that has existed since 0.0.1,
  // not brick the boot path that would let the user fix it.
  return CHANNEL_SCRIPT_PATHS[v] ? v : 'discord'
}
function activeChannelScriptPath() {
  return CHANNEL_SCRIPT_PATHS[activeChannelBackend()]
}
const MEMORY_SERVER_SCRIPT_PATH = toUnpackedPath(path.join(REPO_ROOT, 'memory', 'server.mjs'))
const CALENDAR_SERVER_SCRIPT_PATH = toUnpackedPath(path.join(REPO_ROOT, 'calendar', 'server.mjs'))

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
      // NEVER throw from here. This runs in createOnboardingServer's
      // synchronous prelude, whose only caller wraps boot in a catch that
      // calls fatal() -> app.exit(1). A .mcp.json truncated by a crash mid-
      // write therefore bricked the app permanently: double-click, no window,
      // no dialog, and no in-app way back -- the app that would show the error
      // is the one refusing to start. Preserve the bad file (it is the user's
      // data and may hold hand-added servers) and re-seed beside it.
      const backup = `${MCP_JSON_PATH}.corrupt-${Date.now()}`
      try {
        fs.renameSync(MCP_JSON_PATH, backup)
        console.error(`[scheherazade/onboarding] .mcp.json was not valid JSON (${err.message}); moved to ${backup} and re-seeding from defaults`)
      } catch (mvErr) {
        console.error(`[scheherazade/onboarding] .mcp.json is not valid JSON (${err.message}) and could not be set aside (${mvErr.message}); re-seeding over it`)
      }
      existing = null
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
  // agent-channel resolves per CHANNEL_BACKEND at CALL time (not module
  // load): this function runs on every boot AND on every channel switch
  // (POST /api/channels/switch calls it before restarting the agent), so
  // the entry always tracks the currently-picked backend.
  const KNOWN_SERVERS = {
    'agent-channel': activeChannelScriptPath(),
    memory: MEMORY_SERVER_SCRIPT_PATH,
    calendar: CALENDAR_SERVER_SCRIPT_PATH,
  }
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
      args: [activeChannelScriptPath()],
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
  // darwin only: the calendar server is osascript + macOS Calendar all the way
  // down (calendar/read.cjs). Registering it on Windows handed the agent a tool
  // that can only ever fail, which is worse than not having one.
  if (!servers['calendar'] && process.platform === 'darwin') {
    servers['calendar'] = {
      command: process.execPath,
      args: [CALENDAR_SERVER_SCRIPT_PATH],
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
    // Atomic, for the same reason writeAgentConfig above is: .mcp.json has a
    // reader in ANOTHER process (the claude CLI at its own spawn) and is
    // rewritten on every boot and every channel switch. A plain writeFileSync
    // truncates first, and a crash inside that window leaves a 0-byte or
    // half-written file -- which is precisely the corrupt-.mcp.json state the
    // read path above now has to recover from. Do not produce it in the first
    // place.
    const tmp = `${MCP_JSON_PATH}.tmp`
    fs.writeFileSync(tmp, nextText)
    fs.renameSync(tmp, MCP_JSON_PATH)
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
// discipline memory/service.mjs uses on every write (its SILENT FIELD-DROP
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
// SEAM: main.cjs's spawnRealAgentChild() calls readDiscordToken() at the
// moment of spawn and injects the result directly into that child's own
// `env: {...}` -- the token must NEVER be written back out to a .env file
// or any other on-disk config.
function storeDiscordTokenVerified(token) {
  return storeProviderKeyVerified('discord-bot', token)
}

function readDiscordToken() {
  return readProviderKey('discord-bot')
}

// ── Slack / Telegram tokens: same safeStorage seam as the Discord token ──
// (multichannel, v0.0.18). Same rule, verbatim: decrypted only at the
// moment of spawn (main.cjs) and injected into that child's own env --
// never written to .env, .agent-config, .mcp.json, or any other on-disk
// plaintext. Slack needs TWO tokens (bot xoxb- for Web API calls, app
// xapp- for the Socket Mode websocket), stored as separate pseudo-providers
// so each gets its own manifest + read-back verify.
function storeSlackBotTokenVerified(token) {
  return storeProviderKeyVerified('slack-bot', token)
}
function storeSlackAppTokenVerified(token) {
  return storeProviderKeyVerified('slack-app', token)
}
function readSlackBotToken() {
  return readProviderKey('slack-bot')
}
function readSlackAppToken() {
  return readProviderKey('slack-app')
}
function storeTelegramTokenVerified(token) {
  return storeProviderKeyVerified('telegram-bot', token)
}
function readTelegramToken() {
  return readProviderKey('telegram-bot')
}

// ── Local liveness ping (chatgpt/ollama, no-secret local-proxy modes) ────
// NON-BLOCKING BY DESIGN: both callers below always return `ok: true`
// regardless of what this reports. chatgpt/ollama route the spawned agent
// to a LOCAL proxy/daemon with no stored user secret at all (provider-env.
// cjs's buildProviderEnv() never reads a stored credential for either
// mode) -- the user may well not have started the proxy/daemon yet at the
// point they click through onboarding Step 1, and that must not block
// setup. `reachable` is purely informational (for whatever UI surfaces it
// later -- see this task's report, wizard.js is out of scope here and does
// not read this field yet).
//
// Node's fetch has NO default timeout. Every validation call below talks to a
// third party during the onboarding wizard, so a captive portal or a
// blackholing corporate proxy left the spinner running forever with no error
// and no cancel, holding the socket for the OS default. 10s is long enough for
// a slow-but-live API and short enough that a wedged network becomes a visible
// failure the user can act on. (Found 2026-08-03.)
const CONNECT_API_TIMEOUT_MS = 10_000

// AbortSignal.timeout() requires no extra dependency (global since Node
// 17.3; this app's bundled Electron/Node is v24) and keeps a firewalled/
// hung local port from stalling the validate response; a plain ECONNREFUSED on an unbound
// localhost port resolves near-instantly on its own, this timeout only
// guards the non-instant edge cases.
const LOCAL_LIVENESS_TIMEOUT_MS = 1500

async function checkLocalLiveness(url, label) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(LOCAL_LIVENESS_TIMEOUT_MS) })
    // Any HTTP response at all (2xx/4xx/5xx alike) proves something is
    // listening on the port -- that is all "reachable" claims here, not
    // that it is correctly configured or actually the right process.
    return { ok: true, reachable: true, detail: `${label} is reachable at ${url}` }
  } catch (err) {
    // Connection refused / timeout -- NOT a validation failure. Informational.
    return {
      ok: true,
      reachable: false,
      detail: `${label} not detected at ${url} yet -- you can start it after finishing setup (${err.message})`,
    }
  }
}

// ── BYOK live validation pings ───────────────────────────────────────────
// `opts.proxyPort` is optional (only 'chatgpt' consults it) -- lets a future
// wizard step pass the same custom port field /api/onboarding/complete
// already accepts, without requiring it; defaults to the identical constant
// buildProviderEnv() itself falls back to (provider-env.cjs).
// `opts.baseUrl` is optional (only 'custom' consults it, custom-provider
// addition 2026-07-25) -- the settings page's own POST /api/agent/custom-
// provider is the primary way this gets configured; this route is a
// secondary, defense-in-depth path (see 'custom' branch below).
// Sent alongside `Authorization: Bearer` for a setup-token OAuth credential.
// Both entries and their ORDER are copied from what the real `claude` CLI puts
// on the wire (captured 2026-07-29 against a local server; see the
// claude-subscription branch below). The CLI's full list carries eight more
// feature betas -- interleaved-thinking, context-management and friends --
// deliberately left out: they are about what a conversation may DO, not about
// who is asking, and a validation ping should not inherit a feature list that
// drifts every release. These two are the identity pair.
const CLAUDE_OAUTH_BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20'

async function validateProviderKey(provider, key, opts = {}) {
  // chatgpt/ollama: NO user secret needed at all -- skip the generic
  // empty-key guard below entirely for these two (an empty/untouched "key"
  // input is expected and irrelevant for local-proxy modes) and go straight
  // to the local liveness ping instead of validating anything against an
  // external cloud API. Security/correctness fix (2026-07-04): the previous
  // code validated the pasted value against api.openai.com / ollama.com --
  // wrong on two counts for these modes: (1) misleading, since
  // provider-env.cjs's buildProviderEnv() never sends that pasted value
  // anywhere (chatgpt gets a fixed placeholder key, ollama gets the literal
  // string 'ollama') -- a real OpenAI/ollama.com cloud credential the
  // runtime then silently ignores; (2) it shipped whatever the user typed
  // to an external cloud API for a mode explicitly designed to need no
  // secret and stay fully local.
  if (provider === 'chatgpt') {
    // Validation-time must reject exactly the same proxyPort values
    // spawn-time rejects, and must NEVER build a liveness URL whose host
    // isn't localhost (Codex finding #5 fix, 2026-07-04) -- shared guard,
    // see resolveChatgptProxyPort()'s own header comment (provider-env.cjs).
    const portResult = resolveChatgptProxyPort(opts.proxyPort)
    if (portResult.error) {
      // Non-blocking, consistent with checkLocalLiveness()'s own shape below
      // -- an invalid port is reported as "not reachable", never thrown, and
      // no fetch() is attempted (so no URL is ever built from the bad input).
      return { ok: true, reachable: false, detail: `codex-as-api proxy port is invalid -- ${portResult.error}` }
    }
    return checkLocalLiveness(`http://localhost:${portResult.port}`, 'codex-as-api proxy')
  }
  if (provider === 'ollama') {
    return checkLocalLiveness(OLLAMA_BASE_URL, 'Ollama daemon')
  }
  if (provider === 'custom') {
    // Same "no secret required, ping instead of validate a key" shape as
    // chatgpt/ollama above (custom-provider addition, 2026-07-25) -- except
    // the target is WHATEVER opts.baseUrl names, not a fixed localhost
    // port/URL. resolveCustomBaseUrl is the same single-source-of-truth
    // guard buildProviderEnv()'s spawn-time 'custom' branch uses
    // (provider-env.cjs), so validation-time and spawn-time can never
    // accept a URL the other would reject. This route is not the primary
    // way to configure 'custom' (see POST /api/agent/custom-provider
    // below), but 'custom' being in PROVIDERS makes this generic route
    // reachable too -- so it gets a real branch rather than falling through
    // to the empty-key guard below (which would wrongly reject 'custom's
    // OPTIONAL, often-blank key as an error).
    // ok:FALSE here, unlike the chatgpt invalid-port branch above which
    // returns ok:true. The two are not the same case: for chatgpt, `ok` has
    // no side effect -- it is not in PROVIDERS_REQUIRING_STORED_CREDENTIAL and the validate
    // route has no chatgpt clause, so nothing is ever persisted. For
    // 'custom' this same route DOES persist on ok:true whenever a non-blank
    // key is present (`provider === 'custom' && key && key.trim()`), so
    // ok:true on a URL we KNOW is unusable would store a credential for a
    // config that can never spawn (buildProviderEnv rejects the same URL
    // with not_ready) and report success to the caller. An unusable base URL
    // is a validation failure, not an informational liveness miss -- the
    // ok:true/reachable:false shape is reserved for "well-formed target,
    // nothing listening yet", which is the legitimate not-started-yet case
    // below.
    const urlResult = resolveCustomBaseUrl(opts.baseUrl)
    if (urlResult.error) {
      return { ok: false, reachable: false, reason: `custom base URL is invalid -- ${urlResult.error}` }
    }
    return checkLocalLiveness(urlResult.url, 'custom proxy')
  }

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
    if (provider === 'claude-subscription') {
      // The value here is a `claude setup-token` 1-year OAuth token, NOT an
      // x-api-key, so the 'claude' BYOK branch above cannot be reused: these
      // are two different evaluators on the server side, not two spellings of
      // one header. Verified live 2026-07-29 by sending one deliberately bogus
      // string both ways -- as `Authorization: Bearer` it comes back
      // {"type":"authentication_error","message":"OAuth access token is
      // invalid."}, as `x-api-key` it comes back "invalid x-api-key".
      //
      // The request below is COPIED OFF THE WIRE from the client that is known
      // to work, which is a stronger source than the docs and disagreed with
      // them. Method: point the real CLI at a local capture server
      // (ANTHROPIC_BASE_URL=http://127.0.0.1:PORT, isolated CLAUDE_CONFIG_DIR,
      // a junk CLAUDE_CODE_OAUTH_TOKEN) and read what it actually sends. It
      // sends `POST /v1/messages?beta=true` with `x-app: cli` and an
      // anthropic-beta list LED BY `claude-code-20250219`, then oauth-2025-04-20.
      //
      // MEASURED WITH A REAL TOKEN 2026-07-29, and the measurement is kept here
      // because it corrects this comment's own earlier draft. A live 1-year
      // setup-token was minted and both shapes were sent:
      //   this wire-copied shape                       -> 200
      //   the docs-only shape (no ?beta=true, no x-app,
      //     anthropic-beta: oauth-2025-04-20 alone)    -> 200 ALSO
      // So none of the three extras is load-bearing, and the draft that said
      // the docs-only version "would have rejected every valid token" was
      // describing a risk that measured zero. It is kept as the wire shape
      // anyway -- matching the client that is known to work is still the right
      // default when the alternative is inferring from prose -- but the reason
      // is now conservatism, not a bug that was caught.
      // Keep this in sync with the CLI if that capture is ever redone.
      //
      // DO NOT "IMPROVE" THIS TO /api/oauth/validate. That endpoint exists, it
      // is named exactly like the thing this function does, and it REJECTS a
      // perfectly good setup-token. Measured 2026-07-29 with a live one:
      //   POST /api/oauth/validate -> 403 permission_error "OAuth token does
      //     not meet scope requirement any_of(user:profile, user:office,
      //     user:ccr_inference)"
      //   GET  /api/oauth/profile  -> 403, same shape
      //   POST /v1/messages        -> 200
      // A setup-token carries `user:inference` and nothing else -- visible in
      // the authorize URL the CLI opens (scope=user%3Ainference) and stated
      // outright in a CLI diagnostic string ("env-var and setup-token sessions
      // default to user:inference only"). So the endpoint whose NAME promises
      // validation is the one guaranteed to fail here. Pick the endpoint that
      // matches the token's scope, not the one that matches the verb.
      // (The fail-open rule below already contains this mistake if someone
      // makes it anyway: 403 permission_error is not an authentication_error,
      // so it returns ok:true rather than destroying the credential. That was
      // chosen for the print-once reason, and it happens to cover this too.)
      //
      // WHY /v1/messages AND NOT THE FREE GET: /v1/models was measured with the
      // same live token and also answers 200, so cost is no longer the
      // deciding factor -- it would work. /v1/messages is kept because it
      // exercises the capability the credential is actually stored FOR. A
      // token that authenticates but cannot infer passes /v1/models and fails
      // the first real spawn, which is precisely the silent-failure shape this
      // whole branch exists to end. max_tokens:1 makes the difference one
      // token of output, which is not worth a weaker check.
      // (Superseded follow-up, left visible on purpose: this comment used to
      // promise "if /v1/models also accepts a valid one, move to it and drop
      // the inference entirely". It does accept one. Not moving, for the
      // reason above -- a promise reversed by its own evidence, not forgotten.)
      //
      // FAIL-OPEN, DELIBERATELY, AND THE ASYMMETRY IS THE WHOLE DESIGN. This
      // rejects ONLY on an explicit 401 authentication_error. A network
      // failure, a 5xx, a 429, a permission/scope error, an unrecognised body
      // -- all return ok:true. The reason is specific to this provider and
      // does not generalise from the BYOK branch: a setup-token is PRINT-ONCE
      // (`claude setup-token` persists nothing anywhere, verified 2026-07-29),
      // so a false rejection does not cost the user a retry the way a
      // re-pasteable API key does -- it destroys the credential and forces the
      // entire interactive OAuth flow again. Accepting a bad token instead
      // surfaces at first agent spawn with the upstream's own error. Between
      // those two, stranding someone who did everything right is worse.
      // Own try/catch, not the function-level one below: that handler ends in
      // `{ ok: false, reason: err.message }`, which for THIS provider is the
      // exact false-rejection the paragraph above is written to prevent -- a
      // dropped wifi frame would burn a print-once credential.
      let res
      try {
        res = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
            'x-app': 'cli',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
      } catch {
        return {
          ok: true,
          verified: false,
          detail: '네트워크 문제로 토큰을 확인하지 못했습니다. 설정은 계속 진행됩니다.',
        }
      }
      if (res.ok) return { ok: true }
      if (res.status === 401) {
        const body = await res.json().catch(() => null)
        if (body && body.error && body.error.type === 'authentication_error') {
          return { ok: false, reason: '토큰이 유효하지 않습니다. setup-token을 다시 실행해 주세요.' }
        }
      }
      // Everything else: we could not tell. Say so rather than blocking.
      return { ok: true, verified: false, detail: `토큰을 확인하지 못했습니다 (HTTP ${res.status}). 설정은 계속 진행됩니다.` }
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

  const meRes = await fetch(`${DISCORD_API}/users/@me`, { headers, signal: AbortSignal.timeout(CONNECT_API_TIMEOUT_MS) })
  if (!meRes.ok) {
    return { ok: false, branch: 'invalid_token' }
  }

  const appRes = await fetch(`${DISCORD_API}/oauth2/applications/@me`, { headers, signal: AbortSignal.timeout(CONNECT_API_TIMEOUT_MS) })
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

  const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, { headers, signal: AbortSignal.timeout(CONNECT_API_TIMEOUT_MS) })
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
  const channelsRes = await fetch(`${DISCORD_API}/guilds/${guild.id}/channels`, { headers, signal: AbortSignal.timeout(CONNECT_API_TIMEOUT_MS) })
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
  return { ok: true, guildId: guild.id, guildName: guild.name, channelId: homeChannel.id, channelName: homeChannel.name }
}

// ── Discord reconnect enumeration (IA v0.0.9) ────────────────────────────
// Same 3-check validation as validateDiscordToken above, but NO auto-pick:
// onboarding's "first guild, first text channel" inference assumes a freshly
// created single-server setup (see the flagged comment above) -- a RECONNECT
// user is switching servers/channels on purpose, so the only honest move is
// to enumerate the candidates and let them pick. validateDiscordToken stays
// verbatim for the onboarding path; this is a separate reader, not a rewrite.
//
// fetchImpl is injectable for tests (scripts/test-discord-reconnect.mjs
// drives every branch with fixture responses -- no live Discord API in CI).
// Guild fan-out is capped; the cap is REPORTED (truncated flag), never
// silent (no-silent-caps rule).
const RECONNECT_MAX_GUILDS = 10
async function enumerateDiscordTargets(token, fetchImpl = fetch) {
  if (!token || !token.trim()) return { ok: false, branch: 'invalid_token' }
  const headers = { Authorization: `Bot ${token}` }

  const meRes = await fetchImpl(`${DISCORD_API}/users/@me`, { headers })
  if (!meRes.ok) return { ok: false, branch: 'invalid_token' }

  const appRes = await fetchImpl(`${DISCORD_API}/oauth2/applications/@me`, { headers })
  if (!appRes.ok) return { ok: false, branch: 'invalid_token' }
  const appBody = await appRes.json()
  const flags = appBody.flags || 0
  const hasMessageContentIntent = (flags & GATEWAY_MESSAGE_CONTENT) !== 0 || (flags & GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0
  if (!hasMessageContentIntent) return { ok: false, branch: 'intent_off' }

  const guildsRes = await fetchImpl(`${DISCORD_API}/users/@me/guilds`, { headers })
  if (!guildsRes.ok) throw new Error(`Discord guilds fetch failed: HTTP ${guildsRes.status}`)
  const allGuilds = await guildsRes.json()
  if (!Array.isArray(allGuilds) || allGuilds.length === 0) return { ok: false, branch: 'not_invited' }

  const truncated = allGuilds.length > RECONNECT_MAX_GUILDS
  const guilds = []
  for (const g of allGuilds.slice(0, RECONNECT_MAX_GUILDS)) {
    const channelsRes = await fetchImpl(`${DISCORD_API}/guilds/${g.id}/channels`, { headers })
    if (!channelsRes.ok) {
      throw new Error(`Discord channels fetch failed for guild ${g.id}: HTTP ${channelsRes.status}`)
    }
    const channels = await channelsRes.json()
    const textChannels = (Array.isArray(channels) ? channels : [])
      .filter((c) => c.type === 0)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((c) => ({ id: c.id, name: c.name }))
    guilds.push({ id: g.id, name: g.name, channels: textChannels })
  }
  return { ok: true, guilds, truncated }
}

// ── Telegram / Slack connect enumeration (multichannel, v0.0.18) ─────────
// Same shape/discipline as enumerateDiscordTargets above: fetchImpl
// injectable for tests, branch codes for user-fixable failures, throw on
// unexpected transport errors (fail loud).
const TELEGRAM_API = 'https://api.telegram.org'
async function telegramApi(token, method, params, fetchImpl = fetch) {
  const res = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(CONNECT_API_TIMEOUT_MS),
  })
  // Telegram signals auth failures via HTTP status (401/404) and everything
  // else via body.ok -- normalize both into one bag so callers branch once.
  let body = {}
  try {
    body = await res.json()
  } catch {
    // non-JSON (proxy error page etc.) -- leave body empty; ok stays false
  }
  return { status: res.status, ok: res.ok && body.ok === true, result: body.result, description: body.description || '' }
}

async function enumerateTelegramChats(token, fetchImpl = fetch) {
  if (!token || !token.trim()) return { ok: false, branch: 'invalid_token' }
  const me = await telegramApi(token.trim(), 'getMe', {}, fetchImpl)
  if (me.status === 401 || me.status === 404) return { ok: false, branch: 'invalid_token' }
  if (!me.ok) throw new Error(`Telegram getMe failed: HTTP ${me.status} ${me.description}`)
  // getUpdates long-poll conflicts (HTTP 409) with a RUNNING telegram
  // backend holding its own poll. Its own branch so the UI can say "stop
  // the agent first" instead of a generic failure.
  const upd = await telegramApi(token.trim(), 'getUpdates', { limit: 100, timeout: 0 }, fetchImpl)
  if (upd.status === 409) return { ok: false, branch: 'conflict_running', bot: { username: me.result.username } }
  if (!upd.ok) throw new Error(`Telegram getUpdates failed: HTTP ${upd.status} ${upd.description}`)
  const chats = new Map()
  for (const u of upd.result || []) {
    const msg = u.message || u.edited_message || u.channel_post
    if (!msg || !msg.chat) continue
    const c = msg.chat
    const label = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id)
    chats.set(String(c.id), { id: String(c.id), label, type: c.type })
  }
  // Empty chats is NOT an error: a fresh bot nobody has messaged yet has
  // no updates. The UI turns this into "봇에게 먼저 메시지를 보내 주세요".
  return { ok: true, bot: { username: me.result.username }, chats: [...chats.values()] }
}

const SLACK_API = 'https://slack.com/api'
async function slackApi(token, method, params, fetchImpl = fetch) {
  // form-encoded, NOT JSON: x-www-form-urlencoded is the one format EVERY
  // Slack Web API method accepts;
  // per-method JSON acceptance is a docs matrix we should not be betting
  // the connect flow on. All params this file sends are scalars.
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) form.set(k, String(v))
  const res = await fetchImpl(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
    body: form.toString(),
    signal: AbortSignal.timeout(CONNECT_API_TIMEOUT_MS),
  })
  let body = {}
  try {
    body = await res.json()
  } catch {
    // non-JSON -- ok stays false below
  }
  return { status: res.status, ok: body.ok === true, error: body.error || '', body }
}

async function enumerateSlackChannels(botToken, appToken, fetchImpl = fetch) {
  if (!botToken || !botToken.trim()) return { ok: false, branch: 'invalid_bot_token' }
  if (!appToken || !appToken.trim()) return { ok: false, branch: 'invalid_app_token' }
  const auth = await slackApi(botToken.trim(), 'auth.test', {}, fetchImpl)
  if (!auth.ok) return { ok: false, branch: 'invalid_bot_token', detail: auth.error }
  // apps.connections.open = cheapest "is this xapp token real AND is Socket
  // Mode enabled" probe. The returned wss URL is deliberately unused here --
  // opening the socket is the channel backend's job, not the wizard's.
  const conn = await slackApi(appToken.trim(), 'apps.connections.open', {}, fetchImpl)
  if (!conn.ok) return { ok: false, branch: 'invalid_app_token', detail: conn.error }
  const list = await slackApi(
    botToken.trim(),
    'conversations.list',
    { types: 'public_channel,private_channel', limit: 200, exclude_archived: true },
    fetchImpl
  )
  if (!list.ok) throw new Error(`Slack conversations.list failed: ${list.error}`)
  const channels = (list.body.channels || []).map((c) => ({ id: c.id, name: c.name, isMember: c.is_member === true }))
  return { ok: true, team: auth.body.team || '', botUser: auth.body.user || '', channels }
}

// Per-backend readiness, computed live from the credential store + config
// (never cached): "configured" means switch-ready -- credentials AND a home
// picked. Labels are display-only ride-alongs, same convention as
// HOME_GUILD_NAME on the discord reconnect path.
function channelBackendReadiness() {
  const cfg = readAgentConfig()
  // safeStorage.decryptString THROWS when the ciphertext no longer matches this
  // machine's Safe Storage key -- the Migration Assistant case: the .credentials
  // blobs come across to the new Mac, the Keychain entry does not. Unguarded,
  // that threw out of here and 500'd both GET /api/channels/status and POST
  // /api/channels/switch, so the channels page was dead and the user could not
  // re-connect the channel that would fix it. computeAvailableProviders() in
  // this same file already degrades instead of throwing; this is that asymmetry
  // closed. An unreadable credential is "not configured", which is the truth
  // the UI needs.
  const readOrUnconfigured = (fn) => {
    try {
      return fn()
    } catch (err) {
      log(`channelBackendReadiness: stored credential unreadable (${err.message}) -- reporting NOT configured so the user can re-connect`)
      return null
    }
  }
  return {
    // In-app chat has NOTHING to configure -- the "platform" is the app
    // itself, so it is always switchable. This entry is load-bearing, not
    // decorative: /api/channels/switch reads readiness[backend].configured,
    // and before this entry existed readiness['local'] was undefined, so
    // switching to a backend that was already registered in
    // CHANNEL_SCRIPT_PATHS 500'd on the property read (in-app chat slice 5
    // catch, 2026-07-30).
    local: { configured: true, home: '', detail: '' },
    discord: {
      configured: Boolean(readOrUnconfigured(readDiscordToken) && readHomeChannelId()),
      home: cfg.HOME_CHANNEL_NAME || readHomeChannelId() || '',
      detail: cfg.HOME_GUILD_NAME || '',
    },
    slack: {
      configured: Boolean(readOrUnconfigured(readSlackBotToken) && readOrUnconfigured(readSlackAppToken) && cfg.SLACK_HOME_CHANNEL_ID),
      home: cfg.SLACK_HOME_CHANNEL_NAME || cfg.SLACK_HOME_CHANNEL_ID || '',
      detail: cfg.SLACK_TEAM_NAME || '',
    },
    telegram: {
      configured: Boolean(readOrUnconfigured(readTelegramToken) && cfg.TELEGRAM_HOME_CHAT_ID),
      home: cfg.TELEGRAM_HOME_CHAT_NAME || cfg.TELEGRAM_HOME_CHAT_ID || '',
      detail: cfg.TELEGRAM_BOT_USERNAME || '',
    },
  }
}

// ── memory service bridge (data layer, memory/service.mjs) ───────────────
// Issue #9 PR-1: this used to dynamic-import memory/server.mjs — the MCP
// stdio ENTRYPOINT — for its exports, AND run ad hoc SQL against its cached
// db handle for operations that module never exported (imported_pointers
// upsert/clear, journal-day delete, active-day scan). The data layer now
// lives in memory/service.mjs (the MCP server is a thin adapter over the
// same functions); every memory-touching route below calls its exported
// (args)-only API, the service owns its own singleton connection, and this
// file holds zero SQL and zero imports of memory/server.mjs.
// Still a dynamic import — this file is CJS, the service is ESM — same
// mechanism as before, just pointed at a peer data module, never at the
// MCP entrypoint.
let _memoryServicePromise = null

function getMemoryService() {
  if (!_memoryServicePromise) {
    // service.mjs resolves DB_PATH from process.env at module top-level,
    // once, on first import -- must be set before the dynamic import fires.
    if (!process.env.AGENT_NAME) process.env.AGENT_NAME = AGENT_NAME
    const url = pathToFileURL(path.join(REPO_ROOT, 'memory', 'service.mjs')).href
    _memoryServicePromise = import(url)
  }
  return _memoryServicePromise
}

const CATEGORY_TABLES = ['user_facts', 'open_threads', 'corrections', 'preferences']
const ALL_MEMORY_TABLES = [...CATEGORY_TABLES, 'memory_events']

async function writePersonaPreferences({ tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd }) {
  const service = await getMemoryService()
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
    service.write({ table: 'preferences', data: { key, value, source_session: session } })
  }
}

// Net-change collapse for the session feed: without it, ONE correction row
// can render TWICE -- once "추가됨", once "수정됨", identical preview text,
// because both previews resolve to the row's CURRENT content. The write
// side is innocent: every memory_write logs exactly one audit event, and
// the agent genuinely can insert a row and then update it. The defect is
// the FEED rendering raw audit bookkeeping on a surface whose own title
// promises "이번 세션에서 기억한 것" -- what the session NET-remembered.
// One row = one line: (history: docs/HISTORY.md)
//   - inserted today (whatever followed)             -> one "추가됨"
//   - updated today on a pre-existing row            -> one "수정됨"
//     (update outranks confirm: a recency bump must not mask a content
//     change; the shown timestamp is still the newest event's)
//   - only confirmed today                           -> "확인됨"
//   - inserted AND deleted today                     -> nothing (net no-op)
//   - deleted today (pre-existing row)               -> "삭제됨"
// memory_events itself stays a complete append-only audit log -- this
// collapses the VIEW only. Input must be newest-first; output preserves
// each row's first-appearance (i.e. newest-activity) order.
function collapseSessionEvents(todays) {
  const groups = new Map()
  const order = []
  for (const ev of todays) {
    // row_id-less events can't be attributed to a row, so they never merge.
    const key = ev.row_id == null ? `solo:${ev.id}` : `${ev.table_name}:${ev.row_id}`
    let g = groups.get(key)
    if (!g) {
      g = { newest: ev, hasInsert: false, hasUpdate: false }
      groups.set(key, g)
      order.push(g)
    }
    if (ev.event === 'insert') g.hasInsert = true
    if (ev.event === 'update') g.hasUpdate = true
  }
  const out = []
  for (const g of order) {
    const ev = g.newest
    if (ev.event === 'delete') {
      if (g.hasInsert) continue
      out.push(ev)
      continue
    }
    const netEvent = g.hasInsert ? 'insert' : g.hasUpdate ? 'update' : ev.event
    out.push(netEvent === ev.event ? ev : { ...ev, event: netEvent })
  }
  return out
}

// "이번 세션에서 기억한 것" -- grouped by calendar date of the most recent
// memory_events row (not the free-text `session` column, which callers may
// leave null). Same date-derivation-over-session-string principle this
// fleet already landed on elsewhere (boot-handoff date-only note filter).
async function getSessionEvents() {
  const service = await getMemoryService()
  const { rows } = service.query({ table: 'memory_events' })
  if (rows.length === 0) return { date: null, events: [] }
  const sorted = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const latestDate = sorted[0].at.slice(0, 10)
  const todays = collapseSessionEvents(sorted.filter((r) => r.at.slice(0, 10) === latestDate))

  const resolved = []
  for (const ev of todays) {
    let preview = null
    if (ev.event !== 'delete' && CATEGORY_TABLES.includes(ev.table_name)) {
      try {
        const { rows: rowMatch } = service.query({ table: ev.table_name, filter: { id: ev.row_id } })
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
    // Platform rides along in the same injection. The UI used to be written
    // for macOS only -- "this Mac", "Run claude in Terminal", a Full Disk
    // Access card and a permissions panel that are macOS concepts with no
    // Windows equivalent. Mino hit all of it on the first Windows install
    // (2026-08-03 23:56). The renderer cannot see process.platform, so it
    // gets told. copy.js reads this before it builds any string.
    const injected = html.replace(
      '<head>',
      `<head>\n    <meta name="onboard-token" content="${SERVER_TOKEN}">\n    <meta name="host-platform" content="${process.platform}">`
    )
    res.writeHead(200, { 'Content-Type': MIME[ext] })
    res.end(injected)
    return true
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(resolved).pipe(res)
  return true
}

// ── route dispatch ────────────────────────────────────────────────────────
// ── login shell-out (chatgpt/ollama, 2026-07-07) ─────────────────────────
// In-app trigger for the provider CLIs' own login flows ("로그인 한 번 →
// 알아서 셋업"): POST /api/onboarding/login/:provider spawns `codex login` /
// `ollama signin` on the user's behalf instead of sending them to Terminal.
// No credential ever transits HTTP or gets stored by us -- the CLIs write
// their own artifacts (~/.codex/auth.json / ~/.ollama/id_ed25519, 0600) and
// the provider modes read those directly (placeholder-key design, see
// provider-env.cjs). This server only reports state.
//
// SECURITY ENVELOPE (new spawn surface -- model-divergent review gate
// applies before any commit touching this section):
//   - provider strings are matched against the LOGIN_SPECS allowlist; no
//     request data ever reaches an argv (argv arrays below are FIXED).
//   - binaries resolve ONLY from fixed absolute locations (resolveBin
//     below -- app-managed DATA_HOME/bin + well-known admin-owned install
//     dirs; NO PATH consultation at all, so a poisoned launch PATH cannot
//     pick the binary). A bare name is never handed to spawn.
//   - the request-level localhost-auth gate (Host/Origin/X-Onboard-Token,
//     createOnboardingServer below) already covers these routes: POST and
//     DELETE are mutating methods, so the per-launch token is required.
//   - rejectIfRouterNotWired() guards the start route like every other
//     provider-accepting endpoint.
//   - children are spawned detached (own process group) so timeout/cancel
//     can SIGTERM the whole group (browser-opener grandchildren included),
//     mirroring main.cjs's supervisor spawn/kill pattern.
const LOGIN_TIMEOUT_MS = 180_000 // human browser-OAuth pace; deliberately NOT the 60s agent TIMEOUT_MS
const LOGIN_PROBE_TIMEOUT_MS = 10_000 // `codex login status` fast-path cap

// Allowlist of login flows. `argv` fixed; `probe` = cheap already-logged-in
// check run before spawning a real login child; `artifact` = the file the
// CLI writes on success (completion is exit 0 AND artifact present --
// trusting exit code alone was rejected at design time, spec v0.2).
const LOGIN_SPECS = {
  chatgpt: {
    bin: 'codex',
    argv: ['login'],
    probe: { argv: ['login', 'status'] }, // exit 0 = already logged in (verified: prints "Logged in using ChatGPT")
    artifact: () => path.join(os.homedir(), '.codex', 'auth.json'),
    installHint: 'codex CLI가 없습니다. https://github.com/openai/codex 에서 설치 후 다시 시도해주세요.',
  },
  ollama: {
    bin: 'ollama',
    argv: ['signin'],
    // No `ollama login status` equivalent exists (verified against the CLI
    // 2026-07-07: subcommands are signin/signout only) -- the identity-key
    // heuristic below is the honest best available. It can false-positive
    // on a key that was never linked to an account; the wizard copy keeps
    // the existing "터미널에서 ollama signin" fallback wording for that case.
    probe: null,
    artifact: () => path.join(os.homedir(), '.ollama', 'id_ed25519'),
    installHint: 'Ollama 앱이 설치되어 있지 않습니다. https://ollama.com 에서 설치 후 다시 시도해주세요.',
  },
}

// ── MCP connector OAuth intercept (IA v0.0.9, 춘식3 design + Idea review) ──
// In-app authorization of claude.ai connectors (Gmail/Calendar/Atlassian/…):
// spawn `claude mcp login --no-browser "claude.ai <name>"`, capture the
// authorize URL it prints to stdout, hand it to the UI for the user to open.
// The user never touches a terminal (Mino constraint: non-programmers).
//
// Distinct from LOGIN_SPECS (chatgpt/ollama), which have static keys, fixed
// argv, and a LOCAL artifact. Connectors have dynamic names, a name in argv,
// NO local artifact (approval is stored remotely by claude.ai), and require
// an env scrub: ANTHROPIC_API_KEY suppresses claude.ai connectors, so the
// auth child must run WITHOUT it (child env only -- parent untouched).
//
// LOAD-BEARING CAVEAT: the SOLE suppressor is ANTHROPIC_API_KEY. Verified on
// claude CLI 2.1.208 -- `ANTHROPIC_API_KEY=x claude mcp list` prints
// "connectors are disabled ..."; `ANTHROPIC_BASE_URL=... claude mcp list`
// with NO key still lists them. base_url/proxy alone does NOT suppress. So
// the key-scrub that lets the auth child SEE connectors is the same reason a
// running agent that carries a key CAN'T use them. Per provider-env.cjs each
// non-cli lane sets a key (chatgpt=placeholder, ollama='ollama', claude=real
// BYOK) -> all three suppress; claude-cli injects nothing -> connectors load.
// The verdicts below are right for that reason (the key), not because of the
// proxy. connectorLaneWarning() drives the UI to say so vs a dead button.
const MCP_CONNECTOR_SPEC = {
  argv: (connectorName) => ['mcp', 'login', '--no-browser', `claude.ai ${connectorName}`],
  // Fix #1 (춘식3 counter-pass, Mino 07-14 re-flag): the query string is
  // MANDATORY. The real authorize URL carries `?product_surface=sdk-cli`
  // and WITHOUT it the approval page does not appear, so the regex requires
  // both the query AND that param -- a bare .../mcpsrv_x with no query is a
  // capture MISS, not a match. Origin is pinned to https://claude.ai
  // literally, so a captured string can only ever be a claude.ai authorize
  // endpoint (Idea hardening #3; the child is our own claude, but defense in
  // depth is cheap here).
  urlRegex: /https:\/\/claude\.ai\/api\/organizations\/[\w-]+\/mcp\/start-auth\/mcpsrv_[\w]+\?[^\s]*product_surface=sdk-cli[^\s]*/,
  installHint: 'claude 실행 파일을 찾을 수 없습니다. 앱을 다시 설치해주세요.',
}

// The lanes on which an authorized claude.ai connector will actually load at
// agent runtime. The gate is on the KEY (verified 07-14, see caveat above):
// claude-cli injects no ANTHROPIC_API_KEY -> the CLI falls back to
// subscription OAuth (/login), which loads claude.ai connectors. chatgpt/
// ollama/claude each inject a key (provider-env.cjs) -> keyed suppressor ->
// warn. claude-subscription (setup-token / CLAUDE_CODE_OAUTH_TOKEN) sets no
// key but IS a distinct auth source; whether that token suppresses connectors
// is UNVERIFIED, so it is excluded from the green set rather than promised
// (fail toward honesty). base_url alone is NOT a suppressor.
const CONNECTOR_CAPABLE_LANES = new Set(['claude-cli'])
function connectorLaneWarning(config) {
  const provider = (config && config.PROVIDER) || 'claude-cli'
  if (CONNECTOR_CAPABLE_LANES.has(provider)) return null
  return provider // non-null = the UI shows the "this lane can't use connectors" note, naming the lane
}

// Dynamic-keyed connector login state (names are runtime-discovered, and the
// vocabulary adds a 'url_ready' state login-status.cjs doesn't have, so this
// is a local map rather than that fixed-provider module). Written and read
// only within this file.
const mcpConnectorStatus = {}   // name -> { state, code, detail, since }
const mcpLoginChildren = {}     // name -> ChildProcess (ownership token)
const mcpLoginTimers = {}       // name -> timeout handle
const mcpLoginStarting = {}     // name -> bool (double-spawn race guard, LOGIN #4 pattern)
function setMcpStatus(name, state, code = null, detail = null) {
  mcpConnectorStatus[name] = { state, code, detail, since: new Date().toISOString() }
}
function getMcpStatus(name) {
  return mcpConnectorStatus[name] || { state: 'idle', code: null, detail: null, since: null }
}
function clearMcpLoginChild(name) {
  mcpLoginChildren[name] = null
  if (mcpLoginTimers[name]) { clearTimeout(mcpLoginTimers[name]); mcpLoginTimers[name] = null }
}

// ── in-app `claude setup-token` capture (claude-subscription lane) ─────────
// Single session for the whole server: one user, one app, and two concurrent
// `setup-token` children would race each other for the same localhost
// callback port the CLI opens.
//
// Built LAZILY rather than at module scope because it needs
// resolveClaudeBin, which lives on agentControls -- a per-call value from
// main.cjs, never staticCtx (see the staticCtx comment near the bottom of
// this file). The controls object is stable in practice, but the resolver
// closes over `lastAgentControls` so the binary is resolved fresh at spawn
// time rather than pinned to whichever request happened to construct the
// session first.
//
// The session owns the credential end to end -- capture, validate, store --
// and its status() is the only thing route handlers may return. See
// setup-token-session.cjs's header for why that boundary is drawn in the
// module rather than at each call site.
let setupTokenSession = null
let lastAgentControls = null
function getSetupTokenSession(agentControls) {
  if (agentControls) lastAgentControls = agentControls
  if (!setupTokenSession) {
    setupTokenSession = createSetupTokenSession({
      resolveClaudeBin: () => (
        lastAgentControls && typeof lastAgentControls.resolveClaudeBin === 'function'
          ? lastAgentControls.resolveClaudeBin()
          : null
      ),
      validateProviderKey,
      storeProviderKeyVerified,
      log,
    })
  }
  return setupTokenSession
}

// Parser for `claude mcp list`: real output has a health-check preamble
// line and local servers marked "⏸ Pending approval", not just the doc's two
// states. Line-based match naturally skips the preamble; we keep ONLY
// `claude.ai <name>` rows (the connectors),
// dropping local servers (agent-channel/memory/calendar) and plugin:* rows.
function parseMcpConnectorList(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const m = line.match(/^claude\.ai (.+?):\s+.*?-\s+(.*)$/)
    if (!m) continue
    const name = m[1].trim()
    const tail = m[2]
    const status = /needs? authentication/i.test(tail) ? 'needs_auth'
      : /connected/i.test(tail) ? 'connected'
      : 'unknown'
    out.push({ name, status })
  }
  return out
}

// Which providers have a usable credential/auth artifact RIGHT NOW.
// (post-onboarding multi-provider unlock, Mino 07-13 click-test item 3:
// "인증키 있으면 Model Dropdown에서 셀렉 가능하게"). Rides along on GET
// /api/config as camelCase `availableProviders`, and gates the provider
// field of POST /api/agent/model server-side. Detection mirrors what spawn
// time actually requires: claude/claude-subscription = a stored credential
// (provider-env.cjs reads the same store), chatgpt/ollama = the login
// artifact LOGIN_SPECS itself points at. A keychain read failure logs LOUD
// but degrades to "not available" rather than 500ing the whole config bag.
function computeAvailableProviders() {
  const out = []
  for (const provider of ['claude', 'claude-subscription']) {
    try {
      if (readProviderKey(provider)) out.push(provider)
    } catch (err) {
      console.error(`[scheherazade/onboarding] availableProviders: readProviderKey(${provider}) failed (treating as unavailable):`, err.message)
    }
  }
  // claude-cli: the login the user ALREADY has, reused in place. Detection is
  // EXISTENCE-ONLY, deliberately -- opening this file to validate the token
  // would be precisely the thing the zero-auth promise forbids. An expired
  // login therefore still reads as "available", and the CLI itself reports the
  // failure at spawn in its own voice. That is the correct trade: a false
  // "available" costs one loud spawn error, whereas reading the user's OAuth
  // token to avoid that error costs the promise.
  try {
    if (fs.existsSync(CLAUDE_CLI_CREDENTIALS_PATH)) out.push('claude-cli')
  } catch (err) {
    console.error('[scheherazade/onboarding] availableProviders: claude-cli artifact check failed (treating as unavailable):', err.message)
  }
  for (const provider of LOGIN_PROVIDERS) {
    try {
      if (fs.existsSync(LOGIN_SPECS[provider].artifact())) out.push(provider)
    } catch (err) {
      console.error(`[scheherazade/onboarding] availableProviders: artifact check (${provider}) failed (treating as unavailable):`, err.message)
    }
  }
  // custom (custom-provider addition, 2026-07-25): no login/credential
  // artifact of its own -- available once a base URL has been saved at
  // least once (POST /api/agent/custom-provider is the only writer of
  // CUSTOM_BASE_URL). The API key is optional either way (provider-env.cjs
  // falls back to a placeholder), so its presence is not part of this gate
  // -- see hasStoredCustomApiKey() below for that separate question.
  try {
    if (readAgentConfig().CUSTOM_BASE_URL) out.push('custom')
  } catch (err) {
    console.error('[scheherazade/onboarding] availableProviders: custom-provider config check failed (treating as unavailable):', err.message)
  }
  return out
}

// Boolean-only companion to computeAvailableProviders() above: GET
// /api/config's hasCustomApiKey field proves a custom-provider API key
// exists WITHOUT ever exposing it, same "prove existence, never expose the
// value" contract as GET /api/sudo/config's hasPassword field (custom-
// provider addition, 2026-07-25). Kept as its own function rather than
// folded into computeAvailableProviders() because it answers a DIFFERENT
// question -- credential PRESENCE, not provider AVAILABILITY ('custom' is
// available off the base URL alone, with or without a key, per the comment
// above).
function hasStoredCustomApiKey() {
  try {
    return Boolean(readProviderKey('custom'))
  } catch (err) {
    console.error('[scheherazade/onboarding] hasStoredCustomApiKey: readProviderKey(custom) failed (treating as false):', err.message)
    return false
  }
}

// provider -> live ChildProcess while a login child runs. Also the
// ownership token: only children WE spawned are ever signaled -- see
// cancelProviderLogin(). (Same ownership discipline as main.cjs's proxy
// child handling; on a machine where an external login flow happens to be
// running, we can't and don't touch it.)
const loginChildren = { chatgpt: null, ollama: null }
const loginTimers = { chatgpt: null, ollama: null }
// Double-spawn race guard (Codex security review finding #4, 2026-07-07):
// startProviderLogin's "already running?" check and its child-handle
// assignment are separated by an awaited probe -- two concurrent POSTs
// could both pass the check and spawn two OAuth flows, with only the later
// child still cancellable. This flag is set/checked SYNCHRONOUSLY at entry.
const loginStarting = { chatgpt: false, ollama: false }

// External-binary resolution (hardened per security review). FIXED
// absolute locations ONLY -- NO PATH walk at all: a poisoned launch PATH
// must never pick the binary ("logging does not mitigate execution"), and
// Finder-launched apps get a minimal PATH anyway, so the walk was mostly useless for exactly
// the double-click users this app targets. Order:
//   1. DATA_HOME/bin -- the app-managed dependency dir (the dependency-
//      bootstrap step downloads CLIs here; same trust domain as the app's
//      own data). Residual, documented: a same-uid process can replace
//      these files -- hash verification at bootstrap-download time + a
//      pre-spawn recheck is the planned hardening in the bootstrap step.
//   2. Well-known admin-owned install locations (brew arm64 / brew intel +
//      historical /usr/local) -- fixed absolute paths, not request- or
//      env-controlled.
// A dev box with the CLI in some custom prefix can symlink it into
// DATA_HOME/bin; consumer installs get it there via bootstrap.
function resolveBin(name) {
  // Same FIXED-locations-only posture on both platforms (no PATH walk --
  // the Codex-review reasoning above is platform-independent). Win list
  // (win-port Phase 2, UNVERIFIED on magi-win): DATA_HOME/bin is the
  // app-managed bootstrap dir on both platforms; the Ollama entry is its
  // installer's default user-scope location (harmlessly absent for other
  // names, same shape as probing /opt/homebrew/bin/<name> on mac).
  const fixed = process.platform === 'win32'
    ? [
        path.join(DATA_HOME, 'bin', `${name}.exe`),
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', `${name}.exe`),
      ]
    : [
        path.join(DATA_HOME, 'bin', name),
        `/opt/homebrew/bin/${name}`,
        `/usr/local/bin/${name}`,
      ]
  for (const candidate of fixed) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not here, keep looking
    }
  }
  return null
}

function clearLoginChild(provider) {
  loginChildren[provider] = null
  if (loginTimers[provider]) {
    clearTimeout(loginTimers[provider])
    loginTimers[provider] = null
  }
}

// Fast-path probe: resolves true if the provider is ALREADY logged in and
// no real login child needs to run. Never rejects -- probe failure just
// means "run the real login".
function probeAlreadyLoggedIn(provider, binPath) {
  const spec = LOGIN_SPECS[provider]
  if (!spec.probe) {
    // ollama: identity-key heuristic (see LOGIN_SPECS comment).
    return Promise.resolve(fs.existsSync(spec.artifact()))
  }
  return new Promise((resolve) => {
    execFile(binPath, spec.probe.argv, { timeout: LOGIN_PROBE_TIMEOUT_MS }, (err) => resolve(!err))
  })
}

async function startProviderLogin(provider, { force = false } = {}) {
  if (loginStarting[provider] || loginChildren[provider]) {
    // Idempotent: a login is already starting/in flight; report it rather
    // than double-spawning (two browser tabs fighting over one OAuth flow).
    // loginStarting closes the check-vs-assign race across the awaited
    // probe below (Codex finding #4).
    return
  }
  loginStarting[provider] = true
  try {
    await startProviderLoginLocked(provider, { force })
  } finally {
    // By here either a child handle is set (spawn path) or the flow ended
    // (fast-path/failure) -- loginChildren[] takes over as the in-flight
    // marker, so the starting flag always drops.
    loginStarting[provider] = false
  }
}

async function startProviderLoginLocked(provider, { force }) {
  const spec = LOGIN_SPECS[provider]
  const binPath = resolveBin(spec.bin)
  if (!binPath) {
    setLoginStatus(provider, 'failed', 'cli_missing', spec.installHint)
    return
  }
  // Pre-spawn tamper recheck for app-managed binaries (bootstrap.cjs sha256
  // manifest -- Codex round-3 hardening, landed with the bootstrap step).
  // Non-managed locations (brew dirs) pass through; only a managed file
  // that stopped matching its install-time hash is refused.
  if (!verifyManagedBin(binPath)) {
    setLoginStatus(provider, 'failed', 'unknown', '설치된 실행 파일이 검증에 실패했습니다. 설치 단계를 다시 실행해주세요.')
    return
  }
  // `force` (re-login) skips the probe so the user can switch accounts.
  if (!force && (await probeAlreadyLoggedIn(provider, binPath))) {
    setLoginStatus(provider, 'success', null, spec.probe ? 'already logged in' : 'existing identity key found')
    return
  }

  setLoginStatus(provider, 'running', null, `${spec.bin} ${spec.argv.join(' ')} started -- complete the flow in your browser`)
  log(`login shell-out: spawning ${binPath} ${spec.argv.join(' ')} (provider=${provider}, timeout=${LOGIN_TIMEOUT_MS}ms)`)
  const child = spawn(binPath, spec.argv, {
    detached: true, // own pgroup -> group-SIGTERM reaps browser-opener grandchildren too
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  loginChildren[provider] = child

  let stderrTail = ''
  child.stderr.on('data', (chunk) => {
    // Bounded tail, SERVER-SIDE LOG ONLY (Codex finding #5, 2026-07-07):
    // login-CLI stderr can carry OAuth URLs/device codes; the GET status
    // route is deliberately non-mutating (no token required), so raw child
    // output must never ride the wire in `detail`. Matches this file's
    // existing respondError() convention (log the detail, send the class).
    stderrTail = (stderrTail + chunk.toString()).slice(-400)
  })
  child.stdout.resume() // drain so the child never blocks on a full pipe

  child.on('error', (err) => {
    // spawn-level failure (ENOENT raced away, EACCES, ...) -- close may
    // never fire with a meaningful code.
    if (getLoginStatus(provider).state === 'running') {
      setLoginStatus(provider, 'failed', 'unknown', `spawn failed: ${err.message}`)
    }
    clearLoginChild(provider)
  })

  loginTimers[provider] = setTimeout(() => {
    if (getLoginStatus(provider).state !== 'running') return
    setLoginStatus(provider, 'failed', 'timeout', `login did not complete within ${LOGIN_TIMEOUT_MS / 1000}s`)
    try {
      killTree(child.pid, 'SIGTERM')
    } catch (err) {
      log(`login shell-out: timeout SIGTERM to pgid=${child.pid} failed: ${err.message}`)
    }
  }, LOGIN_TIMEOUT_MS)

  child.on('close', (code) => {
    // Only transition if still 'running' -- timeout/cancel set their state
    // FIRST and then kill, so this handler must not overwrite them.
    if (getLoginStatus(provider).state === 'running') {
      if (code === 0 && fs.existsSync(spec.artifact())) {
        setLoginStatus(provider, 'success', null, 'login completed')
      } else if (code === 0) {
        setLoginStatus(provider, 'failed', 'unknown', 'login finished but no credential was written -- try again')
      } else {
        // Coarse client-facing message only; raw stderr stays log-only
        // (see the stderr rule above).
        setLoginStatus(provider, 'failed', 'exit_nonzero', 'login process exited with an error -- see the app log')
      }
    }
    log(`login shell-out: ${provider} child exited (code=${code}) -> ${getLoginStatus(provider).state}${stderrTail ? ` | stderr tail: ${stderrTail.trim()}` : ''}`)
    clearLoginChild(provider)
  })
}

function cancelProviderLogin(provider) {
  const child = loginChildren[provider]
  if (!child) return // nothing in flight; DELETE is idempotent
  setLoginStatus(provider, 'failed', 'cancelled', 'cancelled by user')
  try {
    killTree(child.pid, 'SIGTERM')
  } catch (err) {
    log(`login shell-out: cancel SIGTERM to pgid=${child.pid} failed: ${err.message}`)
  }
}

// App-quit/fatal cleanup (Codex security review finding #3, 2026-07-07):
// login children are detached (own pgroup), so without this they outlive
// the Electron process -- an orphaned `codex login` could finish its OAuth
// exchange and write credentials after the app (and its timeout/cancel
// supervision) is gone. Called from main.cjs's before-quit AND fatal()
// paths, mirroring killAgentSupervisor()/killCodexProxy().
function killAllLoginChildren(signal = 'SIGTERM') {
  for (const provider of LOGIN_PROVIDERS) {
    const child = loginChildren[provider]
    if (!child) continue
    try {
      killTree(child.pid, signal)
      log(`killAllLoginChildren: sent ${signal} to ${provider} login pgroup (pgid=${child.pid})`)
    } catch (err) {
      log(`killAllLoginChildren: ${signal} to ${provider} pgid=${child.pid} failed (${err.message}) -- likely already gone`)
    }
    loginChildren[provider] = null
  }
  // MCP connector auth children ride the SAME detached-child cleanup (Codex
  // finding #3 class): an orphaned `claude mcp login` could otherwise finish
  // its exchange after the app is gone. Folded here so it shares main.cjs's
  // existing before-quit/fatal wiring rather than needing a second export.
  for (const name of Object.keys(mcpLoginChildren)) {
    const child = mcpLoginChildren[name]
    if (!child) continue
    try {
      killTree(child.pid, signal)
      log(`killAllLoginChildren: sent ${signal} to mcp-connector "${name}" pgroup (pgid=${child.pid})`)
    } catch (err) {
      log(`killAllLoginChildren: ${signal} to mcp "${name}" pgid=${child.pid} failed (${err.message}) -- likely already gone`)
    }
    mcpLoginChildren[name] = null
  }
  // The in-app `claude setup-token` pty is the SAME class again -- a
  // long-lived-credential OAuth login child, and this one additionally holds
  // a localhost /callback listener open. It is not detached, but this
  // function exists precisely because the project does not rely on implicit
  // cleanup for its siblings, and an orphan here could finish an exchange and
  // print a 1-year token into a pty whose owner is gone. Rides the same
  // before-quit/fatal wiring in main.cjs rather than adding a second export.
  killSetupTokenChildOnShutdown()
}

// List the account's claude.ai connectors. Read-only, no token needed. Runs
// `claude mcp list` with ANTHROPIC_API_KEY scrubbed from the CHILD env only
// (the key would suppress the very connectors we're enumerating). resolveBin
// is injected (the bundled/native claude, not http-server's fixed-locations
// resolveBin -- see agentControls.resolveClaudeBin in main.cjs).
function listMcpConnectors(binPath) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY
    execFile(binPath, ['mcp', 'list'], { timeout: 15_000, env: childEnv }, (err, stdout) => {
      // `claude mcp list` exits non-zero if any server is unhealthy, but its
      // stdout still carries the rows we parse -- so we parse stdout
      // regardless of exit code, and only treat a truly empty stdout as a
      // failure. (err is logged, never silently swallowed.)
      if (err) log(`listMcpConnectors: exit ${err.code ?? '?'} (parsing stdout anyway): ${err.message}`)
      resolve(parseMcpConnectorList(stdout || ''))
    })
  })
}

// Start the connector authorize flow: spawn `claude mcp login --no-browser`,
// capture the authorize URL from stdout, expose it via status. Mirrors
// startProviderLoginLocked's shape (double-spawn guard, timeout, detached
// pgroup, coarse client detail + raw stderr to log only).
function startMcpConnectorLogin(name, binPath) {
  if (mcpLoginStarting[name] || mcpLoginChildren[name]) return // idempotent
  mcpLoginStarting[name] = true
  try {
    setMcpStatus(name, 'running', null, `${name} 인증 대기`)
    // Child-only env scrub: the parent's ANTHROPIC_API_KEY is never touched
    // (credentials not modified), but the child must run without it or the
    // connectors are suppressed (verified 07-14).
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY
    const child = spawn(binPath, MCP_CONNECTOR_SPEC.argv(name), {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    })
    mcpLoginChildren[name] = child

    // Fix #2 (춘식3): accumulate stdout across chunks. A per-chunk match
    // would drop the URL when it straddles a chunk boundary. Once captured,
    // keep draining (never re-match) so a late chunk can't overwrite it.
    let capturedUrl = ''
    let stdoutBuf = ''
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString()
      if (capturedUrl) return
      const m = stdoutBuf.match(MCP_CONNECTOR_SPEC.urlRegex)
      if (m) {
        capturedUrl = m[0]
        // The captured string cleared urlRegex, so it is a pinned
        // https://claude.ai authorize endpoint -- verified, not raw child
        // output (raw stderr stays log-only, per the stderr rule above).
        setMcpStatus(name, 'url_ready', null, capturedUrl)
      }
    })
    let stderrTail = ''
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-400) })

    mcpLoginTimers[name] = setTimeout(() => {
      if (getMcpStatus(name).state === 'running') {
        setMcpStatus(name, 'failed', 'timeout', `인증이 ${LOGIN_TIMEOUT_MS / 1000}s 내 시작되지 않았습니다`)
        try { killTree(child.pid, 'SIGTERM') } catch (err) { log(`mcp login timeout SIGTERM (${name}) failed: ${err.message}`) }
      }
    }, LOGIN_TIMEOUT_MS)

    child.on('error', (err) => {
      if (getMcpStatus(name).state === 'running') setMcpStatus(name, 'failed', 'unknown', `spawn failed: ${err.message}`)
      clearMcpLoginChild(name)
    })
    child.on('close', (code) => {
      const st = getMcpStatus(name)
      // url_ready is terminal-good: the deliverable (URL) was captured; the
      // child exiting 0 afterward is expected (--no-browser prints and quits).
      if (st.state === 'running') {
        if (code === 0 && capturedUrl) setMcpStatus(name, 'url_ready', null, capturedUrl)
        else if (code === 0) setMcpStatus(name, 'failed', 'unknown', 'login이 종료됐지만 인증 URL을 캡처하지 못했습니다')
        else setMcpStatus(name, 'failed', 'exit_nonzero', 'login 프로세스가 에러로 종료됐습니다 -- 앱 로그를 확인하세요')
      }
      log(`mcp login: "${name}" exited (code=${code}) -> ${getMcpStatus(name).state}${stderrTail ? ` | stderr: ${stderrTail.trim()}` : ''}`)
      clearMcpLoginChild(name)
    })
  } finally {
    mcpLoginStarting[name] = false
  }
}

// ── API route dispatch (issue #9 PR-2, route grouping) ──────────────────
// The route BODIES that lived here as one ~1,300-line if-chain moved
// VERBATIM into onboarding/routes/*.cjs (9 files, one per functional
// group). Helpers, constants, and every mutable singleton (loginChildren/
// loginTimers/loginStarting, the mcp* maps, askpassToken, the credential
// store, validators, getMemoryService, ...) STAY in this file with exactly
// one owner; the route files bind them ONCE via createRoutes(staticCtx) --
// see the route-table assembly near the end of this module (it must sit
// after every helper declaration; handleApi itself only runs at request
// time, long after module init).
//
// Dispatch contract, same as the old chain:
//   - groups run G1..G9, each group's INTERNAL order exactly as before
//     (no cross-group pattern collision exists -- verified pairwise over
//     all 53 routes before the move);
//   - entry.method === null means "any method" (the login regex does its
//     own method split inside its body);
//   - a matched handler that wrote NO response (the login regex's
//     unsupported-verb fall-through, e.g. PUT) keeps scanning and lands on
//     the same 404 an unmatched path gets;
//   - per-call values (agentControls, onOnboardingComplete) and the
//     asynchronously-written askpassToken ride callCtx, never staticCtx --
//     a copied askpassToken would freeze the pre-listen() null forever
//     (design §5 risk 3), so routes get a live getter.
async function handleApi(req, res, pathname, onOnboardingComplete, agentControls) {
  const callCtx = { agentControls, onOnboardingComplete, getAskpassToken: () => askpassToken }
  for (const entry of API_ROUTES) {
    if (entry.method && entry.method !== req.method) continue
    const m = entry.match(pathname)
    if (!m) continue
    await entry.handler(req, res, callCtx, m)
    if (res.headersSent || res.writableEnded) return
  }
  sendJson(res, 404, { error: `no such API route: ${req.method} ${pathname}` })
}

const ROUTE_TO_FILE = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/chat': 'chat.html',
  '/channels': 'channels.html',
  '/logs': 'logs.html',
  '/memory': 'memory.html',
  '/settings': 'settings.html',
  '/connectors': 'connectors.html',
  '/waiting': 'waiting.html',
}

// createOnboardingServer(onOnboardingComplete) -- onOnboardingComplete is an
// OPTIONAL callback (agent-lifecycle fix, 2026-07-03, PART 1) invoked
// synchronously, exactly once per successful /api/discord/validate, right
// after ONBOARDING_COMPLETE flips to '1' and before that request's response
// is sent. main.cjs passes spawnRealAgentChild here so a fresh-onboarding
// user's agent starts immediately instead of waiting for the next app
// launch. Optional (not required) so this file stays independently
// testable/requireable without an Electron main process wired up.
function createOnboardingServer(onOnboardingComplete, agentControls) {
  harnessRender.seedConfigFromTemplates() // first-run only; no-op once CONFIG_DIR has real files
  ensureMcpJsonAgentName() // correctness fix applied every boot, independent of wizard progress
  harnessRender.ensureClaudeOnboardingDone() // first-ever-claude-run only; no-op once ~/.claude.json already has it
  harnessRender.refreshHarnessIfOnboarded() // every boot: shipped harness fixes reach existing installs (no-op pre-onboarding)
  harnessRender.syncTmuxPortable() // every boot: vendored tmux -> DATA_HOME/bin (attach lane, 극한의 딸깍; no-op when stamp current)

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
          handleApi(req, res, pathname, onOnboardingComplete, agentControls).catch((err) => respondError(err))
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
      // spawn-info discovery file (blocker-2, provenance boundary): a
      // token-FREE {port, spawnInfoUrl} so the agent can locate the loopback
      // spawn-info endpoint for an identity check WITHOUT ever opening the
      // {port,token} sudo-askpass file written just below. Keeping the identity
      // path off the sudo-token surface is the whole point (a prompt-injected
      // "read the endpoint file" must not hand over the sudo token). 0644 --
      // a loopback port is not a secret. Independent try: a sudo-file failure
      // must not blind the identity check, nor the reverse.
      try {
        const spawnInfoPath = path.join(DATA_HOME, '.spawn-info-endpoint.json')
        fs.writeFileSync(
          spawnInfoPath,
          JSON.stringify({ port, spawnInfoUrl: `http://127.0.0.1:${port}/api/agent/spawn-info` }) + '\n',
          { mode: 0o644 }
        )
      } catch (err) {
        console.error('[scheherazade/onboarding] failed to write spawn-info endpoint file (identity check falls back to $MODEL):', err.message)
      }
      // sudo askpass endpoint file (0.1.0 prep): per-boot random token + the
      // random port, 0600, so ONLY this user's processes can find/authorize
      // the askpass fetch. Rotates every app boot; a stale file after quit
      // points at a dead port (curl fails loud, nothing served).
      try {
        askpassToken = crypto.randomBytes(32).toString('hex')
        const epPath = path.join(DATA_HOME, '.sudo-askpass-endpoint.json')
        try { fs.unlinkSync(epPath) } catch { /* absent = first boot */ }
        fs.writeFileSync(epPath, JSON.stringify({ port, token: askpassToken }) + '\n', { mode: 0o600 })
      } catch (err) {
        askpassToken = null // fail closed: no token file -> endpoint refuses everything
        console.error('[scheherazade/onboarding] failed to write sudo-askpass endpoint file (sudo -A disabled this boot):', err.message)
      }
      resolve({ server, url })
    })
  })
}

// Model → context cap. Two provenance tiers, labeled honestly in the
// payload (v0.0.22):
//   - claude-cli-table: extracted from the claude CLI 2.1.211 binary's own
//     model table (`"<id>",context:{window:...}` entries) — what the CLI
//     ACTUALLY budgets autocompact against for these ids.
//   - codex-as-api-table: the proxy's model table (openai/codex
//     models.json@6ad0e943, codex-as-api 0.6.3) — the PROXY's real cap.
//     The CLI does not know gpt ids, so its believed window (and therefore
//     the autocompact trigger point) may be SMALLER than this; the gauge's
//     occupancy number is exact either way, only pct is best-effort there.
// Re-verify these pins on every codex-as-api upgrade (see docs/HISTORY.md
// for the upgrade checklist) -- a version bump can silently move the table.
// Unknown model → cap null, UI shows occupancy without a percentage.
function contextCapForModel(model) {
  if (typeof model !== 'string' || !model) return { cap: null, capSource: null }
  const CLAUDE_1M = new Set(['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6'])
  const base = model.replace(/\[1m\]$/, '')
  if (CLAUDE_1M.has(base)) return { cap: 1_000_000, capSource: 'claude-cli-table' }
  if (/^claude-(opus-4-[015]|sonnet-4-[05]|haiku-4-5)/.test(base)) return { cap: 200_000, capSource: 'claude-cli-table' }
  if (/^gpt-5\.6/.test(base)) return { cap: 372_000, capSource: 'codex-as-api-table' }
  if (/^gpt-5\.[245]/.test(base)) return { cap: 272_000, capSource: 'codex-as-api-table' }
  return { cap: null, capSource: null }
}

// ── route-table assembly (issue #9 PR-2) ────────────────────────────────
// Deliberately the LAST thing before module.exports: staticCtx names
// const/let bindings declared all over this file (LOGIN_SPECS,
// MCP_CONNECTOR_SPEC, CATEGORY_TABLES, ...), so building it here -- after
// every declaration -- keeps it free of TDZ ordering traps. handleApi
// (above) reads API_ROUTES at request time only.
//
// staticCtx carries MODULE-SCOPE values only. NOT here, on purpose:
//   - agentControls / onOnboardingComplete -- per handleApi call;
//   - askpassToken -- mutable `let`, written in createOnboardingServer's
//     listen() callback; routes read it live via callCtx.getAskpassToken().
// Route files must NEVER require this file back (a require cycle hands
// them an incomplete exports snapshot); everything flows through here.
// (That rule is also spelled without the call syntax on purpose --
// test-packaging.mjs's require-graph regex reads comments too.)
const staticCtx = {
  // plumbing + shared config I/O
  fs, path, log, sendJson, readJsonBody, readAgentConfig, writeAgentConfig,
  AGENT_NAME, DATA_HOME, CREDENTIALS_DIR,
  // provider / credential surface
  ROUTER_WIRED, PROVIDERS, PROVIDERS_REQUIRING_STORED_CREDENTIAL,
  rejectIfRouterNotWired, computeAvailableProviders, hasStoredCustomApiKey,
  validateProviderKey, storeProviderKeyVerified, readProviderKey,
  resolveCustomBaseUrl, parseCustomProviderJson, MODEL_ID_PATTERN, clearMuteStrikes, readMuteStrikes,
  MUTE_STRIKE_THRESHOLD, EFFORT_LEVELS,
  // channels
  readHomeChannelId, writeEnv, validateDiscordToken, storeDiscordTokenVerified,
  readDiscordToken, enumerateDiscordTargets, activeChannelBackend,
  channelBackendReadiness, readTelegramToken, enumerateTelegramChats,
  telegramApi, storeTelegramTokenVerified, readSlackBotToken, readSlackAppToken,
  enumerateSlackChannels, slackApi, storeSlackBotTokenVerified,
  storeSlackAppTokenVerified, CHANNEL_BACKENDS, ensureMcpJsonAgentName,
  // electron bridge (lazy require, stays testable outside Electron)
  getElectron,
  // login shell-out + dependency bootstrap
  LOGIN_SPECS, LOGIN_PROVIDERS, getLoginStatus, startProviderLogin,
  cancelProviderLogin, BOOTSTRAP_DEPS, getBootstrapStatus, startBootstrap,
  resolveBin, MANAGED_INSTALL_SUPPORTED, MANUAL_INSTALL_PAGES,
  // mcp connectors
  connectorLaneWarning, listMcpConnectors, setMcpStatus, getMcpStatus,
  startMcpConnectorLogin, MCP_CONNECTOR_SPEC,
  // in-app setup-token capture (claude-subscription)
  getSetupTokenSession,
  // agent status / model table
  computeAgentStatus, contextCapForModel,
  // autonomy
  autonomyBudget, autonomyCycle, readAutonomyState,
  // logs / topology / permission probes
  logBuffer, attachTopology, permissionProbes,
  // onboarding-complete side effects + the memory boundary
  writePersonaPreferences, renderAgentSubstrate: harnessRender.renderAgentSubstrate,
  getSessionEvents, getMemoryService, CATEGORY_TABLES,
}

// Group order G1..G11 (G1..G9 = design §1's original move; G10 setup-token
// and G11 chat were born as route files, nothing moved); INTERNAL order
// inside each file preserves the old if-chain order verbatim (memory.cjs:
// the specific /api/memory/* literal blocks stay dispatched BEFORE the
// :table regex).
const API_ROUTES = [
  ...require('./routes/onboarding-meta.cjs').createRoutes(staticCtx), // G1
  ...require('./routes/provider.cjs').createRoutes(staticCtx), // G2
  ...require('./routes/channels.cjs').createRoutes(staticCtx), // G3
  ...require('./routes/mcp-connectors.cjs').createRoutes(staticCtx), // G4
  ...require('./routes/agent-lifecycle.cjs').createRoutes(staticCtx), // G5
  ...require('./routes/autonomy.cjs').createRoutes(staticCtx), // G6
  ...require('./routes/permissions.cjs').createRoutes(staticCtx), // G7
  ...require('./routes/memory.cjs').createRoutes(staticCtx), // G8
  ...require('./routes/settings.cjs').createRoutes(staticCtx), // G9
  ...require('./routes/setup-token.cjs').createRoutes(staticCtx), // G10
  ...require('./routes/chat.cjs').createRoutes(staticCtx), // G11
]

module.exports = {
  createOnboardingServer,
  AGENT_NAME,
  DATA_HOME,
  contextCapForModel,
  readAgentConfig,
  readDiscordToken,
  readHomeChannelId,
  // Exported for main.cjs's RUN_SH_PATH resolution -- same asar/asarUnpack
  // path-mapping problem this file already solved for
  // CHANNEL_SCRIPT_PATH/MEMORY_SERVER_SCRIPT_PATH above, reused as-is
  // rather than re-implemented in main.cjs.
  toUnpackedPath,
  // Exported for main.cjs's spawnRealAgentChild(): needs to read the
  // validated BYOK provider key back out of safeStorage at spawn time to
  // inject ANTHROPIC_API_KEY into the claude child's own env. Never written
  // to any file -- decrypted in-memory only, same as this function's
  // existing callers here (storeProviderKeyVerified's round-trip check,
  // readDiscordToken).
  readProviderKey,
  // Exported for main.cjs's pre-spawn gate and
  // scripts/test-harness-refresh.mjs (pure, no Electron dependency): a
  // failed boot harness refresh must stop the spawn, not just print a line.
  // Kept here rather than in main.cjs because this file owns both
  // DATA_HOME and the render itself.
  readHarnessFailure: harnessRender.readHarnessFailure,
  HARNESS_FAILURE_PATH: harnessRender.HARNESS_FAILURE_PATH,
  refreshHarnessIfOnboarded: harnessRender.refreshHarnessIfOnboarded,
  // Exported for scripts/test-credential-store.mjs (pure, no Electron
  // dependency): getElectron() requires 'electron' lazily precisely so
  // this file stays testable outside an Electron main process, so the
  // harness injects a safeStorage stub and drives the real code --
  // including the two refusal branches (encryption unavailable,
  // round-trip mismatch) that must never leave a key in plaintext.
  storeProviderKeyVerified,
  // Exported for scripts/test-custom-provider-validate.mjs (pure, no
  // Electron dependency): the 'custom' branch returns before any network
  // call, so a plain-node harness can pin the ok:false-on-invalid-URL
  // contract without Electron or a live proxy.
  validateProviderKey,
  // Exported for testability (pure functions, no Electron dependency --
  // see this file's own getElectron() comment): a plain-node test harness
  // can exercise the pid-liveness gate directly without spinning up
  // Electron.
  isMarkerFresh,
  readLivenessMarker,
  computeAgentStatus,
  // Exported for scripts/test-session-feed.mjs (pure function, no db): the
  // net-change collapse is attackable without spinning up Electron or a
  // memory db.
  collapseSessionEvents,
  // Exported for scripts/test-discord-reconnect.mjs (fetchImpl-injectable):
  // every branch (3-check failures, truncation, channel filtering) runs
  // against fixtures, never the live Discord API.
  enumerateDiscordTargets,
  // Exported for scripts/test-mcp-connector.mjs (pure functions, no spawn):
  // the list parser (against real captured output), the mandatory-query URL
  // regex, and the lane-capability gate.
  parseMcpConnectorList,
  MCP_CONNECTOR_SPEC,
  connectorLaneWarning,
  isPidAlive,
  // Exported for testability/tuning visibility (plain values/consts, no
  // Electron dependency): safe for a test harness (or a future
  // settings-page capability check) to read directly.
  TIMEOUT_MS,
  ROUTER_WIRED,
  // Login shell-out: same testability rationale as the two above -- plain
  // const, no Electron dependency. resolveBin exported for the test
  // harness and any future in-repo consumer (main.cjs's proxy went
  // in-process and no longer resolves a binary); killAllLoginChildren is
  // main.cjs's quit/fatal cleanup hook.
  LOGIN_TIMEOUT_MS,
  resolveBin,
  killAllLoginChildren,
  // Multichannel: backend resolution + per-backend credential readers for
  // main.cjs's spawn-time env injection (same seam as readDiscordToken
  // above), plus fetchImpl-injectable enumerators for
  // scripts/test-channel-connect.mjs (pure, no Electron dependency).
  activeChannelBackend,
  // Exported so scripts/test-packaging.mjs can DERIVE the list of channel
  // backend scripts it must verify, instead of keeping its own copy. It kept
  // a hardcoded array of three until 2026-07-30 and a fourth backend shipped
  // unchecked by the very test that exists to catch an unpackaged channel
  // script. One list, one place to add a backend.
  CHANNEL_SCRIPT_PATHS,
  readSlackBotToken,
  readSlackAppToken,
  readTelegramToken,
  enumerateTelegramChats,
  enumerateSlackChannels,
  channelBackendReadiness,
}
