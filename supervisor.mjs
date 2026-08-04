#!/usr/bin/env node
// supervisor.mjs -- node port of run.sh (Windows-port Phase 1).
//
// This file REPLICATES run.sh's battle-tested semantics and FIXES exactly
// the two things docs/supervisor-design.md's review verdicts approved: kill
// by child HANDLE instead of blind pkill on the stop path, and a signal
// handler that reaps the child before exiting. Everything else -- backoff
// ladder, uptime-only restart policy, the 25s one-shot auto-answer window,
// the verbatim prompt table (incl. the load-bearing bare-"1"-no-CR API-key
// answer), asymmetric KST resets, once-per-lifetime env resolution -- is
// copied deliberately, with run.sh line receipts in the comments. Do not
// "improve" any of it here; improvements are their own loudly-noted changes
// AFTER the port proves itself -- see docs/supervisor-design.md for the
// full verdict rationale.
//
// Runtime: plain node OR Electron with ELECTRON_RUN_AS_NODE=1. node-pty is
// GONE (design-0020): the child is headless-lane.mjs -> claude -p
// stream-json over plain pipes, so no native module, no ABI question, no
// PTY. (The old node-pty receipts live in docs/supervisor-design.md and
// git history.)
//
// run.sh stays the production mac lane until this has run a full real
// session on both platforms (design: "What run.sh keeps doing"). The seam in
// main.cjs selects lanes via SUPERVISOR_LANE=node|bash, default bash.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn as cpSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

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

// ── KST clock (run.sh uses TZ=Asia/Seoul date; we use Intl, no TZ env games) ─
const KST_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
const KST_TIME_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function kstDate(nowMs = Date.now()) {
  return KST_DATE_FMT.format(new Date(nowMs)) // en-CA => YYYY-MM-DD
}

function kstStamp(nowMs = Date.now()) {
  // run.sh log(): [%Y-%m-%d %H:%M:%S %Z] with TZ=Asia/Seoul
  return `${KST_DATE_FMT.format(new Date(nowMs))} ${KST_TIME_FMT.format(new Date(nowMs))} KST`
}

function makeLog(now = () => Date.now()) {
  return (msg) => console.log(`[${kstStamp(now())}] ${msg}`)
}

// ── .agent-config parser ────────────────────────────────────────────────────
// Mirrors onboarding/http-server.cjs readAgentConfig() EXACTLY -- that file's
// writeAgentConfig()/shellQuote() is the producer, and bash `source` was the
// original consumer. Same KEY=VALUE lines, same double-quote + \\ \" \$ \`
// escaping. test-supervisor.mjs round-trips shellQuote output through this.
export function parseAgentConfig(text) {
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
    throw new Error(`no .agent-config found at ${configFile}, and AGENT_NAME is not already set in the environment -- run ./setup.sh first, or invoke with AGENT_NAME (and optionally CLAUDE_BIN/MODEL/AGENT_DATA_HOME) pre-exported`)
  }
  const merged = { ...env, ...fileVals }
  const agentName = merged.AGENT_NAME
  if (!agentName) throw new Error('AGENT_NAME missing from config/env')
  const mem = merged.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', agentName)
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
    // Stop-time reaper patterns, lane parity with run.sh's
    // PKILL_PATTERN/PKILL_LEAF_PATTERN (design-0020): the lane's FULL
    // script path (basename alone cross-matched any argv mentioning the
    // file -- editor, grep, the E2E driver's own pkill; live bite
    // 2026-08-04) matches the `node .../headless-lane.mjs` process; the
    // leaf pattern matches an orphaned `claude -p` child via its
    // --mcp-config argv (stable per-agent path -- never key the reaper to
    // post-spawn-mutable fields like MODEL, the 2026-07-03 lesson). Here
    // they only serve the orphan sweep; live kills go through the child
    // handle.
    pkillPattern: path.join(path.dirname(SELF_PATH), 'headless-lane.mjs'),
    pkillLeafPattern: `--mcp-config ${path.join(mem, '.mcp.json')}`,
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

// Child argv: OWNED BY headless-lane.mjs (buildArgs) since design-0020.
// Both lanes (run.sh and this supervisor) now exec the SAME lane script and
// pass the SAME env contract (AGENT_NAME / MEM / CLAUDE_BIN / MODEL /
// SYSTEM_PROMPT_FILE? / MCP_CONFIG_FILE? / tuning knobs) -- argv parity is
// by construction, not by mirrored code. test-supervisor.mjs pins the env
// contract instead of an argv table.

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

// ── identity check (run.sh is_our_supervisor, main.cjs isOurSupervisor) ─────
// Signature = the CONTIGUOUS substring `<SELF_PATH> __loop`, same convention
// as `<RUN_SH_PATH> __loop` (contiguity + ps -ww receipts: run.sh:126-174).
// Fail SAFE: lookup erroring/empty/non-matching all resolve to "not
// verified" -- callers never trust it as already-running, never force-kill.
export function isOurSupervisor(pid, opts = {}) {
  return classifyPidfileOwner(pid, opts) === 'ours'
}

// Cross-LANE hazard (the reason 'foreign_supervisor' exists as a third
// verdict): run.sh and supervisor.mjs share the same PIDFILE, and each
// lane's stopper only recognizes its own spawn signature. Treating a LIVE
// other-lane supervisor as "stale" would delete the pidfile out from under
// it -- orphaning a running agent with a live Discord connection, and
// letting the next start double-spawn a second supervisor onto the same
// token (the exact Fix-C class disaster main.cjs's PIDFILE participation
// exists to prevent). run.sh is frozen (production mac lane until the port
// proves itself), so the tolerance lives HERE: a live pid whose command
// line carries the bash lane's contiguous `run.sh __loop` marker is
// FOREIGN, not stale -- refuse to touch its state, tell the caller.
export function classifyPidfileOwner(pid, {
  signature = `${SELF_PATH} __loop`,
  readCommandLine = defaultReadCommandLine,
} = {}) {
  if (!pid || !isPidAlive(pid)) return 'stale'
  let cmd
  try { cmd = readCommandLine(pid) } catch { return 'stale' }
  if (!cmd) return 'stale'
  if (cmd.includes(signature)) return 'ours'
  if (cmd.includes('run.sh __loop')) return 'foreign_supervisor'
  return 'stale'
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

function defaultReadCommandLine(pid) {
  if (IS_WIN) {
    // VERIFIED BY EXECUTION 2026-08-01 (Idea spike on magi-win): CommandLine
    // read from a node-spawned child, 3 runs 268/295/405ms (all <2s),
    // CommandLine present and matching -- receipts in
    // docs/supervisor-design.md (Architecture). Fail-safe posture stands:
    // an error here just reads as "not verified".
    return execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8' }).trim()
  }
  return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
}

// ── orphan sweep (run.sh:372 pre-spawn pkill, replicated per-iteration) ─────
// Design verdict 1 keeps the pattern sweep ONLY as orphan cleanup mirroring
// run.sh:372 -- which sits INSIDE the while loop (pre-spawn, every
// iteration), so that is what this replicates; the design doc's "at
// supervisor start" phrasing was imprecise about run.sh:372's location. It
// runs only when OUR child handle is dead, so the only things it can reach
// are leaves that outlived their supervisor. stop-path blind sweeps
// (run.sh:455,475) are DROPPED; the handle replaces them (verdict 1).
function sweepOrphansDefault(pkillPattern, log) {
  try {
    if (IS_WIN) {
      // Sweep action (Where-Object -like + Stop-Process) still UNVERIFIED on
      // magi-win; its premise -- CIM CommandLine visibility for node-spawned
      // children -- got receipts in the 2026-08-01 spike (see
      // defaultReadCommandLine above). Verify the sweep itself when a live
      // win session exists to leave a real orphan behind.
      const escaped = pkillPattern.replace(/'/g, "''")
      execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { encoding: 'utf8' })
    } else {
      execFileSync('pkill', ['-f', '--', pkillPattern], { encoding: 'utf8' })
    }
  } catch (err) {
    // pkill exit 1 = "no process matched" -- the normal case, not an error.
    if (err.status !== 1) log(`orphan sweep failed (${err.message}) -- continuing`)
  }
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
// confirmed raw: ~/Documents/MAGI_Memory -> -Users-narr-Documents-MAGI-
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
export function newestTranscript(dir, { eraStart = null } = {}) {
  let best = null
  let entries
  try { entries = fs.readdirSync(dir) } catch { return null }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (eraStart !== null) {
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
export function stallVerdict(tail, { userStallMs, syntheticStallMs } = {}) {
  if (!tail || tail.ageMs === null) return null
  if ((tail.type === 'user' || tail.type === 'attachment') && userStallMs && tail.ageMs >= userStallMs) {
    return tail.toolResult ? 'mid-turn death (tool_result tail)' : 'pending inbound with no turn'
  }
  if (tail.synthetic && syntheticStallMs && tail.ageMs >= syntheticStallMs) {
    return 'terminal synthetic error (autocompact thrash shape)'
  }
  return null // old assistant/system tail = idle, not stalled
}

// The whole transcript-lane poll as ONE testable closure -- extracted from
// the child spawner so the era-guard arithmetic is unit-attackable instead of
// verified-by-inspection only (Melchior review focus, 07-15). Returns a
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
}) {
  let noTranscriptLogged = false
  return function poll() {
    const file = newestTranscript(transcriptDir, { eraStart: spawnedAt })
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
    return verdict ? `transcript stalled ${Math.round(tail.ageMs / 60000)}min: ${verdict}` : null
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
  const child = cpSpawn(process.execPath, [HEADLESS_LANE_PATH], {
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
  const watchdogOn = cfg.stallTimeoutSec > 0 && !IS_WIN
  if (cfg.stallTimeoutSec > 0 && IS_WIN) {
    // Intentional fail-quiet made loud (review S3a): the transcript munge is
    // unverified on Windows, so the watchdog stays off there -- but silently
    // off IS the silent-detector class, so say it at every spawn.
    log('watchdog: disabled on Windows (transcript path munge unverified) -- stall protection is NOT active')
  }
  // Same reasoning, the OTHER way off. The "not active" line used to live only
  // under the IS_WIN branch, so an operator (or a config typo) that zeroed
  // STALL_TIMEOUT on mac got no line at all -- silently off, which is the
  // exact class the Windows line exists to prevent.
  if (cfg.stallTimeoutSec === 0) {
    log('watchdog: disabled by STALL_TIMEOUT=0 -- stall protection is NOT active')
  }
  if (watchdogOn) {
    const poll = createStallLane({
      transcriptDir: transcriptDirFor(cfg.mem),
      stallMs: cfg.stallTimeoutSec * 1000,
      spawnedAt, now, log,
    })
    stallTimer = setInterval(() => {
      const reason = poll()
      if (reason) bounce(reason)
    }, 60_000)
    if (typeof stallTimer.unref === 'function') stallTimer.unref()
  }

  function killHandle(sig) {
    try {
      if (IS_WIN) {
        // taskkill /T = whole tree. VERIFIED BY EXECUTION 2026-08-01 (Idea
        // spike on magi-win): synthetic 3-level node tree, grandchild
        // explicitly reported terminated -- receipts in
        // docs/supervisor-design.md (Kill lane). Caveat kept honest: tree
        // was plain node processes; re-run the same driver against the real
        // CLI+MCP tree once a live win session exists.
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' })
      } else {
        child.kill(sig)
      }
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
  let lastKstDate = kstDate(now())
  // Fresh loop start: don't carry a failure marker over from a previous life
  // (run.sh:353-356 -- e.g. the user fixed a bad key and relaunched).
  clearFailureMarker(cfg.failfile)

  const stopRequested = () => fs.existsSync(cfg.stopflag)
  const exitOnStop = () => {
    try { fs.rmSync(cfg.stopflag, { force: true }) } catch {}
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
    log('stop requested, exiting')
  }

  // Graceful-quit hold (129 loop, Mino live 2026-08-05 02:01): while
  // main.cjs's .shutdown-request marker sits in MEM, the app is inside its
  // quit grace window — respawning a child here just gets it killed at grace
  // expiry, and each respawn re-processes the shutdown turn (the "무한부팅"
  // Mino watched). Hold instead of spawning until the marker clears; main
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

    const curKst = kstDate(now())
    if (curKst !== lastKstDate) {
      // Verdict 6, REPLICATED asymmetry with the presumed reason written
      // down: a new day resets PATIENCE (the backoff count), it does not fix
      // a bad token -- so the failure marker deliberately survives the
      // rollover until a run actually lives past 300s. If this presumption
      // is wrong, this comment is where to find the decision; silence made
      // the bash version archaeology.
      log(`KST date rolled over (${lastKstDate} -> ${curKst}), backoff reset`)
      restartCount = 0
      lastKstDate = curKst
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
function resolveOnPath(bin) {
  if (bin.includes(path.sep)) return fs.existsSync(bin) ? bin : null
  const exts = IS_WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext.toLowerCase())
      if (fs.existsSync(candidate)) return candidate
      const candidateUpper = path.join(dir, bin + ext)
      if (ext && fs.existsSync(candidateUpper)) return candidateUpper
    }
  }
  return null
}

function startAgent(cfg) {
  const log = console.log
  if (!resolveOnPath(cfg.claudeBin)) {
    console.error(`FATAL: '${cfg.claudeBin}' not found on PATH`)
    process.exit(1)
  }
  const existingPid = readPid(cfg.pidfile)
  const owner = existingPid === null ? null : classifyPidfileOwner(existingPid)
  if (owner === 'ours') {
    log(`${cfg.agentName} already running (pid ${existingPid})`)
    return
  }
  if (owner === 'foreign_supervisor') {
    // Starting anyway would put two supervisors on one agent name / one
    // Discord token. Fail loud, change nothing.
    console.error(`a run.sh-lane supervisor (pid ${existingPid}) is already running for ${cfg.agentName} -- stop it with 'run.sh stop' before starting the node lane`)
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
  if (owner === 'foreign_supervisor') {
    // NOT ours to stop, and NOT ours to "clean up" either -- deleting a
    // live supervisor's pidfile orphans it (see classifyPidfileOwner).
    console.error(`pid ${pid} is a live run.sh-lane supervisor -- refusing to touch its pidfile; stop it with 'run.sh stop'`)
    process.exitCode = 1
    return
  }
  if (owner !== 'ours') {
    log(`stale/unverified pidfile (pid ${pid} is dead, or was recycled to an unrelated process), cleaning up`)
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
    return
  }

  log(`stopping ${cfg.agentName} (pid ${pid})...`)
  // STOPFLAG stays as the belt (a lost signal still ends the loop at its
  // next iteration); the signal is the actual stop. Unlike bash -- where
  // TERM was deferred until the foreground child died, so stop had to pkill
  // the LEAF -- the node supervisor's handler reaps its child itself
  // (verdict 7), so there is no stop-path pattern sweep here (verdict 1).
  fs.writeFileSync(cfg.stopflag, '')
  if (IS_WIN) {
    // Windows has no graceful cross-process signal: node's process.kill()
    // is TerminateProcess (handler never runs, child would orphan). Kill
    // the whole tree instead. UNVERIFIED on magi-win (design doc flag).
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }) } catch {}
    try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
    try { fs.rmSync(cfg.stopflag, { force: true }) } catch {}
    log('stopped')
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}

  for (let i = 0; i < 15; i++) {
    if (!isPidAlive(pid)) {
      log('stopped')
      try { fs.rmSync(cfg.stopflag, { force: true }) } catch {}
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  // Re-verify identity before force-kill: up to 15s elapsed, enough for the
  // pid to have died and been recycled (run.sh:462-474, fail SAFE).
  if (isOurSupervisor(pid)) {
    log('did not stop in time, forcing')
    try { process.kill(pid, 'SIGKILL') } catch {}
  } else {
    log(`pid ${pid} no longer identifies as ${cfg.agentName} supervisor (exited and recycled?) -- skipping force-kill of an unconfirmed pid`)
  }
  try { fs.rmSync(cfg.pidfile, { force: true }) } catch {}
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
