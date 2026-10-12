#!/usr/bin/env node
// supervisor.mjs -- THE agent supervisor, on mac, Windows and Linux.
//
// It began (Windows-port Phase 1) as a node port of the bash `run.sh` loop and
// ran only on Windows while run.sh stayed production on mac and Linux. Since
// design-0023 P3 there is one lane: run.sh is deleted and this file is what
// main.cjs spawns everywhere, as `process.execPath supervisor.mjs __loop` with
// ELECTRON_RUN_AS_NODE=1. What that bought: one restart ladder instead of two,
// one watchdog instead of three (timeout(1) / a bash sleep+pkill subshell /
// this file's timers), no `/bin/bash` hardcode to ENOENT on a minimal Linux
// image, and a DETERMINISTIC runtime for the lane and the dsh engine
// (process.execPath) instead of whatever `node` PATH happened to resolve.
//
// The semantics are still run.sh's, deliberately: backoff ladder 5/10/20/40/120,
// uptime-only restart policy, the daily backoff reset, the `.agent-failed.json`
// shape, and the PIDFILE/STOPFLAG/FAILFILE contract shared with main.cjs
// (docs/supervisor-design.md -- a LOCKED contract, names and semantics). The
// two deliberate improvements over the bash original are kill-by-HANDLE on the
// stop path instead of a blind pkill, and a signal handler that reaps the child
// before exiting. run.sh line receipts stay in the comments below: they are the
// argument for why each rule exists, and they outlived the file.
//
// Runtime: plain node OR Electron with ELECTRON_RUN_AS_NODE=1. No node-pty, no
// PTY, no TUI: the child is dsh-lane.mjs (default) or headless-lane.mjs over
// plain pipes.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn as cpSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
// One process-control seam for all three platforms (design-0023 P3): the
// absolute-powershell CommandLine read, the $PID-excluding orphan sweep, the
// taskkill /T tree kill and the PATHEXT resolver all used to live HERE as the
// best of four hand-copies. They now live in proc.cjs and every caller
// (main.cjs, the onboarding server, ollama-daemon) shares them.
import { isPidAlive, readCommandLine as procReadCommandLine, killTree, sweepByPattern, gracefulStop, resolveOnPath } from './proc.cjs'
import { resolveDataHome } from './data-home.cjs'
import { localDate, localStamp, agentTimeZone } from './local-date.cjs'

const SELF_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(SELF_PATH)
const IS_WIN = process.platform === 'win32'

// ── auto-answer layer: REMOVED (design-0020, headless topology) ─────────────
// The expect-parity dialog matcher (trust / confirm / local development /
// text style / BYOK "1"-no-CR) answered TUI dialogs that `claude -p` never
// renders. The whole class is gone with the PTY: the child is now
// headless-lane.mjs -> claude -p stream-json, which has no dialogs to
// answer. The BYOK first-approval behavior in -p mode is design-0020's open
// verification item; if it needs handling, it belongs in the key-save flow,
// not in a resurrected screen-scraper. (history: the full matcher and its
// keystroke forensics live in git before this commit, and in
// docs/HISTORY.md.)

// ── backoff ladder (run.sh:394-400, verbatim) ───────────────────────────────
export function backoffFor(restartCount) {
  if (restartCount <= 1) return 5
  if (restartCount === 2) return 10
  if (restartCount === 3) return 20
  if (restartCount === 4) return 40
  return 120
}

// ── local clock (design-0023 P3: one helper, AGENT_TZ, default Asia/Seoul) ──
// The daily backoff reset and the log stamp used to hardcode Asia/Seoul here
// and in six other files. Same default, so KST installs see no change; a user
// who sets AGENT_TZ now gets a supervisor whose "new day" is the same day the
// note filenames, the journal rows and the nightly cadence use.
export { localDate }

function makeLog(now = () => Date.now()) {
  return (msg) => console.log(`[${localStamp(now())}] ${msg}`)
}

// ── .agent-config parser ────────────────────────────────────────────────────
// Mirrors onboarding/http-server.cjs readAgentConfig() EXACTLY -- that file's
// writeAgentConfig()/shellQuote() is the producer, and bash `source` was the
// original consumer. Same KEY=VALUE lines, same double-quote + \\ \" \$ \`
// escaping. test-supervisor.mjs round-trips shellQuote output through this.
export function parseAgentConfig(text) {
  const out = {}
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
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

// ── config resolution (run.sh:38-109, once per supervisor lifetime) ─────────
// Verdict 5: once-per-lifetime env resolution is REPLICATED. Re-resolving
// per-restart would silently change fleet-known swap semantics ("effort
// changes need a full bounce"). Precedence mirrors bash `source`: values in
// the config file OVERWRITE inherited env for the keys they set; the env-only
// path (main.cjs pre-exports, no file) is the fallback.
export function resolveConfig(env = process.env, scriptDir = SCRIPT_DIR) {
  const configFile = env.AGENT_CONFIG_FILE || path.join(scriptDir, '.agent-config')
  let fileVals = {}
  if (fs.existsSync(configFile)) {
    fileVals = parseAgentConfig(fs.readFileSync(configFile, 'utf8'))
  } else if (!env.AGENT_NAME) {
    throw new Error(`no .agent-config found at ${configFile}, and AGENT_NAME is not already set in the environment -- run the app once to complete onboarding (it writes .agent-config), or invoke with AGENT_NAME (and optionally CLAUDE_BIN/MODEL/AGENT_DATA_HOME) pre-exported`)
  }
  const merged = { ...env, ...fileVals }
  // Lane switch (0.2.2 full harness swap): EVERY provider row now emits
  // LANE_KIND=dsh, and dsh is also the default -- the claude lane survives
  // only behind an explicit LANE_KIND=headless escape hatch (requires a
  // Claude Code CLI install; kept for emergency rollback, not offered by
  // any provider row).
  const laneKind = merged.LANE_KIND === 'headless' ? 'headless' : 'dsh'
  const agentName = merged.AGENT_NAME
  if (!agentName) throw new Error('AGENT_NAME missing from config/env')
  const mem = resolveDataHome({ env: merged, agentName, allowMem: false }) // the supervisor SETS MEM for its child; reading one from its own env would be circular
  const model = merged.MODEL || 'claude-opus-4-6'
  const claudeBin = merged.CLAUDE_BIN || 'claude'
  return {
    agentName,
    mem,
    model,
    claudeBin,
    pidfile: path.join(mem, '.agent.pid'),
    logfile: path.join(mem, 'logs', 'agent.log'),
    stopflag: path.join(mem, '.stop_requested'),
    failfile: path.join(mem, '.agent-failed.json'),
    // Stop-time reaper patterns, carried over verbatim from run.sh's
    // PKILL_PATTERN/PKILL_LEAF_PATTERN (design-0020): the lane's FULL
    // script path (basename alone cross-matched any argv mentioning the
    // file -- editor, grep, the E2E driver's own pkill; live bite
    // 2026-08-04) matches the `node .../headless-lane.mjs` process; the
    // leaf pattern matches an orphaned `claude -p` child via its
    // --mcp-config argv (stable per-agent path -- never key the reaper to
    // post-spawn-mutable fields like MODEL, the 2026-07-03 lesson). Here
    // they only serve the orphan sweep; live kills go through the child
    // handle.
    laneKind,
    pkillPattern: path.join(path.dirname(SELF_PATH), laneKind === 'dsh' ? 'dsh-lane.mjs' : 'headless-lane.mjs'),
    // dsh leaf: an orphaned dsh web engine is matched by its --patch argv
    // (stable per-agent path under MEM, written by dsh-lane's buildPatch) --
    // same never-key-on-mutable-fields rule as the --mcp-config leaf.
    legacyDshLeafPattern: laneKind === 'dsh' ? `--patch ${path.join(mem, '.dsh-lane-home', 'lane.patch.yml')}` : null,
    pkillLeafPattern: laneKind === 'dsh'
      ? `--patch ${path.join(mem, '.dsh-lane-home', 'lane.runtime.patch.yml')}`
      : `--mcp-config ${path.join(mem, '.mcp.json')}`,
    sessionTimeoutSec: Number(merged.SESSION_TIMEOUT) > 0 ? Number(merged.SESSION_TIMEOUT) : 43200,
    // v0.0.15 stall watchdog window (seconds). 0 disables. Default 15 min
    // (see the stall/thrash watchdog block below for why).
    // '15m', '900s', or an empty STALL_TIMEOUT= all used to coerce to 0 via
    // `Number(x) || 0`, which SILENTLY disabled the whole stall/thrash
    // watchdog -- the v0.0.15 incident recurring with a user message
    // unanswered for hours until the 12h session timeout recycled it. An
    // explicit 0 still disables (that is the documented opt-out); anything
    // unparseable falls back to the default and says so.
    stallTimeoutSec: parseStallTimeout(merged.STALL_TIMEOUT),
    systemPromptFile: fs.existsSync(path.join(mem, 'system_prompt.md')) ? path.join(mem, 'system_prompt.md') : null,
    // Context-bleed fix (2026-07-28): same guarded shape as
    // systemPromptFile -- see run.sh's MCP_CONFIG_FILE comment for the
    // full why (global ~/.claude.json MCP schemas riding into every
    // session; 133K-at-boot live catch). No file -> no strict flag.
    mcpConfigFile: fs.existsSync(path.join(mem, '.mcp.json')) ? path.join(mem, '.mcp.json') : null,
    // Claude Code tuning knobs (run.sh:60-63) -- resolved once, exported to
    // the child on every respawn.
    childEnvExtra: {
      CLAUDE_CODE_EFFORT_LEVEL: merged.EFFORT_LEVEL || 'high',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: merged.STREAM_IDLE_TIMEOUT || '300000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: merged.AUTO_COMPACT_WINDOW || '500000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: merged.AUTOCOMPACT_PCT || '80',
    },
  }
}

// Child argv: OWNED BY headless-lane.mjs (buildArgs) since design-0020. This
// supervisor only passes the env contract (AGENT_NAME / MEM / CLAUDE_BIN /
// MODEL / SYSTEM_PROMPT_FILE? / MCP_CONFIG_FILE? / tuning knobs), so argv is
// single-sourced by construction. test-supervisor.mjs pins the env contract
// instead of an argv table.

// ── node shim for the hook lane (v0.0.15 Root A fix) ────────────────────────
// Claude Code hook commands (ours AND third-party plugins') start with bare
// `node`, executed via /bin/sh from the CLI child. On a box with no system
// node the entire hook lane dies with exit 127, which silences
// stop-reply-guard, the rumination gate, and every other protection while
// the incidents they existed for are happening. The win-port Phase 3
// bash->mjs port made this strictly worse: the bash hooks it replaced ran
// everywhere. (history: docs/HISTORY.md)
//
// Fix at the ENV layer, not the command layer: write MEM/bin/node as a tiny
// exec shim onto the supervisor's own runtime (Electron-as-node in the app
// lanes, plain node in dev -- either way process.execPath can run .mjs), and
// APPEND that dir to the child PATH. Append, not prepend: a real system node
// always wins; the shim only fills absence. Command strings in
// settings.local.json are never rewritten, so this also heals hooks we do
// not own (third-party plugin `node "${CLAUDE_PLUGIN_ROOT}/..."` hooks).
// Regenerated on every spawn so an app move or update never leaves the shim
// pointing at a dead binary.
export function ensureNodeShim(cfg, { execPath = process.execPath, env = process.env, log = () => {} } = {}) {
  const binDir = path.join(cfg.mem, 'bin')
  try {
    fs.mkdirSync(binDir, { recursive: true })
    if (IS_WIN) {
      // Windows GA checklist (review S3c): node.cmd resolution depends on
      // PATHEXT containing .CMD -- verify on a real win box before the port
      // ships; a stripped PATHEXT would neuter the shim silently.
      const cmd = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`
      const shimPath = path.join(binDir, 'node.cmd')
      if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, 'utf8') !== cmd) fs.writeFileSync(shimPath, cmd)
    } else {
      const sh = `#!/bin/sh\n# scheherazade node shim -- regenerated at every agent spawn; do not edit.\n# Fills PATH-node absence so Claude Code hook commands (\`node ...\`) can run.\nexport ELECTRON_RUN_AS_NODE=1\nexec "${execPath}" "$@"\n`
      const shimPath = path.join(binDir, 'node')
      if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, 'utf8') !== sh) fs.writeFileSync(shimPath, sh)
      fs.chmodSync(shimPath, 0o755)
    }
  } catch (err) {
    // Fail-soft with a loud line: a broken shim write must not stop the agent
    // from booting -- it just returns the child to the pre-fix hook behavior.
    log(`node shim write failed (${err.message}) -- hook lane will depend on system node`)
    return env.PATH || ''
  }
  // A MEM containing the PATH delimiter would corrupt tokenization for the
  // whole child env (spark F4) -- refuse loudly instead of shipping a broken
  // PATH; the hook lane then simply depends on system node as before.
  if (binDir.includes(path.delimiter)) {
    log(`node shim dir contains the PATH delimiter (${binDir}) -- not appending; hook lane will depend on system node`)
    return env.PATH || ''
  }
  const basePath = env.PATH || ''
  if (basePath.split(path.delimiter).includes(binDir)) return basePath
  return basePath ? `${basePath}${path.delimiter}${binDir}` : binDir
}

// ── failure marker (run.sh write_failure/clear_failure, same JSON shape) ────
// Boot-event marker (v0.0.16): written immediately before every leaf spawn;
// channel.mjs's announceBoot() consumes it after Discord login (deterministic
// boot ping + agent-voiced greeting). Non-fatal on failure -- a missing
// marker costs the ping, never the boot. Shape kept in lane parity with
// run.sh's inline printf (the v0.0.15 cadence-parity regression is exactly
// the class this comment exists to prevent).
export function writeBootEvent(cfg, iteration, { now = () => Date.now(), log = () => {} } = {}) {
  const markerPath = path.join(cfg.mem, '.boot-event.json')
  try {
    const tmp = `${markerPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ts: now(), iteration, lane: 'node', supervisor_pid: process.pid }) + '\n')
    fs.renameSync(tmp, markerPath)
  } catch (err) {
    log(`boot-event marker write failed (non-fatal): ${err.message}`)
  }
}

// Shared path/shape with channel.mjs's writeFailureMarker() so main.cjs's
// poller watches ONE file regardless of which layer caught the problem.
// Atomic tmp+rename; best-effort -- diagnostic, never load-bearing for the
// loop's own survival (run.sh:216-231).
// See stallTimeoutSec below. Returns seconds; 900 (15 min) is the default.
function parseStallTimeout(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 900
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[supervisor] STALL_TIMEOUT=${JSON.stringify(raw)} is not a number of seconds -- falling back to 900. Set STALL_TIMEOUT=0 if you meant to disable the watchdog.`)
    return 900
  }
  return n
}

export function writeFailureMarker(failfile, reason, { now = () => Date.now(), log = () => {} } = {}) {
  const body = JSON.stringify({
    status: 'failed',
    code: 'crash_loop',
    reason,
    since: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }, null, 2) + '\n'
  const tmp = `${failfile}.tmp${process.pid}`
  try {
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, failfile)
  } catch (err) {
    log(`write_failure: could not write ${failfile} (${err.message}) -- skipping this round's failure marker`)
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

export function clearFailureMarker(failfile) {
  try { fs.rmSync(failfile, { force: true }) } catch {}
}

// ── identity check (main.cjs isOurSupervisor's twin) ───────────────────────
// Signature = the CONTIGUOUS substring `<SELF_PATH> __loop`, the exact
// command line main.cjs spawns and the attach bootstrap execs (contiguity +
// `ps -ww` receipts: run.sh:126-174, the argument outlived the file).
// Fail SAFE: lookup erroring/empty/non-matching all resolve to "not
// verified" -- callers never trust it as already-running, never force-kill.
export function isOurSupervisor(pid, opts = {}) {
  return classifyPidfileOwner(pid, opts) === 'ours'
}

// UPGRADE hazard (the reason 'legacy_supervisor' exists as a third verdict):
// an install updating from <=0.2.20 can still have a live `bash .../run.sh
// __loop` supervisor holding this same PIDFILE. Calling it "stale" would
// delete the pidfile out from under a running agent -- orphaning it with a
// live Discord connection, and letting the next start double-spawn a second
// supervisor onto the same token (the exact Fix-C class disaster main.cjs's
// PIDFILE participation exists to prevent). So a live pid whose command line
// carries the old contiguous `run.sh __loop` marker is LEGACY: recognized,
// never adopted as ours, and stoppable (stopAgent below reaps it the same way
// it reaps ours -- there is no `run.sh stop` left to delegate to). Remove this
// verdict once no install can still be running a 0.2.x lane.
export function classifyPidfileOwner(pid, {
  signature = `${SELF_PATH} __loop`,
  readCommandLine = defaultReadCommandLine,
} = {}) {
  if (!pid || !isPidAlive(pid)) return 'stale'
  let cmd
  try { cmd = readCommandLine(pid) } catch { return 'stale' }
  if (!cmd) return 'stale'
  if (cmd.includes(signature)) return 'ours'
  if (cmd.includes(LEGACY_BASH_SIGNATURE)) return 'legacy_supervisor'
  return 'stale'
}

// The pre-0.3 bash lane's contiguous spawn signature. Recognition only.
const LEGACY_BASH_SIGNATURE = 'run.sh __loop'

const defaultReadCommandLine = procReadCommandLine

// ── orphan sweep (run.sh:372 pre-spawn pkill, replicated per-iteration) ─────
// Design verdict 1 keeps the pattern sweep ONLY as orphan cleanup mirroring
// run.sh:372 -- which sits INSIDE the while loop (pre-spawn, every
// iteration), so that is what this replicates; the design doc's "at
// supervisor start" phrasing was imprecise about run.sh:372's location. It
// runs only when OUR child handle is dead, so the only things it can reach
// are leaves that outlived their supervisor. stop-path blind sweeps
// (run.sh:455,475) are DROPPED; the handle replaces them (verdict 1).
function sweepOrphansDefault(pkillPattern, log) {
  sweepByPattern(pkillPattern, { log })
}

// ── stall/thrash watchdog (v0.0.15 Root B fix) ──────────────────────────────
// Exists for a dead window where the CLI sat stalled with a user message
// waiting for hours: the terminal state of an autocompact thrash loop, where
// each compaction re-attaches session-read files, the context refills to the
// limit, the CLI emits its synthetic "Autocompact is thrashing" error, and
// then appends NOTHING more. SESSION_TIMEOUT (12h blanket) is the only
// recycle otherwise, so a morning stall eats the day. (history: docs/HISTORY.md)
//
// Detection reads the session TRANSCRIPT TAIL, not pty silence: an idle TUI
// still redraws, so output silence lies, but a stalled brain stops appending
// to the jsonl. Stall verdicts (age > stallTimeoutSec):
//   (a) tail entry is user/attachment (a delivered message no turn ever
//       answered -- also catches boot-and-mute sessions), or
//   (b) tail entry is the CLI's own synthetic error (model '<synthetic>' /
//       isApiErrorMessage), the thrash loop's terminal shape.
// A normal-but-old assistant tail is just an idle agent: never bounced.
// Parse doubt fails SAFE (no bounce) -- a watchdog that kills healthy
// sessions on a whim is worse than the stall, because a bounce costs the
// whole session context.
//
// The pty lane keeps one cheap EARLY detector: 3+ "Autocompact is thrashing"
// sightings inside 30 min bounces without waiting for the terminal stall.

// Claude Code puts transcripts under ~/.claude/projects/<cwd with '/'->'-'>.
// Receipt: cwd /Users/cto/Documents/Scheherazade -> project dir
// -Users-cto-Documents-Scheherazade. Munge is mac/posix-verified only; on
// Windows the rule is unverified, so the transcript watchdog stays off
// there rather than watching a fabricated path.
// mem is realpath'd first (spark F1): the CLI munges its OWN cwd, and node
// resolves symlinks/trailing slashes there -- a symlinked or trailing-slash
// AGENT_DATA_HOME would otherwise make the watchdog watch a directory that
// never exists, which fails QUIET (no transcript = no verdict = no bounce),
// the exact silent-detector class this teardown was about.
//
// Munge rule: EVERY non-alphanumeric becomes '-', not just path.sep --
// confirmed raw: ~/Documents/Agent_Memory -> -Users-user-Documents-Agent-
// Memory, and session_notes -> session-notes inside deeper project dirs.
// A '_' or '.' in AGENT_DATA_HOME under sep-only munge would re-open the
// same fail-quiet hole one layer down. Default MEM (~/Documents/<name>) only
// survived the corpus because it happened to be alphanumeric.
export function transcriptDirFor(mem, home = os.homedir()) {
  let resolved
  try { resolved = fs.realpathSync(mem) } catch { resolved = path.resolve(mem) }
  return path.join(home, '.claude', 'projects', resolved.replace(/[^a-zA-Z0-9]/g, '-'))
}

// eraStart (review gate G1): the project dir is SHARED by every claude
// session with the same cwd. "Newest mtime" alone therefore binds the
// watchdog to whichever session wrote last, not to OUR child: a stale
// prior-generation file (or a foreign session resumed in the same cwd)
// could either bounce a healthy child or mask a real stall. Filtering on
// birthtime >= eraStart restricts the watch to files CREATED in this
// child's lifetime. birthtime falls back to mtime on filesystems that
// report 0/absent. Residual risk, accepted and documented: a foreign
// session freshly STARTED in the same cwd after our spawn passes the filter
// -- identity beyond creation-era needs a session-id handshake the CLI does
// not expose (and lsof is out: the CLI append-closes its transcript, so an
// open jsonl never shows up there). The residual's blast radius is bounded
// by the bounce budget (createBounceBudget): even a worst-case foreign
// session parked stalled in our cwd costs at most 3 kills per 6h before the
// watchdog degrades to advisory logging -- a bounded nuisance, not an
// unbounded kill loop. (history: docs/HISTORY.md)
// admitName (2026-08-13): the birthtime era filter is CORRECT against a
// foreign session, but it also excluded OUR OWN resumed session. `claude -p
// --resume <id>` appends to the pre-existing <id>.jsonl, whose birthtime is
// from an earlier era, so after the first respawn every poll saw born <
// spawnedAt, dropped the file, and returned null -- the transcript watchdog
// (autocompact-thrash + stall) went silently blind on the DEFAULT (resume)
// path. Proven live: our own transcript files carry birth->mtime gaps of
// hours-to-days from being appended across respawns. We persist our resumed
// id ourselves (.headless-session.json), so identity-by-name is the handshake
// the era comment said the CLI does not expose: a file named exactly
// `${admitName}` bypasses the birthtime gate. This does NOT widen the foreign
// hole -- a foreign session has a different id and still faces the era filter.
export function newestTranscript(dir, { eraStart = null, admitName = null } = {}) {
  let best = null
  let entries
  try { entries = fs.readdirSync(dir) } catch { return null }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (eraStart !== null && name !== admitName) {
      const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
      if (born < eraStart - 1000) continue // 1s slack for clock granularity
    }
    if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs }
  }
  return best ? best.path : null
}

// Reads the tail window of a transcript (never the whole file -- these run to
// hundreds of MB under thrash) and returns the last parseable entry as
// { type, ageMs, synthetic, toolResult, syntheticCount } or null when nothing
// parses. syntheticCount counts synthetic-error entries timestamped at or
// after countSyntheticSince within the same window -- the structural form of
// the old pty thrash lane (review gate G2): a synthetic entry can only be
// minted by the CLI itself (message.model === '<synthetic>'), so unlike a
// byte-stream substring match it cannot be spoofed by a maintenance session
// grepping this very source file, and TUI redraws cannot double-count it.
export function readTranscriptTail(file, { now = () => Date.now(), tailBytes = 262144, countSyntheticSince = null } = {}) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim())
    let last = null
    let syntheticCount = 0
    for (const line of lines) {
      let e
      try { e = JSON.parse(line) } catch { continue } // first line may be cut by the tail window
      if (!e || typeof e !== 'object' || !e.type) continue
      const ts = Date.parse(e.timestamp || '')
      const msg = e.message || {}
      const synthetic = msg.model === '<synthetic>' || e.isApiErrorMessage === true
      if (countSyntheticSince !== null && synthetic && Number.isFinite(ts) && ts >= countSyntheticSince) syntheticCount++
      const content = Array.isArray(msg.content) ? msg.content : []
      last = {
        type: e.type,
        ageMs: Number.isFinite(ts) ? Math.max(0, now() - ts) : null,
        synthetic,
        toolResult: content.some((b) => b && b.type === 'tool_result'),
        syntheticCount: 0, // filled below from the pass-wide counter
      }
    }
    if (last) { last.syntheticCount = syntheticCount; return last }
  } catch { /* unreadable file = no verdict */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
  return null
}

// Asymmetric thresholds (review S1): most user-type tail entries are
// tool_result blocks, not human messages (83-92% across two boxes' raw), and
// a legitimately long streaming turn can leave a user tail warm for a while
// -- so the user/attachment lane waits 2x as long as the synthetic lane
// before calling it a stall. The reason string names which shape it was:
// a tool_result tail is a turn that died mid-flight, not an ignored human.
// Named as a const because design-0025's turn-abort producer keys on exactly
// this verdict (the mid-flight death) and a second literal would drift.
export const MID_TURN_DEATH_VERDICT = 'mid-turn death (tool_result tail)'
export function stallVerdict(tail, { userStallMs, syntheticStallMs } = {}) {
  if (!tail || tail.ageMs === null) return null
  if ((tail.type === 'user' || tail.type === 'attachment') && userStallMs && tail.ageMs >= userStallMs) {
    return tail.toolResult ? MID_TURN_DEATH_VERDICT : 'pending inbound with no turn'
  }
  if (tail.synthetic && syntheticStallMs && tail.ageMs >= syntheticStallMs) {
    return 'terminal synthetic error (autocompact thrash shape)'
  }
  return null // old assistant/system tail = idle, not stalled
}

// The turn-abort record's producer -- supervisor side (design-0025, 2026-09-28).
// When the watchdog's verdict is a mid-turn DEATH the user's question will never
// be answered, and after the respawn the pane would show a live-looking run
// fold, Stop and Read over nothing (the owner's "얘가 툴콜중인지 세션이
// 끊긴건지"). The record is the fact the kill already knows; channel-local's
// restore consumes it and writes one turn-abort transcript item.
//
// Shape (shared with the lane's stall producer and channel-local's consumer):
//   { at, reason, tail, elapsedMs }
// elapsedMs stays null here ON PURPOSE: it means "wall time from awaitingSince",
// and that value lives in the CHANNEL's transcript, a different process. The
// tail age is not that number and writing it here would mislabel it.
//
// NEVER throws and NEVER blocks the kill: a record that cannot be written costs
// one honest line on the next boot, not the bounce. tmp+rename with a
// pid-suffixed tmp -- the lane writes this same file concurrently, and a shared
// tmp name would let the two writers truncate each other's bytes.
export function writeTurnAbortRecord(mem, { reason, tail = null }, { now = () => Date.now(), log = () => {} } = {}) {
  try {
    const file = path.join(mem, '.last-turn-abort.json')
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ at: now(), reason, tail, elapsedMs: null }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    log(`turn-abort record write failed (non-fatal -- the kill proceeds): ${err.message}`)
  }
}

// The whole transcript-lane poll as ONE testable closure -- extracted from
// the child spawner so the era-guard arithmetic is unit-attackable instead of
// verified-by-inspection only (the reviewer review focus, 07-15). Returns a
// bounce-reason string or null; the caller owns the actual kill.
// Era guard, two layers: file binding (newestTranscript eraStart, gate G1)
// keeps prior-generation files out entirely; the tail-timestamp check stays
// as the belt beneath it. Thrash lane (gate G2): 3+ synthetic entries inside
// the window, counted from the transcript, no pty bytes involved.
export function createStallLane({
  transcriptDir, stallMs, spawnedAt,
  now = () => Date.now(), log = () => {},
  userStallMs = stallMs * 2,
  thrashWindowMs = 1_800_000, thrashThreshold = 3,
  // design-0025: called with the tail kind when -- and only when -- the verdict
  // is a mid-turn DEATH (a tool_result tail = the turn died in flight). NOT for
  // 'pending inbound with no turn' (the turn was never in flight) or the thrash
  // lane. The caller binds it to the data dir; this closure stays testable and
  // data-dir-free. A recorder that throws must not become a bounce, so it is
  // wrapped (the writer below cannot throw either -- belt).
  onMidTurnDeath = null,
  // Reads the CURRENTLY-live resumed session id (or null). Called every poll,
  // not captured once: the id changes when the lane mints a fresh session
  // mid-life (rotation/poison recovery updates .headless-session.json). The
  // matching <id>.jsonl is admitted past the birthtime era filter so the
  // watchdog keeps watching our own resumed transcript. Injectable for tests.
  readSessionId = () => null,
}) {
  let noTranscriptLogged = false
  return function poll() {
    const sid = readSessionId()
    const admitName = sid ? `${sid}.jsonl` : null
    const file = newestTranscript(transcriptDir, { eraStart: spawnedAt, admitName })
    if (!file) {
      // Say it ONCE: a watchdog watching a directory that never fills is
      // fail-quiet, and quiet detectors are how the 429-min stall lived.
      if (!noTranscriptLogged) {
        noTranscriptLogged = true
        log(`watchdog: no this-era transcript yet under ${transcriptDir} -- stall lane idle until one appears`)
      }
      return null
    }
    noTranscriptLogged = false
    const tail = readTranscriptTail(file, {
      now,
      countSyntheticSince: Math.max(now() - thrashWindowMs, spawnedAt),
    })
    if (!tail || tail.ageMs === null) return null
    if (now() - tail.ageMs < spawnedAt) return null // previous-era tail (belt)
    if (tail.syntheticCount >= thrashThreshold) {
      return `autocompact thrash: ${tail.syntheticCount} synthetic errors within ${Math.round(thrashWindowMs / 60000)}min`
    }
    const verdict = stallVerdict(tail, { userStallMs, syntheticStallMs: stallMs })
    if (verdict === MID_TURN_DEATH_VERDICT && typeof onMidTurnDeath === 'function') {
      try { onMidTurnDeath({ tail: 'tool_result' }) } catch { /* never let the record block the kill */ }
    }
    return verdict ? `transcript stalled ${Math.round(tail.ageMs / 60000)}min: ${verdict}` : null
  }
}

// ── dsh watchdog lane: the LANE's own heartbeat (design-0023 P3 #7) ────────
// createStallLane above reads the Claude CLI's transcript jsonl. The dsh lane
// writes no such file -- it talks to the engine over a mux event stream -- so
// on the DEFAULT lane that watchdog has been watching an empty directory since
// 0.2.2, logging `no this-era transcript yet` exactly once and then nothing.
// Silently inert, on the path almost every install actually runs.
//
// dsh-lane.mjs now beats into $MEM/.lane-heartbeat.json every 15s
// ({bornTs, ts, lastEventTs, pendingSince}); this reads it. The JUDGEMENT and
// the kill stay here on purpose: the restart ladder, the shared bounce budget
// and the pidfile all live in this process, and a lane cannot enforce a budget
// across its own restarts -- nor restart itself once it is the wedged thing.
//
// Two verdicts, both fail-QUIET (a missing or unparseable file is never a
// bounce -- a watchdog that kills on its own read error is a crash loop):
//   (1) the beat itself went stale -- the lane could not run a 15s timer for
//       a whole stall window, so it is wedged, not merely idle;
//   (2) an inbound has been pending past the same 2x user window the
//       transcript lane uses -- accepted, never answered.
// There is no thrash lane here: `autocompact thrash` is a Claude-Code
// synthetic-error shape with no dsh equivalent to count.
export function createLaneHeartbeatLane({
  heartbeatFile, stallMs, spawnedAt,
  now = () => Date.now(), log = () => {},
  userStallMs = stallMs * 2,
}) {
  let noBeatLogged = false
  const quiet = (msg) => {
    if (noBeatLogged) return null
    noBeatLogged = true
    log(`watchdog: ${msg} -- heartbeat lane idle until one appears`)
    return null
  }
  return function poll() {
    let hb
    try { hb = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8')) } catch { return quiet(`no lane heartbeat at ${heartbeatFile}`) }
    if (!hb || typeof hb !== 'object') return quiet(`lane heartbeat at ${heartbeatFile} is not an object`)
    const born = Number(hb.bornTs) || 0
    // Era guard, the same rule newestTranscript applies to birthtimes: a
    // heartbeat left by the PREVIOUS child must never bounce this one.
    if (born < spawnedAt) return quiet(`lane heartbeat predates this child (born ${born} < spawned ${spawnedAt})`)
    noBeatLogged = false
    const beat = Number(hb.ts) || 0
    const beatAge = now() - beat
    if (beat && beatAge > stallMs) {
      return `lane heartbeat stale ${Math.round(beatAge / 60000)}min: the lane stopped beating (wedged event loop, not idle)`
    }
    const pendingSince = Number(hb.pendingSince) || 0
    if (pendingSince) {
      const pendingAge = now() - pendingSince
      if (pendingAge > userStallMs) {
        return `inbound pending ${Math.round(pendingAge / 60000)}min with no turn end (accepted, never answered)`
      }
    }
    return null
  }
}

// Bounce budget (review S2): during a provider outage the retry ladder can
// legitimately eat the stall window, and an unlimited watchdog would then
// burn a full session context every cycle -- one hour of outage = 4
// context-loss loops. The ledger is SHARED across respawns (runLoop passes
// one array for the supervisor's lifetime); when the budget is spent the
// watchdog goes advisory -- it logs the verdict but stops killing, and
// SESSION_TIMEOUT remains the blanket backstop. Extracted so the budget
// arithmetic is unit-attackable, same rule as createStallLane.
export function createBounceBudget({ ledger = [], budget = 3, windowMs = 6 * 3600_000, now = () => Date.now(), log = () => {} }) {
  let spentLogged = false
  return function tryConsume(reason) {
    const cutoff = now() - windowMs
    while (ledger.length && ledger[0] < cutoff) ledger.shift()
    if (ledger.length >= budget) {
      if (!spentLogged) {
        spentLogged = true
        log(`watchdog: bounce budget spent (${budget} in ${Math.round(windowMs / 3600_000)}h) -- verdict "${reason}" logged, NOT killing; session timeout remains the backstop`)
      }
      return false
    }
    ledger.push(now())
    return true
  }
}

// ── production child spawner (design-0020: spawns headless-lane.mjs) ────────
// Returns { pid, kill, exited } where exited resolves { exitCode, signal }.
// The child is `<node> headless-lane.mjs` run on OUR OWN runtime
// (process.execPath + ELECTRON_RUN_AS_NODE=1 -- same trick as the node
// shim), which in turn owns `claude -p` stream-json. No node-pty, no TUI,
// no auto-answer matcher: plain pipes.
// Session timeout (run.sh:114-126): ONE timer here replaces both the
// gtimeout lane and the manual watchdog subshell -- TERM the child, 10s
// grace, KILL. A node process with a real handle needs neither of bash's
// workarounds. The lane forwards TERM to claude and exits with its code,
// so a timeout recycle is graceful and the next spawn resumes the session
// (.headless-session.json).
const HEADLESS_LANE_PATH = fileURLToPath(new URL('./headless-lane.mjs', import.meta.url))
// dsh lane (0.2.1 harness swap): same spawn/env/timeout/reaper contract,
// different engine inside -- the lane owns `dsh web` instead of `claude -p`.
// Selected per-config via cfg.laneKind (resolveConfig reads LANE_KIND, which
// provider-env.cjs's 'dsh' row exports).
const DSH_LANE_PATH = fileURLToPath(new URL('./dsh-lane.mjs', import.meta.url))

function spawnHeadlessChild(cfg, { now = () => Date.now(), log, watchdogBounces = [] }) {
  // Windows env can carry 'Path'/'path' case-variants; spreading process.env
  // and then setting 'PATH' would leave BOTH keys and the child's resolution
  // becomes nondeterministic -- the shim silently neutered on the exact boxes
  // the win-port targets (review S3b). Strip variants so exactly one PATH
  // key survives. No-op on posix.
  const baseEnv = { ...process.env }
  for (const k of Object.keys(baseEnv)) {
    if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete baseEnv[k]
  }
  const child = cpSpawn(process.execPath, [cfg.laneKind === 'dsh' ? DSH_LANE_PATH : HEADLESS_LANE_PATH], {
    cwd: cfg.mem, // run.sh run_loop `cd "$MEM"` parity
    // stdin unused by the lane; stdout/stderr flow through to the
    // supervisor's own stdout (-> logfile), replacing expect's log_user 1.
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1', // no-op under plain node; makes Electron act as node
      // Hook-lane node shim (see ensureNodeShim): hooks inherit the CLI
      // child's env, so PATH is patched here and nowhere else.
      PATH: ensureNodeShim(cfg, { log }),
      // run.sh export parity -- each its own env var (the Bug-3 spaced-path
      // fix is structural: argv is a real array, nothing whitespace-joined).
      AGENT_NAME: cfg.agentName,
      MEM: cfg.mem,
      CLAUDE_BIN: cfg.claudeBin,
      MODEL: cfg.model,
      ...(cfg.systemPromptFile ? { SYSTEM_PROMPT_FILE: cfg.systemPromptFile } : {}),
      ...(cfg.mcpConfigFile ? { MCP_CONFIG_FILE: cfg.mcpConfigFile } : {}),
      ...cfg.childEnvExtra,
    },
  })
  // A LIST, not one slot. Two independent paths arm a 10s SIGKILL grace timer
  // (session timeout and the watchdog bounce). With a single variable the
  // second arm orphaned the first: onExit cleared only the surviving handle,
  // and the orphan fired later against a pid the OS may already have
  // reassigned -- killHandle's empty catch makes killing the wrong process
  // indistinguishable from a no-op. (Found 2026-08-03; now a live Windows
  // path, since win32 forces this lane.)
  const graceTimers = []
  const armGrace = () => graceTimers.push(setTimeout(() => killHandle('SIGKILL'), 10_000))
  const sessionTimer = setTimeout(() => {
    log(`session timeout (${cfg.sessionTimeoutSec}s) -- terminating child ${child.pid}`)
    killHandle('SIGTERM')
    armGrace()
  }, cfg.sessionTimeoutSec * 1000)

  // Stall/thrash watchdog (see the v0.0.15 block above). All verdicts
  // converge on one bounce() so a child is only ever killed once per life.
  const spawnedAt = now()
  let bounced = false
  let stallTimer = null
  const consumeBounce = createBounceBudget({ ledger: watchdogBounces, now, log })
  const bounce = (reason) => {
    if (bounced) return
    if (!consumeBounce(reason)) return // budget spent: verdict logged, no kill
    bounced = true
    log(`watchdog: bouncing child ${child.pid} -- ${reason}`)
    killHandle('SIGTERM')
    armGrace()
  }
  // STALL_TIMEOUT=0 disables the whole watchdog (spark F2): one knob, no
  // half-disabled surprises for an operator opting out of bounces.
  //
  // Windows: ENABLED as of 2026-08-13. The transcript munge is now verified on
  // the Windows box -- DATA_HOME C:\Users\winuser\Documents\Scheherazade produced the
  // real CLI project dir C--Users-winuser-Documents-Scheherazade, exactly what
  // transcriptDirFor's `[^a-zA-Z0-9] -> '-'` rule yields (pinned in
  // test-supervisor.mjs). The tester runs Windows, and leaving the ONE OS
  // where the silent-dead reports originated with no stall protection was the
  // gap. Carried-over caveat, honest: killHandle's Windows taskkill /T /F was
  // verified against a synthetic 3-level node tree (2026-08-01) but not yet
  // against a live CLI+MCP tree on a real stall -- so the first real Windows
  // bounce is the receipt still owed. The bounce budget bounds any misfire to
  // 3 kills/6h before degrading to advisory.
  const watchdogOn = cfg.stallTimeoutSec > 0
  // Same reasoning, the OTHER way off. The "not active" line used to live only
  // under the IS_WIN branch, so an operator (or a config typo) that zeroed
  // STALL_TIMEOUT on mac got no line at all -- silently off, which is the
  // exact class the Windows line exists to prevent.
  if (cfg.stallTimeoutSec === 0) {
    log('watchdog: disabled by STALL_TIMEOUT=0 -- stall protection is NOT active')
  }
  if (watchdogOn) {
    // Our own resumed session id, read fresh each poll from the lane's
    // .headless-session.json ({sessionId, ts, bornTs}, written by
    // headless-lane.mjs on every session_id capture). Lets the watchdog admit
    // the resumed <id>.jsonl past the birthtime era filter -- see
    // newestTranscript's admitName.
    const sessionFilePath = path.join(cfg.mem, '.headless-session.json')
    const readSessionId = () => {
      try {
        const v = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'))
        return v && typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : null
      } catch { return null }
    }
    // ONE watchdog, two evidence sources, chosen by the lane that is actually
    // running: the CLI lane leaves a transcript jsonl, the dsh lane beats into
    // a heartbeat file. Before P3 only the transcript lane existed, so the
    // DEFAULT lane had no stall protection at all while the log claimed it did.
    const poll = cfg.laneKind === 'dsh'
      ? createLaneHeartbeatLane({
        heartbeatFile: path.join(cfg.mem, '.lane-heartbeat.json'),
        stallMs: cfg.stallTimeoutSec * 1000,
        spawnedAt, now, log,
      })
      : createStallLane({
        transcriptDir: transcriptDirFor(cfg.mem),
        stallMs: cfg.stallTimeoutSec * 1000,
        spawnedAt, now, log, readSessionId,
        // design-0025: a mid-turn death is the one verdict whose unanswered
        // question must leave a record behind (see writeTurnAbortRecord). A
        // budget-refused bounce writes too: the diagnosis is true whether or
        // not the kill lands, and if the lane later answers, the record is
        // simply never consumed (awaiting settles).
        onMidTurnDeath: ({ tail }) => writeTurnAbortRecord(cfg.mem, { reason: 'death', tail }, { log }),
      })
    stallTimer = setInterval(() => {
      const reason = poll()
      if (reason) bounce(reason)
    }, 60_000)
    if (typeof stallTimer.unref === 'function') stallTimer.unref()
  }

  function killHandle(sig) {
    try {
      // proc.killTree: taskkill /PID /T /F on win32 (whole tree -- VERIFIED BY
      // EXECUTION 2026-08-01 on the Windows box against a synthetic 3-level
      // node tree; the real CLI+MCP tree receipt is still owed), a plain
      // handle kill here on POSIX because the child is not a group leader --
      // it shares OUR group, so a negative-pid signal would hit this
      // supervisor too.
      if (IS_WIN) killTree(child.pid, sig)
      else child.kill(sig)
    } catch {}
  }

  const exited = new Promise((resolve) => {
    // stdout/stderr are stdio-inherited straight to the supervisor's own
    // streams (expect's log_user 1 equivalent) -- no data handler, no
    // matcher: there is no TUI to scrape or answer anymore.
    child.on('exit', (exitCode, signal) => {
      clearTimeout(sessionTimer)
      for (const t of graceTimers) clearTimeout(t)
      if (stallTimer) clearInterval(stallTimer)
      resolve({ exitCode: exitCode == null ? -1 : exitCode, signal })
    })
    child.on('error', (err) => {
      log(`lane spawn failed: ${err.message}`)
      clearTimeout(sessionTimer)
      for (const t of graceTimers) clearTimeout(t)
      if (stallTimer) clearInterval(stallTimer)
      resolve({ exitCode: 127, signal: null })
    })
  })

  return { pid: child.pid, kill: killHandle, exited }
}

// ── the restart loop (run.sh run_loop, semantics verbatim) ──────────────────
// Returns (instead of process.exit) so tests can drive it with a fake child
// and fake clock; the __loop main() below exits 0 on return. deps are
// injectable for the ladder tests ONLY -- production passes none.
export async function runLoop(cfg, deps = {}) {
  const now = deps.now || (() => Date.now())
  const log = deps.log || makeLog(now)
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  // One watchdog-bounce ledger for the SUPERVISOR's lifetime, shared across
  // respawns -- the budget (see bounce() in spawnHeadlessChild) is meaningless
  // if every fresh child starts with a clean slate.
  const watchdogBounces = []
  const spawnChild = deps.spawnChild || ((c) => spawnHeadlessChild(c, { now, log, watchdogBounces }))
  const sweepOrphans = deps.sweepOrphans || (() => {
    sweepOrphansDefault(cfg.pkillPattern, log)
    // Second pattern (design-0020): an orphaned `claude -p` leaf whose lane
    // died by SIGKILL before it could TERM its child. Lane parity with
    // run.sh's PKILL_LEAF_PATTERN sweep.
    if (cfg.pkillLeafPattern) sweepOrphansDefault(cfg.pkillLeafPattern, log)
    if (cfg.legacyDshLeafPattern) sweepOrphansDefault(cfg.legacyDshLeafPattern, log)
  })
  const installSignalHandler = deps.installSignalHandler || ((h) => {
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => h(sig))
  })

  fs.mkdirSync(path.join(cfg.mem, 'logs'), { recursive: true })

  let currentChild = null
  // Verdict 7 FIX: run.sh's TERM/INT trap orphaned descendants (bash defers
  // traps while a foreground child runs; the leaf lived on). With a real
  // handle we reap the child BEFORE exiting: TERM, 10s grace, KILL.
  installSignalHandler(async () => {
    log('signal received, exiting loop')
    if (currentChild) {
      currentChild.kill('SIGTERM')
      const gone = await Promise.race([
        currentChild.exited.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 10_000)),
      ])
      if (!gone) currentChild.kill('SIGKILL')
    }
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
    process.exit(0)
  })

  let restartCount = 0
  let spawnSeq = 0 // boot-event iteration counter (run.sh's SPAWN_SEQ twin)
  let lastLocalDate = localDate(now())
  // Fresh loop start: don't carry a failure marker over from a previous life
  // (run.sh:353-356 -- e.g. the user fixed a bad key and relaunched).
  clearFailureMarker(cfg.failfile)

  const stopRequested = () => fs.existsSync(cfg.stopflag)
  const exitOnStop = () => {
    try { fs.rmSync(cfg.stopflag, { force: true }) } catch {}
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
    log('stop requested, exiting')
  }

  // Graceful-quit hold (129 loop, the owner live 2026-08-05 02:01): while
  // main.cjs's .shutdown-request marker sits in MEM, the app is inside its
  // quit grace window — respawning a child here just gets it killed at grace
  // expiry, and each respawn re-processes the shutdown turn (the "무한부팅"
  // the owner watched). Hold instead of spawning until the marker clears; main
  // always unlinks it (ack or timeout) and then stops this supervisor, so
  // the hold cannot outlive the quit. Freshness-capped like channel.mjs's
  // watcher so a crash-leftover marker cannot freeze a fresh boot forever.
  const SHUTDOWN_REQ = path.join(cfg.mem, '.shutdown-request')
  const shutdownRequestFresh = () => {
    try {
      const st = fs.statSync(SHUTDOWN_REQ)
      return now() - st.mtimeMs < 5 * 60 * 1000
    } catch { return false }
  }

  for (;;) {
    if (stopRequested()) { exitOnStop(); return 0 }

    if (shutdownRequestFresh()) {
      log('quit in progress (.shutdown-request present) -- holding respawn until it clears')
      while (shutdownRequestFresh() && !stopRequested()) await sleep(500)
      if (stopRequested()) { exitOnStop(); return 0 }
      log('shutdown-request cleared -- resuming spawn loop')
    }

    const curLocalDate = localDate(now())
    if (curLocalDate !== lastLocalDate) {
      // Verdict 6, REPLICATED asymmetry with the presumed reason written
      // down: a new day resets PATIENCE (the backoff count), it does not fix
      // a bad token -- so the failure marker deliberately survives the
      // rollover until a run actually lives past 300s. If this presumption
      // is wrong, this comment is where to find the decision; silence made
      // the bash version archaeology.
      log(`local date rolled over in ${agentTimeZone()} (${lastLocalDate} -> ${curLocalDate}), backoff reset`)
      restartCount = 0
      lastLocalDate = curLocalDate
    }

    sweepOrphans()

    spawnSeq += 1
    writeBootEvent(cfg, spawnSeq, { now, log })

    const started = now()

    let exitCode = null
    let signal = null
    try {
      currentChild = spawnChild(cfg)
      const res = await currentChild.exited
      exitCode = res.exitCode
      signal = res.signal ?? null
    } catch (err) {
      // spawn itself failed (bad CLAUDE_BIN, native module missing) -- treat
      // as an instant crash so the ladder + failure marker surface it
      // instead of the loop dying silently (procedures/fail_loud.md).
      log(`child spawn failed: ${err.message}`)
      exitCode = 127
    } finally {
      currentChild = null
    }

    if (stopRequested()) { exitOnStop(); return 0 }

    const uptime = Math.floor((now() - started) / 1000)
    if (uptime > 300) {
      restartCount = 0
      clearFailureMarker(cfg.failfile)
    } else {
      restartCount += 1
    }

    const backoff = backoffFor(restartCount)

    // Critical B (run.sh:402-409): quick-fail streak surfaces as a failure
    // marker instead of silently retrying forever. Same message shape; the
    // REAL exit code is recorded honestly (verdict 2) but never drives
    // branching -- restart policy stays uptime-only.
    if (restartCount >= 3) {
      writeFailureMarker(cfg.failfile,
        `agent restarted ${restartCount} times quickly (last uptime ${uptime}s, exit code ${exitCode}) -- likely a bad/revoked provider key or bot token, or an auth hang. Check the BYOK key and Discord bot token in Settings.`,
        { now, log })
    }

    log(`exited (code ${exitCode}${signal ? `, signal ${signal}` : ''}, uptime ${uptime}s, restart #${restartCount}), retrying in ${backoff}s`)
    await sleep(backoff * 1000)
  }
}

// ── start / stop modes (run.sh start_agent/stop_agent) ──────────────────────
function startAgent(cfg) {
  const log = console.log
  // The Claude CLI is a requirement of the HEADLESS lane only. dsh-lane.mjs
  // has execed no `claude` since 0.2.2 (it drives the bundled dsh engine and
  // ignores CLAUDE_BIN entirely), yet this gate refused to start the DEFAULT
  // lane on any machine without a claude binary on PATH -- a hard FATAL for a
  // dependency that lane does not have. On Windows, where nothing installs the
  // CLI by default, that is the whole product refusing to boot over a tool it
  // never runs. Gate the lane that actually needs it, and only that one.
  if (cfg.laneKind === 'headless' && !resolveOnPath(cfg.claudeBin)) {
    console.error(`FATAL: '${cfg.claudeBin}' not found on PATH (required by LANE_KIND=headless; the default dsh lane does not need it)`)
    process.exit(1)
  }
  const existingPid = readPid(cfg.pidfile)
  const owner = existingPid === null ? null : classifyPidfileOwner(existingPid)
  if (owner === 'ours') {
    log(`${cfg.agentName} already running (pid ${existingPid})`)
    return
  }
  if (owner === 'legacy_supervisor') {
    // Starting anyway would put two supervisors on one agent name / one
    // Discord token. Fail loud, change nothing. `stop` (below) can end it.
    console.error(`a pre-0.3 (run.sh) supervisor (pid ${existingPid}) is already running for ${cfg.agentName} -- stop it first: '${SELF_PATH} stop'`)
    process.exitCode = 1
    return
  }
  if (existingPid !== null) {
    log(`stale/unverified PIDFILE (pid ${existingPid} is dead, or was recycled to an unrelated process) -- clearing before start`)
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
  }
  try { fs.rmSync(cfg.stopflag, { force: true }) } catch {}
  clearFailureMarker(cfg.failfile)
  fs.mkdirSync(path.join(cfg.mem, 'logs'), { recursive: true })
  const out = fs.openSync(cfg.logfile, 'a')
  const child = cpSpawn(process.execPath, [SELF_PATH, '__loop'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  fs.writeFileSync(cfg.pidfile, `${child.pid}\n`)
  child.unref()
  fs.closeSync(out)
  log(`${cfg.agentName} started (pid ${child.pid}), log: ${cfg.logfile}`)
}

function readPid(pidfile) {
  try {
    const n = parseInt(fs.readFileSync(pidfile, 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

async function stopAgent(cfg) {
  const log = console.log
  if (!fs.existsSync(cfg.pidfile)) {
    log(`${cfg.agentName} is not running`)
    return
  }
  const pid = readPid(cfg.pidfile)
  const owner = classifyPidfileOwner(pid)
  // A leftover pre-0.3 bash supervisor IS this agent, in an older shape, and
  // there is no `run.sh stop` left to delegate to -- so stop it here. What we
  // must never do is fall through to the "stale" branch below and delete a
  // LIVE supervisor's pidfile, which orphans it (see classifyPidfileOwner).
  if (owner === 'legacy_supervisor') log(`pid ${pid} is a pre-0.3 (run.sh) supervisor -- stopping it with this lane's stop path`)
  if (owner !== 'ours' && owner !== 'legacy_supervisor') {
    log(`stale/unverified pidfile (pid ${pid} is dead, or was recycled to an unrelated process), cleaning up`)
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
    return
  }

  log(`stopping ${cfg.agentName} (pid ${pid})...`)
  // proc.gracefulStop owns the mechanics and documents both platforms: POSIX
  // gets STOPFLAG + a SIGTERM to the process GROUP (so the LANE's own handler
  // runs and reaps the engine, not just this supervisor) and up to 15s before
  // SIGKILL; win32 gets STOPFLAG + the SAME grace window -- the flag is the
  // only stop channel there, both lanes poll it -- and only then taskkill /T
  // /F. Before P3 Windows hard-killed the tree the instant stop was pressed,
  // so no lane shutdown ran there at all. `verify` is the pid-recycling guard:
  // 15s is long enough for the pid to die and be reissued, so re-confirm
  // identity before the hard kill (run.sh:462-474 did the same, fail SAFE).
  const res = await gracefulStop(pid, {
    stopflag: cfg.stopflag,
    graceMs: 15_000,
    verify: (p) => classifyPidfileOwner(p) !== 'stale',
    log,
  })
  if (res.stopped) log('stopped')
  else log(`stop did NOT confirm the supervisor's death (pid ${pid}) -- leaving its pidfile in place rather than orphaning it silently`)
  // Cleanup mirrors the loop's own exitOnStop(): both files go, so a later
  // start is not blocked by a stale flag. Only when the stop actually landed
  // -- an unconfirmed pid keeps its pidfile so the app can still find it.
  if (res.stopped) {
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
  }
  try { fs.rmSync(cfg.stopflag, { force: true }) } catch {}
}

// ── entrypoint ──────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH
if (isMain) {
  const mode = process.argv[2] || 'start'
  let cfg
  try {
    cfg = resolveConfig()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  // A throw out of any mode used to kill the supervisor WITHOUT writing the
  // failure marker main.cjs polls -- e.g. mkdirSync($MEM/logs) on a read-only
  // or full volume, or where that path exists as a regular file. The UI then
  // sat on 'connecting' until the 60s backstop flipped it to code=timeout, a
  // cause unrelated to what actually happened. Marker first, then exit 1.
  const fatalSupervisor = (err) => {
    const reason = (err && err.message) || String(err)
    console.error(`[supervisor] fatal: ${reason}`)
    try { writeFailureMarker(cfg.failfile, `supervisor crashed: ${reason}`) } catch {}
    process.exit(1)
  }
  if (mode === 'start') {
    try { startAgent(cfg) } catch (err) { fatalSupervisor(err) }
  } else if (mode === 'stop') {
    try { await stopAgent(cfg) } catch (err) { fatalSupervisor(err) }
  } else if (mode === '__loop') {
    try { await runLoop(cfg) } catch (err) { fatalSupervisor(err) }
    process.exit(0)
  } else {
    console.error(`usage: supervisor.mjs [start|stop]`)
    process.exit(1)
  }
}
