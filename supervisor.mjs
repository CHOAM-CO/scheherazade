#!/usr/bin/env node
// supervisor.mjs -- node port of run.sh (Windows-port Phase 1).
//
// This file REPLICATES run.sh's battle-tested semantics and FIXES exactly the
// two things docs/supervisor-design.md verdicts 1 and 7 approved: kill by
// child HANDLE instead of blind pkill on the stop path, and a signal handler
// that reaps the child before exiting. Everything else -- backoff ladder,
// uptime-only restart policy, the 25s one-shot auto-answer window, the
// verbatim prompt table (incl. the load-bearing bare-"1"-no-CR API-key
// answer), asymmetric KST resets, once-per-lifetime env resolution -- is
// copied deliberately, with run.sh line receipts in the comments. Do not
// "improve" any of it here; improvements are their own loudly-noted changes
// AFTER the port proves itself (design verdicts 2, 5).
//
// Runtime: plain node OR Electron with ELECTRON_RUN_AS_NODE=1 -- node-pty
// 1.1.0 is N-API and one prebuilt binding passed scripts/probe-pty.mjs under
// both ABIs (receipts in docs/supervisor-design.md, Runtime/ABI). node-pty is
// require()d LAZILY inside the production child spawner so `start`/`stop`
// modes and unit tests never need a working native module.
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

// ── auto-answer table (run.sh:338-345, verbatim, case-sensitive) ────────────
// expect tried these as -re patterns, but all five are literal-only regexes,
// so plain substring match IS the same matcher. Order matters: expect picks
// the FIRST LISTED pattern that matches the buffer (not the earliest match
// position), and we replicate that.
//
// The API-key response is bare "1" with NO carriage return -- empirically
// settled (run.sh:331-337, oracle 2026-07-05, deterministic re-runs): "1" is
// a hotkey that fires the confirm handler; a trailing "\r" INDEPENDENTLY
// selects the default focus (No), so "1\r" writes the key into approved AND
// rejected at once (corrupt state that re-triggers the freeze). 3/3 vs 2/2.
// test-supervisor.mjs pins the no-CR fact.
export const AUTO_ANSWER_PATTERNS = [
  { pattern: 'trust', response: '\r' },
  { pattern: 'confirm', response: '\r' },
  { pattern: 'local development', response: '\r' },
  { pattern: 'text style', response: '\r' },
  { pattern: 'Do you want to use this API key', response: '1' },
]

// 25s one-shot window (run.sh:320 `set timeout 25` + :344 `timeout {}`).
// Design verdict 4: the window is an accidental safety feature -- a stray
// "trust" in ordinary session output must never fire a CR into a live
// session. expect's timeout counts from expect-start, resets ONLY on a match
// (exp_continue), NOT on non-matching data arrival; when it fires, the
// matcher is permanently done (falls through to `expect eof`). The lazy
// close below (checked at feed time) is observably identical: the only
// action a matcher ever takes is sending on a match, and any match attempted
// after the window would have expired is refused.
export const AUTO_ANSWER_WINDOW_MS = 25_000

export function createAutoAnswerMatcher({ send, now = () => Date.now(), windowMs = AUTO_ANSWER_WINDOW_MS, patterns = AUTO_ANSWER_PATTERNS }) {
  let buffer = ''
  let lastMatchTs = now() // window opens at spawn, same as `set timeout 25`
  let closed = false
  const BUFFER_CAP = 4096 // longest pattern is ~35 chars; 4KB keeps straddles safe without unbounded growth

  return {
    get closed() { return closed },
    feed(chunk) {
      if (closed) return
      if (now() - lastMatchTs > windowMs) { closed = true; buffer = ''; return }
      buffer += chunk
      if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP)
      // exp_continue loop: keep answering as long as a pattern matches.
      for (;;) {
        let hit = null
        for (const p of patterns) { // listed order = expect's priority order
          const idx = buffer.indexOf(p.pattern)
          if (idx !== -1) { hit = { ...p, idx }; break }
        }
        if (!hit) return
        send(hit.response)
        // expect discards the buffer through the end of the match.
        buffer = buffer.slice(hit.idx + hit.pattern.length)
        lastMatchTs = now() // a match resets the 25s window (exp_continue)
      }
    },
  }
}

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
    // run.sh:95 -- stop-time PKILL_PATTERN rebuilt on STABLE discriminators
    // only ("--name X" is a contiguous substring of the leaf argv regardless
    // of MODEL, which is post-spawn-mutable). Here it only serves the orphan
    // sweep; live kills go through the child handle.
    pkillPattern: `--name ${agentName}`,
    sessionTimeoutSec: Number(merged.SESSION_TIMEOUT) > 0 ? Number(merged.SESSION_TIMEOUT) : 43200,
    systemPromptFile: fs.existsSync(path.join(mem, 'system_prompt.md')) ? path.join(mem, 'system_prompt.md') : null,
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

// Child argv, mirroring the expect spawn line ORDER exactly (run.sh:319):
// --model M --name N [extra_args] --dangerously-skip-permissions
// --dangerously-load-development-channels server:agent-channel
export function buildChildArgs(cfg) {
  const args = ['--model', cfg.model, '--name', cfg.agentName]
  if (cfg.systemPromptFile) args.push('--append-system-prompt-file', cfg.systemPromptFile)
  args.push('--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:agent-channel')
  return args
}

// ── failure marker (run.sh write_failure/clear_failure, same JSON shape) ────
// Shared path/shape with channel.mjs's writeFailureMarker() so main.cjs's
// poller watches ONE file regardless of which layer caught the problem.
// Atomic tmp+rename; best-effort -- diagnostic, never load-bearing for the
// loop's own survival (run.sh:216-231).
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
export function isOurSupervisor(pid, {
  signature = `${SELF_PATH} __loop`,
  readCommandLine = defaultReadCommandLine,
} = {}) {
  if (!pid || !isPidAlive(pid)) return false
  let cmd
  try { cmd = readCommandLine(pid) } catch { return false }
  if (!cmd) return false
  return cmd.includes(signature)
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

function defaultReadCommandLine(pid) {
  if (IS_WIN) {
    // UNVERIFIED on magi-win (design doc flag): Get-CimInstance CommandLine
    // availability/latency under the app's spawn context. Fail-safe posture
    // means an error here just reads as "not verified".
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
      // UNVERIFIED on magi-win: CommandLine -match sweep + Stop-Process.
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

// ── production child spawner (replaces run_expect + the expect script) ──────
// Returns { pid, kill, exited } where exited resolves { exitCode, signal }.
// Session timeout (run.sh:97-109,255-279): ONE timer here replaces both the
// gtimeout lane and the manual watchdog subshell -- TERM the child, 10s
// grace, KILL. A node process with a real handle needs neither of bash's
// workarounds.
function spawnPtyChild(cfg, { now = () => Date.now(), log }) {
  const require_ = createRequire(import.meta.url)
  const pty = require_('node-pty') // lazy: only the __loop lane needs the native module
  const child = pty.spawn(cfg.claudeBin, buildChildArgs(cfg), {
    name: 'xterm-256color', // run.sh:313 set env(TERM)
    cols: 200, rows: 50,    // run.sh:314 stty_init "rows 50 cols 200"
    cwd: cfg.mem,           // run.sh:285 cd "$MEM"
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      // run.sh:297 export AGENT_NAME MEM CLAUDE_BIN MODEL -- each its own
      // env var (the Bug-3 spaced-path fix is structural here: argv is a
      // real array, nothing is ever whitespace-joined).
      AGENT_NAME: cfg.agentName,
      MEM: cfg.mem,
      CLAUDE_BIN: cfg.claudeBin,
      MODEL: cfg.model,
      ...cfg.childEnvExtra,
    },
  })

  const matcher = createAutoAnswerMatcher({ send: (r) => child.write(r), now })
  let graceTimer = null
  const sessionTimer = setTimeout(() => {
    log(`session timeout (${cfg.sessionTimeoutSec}s) -- terminating child ${child.pid}`)
    killHandle('SIGTERM')
    graceTimer = setTimeout(() => killHandle('SIGKILL'), 10_000)
  }, cfg.sessionTimeoutSec * 1000)

  function killHandle(sig) {
    try {
      if (IS_WIN) {
        // taskkill /T = whole tree. UNVERIFIED on magi-win whether /T reaches
        // the CLI's grandchildren (MCP servers) -- design doc flag.
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' })
      } else {
        child.kill(sig)
      }
    } catch {}
  }

  const exited = new Promise((resolve) => {
    child.onData((d) => {
      process.stdout.write(d) // expect log_user 1: child output -> supervisor stdout -> logfile
      matcher.feed(d)
    })
    child.onExit(({ exitCode, signal }) => {
      clearTimeout(sessionTimer)
      if (graceTimer) clearTimeout(graceTimer)
      resolve({ exitCode, signal })
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
  const spawnChild = deps.spawnChild || ((c) => spawnPtyChild(c, { now, log }))
  const sweepOrphans = deps.sweepOrphans || (() => sweepOrphansDefault(cfg.pkillPattern, log))
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

  for (;;) {
    if (stopRequested()) { exitOnStop(); return 0 }

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
  if (existingPid && isOurSupervisor(existingPid)) {
    log(`${cfg.agentName} already running (pid ${existingPid})`)
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
  if (!isOurSupervisor(pid)) {
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
  if (mode === 'start') {
    startAgent(cfg)
  } else if (mode === 'stop') {
    await stopAgent(cfg)
  } else if (mode === '__loop') {
    await runLoop(cfg)
    process.exit(0)
  } else {
    console.error(`usage: supervisor.mjs [start|stop]`)
    process.exit(1)
  }
}
