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
// 4-provider-mode wiring (2026-07-04): single source of truth for "which
// PROVIDERS values need a stored credential before onboarding-complete",
// shared with main.cjs's spawn-time env building -- see provider-env.cjs's
// own header comment. Zero Electron dependency, safe to require from here.
// OLLAMA_BASE_URL added (server-side validate fix, 2026-07-04): reused here
// too so the local-liveness ping below checks the EXACT SAME URL
// buildProviderEnv() actually spawns the agent against, single source of
// truth, not a second hardcoded copy.
// resolveChatgptProxyPort added (Codex finding #5 fix, 2026-07-04): the same
// digits-only + 1-65535 TCP-range guard provider-env.cjs's buildProviderEnv()
// applies at spawn-time (including its CHATGPT_PROXY_DEFAULT_PORT fallback,
// applied internally -- no separate import of that constant needed here
// anymore), now shared so this file's liveness ping below can never drift
// out of sync with it again (see that function's own header comment for the
// concrete SSRF gap this closes).
const { PROVIDERS_REQUIRING_STORED_CREDENTIAL, resolveChatgptProxyPort, OLLAMA_BASE_URL } = require('../provider-env.cjs')
// Login shell-out (2026-07-07): spawn/execFile for `codex login` /
// `ollama signin` children -- the ONLY non-claude binary spawn sites in
// this codebase (verified by repo-wide grep at design time; the chatgpt
// proxy runs IN-PROCESS via the codex-as-api package, no spawn). Rule for
// any FUTURE external-binary spawn (Codex security review, 2026-07-07):
// resolve via resolveBin() below and use a FIXED argv -- the LOGIN_SPECS
// table is the single existing site.
const { spawn, execFile } = require('node:child_process')
const { LOGIN_PROVIDERS, setLoginStatus, getLoginStatus } = require('./login-status.cjs')
// Fresh-Mac dependency bootstrap (2026-07-07): app-managed download/install
// of the codex/ollama CLIs into DATA_HOME/bin + sha256 manifest. See
// bootstrap.cjs's header for the full design (brew-free, 0 admin prompts).
const { BOOTSTRAP_DEPS, startBootstrap, getBootstrapStatus, verifyManagedBin } = require('./bootstrap.cjs')

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
// Pre-approves the tool surface the headless brain needs (Bash/Read/Edit/
// Write/Glob/Grep + both bundled MCP servers' tools) plus
// enableAllProjectMcpServers -- without this, claude's first headless spawn
// (run.sh -> expect -> claude, cwd == CONFIG_DIR) shows an interactive "New
// MCP server found -- approve?" trust prompt with no one to answer it, and
// the expect script's timeout/pattern list doesn't cover that prompt text
// (see run.sh's own EXPECT_EOF block), so the agent hangs forever instead
// of ever reaching channel.mjs. Also carries the SessionStart/Stop hook
// wiring docs/ARCHITECTURE.md's Hook System section describes (memory
// restore + felt/checkpoint nudges) -- see seedSettingsLocal() for the
// {AGENT_DIR} render that makes those hook paths resolve in both the
// packaged and CLI deployments. Deliberately lives under onboarding/
// templates/ and NOT at a real .claude/settings.local.json path: a common
// GLOBAL gitignore rule (`**/.claude/settings.local.json`, e.g. in
// ~/.config/git/ignore) would silently mark a repo-root .claude/ copy as
// untracked -- shipping fine from a dev's working tree tonight but MISSING
// from a fresh clone / CI checkout, silently no-op-ing the seed and
// re-hanging. onboarding/** is already in package.json's build.files, so
// this tracked path ships with no extra build wiring.
const TEMPLATE_SETTINGS_LOCAL_PATH = path.join(REPO_ROOT, 'onboarding', 'templates', 'claude-settings.local.json')

const AGENT_CONFIG_PATH = path.join(CONFIG_DIR, '.agent-config')
const ENV_PATH = path.join(CONFIG_DIR, '.env')
const MCP_JSON_PATH = path.join(CONFIG_DIR, '.mcp.json')
const SETTINGS_LOCAL_PATH = path.join(CONFIG_DIR, '.claude', 'settings.local.json')

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

// Fix D (agent-lifecycle model-divergent review, 2026-07-03): the marker's
// timestamp freshness alone is not enough -- a dead/replaced process's last
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
// provider-env.cjs's header + this task's own report for why ADD was chosen
// over renaming 'claude'->'claude-byok' (the rename would have rippled into
// onboarding/public/js/{copy,wizard}.js's hardcoded 'claude' tab id and the
// externally-governed copy-source file copy.js is sourced from verbatim --
// out of scope here, and a materially bigger/riskier diff for the same
// outcome).
const PROVIDERS = ['claude', 'claude-subscription', 'chatgpt', 'ollama']

// Effort allowlist for POST /api/agent/effort (Mino 07-13 click-test item 2).
// Values become CLAUDE_CODE_EFFORT_LEVEL in the spawned agent's env via
// main.cjs -> run.sh:56; run.sh's own fallback default is 'high'.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']

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

// settings.local.json gets its own seeder (not the plain copy above) for two
// reasons: (1) it nests one level deeper at CONFIG_DIR/.claude/, and (2) its
// hook commands carry a {AGENT_DIR} placeholder that has to be rendered to a
// real, executable hook-script location. {AGENT_DIR} -> toUnpackedPath(
// REPO_ROOT): in a packaged build REPO_ROOT is inside app.asar (read-only,
// and bash cannot exec a script from the asar virtual FS), so it is mapped
// to app.asar.unpacked, where package.json's asarUnpack now ships hooks/**
// as real files. Off-asar (dev / CLI) toUnpackedPath() is a no-op and this
// resolves to the plain repo root. setup.sh's own render() applies the exact
// same {AGENT_DIR} substitution for its CLI-deployment copy, so both seed
// paths produce working absolute hook paths. Seeds only when absent -- never
// clobbers a user's edited hooks/permissions.
function seedSettingsLocal() {
  if (fs.existsSync(SETTINGS_LOCAL_PATH)) return
  if (!fs.existsSync(TEMPLATE_SETTINGS_LOCAL_PATH)) return
  const rendered = fs
    .readFileSync(TEMPLATE_SETTINGS_LOCAL_PATH, 'utf8')
    .split('{AGENT_DIR}')
    .join(toUnpackedPath(REPO_ROOT))
  fs.mkdirSync(path.dirname(SETTINGS_LOCAL_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_LOCAL_PATH, rendered)
  log('seeded settings.local.json into CONFIG_DIR/.claude (hook paths rendered) from bundled template')
}

// Additive-only settings.local.json migration for EXISTING installs.
// seedSettingsLocal() above is seed-if-absent by design (never clobbers user
// edits), which means a hook added to the bundled template after a user's
// first run would never reach them -- the exact "disk updated, config
// frozen" half-update class diagnosed live on Mino's install 2026-07-13.
// This runs on every boot and ONLY appends known-missing entries; it never
// removes or rewrites anything the user has, so hand-edited hooks and
// permissions survive. Currently migrates:
//   - permissions.allow += mcp__agent-channel__send_file_to_discord
//   - hooks.Stop += stop-reply-guard.mjs (silent-text regression detector,
//     added after the agent composed replies without calling the reply tool
//     and looked dead from Discord -- "돌연사" report, 2026-07-13 19:10)
function ensureSettingsLocalAdditions() {
  if (!fs.existsSync(SETTINGS_LOCAL_PATH)) return // fresh install: seeder covers it
  let settings
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_LOCAL_PATH, 'utf8'))
  } catch (err) {
    // Fail-loud but non-fatal: overwriting a corrupt (possibly hand-edited)
    // file would destroy user configuration to fix a hook.
    console.error(`[scheherazade/onboarding] settings.local.json is not valid JSON, skipping additive migration: ${err.message}`)
    return
  }
  // Snapshot BEFORE mutation -- the in-place mutations below alias the parsed
  // object, so a post-mutation snapshot would always equal the result and the
  // write would silently never happen (same aliasing bug class as
  // ensureMcpJsonAgentName's 2026-07-03 fix below).
  const beforeText = JSON.stringify(settings, null, 2)

  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {}
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = []
  const SEND_FILE_PERM = 'mcp__agent-channel__send_file_to_discord'
  if (!settings.permissions.allow.includes(SEND_FILE_PERM)) settings.permissions.allow.push(SEND_FILE_PERM)

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = []
  if (settings.hooks.Stop.length === 0) settings.hooks.Stop.push({ hooks: [] })
  const stopGroup = settings.hooks.Stop[0]
  if (!Array.isArray(stopGroup.hooks)) stopGroup.hooks = []
  const hasReplyGuard = settings.hooks.Stop.some((group) =>
    Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes('stop-reply-guard.mjs')))
  if (!hasReplyGuard) {
    stopGroup.hooks.push({
      type: 'command',
      command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', 'stop-reply-guard.mjs')}`,
    })
  }

  // v0.0.4: negation-check on the reply tool (denial gate -- see the hook's
  // own header). Appends into the existing mcp__agent-channel__reply
  // PreToolUse matcher group when present; creates the group when a user
  // config predates PreToolUse entirely. Same additive-only contract.
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = []
  const NEGATION_HOOK = 'pre-reply-negation-check.mjs'
  const hasNegation = settings.hooks.PreToolUse.some((group) =>
    Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(NEGATION_HOOK)))
  if (!hasNegation) {
    let replyGroup = settings.hooks.PreToolUse.find((g) => g && g.matcher === 'mcp__agent-channel__reply')
    if (!replyGroup) {
      replyGroup = { matcher: 'mcp__agent-channel__reply', hooks: [] }
      settings.hooks.PreToolUse.push(replyGroup)
    }
    if (!Array.isArray(replyGroup.hooks)) replyGroup.hooks = []
    replyGroup.hooks.push({
      type: 'command',
      command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', NEGATION_HOOK)}`,
    })
  }

  const afterText = JSON.stringify(settings, null, 2)
  if (afterText !== beforeText) {
    fs.writeFileSync(SETTINGS_LOCAL_PATH, afterText + '\n')
    log('settings.local.json additive migration applied (send_file permission / stop-reply-guard hook)')
  }
}

// Subagent definitions (v0.0.4 item b): templates/agents/*.md ->
// CONFIG_DIR/.claude/agents/. Per-file seed-if-absent, same contract as the
// other seeds -- a user who edited a definition keeps their edit; NEW
// definitions added in later app versions still arrive because absence is
// checked per file, not per directory.
const TEMPLATE_AGENTS_DIR = path.join(REPO_ROOT, 'onboarding', 'templates', 'agents')
const AGENTS_DIR = path.join(CONFIG_DIR, '.claude', 'agents')

function seedAgentDefinitions() {
  if (!fs.existsSync(TEMPLATE_AGENTS_DIR)) return
  let entries
  try {
    entries = fs.readdirSync(TEMPLATE_AGENTS_DIR).filter((f) => f.endsWith('.md'))
  } catch (err) {
    console.error(`[scheherazade/onboarding] cannot read agent templates dir: ${err.message}`)
    return
  }
  for (const name of entries) {
    const target = path.join(AGENTS_DIR, name)
    if (fs.existsSync(target)) continue
    fs.mkdirSync(AGENTS_DIR, { recursive: true })
    fs.copyFileSync(path.join(TEMPLATE_AGENTS_DIR, name), target)
    log(`seeded subagent definition ${name} into .claude/agents`)
  }
}

function seedConfigFromTemplates() {
  seedConfigFromTemplate(TEMPLATE_MCP_JSON_PATH, MCP_JSON_PATH)
  seedConfigFromTemplate(TEMPLATE_ENV_PATH, ENV_PATH)
  seedConfigFromTemplate(TEMPLATE_AGENT_CONFIG_PATH, AGENT_CONFIG_PATH)
  seedSettingsLocal()
  ensureSettingsLocalAdditions()
  seedAgentDefinitions()
}

// Global Claude Code CLI first-run state -- NOT part of CONFIG_DIR, and NOT
// covered by seedConfigFromTemplate()'s copy-a-template shape. run.sh's
// headless spawn sets no CLAUDE_CONFIG_DIR/HOME override (confirmed:
// neither appears anywhere in run.sh or spawnRealAgentChild()'s env block
// above, unlike e.g. doze-portable's launcher.sh, which isolates
// CLAUDE_CONFIG_DIR specifically because it runs in a fresh container), so
// the spawned `claude` reads/writes the REAL user's own ~/.claude.json. On
// a machine where the person has ever run `claude` interactively before,
// hasCompletedOnboarding (and theme) are already set there and this is a
// no-op. On a genuinely first-ever `claude` invocation (the exact machine
// state setup.sh's own auto-install path can produce -- it `npm install -g
// @anthropic-ai/claude-code`'s the CLI but never runs it interactively),
// EMPIRICALLY REPRODUCED (2026-07-03, self-test with an isolated fresh
// $HOME): the CLI's own first-run "Choose the text style that looks best
// with your terminal" picker hangs the headless expect spawn indefinitely
// -- run.sh's `-re "text style"` pattern matches that prompt's text and
// sends \r, but the picker does not advance on a bare \r (repeated
// exp_continue matches just re-send \r into the same screen for the whole
// 25s window, then expect falls through to `expect eof` with no one left
// to answer). Same failure shape as the settings.local.json gap above, one
// step earlier in the sequence. MERGE-ONLY: never overwrites a real,
// existing ~/.claude.json wholesale (it can hold the user's own separate
// interactive Claude Code state -- OAuth account info, project trust list,
// history -- this only fills in the three keys that gate the first-run
// prompts, and only when they aren't already satisfied).
const REAL_CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json')

function ensureClaudeOnboardingDone() {
  let existing = {}
  if (fs.existsSync(REAL_CLAUDE_JSON_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(REAL_CLAUDE_JSON_PATH, 'utf8'))
    } catch (err) {
      log(`ensureClaudeOnboardingDone: existing ~/.claude.json is not valid JSON, leaving it untouched: ${err.message}`)
      return
    }
    // No-op only when ALL THREE first-run gates are already satisfied. The
    // fullscreen upsell has its OWN gate, independent of onboarding/theme:
    // claude skips the "Try the new fullscreen renderer?" prompt only when
    // (fullscreenUpsellSeenCount ?? 0) >= 3 (verified against the bundled CLI
    // binary: `fullscreenUpsellSeenCount??0)>=uos)return!1`, uos===3), and
    // run.sh's expect list covers none of that prompt's labels ("Yes, try
    // it"/"Not now"). So a merge that set only hasCompletedOnboarding+theme
    // still hung there on a real terminal (the pty self-test happened not to
    // surface it; a genuine TTY did). All three keys required.
    if (existing.hasCompletedOnboarding && existing.theme && (existing.fullscreenUpsellSeenCount ?? 0) >= 3) return
  }
  const merged = { ...existing, hasCompletedOnboarding: true }
  if (!merged.theme) merged.theme = 'dark'
  merged.fullscreenUpsellSeenCount = Math.max(existing.fullscreenUpsellSeenCount ?? 0, 3)
  // Atomic write: temp file in the SAME directory (so rename() is a
  // same-filesystem atomic swap) + rename, never an in-place writeFileSync.
  // A crash or a concurrent external `claude` writing this same file
  // mid-write would otherwise leave a torn/partial ~/.claude.json that
  // claude's own JSON.parse chokes on -- turning a first-run convenience
  // into a boot-fatal corruption. This does not lock against a concurrent
  // writer's lost update (inherent to a read-modify-write merge), but it
  // guarantees the file on disk is always one whole valid JSON or the other.
  const tmp = `${REAL_CLAUDE_JSON_PATH}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n')
  fs.renameSync(tmp, REAL_CLAUDE_JSON_PATH)
  log('seeded hasCompletedOnboarding/theme/fullscreenUpsellSeenCount into ~/.claude.json (first-run claude gates)')
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
  if (p.includes(marker)) return p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
  // REPO_ROOT itself IS the asar root in a packaged app (path.join(__dirname,
  // '..') = ".../app.asar", no trailing separator) -- the marker above never
  // matches it, so a rendered {AGENT_DIR} would point cycle scripts INSIDE
  // the archive, which bash cannot exec. (Codex catch, 2026-07-08.)
  if (p.endsWith(`${path.sep}app.asar`)) return `${p}.unpacked`
  return p
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
// AbortSignal.timeout() requires no extra dependency (global since Node
// 17.3, this app's bundled Electron/Node is v24 -- confirmed via `node
// --version` at fix time) and keeps a firewalled/hung local port from
// stalling the validate response; a plain ECONNREFUSED on an unbound
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
      // NEW mode (4-provider-mode wiring, 2026-07-04): the pasted value here
      // is a `claude setup-token` 1-year OAuth token, not an x-api-key --
      // it is NOT a valid credential for a plain x-api-key REST ping against
      // /v1/messages the way the 'claude' (BYOK) branch above validates, and
      // the LOCKED design explicitly says not to build an interactive-pty
      // `setup-token` driver just to exercise it live. So this is a
      // LOCAL-ONLY check (non-empty) -- the actual proof this credential
      // works is the storeProviderKeyVerified() round-trip the caller does
      // right after this returns {ok:true} (below, /api/byok/validate), plus
      // whatever happens the first time the real agent spawns with it.
      // Already covered by the empty-key guard at the top of this function;
      // this branch exists so 'claude-subscription' doesn't fall through to
      // the "알 수 없는 제공사" (unknown provider) case below.
      return { ok: true }
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
  return { ok: true, guildId: guild.id, guildName: guild.name, channelId: homeChannel.id, channelName: homeChannel.name }
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

// ── agent substrate rendering (app-path parity with setup.sh, 2026-07-08) ─
// setup.sh's fuller bootstrap (CLAUDE.md / ONTOLOGY_GUIDE.md /
// self_persona.md / checkpoint.md / memory dirs) never ran in the packaged
// app path, so a DMG-installed agent booted with NO substrate at all: no
// restore procedure, no dream cycle, no self-doubt loop -- just the bare
// Claude Code default behavior. This renders the same templates setup.sh
// renders, at onboarding-complete time, with the same
// create-if-absent/re-render split setup.sh uses: CLAUDE.md,
// ONTOLOGY_GUIDE.md, and system_prompt.md are harness (always re-rendered);
// self_persona.md and checkpoint.md are the agent's own history (never
// overwritten). {AGENT_DIR} renders to the UNPACKED repo root -- the agent
// invokes cycle scripts with bash by absolute path, and bash cannot exec a
// file inside app.asar (same class as the toUnpackedPath comment above).
// Harness-only render, extracted (07-13) so app boot can re-render harness
// files for EXISTING installs when the app updates -- previously harness
// files only refreshed at onboarding-complete time, so a shipped CLAUDE.md
// fix (e.g. the §10 memory-write rules) never reached installs that had
// already onboarded. Harness files are "always re-rendered" by design (see
// the create-if-absent/re-render split comment above); this just adds a
// second call site with the same semantics. Never touches self_persona.md /
// checkpoint.md.
function renderHarnessFiles({ displayName, tone, primaryTask }) {
  const agentDir = toUnpackedPath(REPO_ROOT)
  const renderHarness = (srcName, dstName) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, srcName), 'utf8')
    const rendered = src
      .replaceAll('{AGENT_DIR}', agentDir)
      .replaceAll('{AGENT_NAME}', AGENT_NAME)
      .replaceAll('{MEMORY_DIR}', DATA_HOME)
    fs.writeFileSync(path.join(DATA_HOME, dstName), rendered)
  }

  renderHarness('CLAUDE.md', 'CLAUDE.md')
  renderHarness('ONTOLOGY_GUIDE.md', 'ONTOLOGY_GUIDE.md')

  const promptSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'onboarding', 'templates', 'agent-system-prompt.md'),
    'utf8'
  )
  const prompt = promptSrc
    .replaceAll('{DISPLAY_NAME}', displayName)
    .replaceAll('{TONE}', tone)
    .replaceAll('{PRIMARY_TASK}', primaryTask || '일상 대화와 기록')
  fs.writeFileSync(path.join(DATA_HOME, 'system_prompt.md'), prompt)
}

// Boot-time harness refresh for already-onboarded installs. Fail-loud in
// log, non-fatal: a broken template must not stop the whole server, but it
// must never be silent either.
function refreshHarnessIfOnboarded() {
  try {
    const config = readAgentConfig()
    if (!config.ONBOARDING_COMPLETE) return false
    renderHarnessFiles({
      displayName: config.DISPLAY_NAME || AGENT_NAME,
      tone: config.TONE || 'casual',
      primaryTask: config.PRIMARY_TASK || '',
    })
    console.error('[scheherazade/onboarding] harness re-rendered at boot (CLAUDE.md / ONTOLOGY_GUIDE.md / system_prompt.md)')
    return true
  } catch (err) {
    console.error('[scheherazade/onboarding] boot harness refresh FAILED (agent runs on stale harness):', err.message)
    return false
  }
}

function renderAgentSubstrate({ displayName, tone, primaryTask }) {
  for (const dir of ['session_notes/.archive', 'journals', 'dreams', 'logs', '.review']) {
    fs.mkdirSync(path.join(DATA_HOME, dir), { recursive: true })
  }

  renderHarnessFiles({ displayName, tone, primaryTask })

  const personaPath = path.join(DATA_HOME, 'self_persona.md')
  if (!fs.existsSync(personaPath)) {
    const today = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(
      personaPath,
      [
        `# ${displayName} -- Self Persona`,
        '',
        '> Identity, not instructions. CLAUDE.md governs behavior; this file',
        '> governs who is behaving. It changes only through the persona reflux',
        '> cycle (see CLAUDE.md §4 and scripts/persona-reflux.sh) -- never edited',
        '> on impulse.',
        '',
        '## Identity',
        '',
        '(Nothing here yet. This fills in from lived sessions, not from invention',
        '-- leave it blank until there is real history to draw from.)',
        '',
        '## Voice',
        '',
        `(How ${displayName} actually talks, once there is enough of a record to say.)`,
        '',
        '## Values',
        '',
        `(What ${displayName} holds to, learned from friction -- not declared up front.)`,
        '',
        '## Evolution Log',
        '',
        `- ${today} -- persona created from template. No lived history yet.`,
        '',
      ].join('\n')
    )
  }

  const checkpointPath = path.join(DATA_HOME, 'checkpoint.md')
  if (!fs.existsSync(checkpointPath)) {
    fs.writeFileSync(
      checkpointPath,
      [
        '# Checkpoint',
        '',
        '> Cross-session handoff. Overwritten on significant state changes -- a',
        '> snapshot, not a log. For history, see session_notes/ and journals/.',
        '',
        '## Status',
        '',
        '(First session has not happened yet.)',
        '',
      ].join('\n')
    )
  }

  log('rendered agent substrate into DATA_HOME (CLAUDE.md, ONTOLOGY_GUIDE.md, system_prompt.md; persona/checkpoint seeded if absent)')
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
  for (const provider of LOGIN_PROVIDERS) {
    try {
      if (fs.existsSync(LOGIN_SPECS[provider].artifact())) out.push(provider)
    } catch (err) {
      console.error(`[scheherazade/onboarding] availableProviders: artifact check (${provider}) failed (treating as unavailable):`, err.message)
    }
  }
  return out
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

// External-binary resolution (hardened per Codex security review finding
// #2 + re-review finding #3, 2026-07-07). FIXED absolute locations ONLY --
// NO PATH walk at all: a poisoned launch PATH must never pick the binary
// (Codex: "logging does not mitigate execution"), and Finder-launched apps
// get a minimal PATH anyway, so the walk was mostly useless for exactly
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
  const fixed = [
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
      process.kill(-child.pid, 'SIGTERM')
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
        // Coarse client-facing message only; the raw exit code + stderr
        // tail go to the server log below (Codex finding #5).
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
    process.kill(-child.pid, 'SIGTERM')
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
      process.kill(-child.pid, signal)
      log(`killAllLoginChildren: sent ${signal} to ${provider} login pgroup (pgid=${child.pid})`)
    } catch (err) {
      log(`killAllLoginChildren: ${signal} to ${provider} pgid=${child.pid} failed (${err.message}) -- likely already gone`)
    }
    loginChildren[provider] = null
  }
}

async function handleApi(req, res, pathname, onOnboardingComplete, agentControls) {
  if (pathname === '/api/config' && req.method === 'GET') {
    // routerWired (PIECE 3, consumer 1): a static capability flag, not
    // proc-state, so it rides along with the rest of the config bag every
    // page here already fetches (see wizard.js/settings.js/memory.js/
    // waiting.js's own `api('/api/config')` calls) rather than needing a
    // new route. camelCase key deliberately, to stay visually distinct from
    // readAgentConfig()'s UPPER_SNAKE_CASE on-disk fields -- this one isn't
    // a stored config value, it's a build-time constant.
    // homeChannelId rides along camelCase like routerWired: it's read from
    // .env (readHomeChannelId), not a readAgentConfig() on-disk field. The
    // memory pane's Discord-open button needs guild+channel as a pair;
    // duplicating the channel id into .agent-config would risk drift.
    // availableProviders rides along camelCase like the two above: computed
    // live (credential store + login artifacts), never a stored field.
    sendJson(res, 200, { ...readAgentConfig(), homeChannelId: readHomeChannelId(), routerWired: ROUTER_WIRED, availableProviders: computeAvailableProviders() })
    return
  }

  if (pathname === '/api/byok/validate' && req.method === 'POST') {
    // proxyPort added (server-side validate fix, 2026-07-04): optional,
    // only consulted for provider === 'chatgpt' (see validateProviderKey).
    // Not sent by today's wizard.js (out of scope here) -- defaults to
    // CHATGPT_PROXY_DEFAULT_PORT when absent, additive/forward-compatible.
    const { provider, key, proxyPort } = await readJsonBody(req)
    if (!PROVIDERS.includes(provider)) {
      sendJson(res, 400, { error: `unknown provider: ${provider}` })
      return
    }
    // PIECE 3 enforcement: reject BEFORE ever validating/storing a key for
    // a non-wired provider -- this is the earliest point a provider choice
    // becomes persisted (storeProviderKeyVerified below), so gating here
    // closes the backdoor at its source rather than only at
    // onboarding-complete.
    if (rejectIfRouterNotWired(res, provider)) return
    const result = await validateProviderKey(provider, key, { proxyPort })
    if (!result.ok) {
      sendJson(res, 200, result)
      return
    }
    // Only store a credential for providers that actually need one on disk
    // (Codex finding #2 fix, 2026-07-04). chatgpt/ollama are no-secret local
    // modes -- buildProviderEnv() never calls readProviderKey() for either
    // (chatgpt gets a fixed placeholder key, ollama gets the literal string
    // 'ollama'; see provider-env.cjs), so storing whatever was pasted/left
    // in the `key` field for them just persists an unused, never-read-back
    // value. PROVIDERS_REQUIRING_STORED_CREDENTIAL is the single source of
    // truth shared with /api/onboarding/complete's own credential gate below.
    if (PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes(provider)) {
      storeProviderKeyVerified(provider, key) // throws (fail loud) on storage failure -> caught by outer handler -> 500
    }
    // Spread `result` rather than a hardcoded `{ ok: true }` (server-side
    // validate fix, 2026-07-04): for 'claude'/'claude-subscription' this is
    // still exactly `{ ok: true }` (unchanged shape), but for 'chatgpt'/
    // 'ollama' it now also carries the informational `reachable`/`detail`
    // local-liveness fields from checkLocalLiveness() -- additive, backward
    // compatible with wizard.js's existing `if (result.ok) {...}` check,
    // which ignores unknown extra fields.
    sendJson(res, 200, result)
    return
  }

  if (pathname === '/api/onboarding/complete' && req.method === 'POST') {
    const body = await readJsonBody(req)
    // proxyPort/model added (4-provider-mode wiring, 2026-07-04): chatgpt's
    // optional local-proxy port and ollama's required local model tag --
    // see provider-env.cjs's buildProviderEnv() for how these feed the
    // spawned child's env.
    const { displayName, provider, tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd, proxyPort, model } = body
    if (!displayName || !provider || !tone) {
      sendJson(res, 400, { error: 'displayName, provider, and tone are required' })
      return
    }
    if (!PROVIDERS.includes(provider)) {
      sendJson(res, 400, { error: `unknown provider: ${provider}` })
      return
    }
    // 4-provider-mode wiring (2026-07-04): ollama has no user secret, but
    // DOES need a real local model tag -- unlike the credential check below
    // (which chatgpt/ollama are exempt from), this is provider-specific and
    // fails loud here rather than letting main.cjs's buildProviderEnv()
    // discover it missing at spawn time (see that function's 'not_ready'
    // guard for ollama, which this mirrors at the earlier, more useful
    // moment).
    if (provider === 'ollama' && (!model || !String(model).trim())) {
      sendJson(res, 400, { error: 'ollama provider requires a model name' })
      return
    }
    // PIECE 3 enforcement, defense-in-depth: /api/byok/validate above
    // already refuses to validate/store a key for a non-wired provider, so
    // this should be unreachable via the normal wizard flow -- but
    // onboarding-complete is a separate crafted-request surface (a client
    // could, in principle, POST here directly with a provider it never
    // actually validated a key for, though the credential check right below
    // would already catch that case too). Belt-and-suspenders: check
    // ROUTER_WIRED here as well so this endpoint alone is never the gap.
    if (rejectIfRouterNotWired(res, provider)) return
    // Onboarding-complete gate (security review, 2026-07-03; relaxed
    // 2026-07-04, 4-provider-mode wiring): completing setup used to accept
    // ANY provider string with no check that its key was ever actually
    // validated. readProviderKey(provider) can only return non-null if
    // storeProviderKeyVerified() previously succeeded for this exact
    // provider -- the only code path that ever writes
    // CREDENTIALS_DIR/${provider}.key.enc is the /api/byok/validate success
    // branch above -- so this single check proves BOTH "the key was
    // validated" AND "a safeStorage credential exists" at once.
    // ONLY applies to PROVIDERS_REQUIRING_STORED_CREDENTIAL (claude,
    // claude-subscription) -- chatgpt/ollama route to a local proxy/daemon
    // with NO user secret at all (provider-env.cjs), so nothing is ever
    // stored for them via /api/byok/validate; gating their completion on a
    // credential that will never exist would deadlock those two providers
    // forever.
    if (PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes(provider)) {
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
    }
    // Codex finding #6 (login shell-out review 2026-07-07; deferred while the
    // bootstrap step was unbuilt, closed now that it shipped): chatgpt/ollama
    // are exempt from the stored-credential gate above BY DESIGN (their auth
    // lives in the CLIs' own files, never in our Keychain) -- which left this
    // endpoint accepting completion for them with a login that never
    // happened. The wizard already gates Next on login success client-side;
    // this is the server-side check for the crafted-POST surface, same
    // belt-and-suspenders posture as the ROUTER_WIRED check above. The gate
    // is the login flow's own success artifact (LOGIN_SPECS), i.e. the
    // durable half of the "exit 0 AND artifact present" bar -- durable
    // across app restarts where the in-memory login-status singleton is not,
    // and it correctly accepts a user whose codex/ollama login predates this
    // app. For ollama this inherits the identity-key heuristic documented at
    // LOGIN_SPECS (can false-positive on a never-linked key); the gate is
    // deliberately no STRICTER than the login step itself claims to be.
    const loginSpec = LOGIN_SPECS[provider]
    if (loginSpec && !fs.existsSync(loginSpec.artifact())) {
      sendJson(res, 400, { error: `${provider} 로그인이 완료되지 않았습니다 -- 1단계에서 로그인을 마친 뒤 설정을 완료해주세요` })
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
      // 4-provider-mode wiring (2026-07-04): written unconditionally (as ''
      // when not applicable) so a provider SWITCH away from chatgpt/ollama
      // doesn't leave a stale port/model value silently readable under the
      // new provider -- writeAgentConfig() merges onto existing fields, so
      // an omitted key here would otherwise never get cleared. MODEL in
      // particular: main.cjs's `config.MODEL || 'claude-opus-4-6'` fallback
      // treats '' the same as unset, so clearing it here on a non-ollama
      // provider is safe and prevents a stale ollama model tag (e.g.
      // "llama3.1:8b") from silently surviving a later switch back to
      // claude/claude-subscription and getting sent as an Anthropic model
      // id (this codebase has no re-onboarding/provider-switch UI today --
      // see this task's report -- but onboarding-complete is a POST
      // endpoint any client could call twice, so this is cheap defense
      // regardless).
      CHATGPT_PROXY_PORT: provider === 'chatgpt' && proxyPort ? String(proxyPort).trim() : '',
      MODEL: provider === 'ollama' ? String(model).trim() : '',
    })
    await writePersonaPreferences({ tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd })
    renderAgentSubstrate({ displayName, tone, primaryTask })
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
    // HOME_GUILD_ID lives in .agent-config (not .env): it's a UI-only value
    // (building the discord.com/channels/<guild>/<channel> URL) -- the agent
    // child process never needs it, and .agent-config is what /api/config
    // already serves, so persisting here exposes it to the client for free.
    writeAgentConfig({ ONBOARDING_STEP: '4', ONBOARDING_COMPLETE: '1', ONBOARDING_COMPLETED_AT: new Date().toISOString(), HOME_GUILD_ID: result.guildId })
    // BUG 1 fix (agent-lifecycle, 2026-07-03): this is the ONLY place
    // ONBOARDING_COMPLETE flips from unset -> '1' outside of an app
    // restart. Before this fix there was no callback into main.cjs here,
    // so spawnRealAgentChild() (which requires ONBOARDING_COMPLETE==='1'
    // to proceed) only ever ran again on the NEXT app launch -- a
    // fresh-onboarding user's agent silently never started until they
    // quit and reopened the app. Fired synchronously, before the response
    // is sent, so by the time the client's poll for Step 5 liveness
    // begins the spawn attempt has already happened (see
    // GET /api/agent/status below).
    if (typeof onOnboardingComplete === 'function') {
      try {
        onOnboardingComplete()
      } catch (err) {
        // Never let a spawn-side failure break the validate response --
        // the token IS valid and IS stored; the agent-status endpoint
        // (not this response) is the fail-loud surface for spawn
        // problems. Still log loud, never swallow silently.
        console.error('[scheherazade/onboarding] onOnboardingComplete callback threw:', err)
      }
    }
    sendJson(res, 200, result)
    return
  }

  if (pathname === '/api/agent/status' && req.method === 'GET') {
    sendJson(res, 200, computeAgentStatus())
    return
  }

  // ── control panel: agent lifecycle (2026-07-09) ─────────────────────────
  // #5 on/off + #4 restart/model-swap. Delegate to main.cjs's serialized
  // lifecycle fns (passed in as agentControls; the pkill-race + intentional-
  // stop handling lives there, see stopAgentAwaited/intentionalStopMode). All
  // are token-gated like every /api route (X-Onboard-Token check above).
  //
  // Fire-and-forget + 202, matching the onboarding-complete pattern above:
  // stop/restart await run.sh stop (up to ~15s worst case), so the client must
  // NOT block on that -- it fires the action and polls GET /api/agent/status
  // (the same poll the Step 5 screen already uses) until state settles
  // (stopped for #5-off, connecting->live for start/restart). Errors surface
  // via agent-status ('failed') or the logged .catch, never a hung request.
  // Overlapping control actions are prevented by the UI (buttons disabled while
  // an action is in flight), so these are NOT serialized/busy-guarded here
  // (Mino 2026-07-09, YAGNI) -- the load-bearing safety is main.cjs awaiting
  // CONFIRMED process death before any respawn.
  if (pathname === '/api/agent/stop' && req.method === 'POST') {
    if (!agentControls || typeof agentControls.stopAgent !== 'function') {
      sendJson(res, 500, { error: 'agent controls not wired' })
      return
    }
    agentControls.stopAgent().catch((err) => console.error('[scheherazade/onboarding] stopAgent threw:', err))
    sendJson(res, 202, { ok: true })
    return
  }
  if (pathname === '/api/agent/start' && req.method === 'POST') {
    if (!agentControls || typeof agentControls.startAgent !== 'function') {
      sendJson(res, 500, { error: 'agent controls not wired' })
      return
    }
    agentControls.startAgent().catch((err) => console.error('[scheherazade/onboarding] startAgent threw:', err))
    sendJson(res, 202, { ok: true })
    return
  }
  if (pathname === '/api/agent/restart' && req.method === 'POST') {
    if (!agentControls || typeof agentControls.restartAgent !== 'function') {
      sendJson(res, 500, { error: 'agent controls not wired' })
      return
    }
    agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] restartAgent threw:', err))
    sendJson(res, 202, { ok: true })
    return
  }
  // POST /api/agent/model {model, provider?} -- #4 model swap: write MODEL
  // (and, when the model lives under a different provider, PROVIDER) to
  // config then restart so the fresh spawn picks it up. Pattern-validated as
  // defense (the value becomes `--model <MODEL>` argv). The provider field
  // is the promised SERVER-SIDE gating half (07-13 multi-provider unlock):
  // allowlist + rejectIfRouterNotWired + computeAvailableProviders, so a
  // crafted request can't switch to a provider with no usable credential.
  // The X-Onboard-Token gate + 127.0.0.1-only bind already bound WHO can
  // reach this route.
  if (pathname === '/api/agent/model' && req.method === 'POST') {
    if (!agentControls || typeof agentControls.restartAgent !== 'function') {
      sendJson(res, 500, { error: 'agent controls not wired' })
      return
    }
    const { model, provider } = await readJsonBody(req)
    const value = typeof model === 'string' ? model.trim() : ''
    if (!value || value.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
      sendJson(res, 400, { error: 'invalid model id' })
      return
    }
    let providerValue = null
    if (provider !== undefined && provider !== null && provider !== '') {
      providerValue = typeof provider === 'string' ? provider.trim() : ''
      if (!PROVIDERS.includes(providerValue)) {
        sendJson(res, 400, { error: `invalid provider: ${providerValue}` })
        return
      }
      if (rejectIfRouterNotWired(res, providerValue)) return
      if (!computeAvailableProviders().includes(providerValue)) {
        sendJson(res, 409, { error: `provider not authenticated: ${providerValue}` })
        return
      }
    }
    writeAgentConfig(providerValue ? { MODEL: value, PROVIDER: providerValue } : { MODEL: value })
    agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] restartAgent (model swap) threw:', err))
    sendJson(res, 202, { ok: true, model: value, ...(providerValue ? { provider: providerValue } : {}) })
    return
  }
  // POST /api/agent/effort {effort} -- Mino 07-13 click-test item 2, same
  // shape as the model route: write EFFORT_LEVEL then restart. main.cjs
  // forwards it into the spawn env only when set; run.sh:56 defaults 'high'.
  if (pathname === '/api/agent/effort' && req.method === 'POST') {
    if (!agentControls || typeof agentControls.restartAgent !== 'function') {
      sendJson(res, 500, { error: 'agent controls not wired' })
      return
    }
    const { effort } = await readJsonBody(req)
    const effortValue = typeof effort === 'string' ? effort.trim() : ''
    if (!EFFORT_LEVELS.includes(effortValue)) {
      sendJson(res, 400, { error: `invalid effort level (expected one of: ${EFFORT_LEVELS.join(', ')})` })
      return
    }
    writeAgentConfig({ EFFORT_LEVEL: effortValue })
    agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] restartAgent (effort swap) threw:', err))
    sendJson(res, 202, { ok: true, effort: effortValue })
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

  // ── login shell-out routes (2026-07-07, see engine above handleApi) ────
  // POST   /api/onboarding/login/:provider        -- start (body: {force?})
  // GET    /api/onboarding/login/:provider/status -- poll (S5_POLL pattern)
  // DELETE /api/onboarding/login/:provider        -- cancel
  const loginMatch = pathname.match(/^\/api\/onboarding\/login\/([a-z-]+)(\/status)?$/)
  if (loginMatch) {
    const provider = loginMatch[1]
    const isStatusPath = Boolean(loginMatch[2])
    // Allowlist FIRST (before even the router gate): only login-capable
    // providers exist here at all. 'claude'/'claude-subscription' are not
    // login-shell-out providers (claude-subscription is an explicit defer,
    // spec v0.2 Q3) -- 400, not 404, to make the contract loud.
    if (!LOGIN_PROVIDERS.includes(provider)) {
      sendJson(res, 400, { error: `unknown login provider: ${provider}` })
      return
    }
    if (isStatusPath && req.method === 'GET') {
      sendJson(res, 200, { provider, ...getLoginStatus(provider) })
      return
    }
    if (!isStatusPath && req.method === 'POST') {
      // Same PIECE 3 enforcement as /api/byok/validate: never start a
      // login flow for a provider the build can't select.
      if (rejectIfRouterNotWired(res, provider)) return
      const body = await readJsonBody(req)
      await startProviderLogin(provider, { force: Boolean(body && body.force) })
      sendJson(res, 200, { provider, ...getLoginStatus(provider) })
      return
    }
    if (!isStatusPath && req.method === 'DELETE') {
      cancelProviderLogin(provider)
      sendJson(res, 200, { provider, ...getLoginStatus(provider) })
      return
    }
    // fall through to the 404 below for anything else (e.g. PUT)
  }

  // ── dependency-bootstrap routes (2026-07-07, see bootstrap.cjs) ────────
  // GET  /api/onboarding/bootstrap/status -- all deps: install-flow state
  //      + `present` (resolveBin says a usable binary already exists, e.g.
  //      brew/dev machines -- the wizard skips the download for those).
  // POST /api/onboarding/bootstrap/:dep   -- start download+install.
  if (pathname === '/api/onboarding/bootstrap/status' && req.method === 'GET') {
    const out = {}
    for (const dep of BOOTSTRAP_DEPS) {
      out[dep] = { ...getBootstrapStatus(dep), present: Boolean(resolveBin(dep)) }
    }
    sendJson(res, 200, out)
    return
  }
  const bootstrapMatch = pathname.match(/^\/api\/onboarding\/bootstrap\/([a-z-]+)$/)
  if (bootstrapMatch && req.method === 'POST') {
    const dep = bootstrapMatch[1]
    if (!BOOTSTRAP_DEPS.includes(dep)) {
      sendJson(res, 400, { error: `unknown bootstrap dependency: ${dep}` })
      return
    }
    // Fire-and-poll like the login flow: the response is the CURRENT
    // status, completion arrives via the status route.
    startBootstrap(dep).catch((err) => {
      console.error(`[scheherazade/onboarding] startBootstrap(${dep}) rejected unexpectedly:`, err)
    })
    sendJson(res, 200, { dep, ...getBootstrapStatus(dep) })
    return
  }

  // ── Full Disk Access onboarding routes (2026-07-07) ────────────────────
  // No official FDA-status API exists (Apple DTS: "attempt the operation
  // and handle the error"), so `granted` is a HEURISTIC probe: read a
  // TCC-protected file. TimeMachine.plist chosen over TCC.db (the latter
  // false-negatives on 700-permission systems). Grant takes effect only
  // after APP RELAUNCH (TCC caches at process launch) -- hence /relaunch.
  if (pathname === '/api/onboarding/fda/status' && req.method === 'GET') {
    let granted = false
    try {
      fs.readFileSync('/Library/Preferences/com.apple.TimeMachine.plist')
      granted = true
    } catch {
      granted = false
    }
    sendJson(res, 200, { granted, heuristic: true })
    return
  }
  if (pathname === '/api/onboarding/fda/open' && req.method === 'POST') {
    const { shell } = getElectron()
    // Legacy pane URL -- still honored on macOS 14/15 per community docs;
    // Sequoia anchors are flaky, so fire twice with a beat between (the
    // documented workaround), harmless when the first one lands.
    const paneUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    await shell.openExternal(paneUrl)
    setTimeout(() => {
      shell.openExternal(paneUrl).catch(() => {})
    }, 1000)
    sendJson(res, 200, { ok: true })
    return
  }
  if (pathname === '/api/onboarding/fda/relaunch' && req.method === 'POST') {
    const { app } = getElectron()
    sendJson(res, 200, { ok: true })
    // Give the response a beat to flush before the process dies.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 300)
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

// createOnboardingServer(onOnboardingComplete) -- onOnboardingComplete is an
// OPTIONAL callback (agent-lifecycle fix, 2026-07-03, PART 1) invoked
// synchronously, exactly once per successful /api/discord/validate, right
// after ONBOARDING_COMPLETE flips to '1' and before that request's response
// is sent. main.cjs passes spawnRealAgentChild here so a fresh-onboarding
// user's agent starts immediately instead of waiting for the next app
// launch. Optional (not required) so this file stays independently
// testable/requireable without an Electron main process wired up.
function createOnboardingServer(onOnboardingComplete, agentControls) {
  seedConfigFromTemplates() // first-run only; no-op once CONFIG_DIR has real files
  ensureMcpJsonAgentName() // correctness fix applied every boot, independent of wizard progress
  ensureClaudeOnboardingDone() // first-ever-claude-run only; no-op once ~/.claude.json already has it
  refreshHarnessIfOnboarded() // every boot: shipped harness fixes reach existing installs (no-op pre-onboarding)

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
      resolve({ server, url })
    })
  })
}

module.exports = {
  createOnboardingServer,
  AGENT_NAME,
  DATA_HOME,
  readAgentConfig,
  readDiscordToken,
  readHomeChannelId,
  // Exported for main.cjs's RUN_SH_PATH resolution (agent-lifecycle fix,
  // 2026-07-03) -- same asar/asarUnpack path-mapping problem this file
  // already solved for CHANNEL_SCRIPT_PATH/MEMORY_SERVER_SCRIPT_PATH above,
  // reused as-is rather than re-implemented in main.cjs.
  toUnpackedPath,
  // Exported for Critical A (agent-lifecycle model-divergent review,
  // 2026-07-03): spawnRealAgentChild() needs to read the validated BYOK
  // provider key back out of safeStorage at spawn time to inject
  // ANTHROPIC_API_KEY into the claude child's own env (a fresh Mac that
  // never ran `claude login` otherwise has no credentials and the CLI
  // hangs at its own auth prompt forever). Never written to any file --
  // decrypted in-memory only, same as this function's existing callers
  // here (storeProviderKeyVerified's round-trip check, readDiscordToken).
  readProviderKey,
  // Exported for Fix D verification (agent-lifecycle model-divergent
  // review, 2026-07-03): pure functions, no Electron dependency (see this
  // file's own getElectron() comment -- "stays requireable/testable
  // outside a running Electron main process"), so a plain-node test
  // harness can exercise the pid-liveness gate directly without spinning
  // up Electron.
  isMarkerFresh,
  readLivenessMarker,
  computeAgentStatus,
  isPidAlive,
  // Exported for testability/tuning visibility (Step 5 onboarding-wiring
  // fix, 2026-07-03, PIECE 2 + PIECE 3) -- same rationale as the Fix D
  // exports above: plain values/consts, no Electron dependency, safe for a
  // test harness (or a future settings-page capability check) to read
  // directly.
  TIMEOUT_MS,
  ROUTER_WIRED,
  // Login shell-out (2026-07-07): same testability rationale as the two
  // above -- plain const, no Electron dependency. resolveBin exported for
  // the test harness and any future in-repo consumer (main.cjs's proxy
  // went in-process and no longer resolves a binary);
  // killAllLoginChildren is main.cjs's quit/fatal cleanup hook (Codex
  // finding #3).
  LOGIN_TIMEOUT_MS,
  resolveBin,
  killAllLoginChildren,
}
