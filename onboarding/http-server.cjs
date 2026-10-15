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
//      ($HOME/Documents/$AGENT_NAME) and the supervisor's own reaper pattern --
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
const { PROVIDERS_REQUIRING_STORED_CREDENTIAL, resolveChatgptProxyPort, resolveCustomBaseUrl, parseCustomProviderJson, OLLAMA_CLOUD_BASE_URL, normalizeOllamaCloudModel, unwrapOAuthKey } = require('../provider-env.cjs')
// External-network validation cap for the ollama.com key check -- a real
// 1-token generation over the internet, so LOCAL_LIVENESS_TIMEOUT_MS's
// loopback-scale value would false-negative on any slow link.
const OLLAMA_CLOUD_TIMEOUT_MS = 15_000
// Login shell-out (2026-07-07): spawn/execFile for `codex login` /
// `ollama signin` children -- the ONLY non-claude binary spawn sites in
// this codebase (verified by repo-wide grep at design time; the chatgpt
// proxy runs IN-PROCESS via the codex-as-api package, no spawn). Rule for
// any FUTURE external-binary spawn (Codex security review, 2026-07-07):
// resolve via resolveBin() below and use a FIXED argv -- the LOGIN_SPECS
// table is the single existing site.
// design-0023 P4: this file no longer spawns anything directly. Every
// external-binary call goes through HOST.spawnBin / HOST.execFileBin
// (onboarding/platform.cjs), which owns the .cmd-needs-a-shell rule, the
// detached/shell incompatibility on Windows, windowsHide, and the mandatory
// 'error' listener -- five hand-copies of the first, three of the last, and
// two call sites (the MCP pair) that had neither.

// Kill a detached child AND its descendants. Negative-pid process-group signals
// do not exist on Windows, so every group-kill below threw straight into its
// catch and killed nothing: detached `codex login` / `claude mcp login`
// children outlived app quit, and an orphaned OAuth flow can still finish its
// exchange and write credentials after the app is gone -- the exact Codex
// finding #3 these call sites exist to prevent. (Found 2026-08-03.)
const { killTree } = require('../proc.cjs')

// ── the host capability table (design-0023 P4) ──────────────────────────
// Every `process.platform === 'darwin'` / `!== 'win32'` test that used to
// live in this file is a lookup on HOST now. The ones this file owned:
// the calendar MCP registration, the safeStorage refusal wording, the
// claude-cli keychain probe, resolveBin's candidate list, the claude
// installer's platform gate, and readCliSessionToken. Each of them had
// Linux as an unnamed else-branch; see onboarding/platform.cjs's header.
const platformTable = require('./platform.cjs')
const HOST = platformTable.host()

// The autonomous cycle's meter and decision logic. The SAME modules the
// channel.mjs watcher enforces against -- the settings page must not compute
// the user's token count a second, subtly different way. One implementation,
// two callers.
const autonomyBudget = require(path.join(__dirname, '..', 'autonomy', 'budget.cjs'))
const autonomyCycle = require(path.join(__dirname, '..', 'autonomy', 'cycle.cjs'))
const { LOGIN_PROVIDERS, setLoginStatus, getLoginStatus } = require('./login-status.cjs')
const logBuffer = require('./log-buffer.cjs') // /api/logs read side; main.cjs owns the write side + sink init
const attachTopology = require('../attach-topology.cjs') // /api/topology read side (0.1.0 prep); no Electron deps, safe here
// In-app `claude setup-token` capture. Pure-JS state machine, and now a
// REFUSING one: the pty it drove came from the top-level node-pty dependency,
// retired 2026-09-07 (design-0023 P2). getSetupTokenSession() injects no
// spawner, so start() answers 'unsupported' and routes/setup-token.cjs points
// the caller at /api/claude-login/* -- the in-app loopback OAuth below, which
// has been the wizard's primary Claude login since 0.2.18, needs no CLI, and
// stores the same 'claude-subscription' credential.
const { createSetupTokenSession, killSetupTokenChildOnShutdown } = require('../setup-token-session.cjs')

// Full-scope OAuth capture for the usage gauge (2026-08-13, the owner: the win
// tester's gauge is stuck on HTTP 429 because setup-token's user:inference
// scope cannot read the usage endpoint). Loopback flow, no native module.
const {
  createUsageOAuthSession, killUsageOAuthChildOnShutdown, refreshUsageCredential, serializeLoginCredential,
  PROVIDER_ID: USAGE_PROVIDER_ID, LOGIN_SCOPES,
} = require('../oauth-usage-session.cjs')

// sudo askpass per-boot token (0.1.0 prep): generated in createOnboardingServer's
// listen callback, checked by GET /api/sudo/password. Module-level on purpose --
// the route handler and the listen callback live in different closures. null =
// fail closed (endpoint refuses everything).
let askpassToken = null
// caption endpoint per-boot token (0.1.7): same contract as askpassToken --
// generated in listen(), written to a 0600 endpoint file, checked
// fail-closed in the route body. Exists so the SLACK channel process (no
// Electron safeStorage, so it cannot read the ollama key itself) can ask
// THIS process for a vision stand-in caption -- the key never leaves here.
let captionToken = null
let usageToken = null // per-boot Bearer for GET /api/agent/usage (.usage-endpoint.json)
// Permission probes, bound to THIS host (design-0023 P4). The route bodies in
// routes/permissions.cjs are deliberately platform-blind -- they call
// probeAll/probeAutomation and serve DEEP_LINKS -- so the platform selection
// happens once, here, where HOST already is. Three bindings:
//   platform     the probe TABLE row to run (darwin/win32/linux). Without it
//                probeAll falls back to process.platform, which is the same
//                answer in production but not in a test that injects a host.
//   safeStorage  the Linux keyring probe's OFFICIAL tier. Electron is
//                required lazily by getElectron() and this file must stay
//                loadable outside it (tools/dev-serve-ui.mjs), so the handle
//                is fetched per call and a failure degrades to the probe's
//                gdbus heuristic tier rather than throwing into a 500.
//   DEEP_LINKS   the host's row, not the darwin constant: a Linux status
//                payload must not carry x-apple.systempreferences: URLs, and
//                POST /api/permissions/open must 400 for a class this host
//                has no pane for -- which off macOS is every class.
const permissionProbesModule = require('./permission-probes.cjs')
function hostElectronProbeDeps() {
  try {
    const { safeStorage } = getElectron()
    return { safeStorage }
  } catch {
    // No Electron (dev server, tests): the probes have honest non-Electron
    // tiers and an absent dep is 'indeterminate', never a fabricated reading.
    return {}
  }
}
const permissionProbes = {
  ...permissionProbesModule,
  DEEP_LINKS: permissionProbesModule.deepLinksFor(HOST.id),
  probeAll: (deps) => permissionProbesModule.probeAll({ platform: HOST.id, ...hostElectronProbeDeps(), ...deps }),
  probeAutomation: (target, deps) => permissionProbesModule.probeAutomation(target, { platform: HOST.id, ...deps }),
  probeSudoVerified: (deps) => permissionProbesModule.probeSudoVerified({ platform: HOST.id, ...deps }),
}
// Fresh-Mac dependency bootstrap (2026-07-07): app-managed download/install
// of the codex/ollama CLIs into DATA_HOME/bin + sha256 manifest. See
// bootstrap.cjs's header for the full design (brew-free, 0 admin prompts).
const { BOOTSTRAP_DEPS, startBootstrap, getBootstrapStatus, verifyManagedBin, MANAGED_INSTALL_SUPPORTED, MANUAL_INSTALL_PAGES } = require('./bootstrap.cjs')

const REPO_ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(__dirname, 'public')
const PUBLIC_DIR_RESOLVED = path.resolve(PUBLIC_DIR)

// design-0029: portable channel temp dirs must not cross profiles.
const PROFILE_NAME = process.env.SERA_PROFILE || '' // design-0029: an explicit data-home override is not profile selection.
const AGENT_NAME = PROFILE_NAME ? `scheherazade-${PROFILE_NAME}` : 'scheherazade'

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
// SCHEHERAZADE_MEMORY_DB env override (used by tests/smoke.mjs) still
// works unchanged.
//
// AGENT_DATA_HOME override: channel.mjs and the supervisor (MEM=) have always
// honored this env var; production is unaffected -- main.cjs passes
// AGENT_DATA_HOME into the env of the children it spawns, never into its
// own process.env, and http-server runs inside main. (history: docs/HISTORY.md)
// 0.2.9 unification: back to the canonical 'Scheherazade' -- the dsh track
// IS the main line now, and main.cjs folds a 0.2-test 'Scheherazade02' home
// into the canonical one at boot (see the fold-in block there). The other
// two fixed resolutions (onboarding/bootstrap.cjs, memory/service.mjs)
// carry the same name -- change all three together.
const { resolveDataHome, resolveMemoryDb } = require('../data-home.cjs')
const DATA_HOME = resolveDataHome({ allowMem: false }) // app process: MEM is the lane->hook spelling, never an input here
const MEMORY_DB_PATH = resolveMemoryDb({ dataHome: DATA_HOME })

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

// ── appearance (Appearance tab, 2026-08-05 the owner "어피어런스 탭 만들고") ──
// User-tunable look knobs (glass gauge / font / accent). The mapping lives
// in public/js/appearance-model.js — required HERE too, so the pre-paint
// <style> the server injects and the browser's live slider apply can never
// drift. Store = plain JSON in DATA_HOME; normalize() makes any on-disk
// junk safe, so reads never throw.
const AppearanceModel = require('./public/js/appearance-model.cjs')
const APPEARANCE_PATH = path.join(CONFIG_DIR, 'appearance.json')

function readAppearance() {
  try {
    return AppearanceModel.normalize(JSON.parse(fs.readFileSync(APPEARANCE_PATH, 'utf8')))
  } catch {
    return AppearanceModel.normalize(null) // defaults
  }
}

function writeAppearance(raw) {
  const cfg = AppearanceModel.normalize(raw)
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(APPEARANCE_PATH, JSON.stringify(cfg, null, 2) + '\n')
  return cfg
}

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
// timestamp at all. Uses the same kill(pid, 0)-probe idiom the supervisor's own
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
      // Sleep/wake false-fail fix (2026-08-15, the owner field report): proc.state
      // never leaves 'connecting' after a SUCCESSFUL boot -- "live" is derived
      // purely from marker freshness above. So this backstop used to fire for
      // an agent that had been live for HOURS whenever the marker merely went
      // stale (macOS system sleep freezes the heartbeat timer; local-model
      // reload after wake can add minutes): since was hours old, the stale
      // read instantly synthesized failed:timeout, and the UI showed a dead
      // session for an agent that was about to heartbeat again. The timeout
      // is only meant for "this spawn attempt NEVER came up". A marker whose
      // lastHeartbeat is newer than `since` is durable proof the agent DID go
      // live after this spawn attempt (survives app restarts and does not
      // depend on poll cadence, unlike an in-memory latch) -- in that case
      // stay 'connecting' (reconnecting, in truth) and let the next fresh
      // heartbeat flip it back to 'live'. A genuinely dead process is still
      // caught by the other paths (main.cjs exit handler / failure markers).
      const lastBeat = marker ? Date.parse(marker.lastHeartbeat) : NaN
      const wentLiveSinceSpawn = Number.isFinite(lastBeat) && lastBeat >= connectingSince
      if (!wentLiveSinceSpawn) {
        return {
          state: 'failed',
          code: 'timeout',
          detail: `agent did not reach a confirmed live state within ${TIMEOUT_MS}ms of the last spawn attempt`,
          lastHeartbeat: marker ? marker.lastHeartbeat : null,
        }
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
const PROVIDERS = ['claude', 'claude-cli', 'claude-subscription', 'chatgpt', 'ollama', 'custom', 'dsh']

// The artifact that proves a Claude Code CLI login exists on this machine.
// Checked for EXISTENCE ONLY and never opened (see computeAvailableProviders).
// This is the same file the CLI itself authenticates from when no API key /
// OAuth token / base-url override is present in its env -- which is exactly
// what provider-env.cjs's 'claude-cli' branch arranges.
const CLAUDE_CLI_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json')

// Effort allowlist for POST /api/agent/effort (the owner 07-13 click-test item 2).
// Values become CLAUDE_CODE_EFFORT_LEVEL in the spawned agent's env via
// main.cjs -> the supervisor's childEnvExtra; its fallback default is 'high'.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// Shared pattern-validation for any model id accepted from the client, no
// matter which route (POST /api/agent/model and POST /api/agent/custom-
// provider both write this into MODEL, which becomes `--model <MODEL>`
// argv at spawn -- the supervisor). Extracted to one const (custom-provider
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

// ── per-launch UI session cookie (page-scrape fix, 2026-08-07) ───────────
// The 08-04 "token on all /api GETs" hardening had a bypass: static HTML
// stayed Host-gated only, and serveStatic injects SERVER_TOKEN into every
// page as a <meta> tag — so any local process could GET a page (Host is
// attacker-chosen on a raw socket) and scrape the token right back out
// (proved in the 0.0.66 vault-roundtrip test, 08-05). Fix: HTML is served
// ONLY to requests carrying this cookie. The cookie is set by GET
// /boot?t=<SERVER_TOKEN> — a URL only the Electron main process (same
// process as this module) and dev-serve-ui's printed URL ever know.
// Navigations can't carry a header, but they do carry cookies; that is the
// whole reason this is a cookie and not the existing header check.
// HttpOnly + SameSite=Strict: page JS never needs the cookie (it reads the
// meta tag), and no cross-site navigation may ride it.
const SESSION_COOKIE_NAME = 'schz-ui-session'
const SESSION_COOKIE = crypto.randomBytes(32).toString('hex')

function hasUiSession(req) {
  const header = req.headers.cookie
  if (typeof header !== 'string' || !header) return false
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue
    if (safeTokenEqual(part.slice(eq + 1).trim(), SESSION_COOKIE)) return true
  }
  return false
}

// The path (incl. token) the Electron window / dev browser must load FIRST.
// `to` is where /boot redirects after setting the cookie.
function bootPathFor(to = '/') {
  return `/boot?t=${SERVER_TOKEN}&to=${encodeURIComponent(to)}`
}

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
// tests/test-hooks-port.mjs, test-context-gauge.mjs, and
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
  // BOM + CRLF tolerant: a user (or a PowerShell Set-Content) editing this file on
  // Windows writes both, and a strict parser then reads ONBOARDING_COMPLETE as
  // '"1"\r' and the app boots without its agent (10-06 on Mino's box).
  const text = fs.readFileSync(AGENT_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')
  const out = {}
  for (const line of text.split(/\r?\n/)) {
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
  // 0.3.7 migrate-on-read: an old install has only the legacy single
  // CHANNEL_BACKEND. Present it in list form too (same one channel, same
  // primary) so every reader can use CHANNEL_BACKENDS; nothing about behaviour
  // changes. migrateChannelBackendsOnDisk() below persists it once at boot.
  if (out.CHANNEL_BACKEND && !out.CHANNEL_BACKENDS) {
    out.CHANNEL_BACKENDS = require('../channel-backends.cjs').parseBackends(out).join(',')
  }
  return out
}

// Persist the list form for a legacy-only config. No-op for fresh installs
// (no CHANNEL_BACKEND at all: default discord needs no key) and for configs
// already carrying the list. Returns true when it wrote.
function migrateChannelBackendsOnDisk() {
  try {
    if (!fs.existsSync(AGENT_CONFIG_PATH)) return false
    const raw = fs.readFileSync(AGENT_CONFIG_PATH, 'utf8')
    if (/^CHANNEL_BACKENDS=/m.test(raw) || !/^CHANNEL_BACKEND=/m.test(raw)) return false
    const cur = readAgentConfig()
    writeAgentConfig(require('../channel-backends.cjs').backendConfigFields(require('../channel-backends.cjs').parseBackends(cur)))
    return true
  } catch (err) {
    log(`channel config migration skipped: ${err.message}`)
    return false
  }
}

function writeAgentConfig(fields) {
  ensureConfigDir()
  const merged = { ...readAgentConfig(), ...fields }
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${shellQuote(v)}`)
  // Atomic (tmp + rename), NOT a plain writeFileSync (red-team 2026-07-13).
  // This file has readers in OTHER processes -- the supervisor parses it at spawn, and
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
// moves: THREE CODE sites define this path (the const below; STRIKES_PATH in
// hooks/stop-reply-guard.mjs; muteStrikesFile in headless-lane.mjs, which
// writes the ledger for the `-p` lane where the guard's exit-2-gated writes
// never fire). A grep returns a fourth hit -- this sentence.
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
// 0.3.7 multi-channel: .agent-config carries CHANNEL_BACKENDS (list) beside the
// legacy CHANNEL_BACKEND (see channel-backends.cjs). "Active" = the PRIMARY: the
// first enabled backend, the one the claude CLI's single agent-channel MCP
// entry points at. Other enabled backends run as companion processes
// (main.cjs). Unknown/absent values still degrade to discord, never throw.
const channelBackendsLib = require('../channel-backends.cjs')
function enabledChannelBackends() {
  return channelBackendsLib.parseBackends(readAgentConfig()).filter((b) => CHANNEL_SCRIPT_PATHS[b])
}
function activeChannelBackend() {
  return enabledChannelBackends()[0] || 'discord'
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
  // Data-home contract for every MCP child (design-0023 P3). cwd alone was
  // load-bearing before: channel.mjs resolved its home from cwd/AGENT_DATA_HOME
  // and memory/service.mjs from a hardcoded literal, so a user with a moved
  // AGENT_DATA_HOME got a channel in the new home and a database in the old
  // one (read-D §6 #3). Both paths now ride in the row's env, which the claude
  // lane merges over the inherited env and the dsh lane emits verbatim into
  // its patch (dsh-lane.mjs mcpRowsFromClaudeConfig) -- one seam, both lanes.
  // No secret ever goes here (see the BOT-TOKEN SEAM note below).
  const MCP_CHILD_ENV = {
    AGENT_NAME,
    ELECTRON_RUN_AS_NODE: '1',
    AGENT_DATA_HOME: DATA_HOME,
    SCHEHERAZADE_MEMORY_DB: MEMORY_DB_PATH,
  }
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
    servers[name].env = { ...(servers[name].env || {}), ...MCP_CHILD_ENV }
  }
  // If either expected server entry is missing (fresh clone before any
  // setup.sh run), seed it with the same corrected shape.
  if (!servers['agent-channel']) {
    servers['agent-channel'] = {
      command: process.execPath,
      args: [activeChannelScriptPath()],
      cwd: DATA_HOME,
      env: { ...MCP_CHILD_ENV },
    }
  }
  if (!servers['memory']) {
    servers['memory'] = {
      command: process.execPath,
      args: [MEMORY_SERVER_SCRIPT_PATH],
      cwd: DATA_HOME,
      env: { ...MCP_CHILD_ENV },
    }
  }
  // darwin only: the calendar server is osascript + macOS Calendar all the way
  // down (calendar/read.cjs). Registering it on Windows handed the agent a tool
  // that can only ever fail, which is worse than not having one.
  if (!servers['calendar'] && HOST.calendarMcp) {
    servers['calendar'] = {
      command: process.execPath,
      args: [CALENDAR_SERVER_SCRIPT_PATH],
      cwd: DATA_HOME,
      env: { ...MCP_CHILD_ENV },
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
      // Named per platform. On Windows safeStorage is DPAPI, not a keychain,
      // and telling a Windows user their macOS Keychain is unreachable is the
      // same class of visibly-false sentence as the "Claude Code is not
      // installed" one in main.cjs -- it teaches them to stop reading.
      `safeStorage encryption unavailable on this system (${HOST.credStoreName} not reachable` +
        (HOST.isLinux ? ' -- this needs a running keyring, e.g. gnome-keyring or kwallet' : '') +
        ') -- refusing to store the key in plaintext.'
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
  // 0.4.3: main.cjs drops its cached live credential for this provider (the
  // route proxy's), so a re-login / re-paste reaches the running agent.
  for (const fn of providerKeyStoredListeners) { try { fn(provider) } catch {} }
  return filePath
}
const providerKeyStoredListeners = []
function onProviderKeyStored(fn) { providerKeyStoredListeners.push(fn) }

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
    // NO PORT CONFIGURED is now the normal case (2026-08-04): the in-process
    // proxy binds an ephemeral port at spawn, so before the first spawn there
    // is no port to ping and nothing is expected to be listening.
    //
    // Pinging the old 18080 default here would have been actively harmful --
    // "not reachable" for a healthy install (nothing has bound yet), or, worse,
    // "reachable" because some unrelated process owns 18080, which is a green
    // light for a proxy that is not ours and never will be.
    //
    // `reachable: null` is the third state, distinct from true and false:
    // there is nothing to check yet.
    const explicit = opts.proxyPort != null && String(opts.proxyPort).trim() !== ''
    if (!explicit) {
      return {
        ok: true,
        reachable: null,
        detail: 'the app starts its own codex-as-api proxy on a free port when the agent launches -- nothing to reach until then',
      }
    }
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
    // Ollama CLOUD API-key mode (2026-08-04, the owner "ollama -> API키"; the
    // previous local-daemon check lived here -- see git history. The daemon's
    // port-answers-so-"connected" lie is what a real external tester paid
    // for the same day). Verdict = one authenticated 1-token POST to
    // /v1/messages, which is the only endpoint that actually proves the key:
    // ollama.com's /api/tags and /v1/models answer 200 WITHOUT auth (probed
    // 2026-08-04), so they can never validate anything.
    //
    // Keyless calls fall back to the STORED key so the connectors page's
    // Test button can re-verify without re-pasting (the /api/byok/validate
    // route only persists when the body carried a non-empty key -- see
    // provider.cjs -- so this fallback can never store an empty key).
    let effectiveKey = typeof key === 'string' && key.trim() ? key.trim() : ''
    if (!effectiveKey) {
      try { effectiveKey = readProviderKey('ollama') || '' } catch (err) { /* fall through to the required error */ }
    }
    if (!effectiveKey) {
      return { ok: false, reason: 'ollama.com API key required -- create one in your ollama.com account settings and paste it here' }
    }
    // Public catalog for the model-name check (200 without auth -- fine,
    // it is only used for the modelPresent hint, never as the key verdict).
    let names = []
    try {
      const res = await fetch(`${OLLAMA_CLOUD_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_CLOUD_TIMEOUT_MS) })
      const body = await res.json()
      names = Array.isArray(body.models) ? body.models.map((m) => m.name) : []
    } catch (err) { /* catalog unavailable: key verdict below still stands, modelPresent degrades to undefined */ }
    const wantedRaw = typeof opts.model === 'string' && opts.model.trim() ? opts.model.trim() : ''
    // Same signin-era ':cloud' tag normalization the spawn env applies
    // (provider-env.cjs) -- validate must judge the NAME THE LANE WILL SEND,
    // not the raw config string, or an old config reads as broken when the
    // runtime would actually work (the owner field receipt 2026-08-04 17:37).
    const wanted = normalizeOllamaCloudModel(wantedRaw)
    const normNote = wantedRaw && wanted !== wantedRaw ? ` (checked as "${wanted}" -- the local ':cloud' tag suffix does not exist on ollama.com and is stripped at spawn too)` : ''
    // Probe with a model the catalog vouches for whenever the wanted one
    // isn't in it -- the auth verdict must never be blocked on a typo'd
    // model name.
    const probeModel = wanted && names.includes(wanted) ? wanted : names[0] || wanted || 'glm-5.2'
    try {
      const res = await fetch(`${OLLAMA_CLOUD_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Bearer ONLY -- mirror exactly what the runtime lane sends.
          // This used to send both header forms "to cover whichever is
          // honored", and that hedge cost a live failure (2026-08-04
          // 18:14): validate passed on the Bearer half while the spawned
          // CLI (then on ANTHROPIC_API_KEY -> x-api-key) got 401 from the
          // same key. A validator that authenticates differently from the
          // runtime vouches for a lane it never tested.
          authorization: `Bearer ${effectiveKey}`,
        },
        body: JSON.stringify({ model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(OLLAMA_CLOUD_TIMEOUT_MS),
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: `ollama.com rejected the API key (HTTP ${res.status}). Check the key in your ollama.com account settings.` }
      }
      if (!res.ok) {
        // Non-auth failure with a live key attempt: read the error body for
        // the receipt. A model error here still proves the KEY (auth passed),
        // so it reports ok:true + modelPresent:false, mirroring the old
        // daemon branch's warn-don't-block contract.
        let errBody = ''
        try { errBody = JSON.stringify(await res.json()).slice(0, 300) } catch (err) { /* keep '' */ }
        if (/not.?found|invalid.?model|no such model/i.test(errBody) || res.status === 404) {
          return { ok: true, reachable: true, modelPresent: false, detail: `ollama.com accepted the key, but model "${probeModel}" was refused (HTTP ${res.status}). Pick a name from the ollama.com model list${names.length ? ` (${names.length} available, first 8: ${names.slice(0, 8).join(', ')})` : ''}.` }
        }
        return { ok: false, reason: `ollama.com answered HTTP ${res.status}: ${errBody || 'no body'}` }
      }
      const modelPresent = wanted ? names.length ? names.includes(wanted) : probeModel === wanted : undefined
      if (wanted && modelPresent === false) {
        // Name the truncation: showing 8 of N unlabeled reads as "this IS the
        // catalog" -- that misread cost a wrong "glm-5.2 is gone" report on
        // 2026-08-19 (the owner caught it against the live library page).
        return { ok: true, reachable: true, modelPresent: false, detail: `ollama.com accepted the key, but model "${wanted}" is not in its model list (${names.length} available, first 8: ${names.slice(0, 8).join(', ')}). Check the name on ollama.com.${normNote}` }
      }
      return { ok: true, reachable: true, modelPresent, detail: (wanted ? `ollama.com accepted the key and model "${wanted}" answered.` : 'ollama.com accepted the key.') + normNote }
    } catch (err) {
      return { ok: false, reason: `could not reach ollama.com (${err.message}) -- check your network and try again` }
    }
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

  // claude-subscription keyless fallback (2026-08-06, connectors-page Test
  // unification): mirror the ollama branch's stored-key fallback above so the
  // connectors Test button can re-verify the stored setup-token without a
  // re-paste (a setup-token CANNOT be pasted twice -- see the branch comment
  // below). Safe for the same reason ollama's is: the /api/byok/validate
  // route only persists when the BODY carried a non-empty key, so an ok
  // verdict from this fallback never writes anything.
  if (provider === 'claude-subscription' && (!key || typeof key !== 'string' || key.trim() === '')) {
    try { key = (unwrapOAuthKey(readProviderKey('claude-subscription')) || {}).token || '' } catch (err) { /* fall through to the empty guard */ }
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
// fetchImpl is injectable for tests (tests/test-discord-reconnect.mjs
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
  if (!list.ok) {
    // Both tokens can pass their shallow probes (auth.test / apps.connections.
    // open) while the LIST call fails -- the classic case is a from-scratch
    // Slack app whose bot token lacks the channels:read / groups:read scopes.
    // This used to THROW -> route 500 -> generic toast, and a real first
    // external tester (2026-08-04) retried "valid" tokens forever with no clue
    // why. A branch with the verbatim Slack error is actionable; a 500 is not.
    return { ok: false, branch: 'list_failed', detail: list.error }
  }
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
      // Tokens ALONE are a complete slack config since DM-default mode
      // (2026-08-04, the owner): no home channel means the conversation is the
      // bot's DM. A picked channel still shows as `home` when present.
      configured: Boolean(readOrUnconfigured(readSlackBotToken) && readOrUnconfigured(readSlackAppToken)),
      home: cfg.SLACK_HOME_CHANNEL_NAME || cfg.SLACK_HOME_CHANNEL_ID || 'DM',
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
// Escape a string for use inside a double-quoted HTML attribute. The
// capability JSON below carries `"` on every key, and `&`/`<` would let a
// future field close the tag. Five entities, no HTML parser, same posture as
// the literal-<head>-replace this file already documents.
function htmlAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // .cjs: appearance-model.cjs is shared verbatim between this server
  // (require) and the browser (classic <script>) — the extension keeps
  // node's "type":"module" from reading it as ESM, and this MIME entry
  // keeps browsers from refusing it as octet-stream.
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Pretendard Variable (P0 design-research 2026-08: one bundled KR/Latin
  // font kills the Malgun vs Apple SD Gothic cross-platform mismatch).
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', // OFL license file beside the font
  // Images (agent-avatar fallback, 2026-09-28): public/ held none until the
  // avatar landed, so this map had no image entry and a .png served as
  // application/octet-stream. The fallback avatar is the ONLY static image
  // today, but the whole set is here because a browser <img> must not be
  // left to content-sniff.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
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
    // HTML carries the onboard token (meta injection below), so HTML is
    // exactly the surface the page-scrape bypass used — cookie-gate it.
    // Non-HTML assets (css/js/img) carry no secret and stay Host-gated.
    if (!hasUiSession(req)) {
      log(`REJECT no ui session ${req.method} ${urlPath}`)
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('forbidden: no ui session (open the app, or use the /boot URL the server printed)')
      return true
    }
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
    // Windows equivalent. the owner hit all of it on the first Windows install
    // (2026-08-03 23:56). The renderer cannot see process.platform, so it
    // gets told. copy.js reads this before it builds any string.
    // host-capabilities rides beside host-platform (design-0023 P4). The
    // page needs the ANSWERS, not the platform id, at FIRST PAINT: copy.js
    // and every render gate used to re-derive "is this a Mac?" from the id
    // and get Linux wrong three different ways. Same JSON GET /api/config
    // serves, so the pre-fetch page and the post-fetch page cannot disagree.
    const capsJson = htmlAttr(JSON.stringify(HOST.clientView()))
    let injected = html.replace(
      '<head>',
      `<head>\n    <meta name="onboard-token" content="${SERVER_TOKEN}">\n    <meta name="host-platform" content="${HOST.id}">\n    <meta name="host-capabilities" content="${capsJson}">`
    )
    // Appearance overrides ride the SAME serve (Appearance tab, 2026-08-05):
    // injected before </head> so they land AFTER app.css's <link> and win
    // the :root cascade — pre-paint, so no flash of default styling. The
    // element id is what js/appearance.js live-updates on slider drag.
    injected = injected.replace(
      '</head>',
      `  <style id="appearance-style">\n${AppearanceModel.cssText(readAppearance())}\n    </style>\n  </head>`
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
  // 'ollama' REMOVED 2026-08-04 (the owner: "ollama -> API키"): its connect method
  // is now an ollama.com API-key paste stored via the same credential plumbing
  // as claude BYOK (see provider-env.cjs's ollama row + validateProviderKey's
  // ollama branch). No spec here means the login routes reject it and the
  // onboarding-complete artifact gate skips it -- the stored-credential gate
  // (PROVIDERS_REQUIRING_STORED_CREDENTIAL) covers ollama instead. The old
  // entry's identity-key heuristic (~/.ollama/id_ed25519) was exactly the
  // false-"connected" a real external tester hit the same day.
}

// ── MCP connector OAuth intercept (IA v0.0.9, an internal design + review) ──
// In-app authorization of claude.ai connectors (Gmail/Calendar/Atlassian/…):
// spawn `claude mcp login --no-browser "claude.ai <name>"`, capture the
// authorize URL it prints to stdout, hand it to the UI for the user to open.
// The user never touches a terminal (the owner constraint: non-programmers).
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
  // Fix #1 (a counter-pass, the owner 07-14 re-flag): the query string is
  // MANDATORY. The real authorize URL carries `?product_surface=sdk-cli`
  // and WITHOUT it the approval page does not appear, so the regex requires
  // both the query AND that param -- a bare .../mcpsrv_x with no query is a
  // capture MISS, not a match. Origin is pinned to https://claude.ai
  // literally, so a captured string can only ever be a claude.ai authorize
  // endpoint (red-team hardening #3; the child is our own claude, but defense in
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

// ── full-scope OAuth capture for the usage gauge ──────────────────────────
// Sibling to the setup-token session above, same single-flight rationale
// (one loopback callback port at a time). This one needs no CLI binary -- it
// runs the OAuth code exchange in-process -- so it is not gated on
// agentControls and can be built at first request unconditionally. The stored
// credential is 'claude-usage', kept separate from the setup-token so the
// agent lane and the meter never share a token.
let usageOAuthSession = null
function getUsageOAuthSession() {
  if (!usageOAuthSession) {
    usageOAuthSession = createUsageOAuthSession({
      storeUsageCredential: (json) => storeProviderKeyVerified(USAGE_PROVIDER_ID, json),
      log,
    })
  }
  return usageOAuthSession
}

// ── in-app Claude login for the AGENT LANE (claude-subscription) ───────────
// The browser replacement for `claude setup-token`: same OAuth machinery as
// the usage session above (loopback redirect, PKCE, single-flight, no CLI),
// but requesting ONLY user:inference so the endpoint mints the long-lived oat
// token, and storing the RAW token string as 'claude-subscription' -- byte-for
// -byte the credential the CLI's setup-token produced. The dsh lane reads that
// slot unchanged, so this drops the Claude Code CLI dependency for login with
// zero change to how the agent runs. Separate single-flight instance from the
// usage session: the two flows must never share one loopback callback port.
let loginOAuthSession = null
function getLoginOAuthSession() {
  if (!loginOAuthSession) {
    loginOAuthSession = createUsageOAuthSession({
      storeUsageCredential: (token) => storeProviderKeyVerified('claude-subscription', token),
      scopes: LOGIN_SCOPES,
      // 0.4.3: store the access+refresh blob (same shape the usage gauge
      // reads) when the endpoint returns a refresh token + expiry -- a bare
      // access token died after hours with nothing able to renew it (field
      // report 2026-10-12). No refresh token -> bare string, as before.
      // Readers unwrap both shapes (provider-env.cjs unwrapOAuthKey).
      serialize: serializeLoginCredential,
      log,
    })
  }
  return loginOAuthSession
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
// (post-onboarding multi-provider unlock, the owner 07-13 click-test item 3:
// "인증키 있으면 Model Dropdown에서 셀렉 가능하게"). Rides along on GET
// /api/config as camelCase `availableProviders`, and gates the provider
// field of POST /api/agent/model server-side. Detection mirrors what spawn
// time actually requires: claude/claude-subscription = a stored credential
// (provider-env.cjs reads the same store), chatgpt/ollama = the login
// artifact LOGIN_SPECS itself points at. A keychain read failure logs LOUD
// but degrades to "not available" rather than 500ing the whole config bag.
function computeAvailableProviders() {
  const out = [...new Set(require('../lane-providers.cjs').laneModels().flatMap((m) => m.providers))]
  // PROVIDERS_REQUIRING_STORED_CREDENTIAL rather than a literal list, so a
  // provider moving to key-mode (ollama, 2026-08-04) is available exactly
  // when its stored credential exists -- same single source of truth as the
  // validate/complete gates.
  for (const provider of PROVIDERS_REQUIRING_STORED_CREDENTIAL) {
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
    if (fs.existsSync(CLAUDE_CLI_CREDENTIALS_PATH)) {
      out.push('claude-cli')
    } else if (HOST.cliCredentialKeychain) {
      // macOS CLI logins live in the login keychain, not the JSON file --
      // without this branch the found-login card NEVER shows on a typical
      // Mac (0.2.3 E2E find, 2026-08-19). Existence-only stays true to the
      // zero-auth promise: no `-w`, so the secret itself is never read here
      // (metadata presence check only; the ACL guards the secret, not the
      // item's existence). The lane's readClaudeCliToken() reads the same
      // keychain service at spawn.
      const { execFileSync: probeExec } = require('node:child_process')
      try {
        probeExec('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore', timeout: 3000 })
        out.push('claude-cli')
      } catch { /* not present (or security unavailable) -> not offered */ }
    }
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
  // dsh (0.2.1 harness swap): no credential of its own (provider-env.cjs
  // 'dsh' row is credential:'none' -- local ollama daemon, dummy bearer).
  // Availability gate = the pinned engine actually being installed in this
  // build; existence-only, same stance as claude-cli above. A running
  // ollama daemon is NOT probed here: that is a spawn-time truth the lane
  // reports loudly itself, and probing :11434 from a config GET would make
  // availability flap with the daemon.
  try {
    require.resolve('@deepseek-ai/dsh/package.json')
    out.push('dsh')
  } catch {
    // engine not bundled in this build -- silently unavailable, by design
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
// design-0023 P4: the candidate LIST moved to onboarding/platform.cjs so
// there is one per-platform answer instead of a mac list, a win list, and no
// Linux list at all. The posture above is unchanged and is restated in that
// file's header -- fixed absolute locations, no PATH walk (platform.cjs's
// resolveBin takes an explicit `allowPath` that nothing here passes).
//
// What the move FIXED: the non-win arm was `[DATA_HOME/bin, /opt/homebrew/bin,
// /usr/local/bin]`, so on Linux `codex login` reported cli_missing on every
// apt (/usr/bin), npm (~/.npm-global/bin), snap (/snap/bin) and
// installer-script (~/.local/bin) install -- i.e. on essentially every Linux
// box, while telling the user their CLI was not installed.
function resolveBin(name) {
  return HOST.resolveBin(name)
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
    // .cmd/.bat shims (npm global bin on Windows) need shell:true for
    // execFile too -- HOST.execFileBin is the one owner of that rule now
    // (design-0023 P4); this used to be one of five hand-copies, two of
    // which (the MCP pair below) did not have it at all.
    HOST.execFileBin(binPath, spec.probe.argv, { timeout: LOGIN_PROBE_TIMEOUT_MS }, (err) => resolve(!err))
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
  // .cmd shims (npm global bin on Windows) need shell:true -- Node's spawn
  // cannot exec a .cmd directly without it -- and detached is incompatible
  // with shell:true there, so the own-pgroup request is dropped exactly on
  // that path. Both rules live in HOST.spawnBin now (design-0023 P4), which
  // also guarantees the 'error' listener below is never the only thing
  // standing between a spawn failure and main.cjs's uncaughtException.
  const child = HOST.spawnBin(binPath, spec.argv, {
    detached: true, // own pgroup -> group-SIGTERM reaps browser-opener grandchildren too
    stdio: ['ignore', 'pipe', 'pipe'],
    onError: (err) => {
      // spawn-level failure (ENOENT raced away, EACCES, ...) -- close may
      // never fire with a meaningful code.
      if (getLoginStatus(provider).state === 'running') {
        setLoginStatus(provider, 'failed', 'unknown', `spawn failed: ${err.message}`)
      }
      clearLoginChild(provider)
    },
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
  // The usage-gauge OAuth flow holds the same class of loopback /callback
  // listener (no child process, but a live socket that could still complete a
  // token exchange). Close it on the same shutdown path.
  killUsageOAuthChildOnShutdown()
  // Claude CLI install-assist child: same detached-child class. An orphaned
  // installer finishing after the app is gone is harmless-ish (it just
  // installs), but supervision-less children are exactly the pattern this
  // function exists to not have.
  if (claudeInstallChild) {
    try {
      killTree(claudeInstallChild.pid, signal)
      log(`killAllLoginChildren: sent ${signal} to claude-cli installer pgroup (pgid=${claudeInstallChild.pid})`)
    } catch (err) {
      log(`killAllLoginChildren: ${signal} to claude-cli installer failed (${err.message}) -- likely already gone`)
    }
    claudeInstallChild = null
  }
  if (claudeInstallTimer) { clearTimeout(claudeInstallTimer); claudeInstallTimer = null }
}

// ── Claude Code CLI install-assist (2026-08-04, the owner "2로 가자") ───────────
// A truly clean machine has no claude CLI, and the app deliberately ships
// none (no redistribution grant in its LICENSE -- see main.cjs's
// resolveClaudeBin comment). Until now the fix was a curl one-liner the UI
// didn't even render. This runs Anthropic's OWN official installer on the
// user's click -- install-assist, not redistribution: the bytes come from
// claude.ai, the user initiates it, and the license/plan requirements are
// shown next to the button (wizard copy).
//
// Security posture mirrors LOGIN_SPECS: argv is FIXED (no request data ever
// reaches it), the child is detached (own pgroup) so timeout/cancel/quit can
// kill the whole tree, and completion is exit 0 AND the artifact check
// (resolveClaudeBin() actually finding a binary) -- the same
// exit-0-plus-artifact bar the login flows use. darwin-only, same
// MANAGED_INSTALL_SUPPORTED precedent as bootstrap.cjs (the owner locked 07-13):
// Windows stays detection-only with a manual command.
const CLAUDE_INSTALL_TIMEOUT_MS = 300_000 // installer downloads a real binary; login-flow 180s is too tight on slow links
const CLAUDE_INSTALL_ARGV = ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] // FIXED -- the exact command the manual instruction shows
let claudeInstallChild = null
let claudeInstallTimer = null
let claudeInstallStatus = { state: 'idle', code: null, detail: null, since: new Date().toISOString() }

function setClaudeInstallStatus(state, code = null, detail = null) {
  claudeInstallStatus = { state, code, detail, since: new Date().toISOString() }
}

function getClaudeInstallStatus() {
  return claudeInstallStatus
}

function startClaudeCliInstall({ resolveClaudeBin }) {
  // design-0023 P4: the gate is "does upstream ship an installer we can run
  // here?" (HOST.claudeCliInstall), not "is this Windows?". Same answer on
  // Windows, but it is now the same answer for the same REASON on Linux,
  // where the curl|bash path is upstream's supported one and used to be
  // reached only because Linux fell through a win32 test.
  if (!HOST.claudeCliInstall) {
    setClaudeInstallStatus('failed', 'unsupported_platform',
      `no managed installer for this platform -- run the ${HOST.shellName} command manually`)
    return
  }
  if (claudeInstallChild) return // already in flight; status route reports it
  if (resolveClaudeBin && resolveClaudeBin()) {
    setClaudeInstallStatus('success', null, 'already installed')
    return
  }
  setClaudeInstallStatus('running')
  let child
  try {
    // /bin/bash is an absolute path, so this is not a resolution question --
    // it goes through HOST.spawnBin for the 'error'-listener guarantee and
    // the one detached rule. On a bash-less Linux (Alpine, some Nix profiles)
    // it still degrades to failed/spawn_failed, never a crash.
    child = HOST.spawnBin('/bin/bash', CLAUDE_INSTALL_ARGV, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      onError: (err) => {
        if (claudeInstallTimer) { clearTimeout(claudeInstallTimer); claudeInstallTimer = null }
        claudeInstallChild = null
        setClaudeInstallStatus('failed', 'spawn_failed', err.message)
      },
    })
  } catch (err) {
    setClaudeInstallStatus('failed', 'spawn_failed', err.message)
    return
  }
  claudeInstallChild = child
  // stderr tail server-log ONLY (login-flow precedent: GET status needs no
  // token, so child output never rides the status payload).
  let errTail = ''
  child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000) })
  claudeInstallTimer = setTimeout(() => {
    if (!claudeInstallChild) return
    try { killTree(claudeInstallChild.pid, 'SIGTERM') } catch { /* already gone */ }
    setClaudeInstallStatus('failed', 'timeout', '설치가 시간 내에 끝나지 않았습니다. 네트워크를 확인하고 다시 시도해주세요.')
  }, CLAUDE_INSTALL_TIMEOUT_MS)
  child.on('exit', (code) => {
    if (claudeInstallTimer) { clearTimeout(claudeInstallTimer); claudeInstallTimer = null }
    claudeInstallChild = null
    if (claudeInstallStatus.state !== 'running') return // timeout already ruled
    const present = Boolean(resolveClaudeBin && resolveClaudeBin())
    if (code === 0 && present) {
      setClaudeInstallStatus('success')
      log('claude-cli install: installer exited 0 and the binary resolves -- success')
    } else {
      // exit 0 without an artifact is a FAILURE (same bar as login flows) --
      // "installer said fine" is not "the app can spawn it".
      setClaudeInstallStatus('failed', code === 0 ? 'artifact_missing' : 'exit_nonzero', '설치가 완료되지 않았습니다. 다시 시도하거나 터미널에서 직접 설치해주세요.')
      log(`claude-cli install: exit ${code} present=${present}${errTail ? ` stderr tail: ${errTail.slice(-500)}` : ''}`)
    }
  })
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
    // HOST.execFileBin, not bare execFile (design-0023 P4): this call site
    // never had the .cmd branch the login path has, so an npm-shim `claude`
    // was an EINVAL on current Node rather than a connector list. Masked
    // today only because main.cjs's resolveClaudeBin refuses to return a
    // shim -- a mask, not a fix.
    HOST.execFileBin(binPath, ['mcp', 'list'], { timeout: 15_000, env: childEnv }, (err, stdout) => {
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
    const child = HOST.spawnBin(binPath, MCP_CONNECTOR_SPEC.argv(name), {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      onError: (err) => {
        if (getMcpStatus(name).state === 'running') setMcpStatus(name, 'failed', 'unknown', `spawn failed: ${err.message}`)
        clearMcpLoginChild(name)
      },
    })
    mcpLoginChildren[name] = child

    // Fix #2 (same review): accumulate stdout across chunks. A per-chunk match
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
let modelDiscoveryPromise = null
function discoverCatalog() {
  if (!modelDiscoveryPromise) {
    const discovery = require('../model-discovery.cjs')
    const catalog = require('./public/js/model-catalog.cjs')
    let claudeToken
    try { claudeToken = require('../provider-env.cjs').readClaudeCliToken().token } catch { /* no CLI login */ }
    modelDiscoveryPromise = discovery.discoverModels({ claudeToken })
      .then((rows) => catalog.mergeDiscovered(rows))
      .catch(() => catalog.MODELS)
  }
  return modelDiscoveryPromise
}

async function handleApi(req, res, pathname, onOnboardingComplete, agentControls) {
  if (req.method === 'GET' && pathname === '/api/models') {
    const models = [...await discoverCatalog(), ...require('../lane-providers.cjs').laneModels()]
    const cfg = readAgentConfig()
    if (cfg.CUSTOM_BASE_URL && cfg.PROVIDER === 'custom' && cfg.MODEL && !models.some((m) => m.id === cfg.MODEL)) {
      models.push({ id: cfg.MODEL, label: `${cfg.MODEL} [UI custom]`, group: 'Custom', providers: ['custom'], source: 'ui' })
    }
    sendJson(res, 200, { models })
    return
  }
  const callCtx = { agentControls, onOnboardingComplete, getAskpassToken: () => askpassToken, getCaptionToken: () => captionToken, getUsageToken: () => usageToken }
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
  '/appearance': 'appearance.html',
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
  harnessRender.syncChromuxPortable() // every boot: vendored chromux -> DATA_HOME/bin + wrappers + its bundled skills (web-search path for non-Anthropic backends)
  harnessRender.syncAgentTools() // every boot: first-party agent helpers (windowshot 같이보기) -> DATA_HOME/bin/agent-tools + wrappers

  return new Promise((resolve, reject) => {
    let allowedHosts = null // populated once listen() resolves and the real ephemeral port is known

    discoverCatalog() // Cache rows are synchronous; provider discovery must not delay lane startup.
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

        // Token required on ALL /api/* requests, not just mutations
        // (opencodex review, 2026-08-04: the GET set includes
        // /api/memory/* and /api/journal -- everything the agent knows
        // about the user. The Host allowlist defeats browsers, but any
        // other local process could read it with one header. That is the
        // exact threat the comment above cites; reads were left out of
        // the remedy). Static pages stay Host-gated only -- the browser
        // cannot attach a header to a navigation, and the token rides
        // INTO the page via serveStatic's <meta> injection.
        const isMutating = req.method === 'POST' || req.method === 'DELETE'
        // /api/sudo/password is the ONE /api GET whose caller can never hold
        // the onboard token: sudo -A runs the askpass helper inside the
        // AGENT's process tree, not a served page — the per-launch token
        // never reaches it. It authenticates with its OWN per-boot token
        // (32-byte random, 0600 endpoint file, checked fail-closed in the
        // route body). The 2026-08-04 token-on-all-GETs hardening swept this
        // route in and silently killed every `sudo -A` with a gate 403 the
        // helper's curl -f turned into exit 22 (found live 2026-08-05, the owner
        // "sudo + 비밀번호 앱에서 에이전트한테 제대로 못 넘겨주는것같은데").
        const isAskpassFetch = req.method === 'GET' && pathname === '/api/sudo/password'
        // /api/agent/caption-image is the askpass exemption's POST sibling:
        // its caller is the channel process (agent tree), which can never
        // hold the served-page onboard token. It authenticates with its OWN
        // per-boot token (.caption-endpoint.json, 0600), checked fail-closed
        // in the route body.
        const isCaptionFetch = req.method === 'POST' && pathname === '/api/agent/caption-image'
        // /api/agent/usage: read-only quota meter for the in-app agent (agent
        // tree, no served-page token). Own per-boot token (.usage-endpoint.json,
        // 0600), checked fail-closed in the route body.
        const isUsageFetch = req.method === 'GET' && pathname === '/api/agent/usage'
        if ((isMutating || pathname.startsWith('/api/')) && !isAskpassFetch && !isCaptionFetch && !isUsageFetch) {
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

        // ── /boot: the only way to acquire the UI session cookie ────────
        // Proves possession of the per-launch SERVER_TOKEN via query param
        // (a navigation can carry a query where it cannot carry a header),
        // sets the HttpOnly session cookie, and bounces to `to`. Wrong or
        // missing token → same 403 the token gate uses. `to` is sanitized
        // to a same-origin absolute path: "//evil.example" would be a
        // protocol-relative external redirect, so anything not matching
        // "/" + non-"/" collapses to "/".
        if (pathname === '/boot' && req.method === 'GET') {
          if (!safeTokenEqual(parsedUrl.searchParams.get('t'), SERVER_TOKEN)) {
            log(`REJECT bad /boot token`)
            res.writeHead(403, { 'Content-Type': 'text/plain' })
            res.end('forbidden: missing or invalid onboard token')
            return
          }
          const rawTo = parsedUrl.searchParams.get('to') || '/'
          const to = /^\/(?!\/)/.test(rawTo) ? rawTo : '/'
          res.writeHead(302, {
            'Set-Cookie': `${SESSION_COOKIE_NAME}=${SESSION_COOKIE}; HttpOnly; SameSite=Strict; Path=/`,
            Location: to,
          })
          res.end()
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
      // caption endpoint file (0.1.7): channel processes discover the port +
      // per-boot token here. Failure just disables Slack captions this boot
      // (markers degrade to the honest no-vision text) -- never fatal.
      try {
        captionToken = crypto.randomBytes(32).toString('hex')
        const capPath = path.join(DATA_HOME, '.caption-endpoint.json')
        try { fs.unlinkSync(capPath) } catch { /* absent = first boot */ }
        fs.writeFileSync(capPath, JSON.stringify({ port, token: captionToken }) + '\n', { mode: 0o600 })
      } catch (err) {
        captionToken = null // fail closed: route refuses everything
        console.error('[scheherazade/onboarding] failed to write caption endpoint file (Slack vision stand-in disabled this boot):', err.message)
      }
      // usage endpoint file: the agent's usage-budget helper reads {url, token}
      // here. Failure just disables the route this boot (403 for everyone).
      try {
        usageToken = crypto.randomBytes(32).toString('hex')
        const usePath = path.join(DATA_HOME, '.usage-endpoint.json')
        try { fs.unlinkSync(usePath) } catch { /* absent = first boot */ }
        fs.writeFileSync(usePath, JSON.stringify({ url: `http://127.0.0.1:${port}/api/agent/usage`, token: usageToken }) + '\n', { mode: 0o600 })
      } catch (err) {
        usageToken = null // fail closed
        console.error('[scheherazade/onboarding] failed to write usage endpoint file (agent usage meter disabled this boot):', err.message)
      }
      resolve({ server, url })
    })
  })
}

// ── dynamic Claude model catalog (2026-08-13, the owner: "모델 리스트 하드코딩
// 말고 더 좋은 방법 없냐? 다이나믹하게 긁어오는법 있음 좋을듯") ────────────
// The claude CLI binary carries its own model table as literal
// `"<id>",context:{window:<n>...}` entries -- the same table the static
// contextCapForModel pins below were hand-extracted from (2.1.211). Scanning
// the binary at runtime makes the Claude model list AND its context caps
// follow whatever CLI is actually installed: a new model ships in the next
// CLI update, not in a Scheherazade release. Chunked scan (8MB + 256B
// overlap) so a ~200MB binary never lands in memory whole; result cached by
// (path, mtime) so the cost is one scan per binary version. Extraction
// failure or an id-less binary returns [] -- callers fall back to the static
// catalog/pins, never to an empty picker.
let claudeBinModelsCache = null // { key, models: [{id, window}] }
function extractClaudeModelsFromBin(binPath) {
  if (!binPath) return []
  let stat
  try { stat = fs.statSync(binPath) } catch { return [] }
  const key = `${binPath}:${stat.mtimeMs}:${stat.size}`
  if (claudeBinModelsCache && claudeBinModelsCache.key === key) return claudeBinModelsCache.models
  const found = new Map()
  // window literals appear both expanded ("200000"/"200_000") and in
  // exponent form ("1e6") -- the exponent tail must be INSIDE the capture
  // or "1e6" reads as window:1 (caught live on the first scan, 2026-08-13).
  // TWO record shapes coexist in the 2.1.x binary (both live-verified on
  // this box the same day):
  //   legacy: "claude-opus-5",context:{window:1e6,...
  //   new:    {id:"claude-fable-5",family:"fable",...,context:{window:1e6,...
  // The new-shape lookahead is bounded (records run ~600-800 chars) so an
  // id whose record lacks a context block cannot steal the NEXT record's
  // window from a kilobyte away.
  const RES = [
    /"(claude-[a-z0-9.-]+)",context:\{window:([0-9][0-9_]*(?:e[0-9]+)?)/g,
    /id:"(claude-[a-z0-9.-]+)"[^]{0,900}?context:\{window:([0-9][0-9_]*(?:e[0-9]+)?)/g,
  ]
  try {
    const fd = fs.openSync(binPath, 'r')
    try {
      const CHUNK = 8 * 1024 * 1024
      const OVERLAP = 2048 // > one full new-shape record (~800 chars), so a boundary-split record still matches in the next chunk
      const buf = Buffer.alloc(CHUNK + OVERLAP)
      let pos = 0
      while (pos < stat.size) {
        const readStart = Math.max(0, pos - OVERLAP)
        const n = fs.readSync(fd, buf, 0, buf.length, readStart)
        if (n <= 0) break
        const text = buf.toString('latin1', 0, n)
        for (const re of RES) {
          let m
          while ((m = re.exec(text)) !== null) {
            const raw = m[2]
            const window = raw.includes('e') ? Number(raw) : Number(raw.replace(/_/g, ''))
            // < 1000 = a mis-parse or a non-context entry, never a real window.
            // Same id can appear in BOTH table shapes with DIFFERENT windows
            // (live case: opus-4-6 = 1e6 in the legacy record, 200000 in a
            // second one) -- keep the LARGEST seen, which matches the
            // hand-verified claude-cli-table pins for every overlapping id.
            if (Number.isFinite(window) && window >= 1000) {
              found.set(m[1], Math.max(window, found.get(m[1]) || 0))
            }
          }
          re.lastIndex = 0
        }
        pos = readStart + n
        if (n < buf.length) break
      }
    } finally { fs.closeSync(fd) }
  } catch (err) {
    console.error(`[scheherazade/onboarding] claude binary model scan failed (static catalog stands): ${err.message}`)
    return []
  }
  const models = [...found.entries()].map(([id, window]) => ({ id, window })).sort((a, b) => a.id.localeCompare(b.id))
  claudeBinModelsCache = { key, models }
  return models
}

// Model → context cap. Two provenance tiers, labeled honestly in the
// payload (v0.0.22):
//   - claude-cli-table: extracted from the claude CLI 2.1.211 binary's own
//     model table (`"<id>",context:{window:...}` entries) — what the CLI
//     ACTUALLY budgets autocompact against for these ids.
//   - codex-as-api-table: the proxy's model table — the PROXY's real cap.
//     The CLI does not know gpt ids, so its believed window (and therefore
//     the autocompact trigger point) may be SMALLER than this; the gauge's
//     occupancy number is exact either way, only pct is best-effort there.
//     MEASURED 2026-09-28, every catalog chatgpt row booted in-process with an
//     EMPTY CODEX_HOME (the fresh-install number we ship; /health reads config
//     only, no ChatGPT call). Raw, one line per id:
//       {"id":"gpt-6-astra","context_window":200000,"auto_compact_token_limit":160000}
//       {"id":"gpt-6-luna","context_window":200000,"auto_compact_token_limit":160000}
//       {"id":"gpt-6-sol","context_window":200000,"auto_compact_token_limit":160000}
//       {"id":"gpt-daybreak-blue-latest","context_window":200000,"auto_compact_token_limit":160000}
//     With CODEX_HOME UNSET on this box all four read 372000 / 334800 instead:
//     that is this machine's ~/.codex/config.toml `model_context_window =
//     372000` leaking into /health (codex-as-api's getContextWindow() returns
//     the config value when capabilityForModel() carries no entry), not a vendor
//     number -- pin THAT and every normal install's gauge reads ~46% too empty.
//     The gpt-5.x branch below keeps its own, older receipt: codex-as-api 0.6.5
//     carries context_window 272_000 for every 5.x slug (5.6 / 5.6-sol /
//     5.6-terra / 5.6-luna / 5.5 / 5.4), and the prior 372_000 pin for the 5.6
//     family was substantiated by NO installed package. That branch no longer
//     serves a catalog row (2026-09-28 prune) but stays for a saved config that
//     still names one.
// Re-verify these pins on every codex-as-api upgrade (see docs/HISTORY.md
// for the upgrade checklist) -- a version bump can silently move the table.
// Unknown model → cap null, UI shows occupancy without a percentage.
function contextCapForModel(model) {
  if (typeof model !== 'string' || !model) return { cap: null, capSource: null }
  // claude-opus-5-5 (2026-09-28) is REQUIRED here by test-context-gauge's
  // "every pickable catalog model resolves to a cap" section: the catalog row
  // alone would leave it with cap null and silently drop its gauge. 1M from
  // both receipts — see model-catalog.cjs's row-provenance note.
  // claude-fable-5-1 (2026-09-28 prune): same 1M / claude-cli-table receipt as
  // its fable sibling.
  // The retired picker ids (claude-fable-5, claude-opus-5, claude-opus-4-8)
  // STAY in this set on purpose, as do the two entries that never matched a
  // catalog row (claude-opus-4-7, claude-sonnet-4-6): a saved config can still
  // name any of them, and a removed entry would make contextCapForModel return
  // null for it -- the gauge goes blank rather than merely stale. Deleting a
  // picker ROW is not licence to stop answering for the id.
  const CLAUDE_1M = new Set(['claude-fable-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'])
  const base = model.replace(/\[1m\]$/, '')
  // Live tier first (2026-08-13): whatever the last binary scan saw is the
  // installed CLI's own table -- fresher than any hand-pinned entry below.
  // A '[1m]' suffix opts OUT of this tier (the scan does not carry the
  // 1m-beta flags, and a scanned 200K base would under-report a 1M lane).
  if (!/\[1m\]$/.test(model) && claudeBinModelsCache) {
    const scanned = claudeBinModelsCache.models.find((m) => m.id === base)
    if (scanned) return { cap: scanned.window, capSource: 'claude-cli-binary' }
  }
  const discovered = require('./public/js/model-catalog.cjs').byId(base)
  if (discovered && Number.isInteger(discovered.contextWindow) && discovered.contextWindow > 0) {
    return { cap: discovered.contextWindow, capSource: discovered.contextWindowSource }
  }
  if (CLAUDE_1M.has(base)) return { cap: 1_000_000, capSource: 'claude-cli-table' }
  if (/^claude-(opus-4-[015]|sonnet-4-[05]|haiku-4-5)/.test(base)) return { cap: 200_000, capSource: 'claude-cli-table' }
  // All gpt-5.x slugs codex-as-api 0.6.5 knows share context_window 272_000
  // (see the provenance block above). Merged from the old split 5.6→372k /
  // 5.[245]→272k pins once the 372k value was falsified against 0.6.5.
  if (/^gpt-5\.[23456]/.test(base)) return { cap: 272_000, capSource: 'codex-as-api-table' }
  // gpt-6-* / gpt-daybreak-blue-latest: not in codex-as-api's
  // model_capabilities_default, so the proxy serves its unknown-model default
  // context_window 200_000 (measured 2026-09-28 in-process with an empty
  // CODEX_HOME -- see the raw /health lines in the provenance block above) and
  // compacts at 160000. The model itself is 372K; a user's ~/.codex/config.toml
  // `model_context_window = 372000` overrides the proxy live (that is how the
  // reference-fleet lanes report 372000). Pin the proxy's DEFAULT here so the
  // gauge matches the compaction point on a fresh machine; re-verify when
  // codex-as-api learns the gpt-6 family.
  if (/^gpt-6/.test(base)) return { cap: 200_000, capSource: 'codex-as-api-table' }
  // gpt-daybreak-blue-latest (catalog row 2026-09-28) needs its own branch, not
  // a share of /^gpt-6/: without one it fell through to {cap:null} and the
  // test-codex-proxy-model drift guard caught it (proxy=200000 pin=null). Same
  // measured default as the gpt-6 rows, same source label.
  if (base === 'gpt-daybreak-blue-latest') return { cap: 200_000, capSource: 'codex-as-api-table' }
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
// ── BYOS usage gauge + update check (tester requests, 2026-08-04) ─────────
// Usage: the same Anthropic OAuth usage endpoint the reference fleet gauges
// poll. Contract discipline inherited from that script: a failed read is
// null/branch, NEVER 0 -- 0 means "window just reset" and must stay
// distinguishable from "could not read".
const APP_VERSION = (() => {
  try { return require('../package.json').version } catch { return '0.0.0' }
})()

// Cache + stale-on-error (2026-08-04, the owner field: "usage는 429가 떠버리네" --
// the OAuth usage endpoint rate-limits fast, and v1 hit it fresh on every
// page load AND every Refresh click). 60s success TTL absorbs refresh spam;
// on any failure the LAST GOOD reading is served with stale:true + asOf so
// the gauge shows "82% (as of 17:42)" instead of degrading to a bare
// HTTP 429 -- an error should annotate a gauge, not replace it.
let usageCache = null // { at, payload } -- last GOOD reading only
// Failure cooldown (2026-08-13, win-tester field: Claude row stuck on a bare
// "HTTP 429" -- screenshot receipt in the reference fleet research notes). Success has a 60s
// TTL but failures had NONE, so every page entry / refresh click hit the
// rate-limited endpoint again while it was telling us to back off -- the one
// caller pattern that keeps a 429 a 429. A failed read now also arms a
// cooldown; inside it the cached verdict (stale-good or the error) is served
// without touching the network. Cleared by any successful read.
let usageFailCooldown = null // { until, payload }

// CLI-session token fallback (2026-08-04, the owner field: gauge stuck on
// "HTTP 403"). The app-captured `claude setup-token` carries user:inference
// ONLY -- the usage endpoint refuses it. The Claude Code CLI's own
// interactive login token DOES read it (the the reference fleet's gauge has polled
// this endpoint with exactly that credential for weeks). So: try the
// setup-token first (it's OUR credential, stored with consent), and on
// 401/403 fall back to the CLI session this machine already has --
// macOS keychain item "Claude Code-credentials" (payload JSON,
// .claudeAiOauth.accessToken), or ~/.claude/.credentials.json elsewhere.
// Honesty rules: the payload carries source:'cli-session' so the UI can say
// whose login the number describes; the token itself is never logged or
// returned; expiresAt in the past -> null (the CLI refreshes it when used,
// we never write). Reading this file/keychain item is a departure from the
// claude-cli row's "we read nothing" promise -- scoped HERE deliberately:
// this reads the credential to show the USER their OWN meter, not to
// pre-validate or to authenticate a lane.
function readCliSessionToken() {
  try {
    let raw = null
    if (HOST.cliCredentialKeychain) {
      const r = require('child_process').spawnSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' })
      if (r.status === 0 && r.stdout) raw = r.stdout.trim()
    }
    if (!raw) {
      const p = path.join(os.homedir(), '.claude', '.credentials.json')
      if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf8')
    }
    if (!raw) return null
    const oauth = (JSON.parse(raw) || {}).claudeAiOauth
    const token = oauth && typeof oauth.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : null
    const expiresAt = oauth && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null
    if (!token) return null
    if (expiresAt && expiresAt < Date.now()) return null // stale session: fail honest, never send a dead token
    return token
  } catch { return null }
}

// The full-scope usage credential ('claude-usage'), minted by the OAuth login
// flow. Unlike the setup-token this one is short-lived (8h) but carries a
// refresh token (~29d), so the gauge refreshes it transparently: if the
// stored access token is within a 5-minute skew of expiry, run the refresh
// grant, re-store the rotated credential, and return the fresh access token.
// Every failure path returns null so the caller falls through to the next
// credential -- a transient refresh failure must NOT delete the stored
// credential (the refresh token may still be good next time).
const USAGE_REFRESH_SKEW_MS = 5 * 60 * 1000
async function readUsageOAuthToken() {
  let raw
  try { raw = readProviderKey(USAGE_PROVIDER_ID) } catch { return null }
  if (!raw) return null
  let cred
  try { cred = JSON.parse(raw) } catch { return null }
  if (!cred || !cred.accessToken) return null
  const stillFresh = !cred.expiresAt || cred.expiresAt - Date.now() > USAGE_REFRESH_SKEW_MS
  if (stillFresh) return cred.accessToken
  // Expiring or expired -> refresh. Never throws.
  const refreshed = await refreshUsageCredential(raw)
  if (!refreshed) {
    // Refresh failed. If the access token has not YET expired, use it anyway
    // (a refresh outage should not blind a still-valid meter); if it has,
    // return null and let the next credential answer.
    if (cred.expiresAt && cred.expiresAt < Date.now()) return null
    return cred.accessToken
  }
  try { storeProviderKeyVerified(USAGE_PROVIDER_ID, refreshed) } catch (err) {
    log(`usage-gauge: refreshed credential store failed: ${err.message}`)
  }
  try { return JSON.parse(refreshed).accessToken } catch { return null }
}

// force (2026-08-05, the owner: 수동 리프레시는 진짜 파싱이어야 함): the Refresh
// button passes ?force=1 to bypass the 60s read-cache -- without it a manual
// refresh inside the window is a silent no-op. The cache still gets WRITTEN
// (and stale-on-error still applies), only the read is skipped. All three
// fetchers share this contract.
async function fetchClaudeSubscriptionUsage(opts = {}) {
  const now = Date.now()
  if (!opts.force && usageCache && now - usageCache.at < 60_000) return usageCache.payload
  // Failure cooldown honors force only PARTIALLY: a manual refresh may retry
  // early, but never inside the first 15s -- a user hammering ↻ against a
  // rate-limited endpoint must not be the reason it stays rate-limited.
  if (usageFailCooldown && now < usageFailCooldown.until && (!opts.force || now < usageFailCooldown.hardUntil)) {
    return usageFailCooldown.payload
  }
  const failWith = (branch, detail, retryAfterMs) => {
    const payload = usageCache
      ? { ...usageCache.payload, stale: true, staleReason: detail || branch }
      : { ok: false, branch, ...(detail ? { detail } : {}) }
    const backoffMs = Math.max(60_000, Number(retryAfterMs) || 0)
    usageFailCooldown = { until: now + backoffMs, hardUntil: now + 15_000, payload }
    return payload
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const hit = async (token) => {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `scheherazade/${APP_VERSION}`,
      },
      signal: AbortSignal.timeout(8000),
    })
    return { res, body: await res.json().catch(() => null) }
  }
  // Credential priority (2026-08-13, the real fix for the win tester's stuck
  // 429). The FIRST credential the app can hold that actually reads the
  // endpoint is the full-scope 'claude-usage' OAuth token minted by the usage
  // login flow. The old app credential -- the setup-token -- carries
  // user:inference only and the endpoint refuses it (403, promoting to a
  // persistent 429 under polling), so it now sits BELOW the full-scope token
  // and above the machine's CLI session:
  //   1. claude-usage  (full-scope app OAuth, refreshed on the fly)
  //   2. claude-subscription  (setup-token; kept for boxes that only have it)
  //   3. this machine's Claude CLI login (macOS keychain / ~/.claude)
  let usageToken = null
  try {
    usageToken = await readUsageOAuthToken()
  } catch (err) {
    log(`usage-gauge: usage-oauth read failed: ${err.message}`)
  }
  let subToken = null
  try {
    subToken = (unwrapOAuthKey(readProviderKey('claude-subscription')) || {}).token || null
  } catch (err) {
    // A setup-token that cannot be decrypted is not fatal here: the
    // full-scope token or the CLI session may still answer.
    if (!usageToken) return failWith('token_unreadable', err.message)
  }
  let source = usageToken ? 'usage-oauth' : 'app-login'
  let out
  try {
    const firstToken = usageToken || subToken
    if (firstToken) out = await hit(firstToken)
    // Fall through on ANY non-ok. Each fallback is a DIFFERENT credential, so
    // one's 403/429 says nothing about the next's budget; the failure
    // cooldown above keeps this from doubling traffic while the endpoint is
    // genuinely down. "keep the better answer": a fallback only replaces the
    // prior read if it actually succeeded, so a total failure still reports
    // the FIRST credential's real status rather than hiding it.
    if ((!out || !out.res.ok) && usageToken && subToken) {
      const retry = await hit(subToken)
      if (retry.res.ok || !out) { out = retry; source = 'app-login' }
    }
    if (!out || !out.res.ok) {
      const cliToken = readCliSessionToken()
      if (cliToken) {
        const retry = await hit(cliToken)
        if (retry.res.ok || !out) { out = retry; source = 'cli-session' }
      }
    }
  } catch (err) {
    return failWith('unreachable', err.message)
  }
  if (!out) return failWith('no_token')
  if (!out.res.ok) {
    const ra = Number(out.res.headers && out.res.headers.get && out.res.headers.get('retry-after'))
    return failWith('http_error', `HTTP ${out.res.status}`, Number.isFinite(ra) ? ra * 1000 : 0)
  }
  const body = out.body || {}
  // Fable weekly pool (same shape the fleet's usage-poll.sh parses since
  // 2026-07-02): the dedicated Fable quota lives inside the generic
  // 'limits' array as a 'weekly_scoped' entry keyed by
  // scope.model.display_name. NOT in a top-level bucket like five_hour.
  let fablePct = null
  const limits = Array.isArray(body.limits) ? body.limits : []
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue
    if (item.kind !== 'weekly_scoped') continue
    const scope = (item.scope && typeof item.scope === 'object') ? item.scope : {}
    const model = (scope.model && typeof scope.model === 'object') ? scope.model : {}
    const name = typeof model.display_name === 'string' ? model.display_name.trim().toLowerCase() : ''
    if (name === 'fable') {
      fablePct = num(typeof item.percent === 'number' ? item.percent : null)
      break
    }
  }
  const payload = {
    ok: true,
    source, // 'app-login' | 'cli-session' -- UI labels whose login the meter reads
    fiveHourPct: num(body.five_hour && body.five_hour.utilization),
    weeklyPct: num(body.seven_day && body.seven_day.utilization),
    fiveHourResetsAt: (body.five_hour && body.five_hour.resets_at) || null,
    weeklyResetsAt: (body.seven_day && body.seven_day.resets_at) || null,
    fablePct, // null when absent (non-fable subscription) -- UI skips the gauge
    asOf: new Date(now).toISOString(),
  }
  usageCache = { at: now, payload }
  usageFailCooldown = null
  return payload
}

// ── Codex/ChatGPT usage gauge (2026-08-04, the owner: "ollama/Codex/Claude
// 사용량 게이지 ... CodexBar같은것처럼 잘 보여야하는데, 이게 킥임") ──────
// Mechanism = CodexBar's own (verified in its docs/codex.md and live
// against this machine 19:3x: HTTP 200, plan_type/rate_limit shape below):
// bearer from ~/.codex/auth.json (tokens.access_token; $CODEX_HOME
// honored), GET chatgpt.com/backend-api/wham/usage. PRIVATE endpoint --
// undocumented, no contract, parse defensively and fail as a branch, never
// a throw. Same 60s-cache + stale-on-error discipline as the claude gauge.
// window labels derive from limit_window_seconds (a prolite plan's PRIMARY
// window is 7d/604800s -- never assume 5h).
//
// Ollama cloud: NO usage/quota API exists (ollama/ollama#15663 closed-dup,
// #16448/#15132 open asks; /api/chat only returns per-call token counts).
// The UI says so honestly and links the dashboard -- nothing to poll here.
let codexUsageCache = null // { at, payload } -- last GOOD reading only
function readCodexAccessToken() {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    const raw = fs.readFileSync(path.join(home, 'auth.json'), 'utf8')
    const auth = JSON.parse(raw)
    const token = auth && auth.tokens && typeof auth.tokens.access_token === 'string' && auth.tokens.access_token
      ? auth.tokens.access_token : null
    return token || null
  } catch { return null }
}
async function fetchCodexUsage(opts = {}) {
  const now = Date.now()
  if (!opts.force && codexUsageCache && now - codexUsageCache.at < 60_000) return codexUsageCache.payload
  const failWith = (branch, detail) => {
    if (codexUsageCache) return { ...codexUsageCache.payload, stale: true, staleReason: detail || branch }
    return { ok: false, branch, ...(detail ? { detail } : {}) }
  }
  const token = readCodexAccessToken()
  if (!token) return failWith('no_token')
  let res, body
  try {
    res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': `scheherazade/${APP_VERSION}` },
      signal: AbortSignal.timeout(8000),
    })
    body = await res.json().catch(() => null)
  } catch (err) {
    return failWith('unreachable', err.message)
  }
  if (!res.ok) return failWith('http_error', `HTTP ${res.status}`)
  const win = (w) => (w && typeof w === 'object' && Number.isFinite(w.used_percent)
    ? {
        usedPct: w.used_percent,
        windowSeconds: Number.isFinite(w.limit_window_seconds) ? w.limit_window_seconds : null,
        resetsAt: Number.isFinite(w.reset_at) ? new Date(w.reset_at * 1000).toISOString() : null,
      }
    : null)
  const rl = (body && body.rate_limit) || {}
  const payload = {
    ok: true,
    planType: (body && typeof body.plan_type === 'string' && body.plan_type) || null,
    primary: win(rl.primary_window),
    secondary: win(rl.secondary_window),
    asOf: new Date(now).toISOString(),
  }
  codexUsageCache = { at: now, payload }
  return payload
}

// ── Ollama cloud usage gauge (2026-08-04, the owner "ollama도 사용량 받을 수
// 있어야해, 어떻게든 해봐") ────────────────────────────────────────────
// No DOCUMENTED usage API exists (ollama/ollama#15663/#16448/#15132), but
// live probing tonight found UNDOCUMENTED auth-gated endpoints:
//   GET https://ollama.com/api/usage  -> 401 {"error":"invalid credentials"}
//   POST https://ollama.com/api/me    -> 401
// (404 for /api/account, /api/credits, /v1/usage -- these two are real.)
// Response SHAPE with a valid key is unverified -- no real key on the dev
// machine. So: parse defensively for plausible numeric fields; when the
// shape is unrecognized, return branch 'unknown_shape' with the top-level
// FIELD NAMES ONLY (never values -- could contain account data) so the
// first real-key Refresh in the field tells us the schema to bind.
let ollamaUsageCache = null // { at, payload } -- last GOOD reading only
// ── dynamic Ollama model catalog (2026-08-13, same ask as the Claude scan:
// "모델 리스트 하드코딩 말고 다이나믹하게") ────────────────────────────────
// ollama.com's /api/tags answers 200 WITHOUT auth (probed 2026-08-04, same
// endpoint the key-validate path reads for its modelPresent hint), so the
// picker's Ollama group can carry the LIVE catalog. 10min success cache +
// stale-on-error: this is a dropdown filler, nothing here is worth a
// per-page-load fetch or a hard failure -- [] on any error, the curated
// static rows stand.
// (Codex has NO dynamic catalog and structurally can't get one the way
// Ollama does: codex-as-api (now 0.6.5, task #6) exposes no model list --
// no JS export of its capability table, and the running proxy serves no
// /v1/models route (only /health for the ONE configured model). The 0.5.2
// "table stops at gpt-5.5" reason is gone -- 0.6.5's table now carries the
// full 5.6 family -- but the table stays INTERNAL, so there is nothing to
// fetch. The chatgpt rows therefore stay a curated static catalog
// (connectors.js), and the context caps stay hand-pinned (contextCapForModel
// above). What keeps the hand-pin from rotting on the next bump is a live
// drift guard, NOT a runtime scan: tests/test-codex-proxy-model.mjs boots
// each catalog GPT model in-process and asserts the proxy's own /health
// context_window still equals the pinned cap.)
let ollamaCatalogCache = null // { at, names }
async function fetchOllamaCloudCatalog(opts = {}) {
  const now = Date.now()
  if (!opts.force && ollamaCatalogCache && now - ollamaCatalogCache.at < 600_000) return ollamaCatalogCache.names
  try {
    const res = await fetch(`${OLLAMA_CLOUD_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_CLOUD_TIMEOUT_MS) })
    const body = await res.json()
    const names = Array.isArray(body.models) ? body.models.map((m) => String(m.name || '')).filter(Boolean).sort() : []
    if (names.length) ollamaCatalogCache = { at: now, names }
    return names
  } catch (err) {
    return ollamaCatalogCache ? ollamaCatalogCache.names : []
  }
}

async function fetchOllamaUsage(opts = {}, deps = {}) {
  // deps: { fetch, readKey, now } -- injected by tests/test-ollama-usage.mjs;
  // production callers pass nothing and get the globals.
  const fetchFn = deps.fetch || fetch
  const readKey = deps.readKey || readProviderKey
  const now = typeof deps.now === 'function' ? deps.now() : Date.now()
  if (!opts.force && ollamaUsageCache && now - ollamaUsageCache.at < 60_000) return ollamaUsageCache.payload
  const failWith = (branch, detail) => {
    if (ollamaUsageCache) return { ...ollamaUsageCache.payload, stale: true, staleReason: detail || branch }
    return { ok: false, branch, ...(detail ? { detail } : {}) }
  }
  let key = null
  try { key = readKey('ollama') } catch (err) { return failWith('key_unreadable', err.message) }
  if (!key) return failWith('no_key')
  let res, body
  try {
    res = await fetchFn('https://ollama.com/api/usage', {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': `scheherazade/${APP_VERSION}` },
      signal: AbortSignal.timeout(8000),
    })
    body = await res.json().catch(() => null)
  } catch (err) {
    return failWith('unreachable', err.message)
  }
  if (!res.ok) return failWith('http_error', `HTTP ${res.status}`)
  if (!body || typeof body !== 'object') return failWith('empty_body')
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const asOf = new Date(now).toISOString()

  // Shape 2 ('totals'), BOUND from a real-key receipt 2026-10-07 15:22
  // (status 200) after ollama.com changed its weekly accounting this month:
  // { range:'7d', scope:'self', granularity:'day', from, until,
  //   totals:{request_count, usage_usd, input_tokens, cached_input_tokens,
  //   output_tokens}, buckets:[{from, until, request_count, usage_usd, ...}] }.
  // No limits / fraction / quota field exists anywhere in the payload and no
  // limits endpoint was found (/api/limits, /api/plan, /api/subscription all
  // 404), so a percent gauge is NOT derivable -- the UI shows spend only.
  const totals = body.totals && typeof body.totals === 'object' ? body.totals : null
  if (totals && (num(totals.request_count) != null || num(totals.usage_usd) != null)) {
    const rawBuckets = Array.isArray(body.buckets) ? body.buckets : []
    const buckets = rawBuckets
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        day: typeof b.from === 'string' ? b.from.slice(0, 10) : null,
        requests: num(b.request_count),
        usd: num(b.usage_usd),
      }))
    const last = buckets.length ? buckets[buckets.length - 1] : null
    const payload = {
      ok: true,
      shape: 'totals',
      range: typeof body.range === 'string' ? body.range : null,
      from: typeof body.from === 'string' ? body.from : null,
      until: typeof body.until === 'string' ? body.until : null,
      weeklyRequests: num(totals.request_count),
      weeklyUsd: num(totals.usage_usd),
      inputTokens: num(totals.input_tokens),
      cachedInputTokens: num(totals.cached_input_tokens),
      outputTokens: num(totals.output_tokens),
      todayRequests: last ? last.requests : null,
      todayUsd: last ? last.usd : null,
      buckets,
      // Legacy pct fields stay present-but-null so an older UI build on a
      // cached page renders "unreadable" instead of throwing.
      sessionPct: null,
      weeklyPct: null,
      asOf,
    }
    ollamaUsageCache = { at: now, payload }
    return payload
  }

  // Shape 1 ('limits'), BOUND from a real-key receipt (the owner's terminal,
  // 2026-08-04 19:38): { activity: {cost, period, models}, limits: { session:
  // {usage: 0.918, models:[{name, request_count}...]}, weekly: {usage:
  // 0.428, models:[...]} } }. usage is a 0-1 fraction; NO reset timestamps
  // in this payload (the dashboard's "Resets in 3 hours" comes from
  // elsewhere) -- so resets stay null-honest here, never computed.
  // ollama.com stopped serving this shape 2026-10; kept so a rollback on
  // their side keeps the gauge working.
  const frac = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 10 : null)
  const limits = body.limits && typeof body.limits === 'object' ? body.limits : null
  const sessionPct = frac(limits && limits.session && limits.session.usage)
  const weeklyPct = frac(limits && limits.weekly && limits.weekly.usage)
  if (sessionPct == null && weeklyPct == null) {
    // Unrecognized shape: surface field NAMES only (never values) so the
    // next real-key refresh is the schema receipt for a re-bind.
    return failWith('unknown_shape', `fields: ${Object.keys(body).slice(0, 12).join(', ') || '(none)'}`)
  }
  const weeklyRequests = limits && limits.weekly && Array.isArray(limits.weekly.models)
    ? limits.weekly.models.reduce((n, m) => n + (Number.isFinite(m && m.request_count) ? m.request_count : 0), 0)
    : null
  const payload = {
    ok: true,
    shape: 'limits',
    sessionPct,
    weeklyPct,
    weeklyRequests,
    asOf,
  }
  ollamaUsageCache = { at: now, payload }
  return payload
}

// Test seam (tests/test-ollama-usage.mjs): the cache is module-scope state,
// so a test that exercises the stale branch needs a way to start clean.
function _resetOllamaUsageCache() { ollamaUsageCache = null }

// ── vision stand-in captioning (0.0.56, the owner 2026-08-04 20:03 "비전이
// 없으면 fallback으로 작은 비전모델 붙여서 같이 지원하면 되는거 아니냐") ──
// When the LANE model cannot see images, the chat upload route asks a
// small vision-capable cloud model -- same ollama key, same Messages API
// the lane itself rides -- to describe the image, and the chat page folds
// that description into the attachment marker. A text-only lane then gets
// the CONTENT of the image, not just the fact that a file exists.
//
// YES-list bound from live ollama.com/library capability pills
// (2026-08-04 scrape receipts, session notes idea/2026-08-04):
//   vision: kimi-k2.7-code, kimi-k3, kimi-k2.6, gemma4, qwen3.5,
//           minimax-m3, mistral-large-3
// 2026-09-16 catalog refresh addition: deepseek-v4.1-flash. ollama.com's
// library page for it carries the `vision` pill (tags page: input "Text,
// Image", 1M context, single :cloud tag, 6 days old at the scrape), and the
// id tool-call-probed clean against ollama.com/v1/chat/completions the same
// day. Without this row the lane took the Gemma caption fallback for images
// a model that can actually see would have read. Mirrored in
// onboarding/public/js/chat.js and channel-slack.mjs -- change all three.
// 2026-09-17 addition (owner override that put the row in the picker):
// glm-5.3-flash. Same receipt shape -- ollama.com's library page carries the
// `vision` pill for it and the id tool-call-probed clean on 2026-09-16. Note
// the family split this creates: glm-5.2 and glm-5.3 are TEXT-ONLY (tools +
// thinking pills only) and stay off this list, while glm-5.3-flash is the
// natively-multimodal one. Match on the full id, never a `glm-5.3` prefix.
// chat.js keeps a mirror of this list for its pre-send toast; change both.
// 0.1.4 policy rewrite (the owner 2026-08-11 13:54): first-party providers are
// vision-'yes'; EVERYTHING else defaults to 'no' (Gemma caption stand-in)
// unless the model is on the known-vision YES list. There is no 'unknown'
// state anymore -- 'unknown' was the dangerous one: it skipped the caption
// AND invited a Read-tool image read that poisoned non-vision transcripts.
// A default-'no' worst case is an unnecessary caption for a vision-capable
// unlisted model; the old worst case was a bricked conversation.
const VISION_YES_MODELS = new Set(['kimi-k2.7-code', 'kimi-k3', 'kimi-k2.6', 'gemma4', 'qwen3.5', 'minimax-m3', 'mistral-large-3', 'deepseek-v4.1-flash', 'glm-5.3-flash'])
// Smallest vision model in the cloud catalog (31b, vs 397b/675b upward) --
// caption latency and quota cost scale with this pick.
const OLLAMA_CAPTION_MODEL = 'gemma4:31b'

function laneVision(spawn) {
  const provider = String((spawn && spawn.provider) || '')
  // spawn.live.model (route proxy, 2026-10-07): the model the proxy sends
  // NOW -- a live switch moves it without a respawn. Mirror of chat.js
  // liveModelOf; change both together.
  const model = String((spawn && ((spawn.live && spawn.live.model) || spawn.model)) || '')
  const base = model.replace(/:.*$/, '') // strip :tag (deepseek-v4-flash:0731)
  // First-party frontier lanes (Claude subscription/API, Codex proxy) all
  // ship vision. Everything else -- ollama, custom, null spawn-info -- is
  // 'no' unless the model is on the known-vision list. Never 'unknown'.
  if (/^claude/.test(provider) || /^claude/.test(model) || provider === 'chatgpt') return 'yes'
  // dsh (0.2.1): 'yes' because the LANE routes image turns itself -- it
  // lifts [image attached:] markers into inline image parts and switches
  // the session to the vision model for that turn (dsh-lane.mjs
  // buildPromptContent/promptWithVision). 'no' here would fire the
  // ollama.com caption fallback, which needs a cloud key this
  // credential-less lane does not have. PDFs stay a known gap -- the lane
  // rewrites their marker to an honest cannot-view note.
  if (provider === 'dsh') return 'yes'
  if (VISION_YES_MODELS.has(base)) return 'yes'
  return 'no'
}

async function fetchImageCaption(imageBase64, mediaType) {
  let key = null
  try { key = readProviderKey('ollama') } catch { return { ok: false, reason: 'key_unreadable' } }
  if (!key) return { ok: false, reason: 'no_key' }
  let res, body
  try {
    res = await fetch('https://ollama.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'User-Agent': `scheherazade/${APP_VERSION}` },
      body: JSON.stringify({
        model: OLLAMA_CAPTION_MODEL,
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'Describe this image thoroughly for someone who cannot see it: overall layout, ALL readable text verbatim, UI elements and their states, numbers, charts, people or objects, and anything unusual. Plain prose, no preamble.' },
          ],
        }],
      }),
      // Generous: a cold 31b vision call can take a while; the upload
      // request that awaits this is a human clicking attach, not a poll.
      signal: AbortSignal.timeout(45_000),
    })
    body = await res.json().catch(() => null)
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` }
  const text = body && Array.isArray(body.content)
    ? body.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim()
    : ''
  if (!text) return { ok: false, reason: 'empty_caption' }
  return { ok: true, caption: text, model: OLLAMA_CAPTION_MODEL }
}

// Update check against the PUBLIC releases repo (the download surface
// testers actually use). v1 is notify + one-click download page -- a real
// in-place auto-update needs a signed app on macOS, deferred with the owner.
// Cache: GitHub unauthenticated API allows 60 req/h/IP; 6h on success,
// 10min on failure so a rate-limit blip cannot wedge the check until
// restart.
const UPDATE_RELEASES_REPO = 'Mino-is-me/scheherazade-releases'
let updateCheckCache = null // { at, payload }
const { isNewerVersion, fetchLatestRelease } = require('./update-version.cjs')
async function checkForUpdate(force = false) {
  // force=true (Settings "Check now" button, the owner 19:14 "오토 업데이트
  // 버튼 어딨니?") bypasses the read side of the cache but still WRITES it,
  // so a manual check refreshes the banner's data too. Rate-limit safety
  // holds: the button is a human click, not a poll loop.
  const now = Date.now()
  if (!force && updateCheckCache) {
    const ttl = updateCheckCache.payload.ok ? 6 * 3600_000 : 10 * 60_000
    if (now - updateCheckCache.at < ttl) return updateCheckCache.payload
  }
  let payload
  try {
    const body = await fetchLatestRelease({ repo: UPDATE_RELEASES_REPO, current: APP_VERSION })
    const latestTag = body.tag_name
    const hasUpdate = isNewerVersion(latestTag, APP_VERSION)
    payload = {
      ok: true,
      current: APP_VERSION,
      latest: latestTag.replace(/^v/, ''),
      hasUpdate,
      url: `https://github.com/${UPDATE_RELEASES_REPO}/releases/tag/${encodeURIComponent(latestTag)}`,
    }
  } catch (err) {
    payload = { ok: false, current: APP_VERSION, hasUpdate: false, detail: err.message }
  }
  updateCheckCache = { at: now, payload }
  return payload
}

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
  readDiscordToken, enumerateDiscordTargets, activeChannelBackend, enabledChannelBackends, migrateChannelBackendsOnDisk,
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
  // full-scope OAuth capture for the usage gauge (claude-usage)
  getUsageOAuthSession,
  // in-app Claude login for the agent lane (claude-subscription, no CLI)
  getLoginOAuthSession,
  // usage gauge + update check (2026-08-04 tester requests)
  fetchClaudeSubscriptionUsage, fetchCodexUsage, fetchOllamaUsage, checkForUpdate, APP_VERSION,
  extractClaudeModelsFromBin, fetchOllamaCloudCatalog,
  readAppearance, writeAppearance, AppearanceModel,
  // vision stand-in captioning (0.0.56)
  laneVision, fetchImageCaption,
  // claude CLI install-assist (2026-08-04, the owner "2로 가자")
  startClaudeCliInstall, getClaudeInstallStatus,
  // agent status / model table
  computeAgentStatus, contextCapForModel,
  // autonomy
  autonomyBudget, autonomyCycle, readAutonomyState,
  // logs / topology / permission probes
  logBuffer, attachTopology, permissionProbes,
  // host capability table (design-0023 P4) -- routes ask it instead of
  // re-testing process.platform. One require, one answer, three platforms.
  HOST,
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
  ...require('./routes/settings.cjs').createRoutes(staticCtx),
  ...require('./routes/profiles.cjs').createRoutes(staticCtx), // design-0029 // G9
  ...require('./routes/setup-token.cjs').createRoutes(staticCtx), // G10
  ...require('./routes/companion.cjs').createRoutes(staticCtx),
  ...require('./routes/chat.cjs').createRoutes(staticCtx), // G11
  ...require('./routes/migrate.cjs').createRoutes(staticCtx), // G12 (design-0022)
  ...require('./routes/oauth-usage.cjs').createRoutes(staticCtx), // G13 (usage-gauge full-scope OAuth)
  ...require('./routes/files.cjs').createRoutes(staticCtx), // G14 (recent-files ledger, 같이보기 batch 2026-08-19)
  ...require('./routes/oauth-login.cjs').createRoutes(staticCtx), // G15 (in-app Claude login → claude-subscription, drops CLI dep)
  ...require('./routes/quickbar.cjs').createRoutes(staticCtx),
  ...require('./routes/pending-signal.cjs').createRoutes(staticCtx), // G16 (design-0024 pending signal "!")
  ...require('./routes/memory-files.cjs').createRoutes(staticCtx), // G17 (Memory page folder view: read-only DATA_HOME tree + file text, 0.3.8)
  ...require('./routes/tts.cjs').createRoutes(staticCtx), // G18 read-aloud (local Pocket-TTS Korean, model fetched on first enable)
  ...require('./routes/stt.cjs').createRoutes(staticCtx), // G19 voice input (local Korean streaming STT, model fetched on first enable)
]

module.exports = {
  createOnboardingServer,
  // Ollama usage gauge parser + its cache reset, for tests/test-ollama-usage.mjs
  fetchOllamaUsage, _resetOllamaUsageCache,
  // Exported for tests/test-agent-status-read.mjs (sleep/wake false-fail
  // fix, 2026-08-15): the READ side of liveness (marker freshness + timeout
  // backstop) finally gets its own unit test. Pure fs/Date logic, no
  // Electron dependency.
  computeAgentStatus,
  // Page-scrape fix (2026-08-07): main.cjs and dev-serve-ui.mjs load the
  // window/browser through /boot so it acquires the UI session cookie that
  // HTML serving now requires. SERVER_TOKEN is exported for the IN-PROCESS
  // e2e suites, which used to prove the bypass by scraping it off a page —
  // that scrape now 403s, which is the point.
  bootPathFor,
  SERVER_TOKEN,
  AGENT_NAME,
  DATA_HOME,
  contextCapForModel,
  // Exported for test pins (dynamic model catalog, 2026-08-13).
  extractClaudeModelsFromBin,
  fetchOllamaCloudCatalog,
  // Exported for test pins (vision stand-in table, 0.0.56) -- pure fn.
  laneVision,
  readAgentConfig,
  // main.cjs: companion toggle (COMPANION_ENABLED) is flipped from its tray menu too.
  writeAgentConfig,
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
  onProviderKeyStored,
  // Exported for main.cjs's pre-spawn gate and
  // tests/test-harness-refresh.mjs (pure, no Electron dependency): a
  // failed boot harness refresh must stop the spawn, not just print a line.
  // Kept here rather than in main.cjs because this file owns both
  // DATA_HOME and the render itself.
  readHarnessFailure: harnessRender.readHarnessFailure,
  HARNESS_FAILURE_PATH: harnessRender.HARNESS_FAILURE_PATH,
  refreshHarnessIfOnboarded: harnessRender.refreshHarnessIfOnboarded,
  // Exported for tests/test-identity-firewall.mjs (vector #2): the
  // settings.local.json seed + additive migration path, which boot runs via
  // startOnboardingServer rather than the harness refresh above.
  seedConfigFromTemplates: harnessRender.seedConfigFromTemplates,
  // Exported for tests/test-credential-store.mjs (pure, no Electron
  // dependency): getElectron() requires 'electron' lazily precisely so
  // this file stays testable outside an Electron main process, so the
  // harness injects a safeStorage stub and drives the real code --
  // including the two refusal branches (encryption unavailable,
  // round-trip mismatch) that must never leave a key in plaintext.
  storeProviderKeyVerified,
  // Exported for tests/test-custom-provider-validate.mjs (pure, no
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
  // Exported for tests/test-session-feed.mjs (pure function, no db): the
  // net-change collapse is attackable without spinning up Electron or a
  // memory db.
  collapseSessionEvents,
  // Exported for tests/test-discord-reconnect.mjs (fetchImpl-injectable):
  // every branch (3-check failures, truncation, channel filtering) runs
  // against fixtures, never the live Discord API.
  enumerateDiscordTargets,
  // Exported for tests/test-mcp-connector.mjs (pure functions, no spawn):
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
  // The host capability table, re-exported so a test (or main.cjs) can read
  // the SAME answers the routes do without a second require path.
  HOST,
  killAllLoginChildren,
  // Multichannel: backend resolution + per-backend credential readers for
  // main.cjs's spawn-time env injection (same seam as readDiscordToken
  // above), plus fetchImpl-injectable enumerators for
  // tests/test-channel-connect.mjs (pure, no Electron dependency).
  activeChannelBackend, enabledChannelBackends, migrateChannelBackendsOnDisk,
  // Exported so tools/test-packaging.mjs can DERIVE the list of channel
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
