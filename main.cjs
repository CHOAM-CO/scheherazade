// main.cjs — Electron main process.
//
// GOAL of this file: retire the #1 project risk (can we ship a Mac-native
// .app/.dmg that supervises child processes and serves a localhost
// onboarding page?) as early as possible, then grow the localhost page into
// the real product surface. The P0 packaging-shell spike proved the shape;
// this revision replaces its PLACEHOLDER_HTML with the real onboarding
// wizard + memory pane + settings, served from onboarding/http-server.cjs.
//
// CommonJS on purpose even though the rest of the repo (channel.mjs) is
// ESM ("type": "module" in package.json) -- Electron's main-process ESM
// support is still version-sensitive/experimental in places, and a `.cjs`
// extension always forces CommonJS regardless of the package.json "type"
// field. For a risk-retiring spike, the boring/safe choice wins, and it
// still holds now that the server has real logic in it.
//
// Three things this file wires together, each isolated in its own function:
//   1. startOnboardingServer() (= createOnboardingServer from
//      onboarding/http-server.cjs) -- plain node:http server on an
//      ephemeral port, serving the wizard/pane/settings static files + a
//      small JSON API (BYOK validation + safeStorage, config write,
//      Discord bot validation, memory_query/memory_delete bridge).
//   2. createMainWindow(url) -- BrowserWindow that loads that localhost URL.
//   3. demoChildProcessSupervision() -- spawns a trivial child, captures
//      stdout, logs its exit code. Still a P1 item: this is the exact shape
//      that will later supervise (a) the `claude` CLI agent process and (b)
//      a provider proxy process -- see wiring notes at bottom. Not part of
//      this revision's scope (onboarding UI only).
//
// FAIL LOUD: no empty catches anywhere below. Every error path either
// rethrows, logs to stderr and exits non-zero, or is a fatal dialog.

'use strict'

const { app, BrowserWindow } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const attachTopology = require('./attach-topology.cjs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const os = require('node:os')
const {
  createOnboardingServer,
  readAgentConfig,
  readDiscordToken,
  readSlackBotToken,
  readSlackAppToken,
  readTelegramToken,
  readHomeChannelId,
  readProviderKey,
  readHarnessFailure,
  toUnpackedPath,
  killAllLoginChildren,
  AGENT_NAME: FIXED_AGENT_NAME,
  DATA_HOME,
} = require('./onboarding/http-server.cjs')
const { setAgentStatus } = require('./onboarding/agent-status.cjs')
const { ensureOllamaDaemon, killOllamaDaemon } = require('./onboarding/ollama-daemon.cjs')
// Log viewer tap (v0.0.20): every line log()/fatal() and the agent child's
// stdout/stderr emit is mirrored into this ring buffer + DATA_HOME/logs/
// app.log, so GET /api/logs (-> /logs page) can show a live session log.
// Sink dir is handed over here rather than computed in the module — see
// log-buffer.cjs's own header on the require-cycle this avoids.
const logBuffer = require('./onboarding/log-buffer.cjs')
logBuffer.initSink(path.join(DATA_HOME, 'logs'))
const { buildProviderEnv, resolveChatgptProxyPort } = require('./provider-env.cjs')
const { probeUserFolders } = require('./tcc-probe.cjs')

// Fix C, closing the residual gap (code-review pass, 2026-07-03): the
// AGENT_PIDFILE check in spawnRealAgentChild() below handles the
// SEQUENTIAL quit-then-reopen double-spawn case, but has a real TOCTOU
// window against a genuinely CONCURRENT second launch (e.g. double-clicking
// the .app twice quickly) -- the PIDFILE isn't written until well after the
// check (Keychain decrypt + spawn() both happen in between), so two
// near-simultaneous launches can both read "no supervisor alive" and both
// spawn. requestSingleInstanceLock() is Electron's own purpose-built
// primitive for exactly this (OS-level lock, held for this process's whole
// lifetime, not a read-then-write race) -- call it before any other boot
// work so a second launch never even reaches spawnRealAgentChild().
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.error('[scheherazade/main] another instance already holds the single-instance lock -- quitting this one immediately.')
  app.quit()
  // Top-level return -- Node wraps every module (including the entry file)
  // in a function, so this is valid here. app.quit() is async; without
  // this, the rest of this script (requiring http-server.cjs, registering
  // app.whenReady()/before-quit/etc, and potentially reaching
  // spawnRealAgentChild()) would still run once in this doomed second
  // instance before the quit actually takes effect -- exactly the
  // double-spawn risk this fix exists to close.
  return
}
app.on('second-instance', () => {
  // A second launch attempt while this instance is running -- focus our
  // existing window instead of doing nothing (or, worse, without the lock
  // above, spawning a competing agent supervisor).
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// ── stdout/stderr hygiene ───────────────────────────────────────────────
// Electron's main process log is just the terminal it was launched from
// (or Console.app once packaged). No stdio-protocol constraint here like
// channel.mjs's MCP stdio channel has, so plain console.* is fine.
// stringify for the log-buffer mirror: log() takes console-style varargs,
// the buffer takes one line. JSON for objects (circular-safe fallback to
// String) keeps spawn-info style payloads readable in the /logs view.
function logLine(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}
function log(...args) {
  console.log(`[scheherazade/main] ${new Date().toISOString()}`, ...args)
  logBuffer.append('main', logLine(args))
}
function fatal(msg, err) {
  console.error(`[scheherazade/main] FATAL: ${msg}`, err ?? '')
  logBuffer.append('main!', `FATAL: ${msg}${err ? ` ${err.stack || err.message || err}` : ''}`)
  shuttingDown = true // block any queued control action from respawning post-cleanup
  // Bug 2 fix (agent-lifecycle, 2026-07-03, cross-model adversarial
  // review): app.exit(1) below force-exits WITHOUT emitting 'before-quit',
  // so the killAgentSupervisor('SIGTERM') wired there (see app.on('before-
  // quit', ...) further down) is bypassed entirely. fatal() is wired to
  // uncaughtException/unhandledRejection, so ANY uncaught error after the
  // agent has spawned would otherwise orphan the whole run.sh -> expect ->
  // claude tree, still holding the Discord token, with no cleanup at all.
  // Best-effort, belt-and-suspenders: the synchronous group-SIGTERM inside
  // killAgentSupervisor() is the part that reliably fires before app.exit()
  // tears this process down; the async 'run.sh stop' child it also spawns
  // may or may not survive the immediate exit below, which is fine here --
  // it's the secondary/reliable path for the ORDINARY quit case, not this
  // crash-path's only line of defense. Wrapped in try/catch so a failure
  // in cleanup can NEVER mask the original fatal error or block the exit;
  // no-ops safely via killAgentSupervisor()'s own
  // `if (agentSupervisorPid == null) return` guard when fatal() fires
  // before any agent has ever spawned.
  try {
    killAgentSupervisor('SIGTERM')
  } catch (cleanupErr) {
    console.error('[scheherazade/main] fatal(): killAgentSupervisor cleanup itself failed (masking nothing, proceeding to exit):', cleanupErr)
  }
  // Same Bug-2 reasoning for OUR in-process codex-as-api proxy server
  // (2026-07-07): close it cleanly on the crash path too (it dies with the
  // process regardless -- this is belt-and-suspenders port release).
  // No-ops when we never started one; external/reused proxies are
  // untouchable by construction (in-process handle only).
  try {
    killCodexProxy()
  } catch (cleanupErr) {
    console.error('[scheherazade/main] fatal(): killCodexProxy cleanup itself failed (masking nothing, proceeding to exit):', cleanupErr)
  }
  // And for detached login children (Codex finding #3): an orphaned
  // `codex login` finishing OAuth after the app died would write
  // credentials with nobody supervising.
  try {
    killAllLoginChildren('SIGTERM')
  } catch (cleanupErr) {
    console.error('[scheherazade/main] fatal(): killAllLoginChildren cleanup itself failed (masking nothing, proceeding to exit):', cleanupErr)
  }
  // And for OUR managed ollama daemon child (2026-07-07): unlike the
  // in-process proxy it would genuinely outlive the process as an orphan.
  // No-ops when we only REUSED an external daemon (handle stays null).
  try {
    killOllamaDaemon('SIGTERM')
  } catch (cleanupErr) {
    console.error('[scheherazade/main] fatal(): killOllamaDaemon cleanup itself failed (masking nothing, proceeding to exit):', cleanupErr)
  }
  // Fail loud: a spike that silently limps along teaches us nothing about
  // whether the real thing will work. Exit non-zero so CI/manual runs see
  // a clear failure instead of a window that just never showed up.
  app.exit(1)
}

// ── (b) localhost onboarding server ─────────────────────────────────────
// Real implementation lives in onboarding/http-server.cjs: the wizard
// (BYOK + safeStorage, name/persona, Discord bot tutorial + gateway-connect
// validation, handoff) plus the read-only memory pane and a minimal
// settings page, all served as static files + a small JSON API over the
// same ephemeral-port pattern the P0 spike established (listen(0, ...),
// read the OS-assigned port off the server object, hand that URL to the
// BrowserWindow). No preload/IPC needed -- the renderer stays fully
// sandboxed and talks to this server over same-origin fetch() only.
const startOnboardingServer = createOnboardingServer

// ── (a) BrowserWindow ────────────────────────────────────────────────────
function createMainWindow(url) {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    // Floor the window at the layout's own width (alignment pass
    // 2026-07-25). .page-shell is max-width 760px + 1.5rem padding each
    // side = 808px of content; below that the settings label column and
    // its control column start colliding and the page reads as broken
    // rather than narrow. Nothing stopped a user from dragging it there.
    minWidth: 860,
    minHeight: 560,
    title: 'Scheherazade',
    webPreferences: {
      // No preload / no Node integration in the renderer -- every wizard
      // and memory-pane action (safeStorage, memory tool, Discord REST
      // calls, shell.openExternal) runs server-side in
      // onboarding/http-server.cjs and is reached over plain fetch(), so
      // the renderer never needs Node/Electron APIs directly.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.loadURL(url).catch((err) => fatal(`BrowserWindow failed to load ${url}`, err))

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    fatal(`did-fail-load: ${errorCode} ${errorDescription}`)
  })

  return win
}

// ── (c) real agent child spawn ──────────────────────────────────────────
// Replaces the old demoChildProcessSupervision() one-shot spike (proved
// "can Electron main spawn+capture+reap a child" -- now retired, its job
// done). This spawns the actual long-lived `claude` CLI agent, per the
// wiring notes that used to live at the bottom of this file.
//
// RESOLVED (2026-07-03, bundle-claude-cli task -- BLOCKER above from the
// packaging-bugfix task is closed): `@anthropic-ai/claude-code` is now a
// real `dependencies` entry in package.json (Mino pre-approved: redistribution
// terms waived, arm64-only, "max UX so the user never installs anything
// separately"). Its postinstall (see node_modules/@anthropic-ai/claude-code/
// install.cjs) detects the platform and hardlinks/copies the matching
// platform package's (`@anthropic-ai/claude-code-darwin-arm64`) native Mach-O
// binary over the `bin/claude.exe` placeholder -- after `npm install`,
// node_modules/@anthropic-ai/claude-code/bin/claude.exe IS the real
// standalone arm64 executable (confirmed: `file` reports Mach-O 64-bit
// arm64, runs `--version` with no system node on PATH). electron-builder's
// `build.extraResources` copies that one file to
// Contents/Resources/claude-cli/claude at build time (package.json's
// `build.files` excludes `node_modules/@anthropic-ai/claude-code*/**` from
// the asar so the ~220MB binary isn't duplicated into app.asar on top of
// the extraResources copy). resolveClaudeBin() below finds it at exactly
// that path in a packaged app.
//
// AGENT-LIFECYCLE FIX (2026-07-03, model-divergent/GPT review -- four
// verified bugs, this revision closes all four):
//   BUG 1 (trigger): spawnRealAgentChild() used to run ONCE at
//     app.whenReady, before ONBOARDING_COMPLETE could possibly be '1' on a
//     fresh install -- it skipped, and nothing ever called it again until
//     the next full app restart. createOnboardingServer() now takes an
//     onOnboardingComplete callback (see boot sequence below) fired
//     synchronously from the /api/discord/validate success path, the exact
//     moment ONBOARDING_COMPLETE flips.
//   BUG 2 (persistent run): this used to spawn `claude` directly with
//     stdio ['ignore','pipe','pipe'] -- no TTY, so Claude Code runs in
//     --print mode, which exits immediately without a prompt/stdin. Fixed
//     by reviving run.sh as an INTERNAL bundled launcher (see RUN_SH_PATH
//     below) instead of spawning the claude binary directly: run.sh's
//     `__loop` mode runs it under /usr/bin/expect (a real PTY) with the
//     proven exponential-backoff restart ladder and trust-prompt handling
//     already battle-tested elsewhere in this fork's lineage. An earlier
//     pass here left a comment calling run.sh "DEAD (Mino directive)" on a
//     mis-read of that directive; reviving it as an internal launcher (the
//     user never touches a CLI, they double-click the .app -- run.sh is an
//     implementation detail, not a CLI surface) is intended and approved.
//   BUG 3 (token forward): empirically confirmed, NOT a bug -- see
//     spawnRealAgentChild()'s BOT-TOKEN SEAM comment below for the test and
//     result.
//   REQUIREMENT 4 (liveness gate): see onboarding/agent-status.cjs (process
//     side) + http-server.cjs's GET /api/agent/status (combines that with
//     channel.mjs's DATA_HOME/.agent-live Discord-heartbeat marker).
function resolveClaudeBin() {
  const isWin = process.platform === 'win32'
  if (app.isPackaged) {
    // electron-builder extraResources target -- see package.json's
    // per-platform build.{mac,win}.extraResources and the RESOLVED comment
    // above for how this gets populated at build time. The name is
    // platform-conditional (win-port Phase 2): the old global `to:
    // claude-cli/claude` stripped the .exe extension, which is harmless on
    // mac (the postinstall put a Mach-O behind the .exe placeholder name)
    // and FATAL on Windows (an extensionless PE binary is not executable).
    const bundled = path.join(process.resourcesPath, 'claude-cli', isWin ? 'claude.exe' : 'claude')
    if (fs.existsSync(bundled)) {
      try {
        fs.accessSync(bundled, fs.constants.X_OK)
        return { bin: bundled, source: 'bundled' }
      } catch {
        // present but not executable -- fall through to PATH
      }
    }
  }
  // PATH fallback. On win, ONLY claude.exe: detection must mirror what the
  // supervisor's pty.spawn can actually exec -- a claude.cmd npm shim would
  // "detect" here and then fail at ConPTY spawn time (CreateProcess does not
  // interpret .cmd), a false-working state worse than a clean not-found.
  // UNVERIFIED on magi-win (flag class as supervisor.mjs's win lanes).
  const exeName = isWin ? 'claude.exe' : 'claude'
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, exeName)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return { bin: candidate, source: 'system-path' }
    } catch {
      // not here, keep looking
    }
  }
  return null
}

// run.sh as an INTERNAL bundled launcher (BUG 2 fix, see comment block
// above). toUnpackedPath (reused from onboarding/http-server.cjs, same
// helper CHANNEL_SCRIPT_PATH/MEMORY_SERVER_SCRIPT_PATH there use) maps this
// to the real on-disk unpacked copy in a packaged app -- see package.json's
// build.files/build.asarUnpack, both of which now list run.sh. No-op in
// dev (REPO_ROOT never contains "/app.asar/" there).
const RUN_SH_PATH = toUnpackedPath(path.join(__dirname, 'run.sh'))
const BASH_BIN = '/bin/bash' // confirmed present on stock macOS; hardcoded rather than PATH-resolved since a packaged app's PATH can be minimal

// Windows-port Phase 1 seam (docs/supervisor-design.md, "What run.sh keeps
// doing"): SUPERVISOR_LANE=node spawns supervisor.mjs under Electron-as-node
// (ELECTRON_RUN_AS_NODE, probe-verified ABI lane); anything else -- including
// unset -- keeps the battle-tested bash lane. Read ONCE at module load: a
// lane is a process-lifetime decision, and flipping it mid-run would desync
// the spawn/stop/identity trio that all key off it.
const SUPERVISOR_MJS_PATH = toUnpackedPath(path.join(__dirname, 'supervisor.mjs'))
const SUPERVISOR_LANE = (process.env.SUPERVISOR_LANE || '').trim().toLowerCase() === 'node' ? 'node' : 'bash'

// Fix C (agent-lifecycle model-divergent review, 2026-07-03): this used to
// spawn `bash run.sh __loop` directly, bypassing run.sh's OWN start_agent()
// PIDFILE entirely -- quit+reopen (or a second app instance) could spawn a
// second supervisor while the first was still alive and orphaned, and the
// two would fight over the same Discord token via pkill inside their
// respective run_loop()s (and, worse, both reply on Discord). This process
// now participates in the exact same PIDFILE run.sh's own start_agent()/
// stop_agent() use, at the same path -- see run.sh's PIDFILE="$MEM/.agent.pid"
// (MEM == DATA_HOME here, since AGENT_DATA_HOME is always set below to
// this exact value).
const AGENT_PIDFILE = path.join(DATA_HOME, '.agent.pid')
// Critical B's second half: run.sh's write_failure() / channel.mjs's
// writeFailureMarker() both write this same path -- see FAILFILE in run.sh
// and FAILURE_MARKER_PATH in channel.mjs. Polled below (see
// pollFailureMarker()) so a bad token/repeated-crash-loop reaches the user
// as a 'failed' status within a bounded time instead of infinite
// 'connecting'.
const AGENT_FAILFILE = path.join(DATA_HOME, '.agent-failed.json')
const FAILURE_POLL_MS = 3_000

// Shared by Fix C (PIDFILE liveness check) and Fix D's sibling check in
// http-server.cjs -- same kill(pid, 0)-probe idiom run.sh's own is_alive()
// uses. Not re-exported/shared as a module between the two files: it's a
// six-line pure function, not worth a shared-module seam between a CJS
// onboarding server and this CJS main process for.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Bug 1 fix (agent-lifecycle, 2026-07-03, cross-model adversarial review):
// isPidAlive() alone is IDENTITY-BLIND -- it only proves *some* process
// holds this pid right now, not that it's OUR run.sh __loop supervisor. A
// stale PIDFILE surviving a crash/reboot, combined with macOS recycling
// that pid to an unrelated process, would otherwise make this app either
// (a) silently never spawn its own agent (isPidAlive() true -> skip spawn,
// UI stuck 'connecting' forever with no clue why), or (b) on quit,
// SIGTERM an unconfirmed/unrelated process via killAgentSupervisor().
// Verify PROCESS IDENTITY via its own command line -- require it to
// contain the CONTIGUOUS spawn signature `<RUN_SH_PATH> __loop`, the
// exact signature spawnRealAgentChild() below uses to spawn it
// (`spawn(BASH_BIN, [RUN_SH_PATH, '__loop'])`), and the same convention
// run.sh's own is_our_supervisor() checks on its side of this PIDFILE.
// Fail SAFE: `ps` erroring, being unavailable, or returning nothing
// (permission, already-exited race) all resolve to "not verified" --
// callers must treat that as if the pid is NOT our supervisor (never
// trust it as already-running, never signal it).
//
// Cross-model adversarial review follow-up (2026-07-03), two compounding
// bugs fixed together:
//   Fix A -- `-ww` forces `ps` to print the FULL, un-truncated command
//     line. Without it, macOS/BSD `ps` width-limits its `command=`
//     output; a legit supervisor launched from a long install path (e.g.
//     inside a deeply-nested "*.app" bundle) can have `__loop` truncated
//     clean off the printed line, false-negating a REAL supervisor as
//     unverified -- which then makes start_agent() double-spawn a second
//     live agent and makes killAgentSupervisor() skip signaling a live
//     one.
//   Fix B -- match the CONTIGUOUS substring `<RUN_SH_PATH> __loop`
//     instead of two independent `.includes()` checks. Two separate
//     substring tests pass if RUN_SH_PATH and '__loop' both appear
//     ANYWHERE in the command line, even unrelated to each other (e.g. a
//     recycled pid now held by an editor/grep/diagnostic process whose
//     argv happens to mention both tokens) -- a false positive that then
//     gets trusted as a live supervisor or signaled as one. The actual
//     spawn is always `bash <RUN_SH_PATH> __loop`, so matching the two
//     tokens back-to-back (space-joined) is both necessary and
//     sufficient, and depends on Fix A: without `-ww`, truncation could
//     also sever this exact contiguous match.
function isOurSupervisor(pid) {
  // Recognition is deliberately LANE-AGNOSTIC (SUPERVISOR_LANE seam,
  // Windows-port Phase 1): both signatures are OUR supervisors on the same
  // PIDFILE. Recognizing only the configured lane would make a lane flip
  // treat a live old-lane supervisor as stale -- and double-spawn a second
  // supervisor onto the same Discord token, the exact Fix-C disaster.
  return readSupervisorCommandLine(pid) !== null
}

// Returns the verified command line when pid is a live supervisor of EITHER
// lane, else null. Shared by isOurSupervisor() and the stop-path lane router.
function readSupervisorCommandLine(pid) {
  if (!isPidAlive(pid)) return null
  let commandLine
  try {
    commandLine = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch (err) {
    log(`readSupervisorCommandLine(${pid}): ps lookup failed (${err.message}) -- treating as UNVERIFIED, fail-safe`)
    return null
  }
  if (commandLine.includes(`${RUN_SH_PATH} __loop`) || commandLine.includes(`${SUPERVISOR_MJS_PATH} __loop`)) return commandLine
  return null
}

// Stop must be routed to the lane that matches the LIVE supervisor, not the
// configured one: each lane's stopper only recognizes its own spawn
// signature (run.sh is frozen as the production mac lane), and the wrong
// stopper would "clean up" a pidfile whose owner is alive -- orphaning a
// running agent. Falls back to the configured lane when nothing verifiable
// is live (then the stopper only does stale-state cleanup anyway).
function supervisorStopCommand() {
  let lane = SUPERVISOR_LANE
  const commandLine = readSupervisorCommandLine(readPidFromFile(AGENT_PIDFILE))
  if (commandLine) lane = commandLine.includes(`${SUPERVISOR_MJS_PATH} __loop`) ? 'node' : 'bash'
  return lane === 'node'
    ? { lane, bin: process.execPath, args: [SUPERVISOR_MJS_PATH, 'stop'], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
    : { lane, bin: BASH_BIN, args: [RUN_SH_PATH, 'stop'], extraEnv: {} }
}

function readPidFromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (err) {
    if (err.code !== 'ENOENT') log(`readPidFromFile(${filePath}): unexpected error: ${err.message}`)
    return null
  }
}

// Tracks the currently-live agent child (the persistent run.sh __loop
// supervisor process, not an individual `claude` crash inside it -- those
// are absorbed by run.sh's own restart/backoff ladder and never reach
// here). Guards against double-spawn (PART 1 requirement): both the
// boot-time call and the onOnboardingComplete callback can legitimately
// race/overlap (e.g. a returning already-onboarded user who somehow also
// re-triggers validate), and spawning two supervisors for the same agent
// would fight over the same Discord token/MCP servers. Fix C adds a SECOND,
// cross-process guard on top (the PIDFILE check below) for the quit+reopen
// case, where this in-memory variable itself was reset by the process
// restart and can't help.
let agentChild = null
let failurePollTimer = null
let lastFailureMtimeMs = 0
// Fix C: pid this app instance considers "the supervisor it's responsible
// for" -- set on a successful spawn (child.pid) OR on discovering one
// already alive via AGENT_PIDFILE (existingPid, see spawnRealAgentChild()).
// killAgentSupervisor() (app quit) uses THIS, not agentChild.pid directly,
// so quit still cleans up a supervisor this process attached to but never
// itself spawned (agentChild stays null in that path -- there's no
// ChildProcess object to hold stdout/stderr/exit listeners on someone
// else's process).
let agentSupervisorPid = null

// codex-as-api proxy, IN-PROCESS (login shell-out / chatgpt provider,
// 2026-07-07; reworked same day from a spawned child to an in-process
// express server after confirming the npm package exports createApp()).
// Non-null ONLY for the http.Server THIS process started via
// createApp().listen() -- ownership is in-process by construction, so
// there is no external process we could ever signal by mistake (the
// dual-supervisor mutual-kill class from the 07-06 run-agent incident is
// structurally impossible here), no orphan on crash (server dies with the
// process), and no binary resolution/spawn surface at all.
// Last spawn's birth config (model/effort/provider/at) -- set at the spawn
// moment in spawnRealAgentChild, served via agentControls.spawnInfo() for
// GET /api/agent/spawn-info. null until the first spawn of this app run.
let lastSpawnInfo = null

let codexProxyServer = null
// The MODEL the live in-process proxy was built for (null = proxy default).
// Compared on every ensure so a model swap rebuilds the proxy instead of
// silently serving the previous pick (see ensureCodexProxy's passthrough
// comment).
let codexProxyModel = null

// Critical B: polls AGENT_FAILFILE (written by run.sh's write_failure() on
// a quick-fail restart streak, or by channel.mjs's writeFailureMarker() on
// a Discord login/token failure) and surfaces it via setAgentStatus so the
// Step 5 UI's poll (GET /api/agent/status) sees 'failed' within
// FAILURE_POLL_MS of either layer detecting the problem, instead of
// sitting on 'connecting' forever. mtime-gated so a repeatedly-rewritten
// marker (run.sh re-writes it on every subsequent quick-fail restart)
// doesn't spam redundant setAgentStatus calls.
function pollFailureMarker() {
  try {
    const stat = fs.statSync(AGENT_FAILFILE)
    if (stat.mtimeMs === lastFailureMtimeMs) return
    lastFailureMtimeMs = stat.mtimeMs
    const parsed = JSON.parse(fs.readFileSync(AGENT_FAILFILE, 'utf8'))
    const detail =
      parsed && typeof parsed.reason === 'string'
        ? parsed.reason
        : 'agent supervisor reported a failure (see run.sh/channel.mjs logs)'
    // Cause-code wiring (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1):
    // the marker is written by two independent emitters -- run.sh's
    // write_failure() (code: "crash_loop") and channel.mjs's
    // writeFailureMarker() (code: "discord_token_bad") -- both now stamp a
    // `code` field into the same JSON shape. Fall back to 'unknown' if it's
    // absent (an old marker written before this fix, mid-write torn read
    // that happened to still parse, etc) or malformed (present but not a
    // non-empty string) -- never guess a more specific code than the
    // marker actually declares.
    const code = parsed && typeof parsed.code === 'string' && parsed.code.trim() !== '' ? parsed.code : 'unknown'
    console.error(`[scheherazade/main] failure marker detected at ${AGENT_FAILFILE}: code=${code} detail=${detail}`)
    setAgentStatus('failed', code, detail)
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[scheherazade/main] pollFailureMarker: failed to read/parse ${AGENT_FAILFILE}:`, err)
    // ENOENT (no marker yet, or since cleared by run.sh's clear_failure()):
    // nothing to surface. Deliberately NOT auto-flipping status back to
    // 'connecting' here on marker-disappearance -- that recovery path needs
    // a real re-validated credential, which today only happens via a fresh
    // app launch (out of this fix's bounded scope).
  }
}

function startFailurePoll() {
  stopFailurePoll()
  lastFailureMtimeMs = 0
  failurePollTimer = setInterval(pollFailureMarker, FAILURE_POLL_MS)
  failurePollTimer.unref?.()
}

function stopFailurePoll() {
  if (failurePollTimer) {
    clearInterval(failurePollTimer)
    failurePollTimer = null
  }
}

// Spawns the real agent as a long-lived background child -- unlike the old
// demo, this does NOT return a promise that resolves on exit (that would
// block the boot sequence for the agent's entire lifetime). It spawns (or
// logs a clear reason + returns null if it can't) and returns immediately;
// exit/error update onboarding/agent-status.cjs's shared status (read by
// http-server.cjs's GET /api/agent/status) for fail-loud surfacing to the
// UI, in addition to the existing console logging.
// ── codex-as-api proxy, in-process (chatgpt provider, 2026-07-07) ────────
// The chatgpt provider mode routes the agent at http://localhost:<port>
// (provider-env.cjs), assuming a codex-as-api proxy is listening. On MAGI's
// machine that proxy is an always-on external daemon; an end-user Mac has
// none -- so the app runs one ITSELF, in-process, via the codex-as-api npm
// package's createApp() (pinned dependency; it reads/refreshes
// ~/.codex/auth.json on its own). Making "login once -> auto-setup"
// actually true for chatgpt with ZERO new spawn surface. Rules:
//   - BIND-FIRST FAIL-CLOSED (supersedes the round-2 lsof identity dance
//     for our own proxy): we do not pre-check then bind (TOCTOU) -- we
//     just bind. The kernel arbitrates atomically: EADDRINUSE means
//     someone else owns the port, and ONLY an explicitly-configured
//     CHATGPT_PROXY_PORT (informed opt-in, same trust class as a BYOK
//     base URL) may then be reused after a loopback liveness check;
//     an occupied DEFAULT port blocks the agent spawn, loudly. lsof is
//     kept for the diagnostic message only, never for the decision.
//     This keeps the co-located-MAGI case working (dev opts in to the
//     fleet proxy explicitly) without ever signaling that external proxy.
//   - NO AUTO-RESTART in v1.1: if our in-process server errors, the
//     agent's calls fail visibly and the next spawnRealAgentChild() pass
//     re-runs this. Loud log, no silent loop.
//   - AWAITED by spawnRealAgentChild(): returns true only when a proxy we
//     trust is up; the agent does not spawn on false.
async function ensureCodexProxy(config) {
  const rawPort = config.CHATGPT_PROXY_PORT
  const explicitPort = rawPort != null && String(rawPort).trim() !== ''
  const portResult = resolveChatgptProxyPort(rawPort)
  if (portResult.error) {
    // buildProviderEnv() already rejected this config upstream; belt-and-
    // suspenders only.
    console.error(`[scheherazade/main] ensureCodexProxy: bad port config: ${portResult.error.reason}`)
    return false
  }
  const port = Number(portResult.port)
  const url = `http://localhost:${port}`
  // Model passthrough (2026-07-14, caught live on Mino's second-device
  // test the same morning the versioned GPT catalog shipped): codex-as-api's
  // anthropic route sends its MODULE-LEVEL default model and only ECHOES
  // body.model back (dist/index.js: `requestModel = MODEL; clientModel =
  // body.model`) -- so the dropdown's gpt-5.6-* pick never reached the
  // engine, and three catalog entries were one actual model (the proxy
  // default, gpt-5.5 at 0.5.2). The module reads CODEX_AS_API_MODEL once at
  // load, hence: env set BEFORE require, require-cache evicted per (re)build
  // so a model swap reloads the constant, and the proxy's own /health
  // `model` field is the RECEIPT gate after listen -- if the engine-side
  // model doesn't match the user's pick, the proxy dies loudly rather than
  // serving a silently different model (the exact defect class this fixes).
  // Only gpt-* ids are forwarded; anything else leaves the proxy default.
  // An explicitly-configured EXTERNAL proxy (the dev/fleet opt-in below) is
  // not ours to configure -- its operator owns its model.
  const desiredModel = typeof config.MODEL === 'string' && /^gpt-/.test(config.MODEL.trim())
    ? config.MODEL.trim()
    : null
  const alive = async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(750) })
      return true // any HTTP response = something listens (same contract as checkLocalLiveness)
    } catch {
      return false
    }
  }
  // Diagnostics ONLY (never a decision input -- see BIND-FIRST above).
  const listenerPidsForLog = () => {
    try {
      const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
        timeout: 3000,
      })
      const pids = out.split('\n').map((s) => s.trim()).filter(Boolean)
      return pids.length ? pids.join(',') : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  if (codexProxyServer) {
    if (codexProxyServer.listening && codexProxyModel === desiredModel && (await alive())) {
      log(`ensureCodexProxy: our in-process proxy already serves ${url} (model ${codexProxyModel || 'proxy default'})`)
      return true
    }
    log(codexProxyServer.listening && codexProxyModel !== desiredModel
      ? `ensureCodexProxy: model changed (${codexProxyModel || 'default'} -> ${desiredModel || 'default'}) -- rebuilding proxy`
      : 'ensureCodexProxy: stale in-process proxy server handle -- closing and re-creating')
    killCodexProxy()
  }

  let createApp
  try {
    if (desiredModel) process.env.CODEX_AS_API_MODEL = desiredModel
    else delete process.env.CODEX_AS_API_MODEL
    // Evict so the module-level MODEL constant re-reads the env we just set;
    // the bundle re-requires only cached stateless deps (express et al).
    try { delete require.cache[require.resolve('codex-as-api')] } catch {}
    ;({ createApp } = require('codex-as-api'))
  } catch (err) {
    console.error('[scheherazade/main] ensureCodexProxy: codex-as-api package failed to load (bundling problem?):', err)
    return false
  }

  try {
    codexProxyServer = await new Promise((resolve, reject) => {
      // Loopback-only bind, deliberately narrower than the CLI's default.
      const srv = createApp().listen(port, '127.0.0.1')
      srv.once('listening', () => resolve(srv))
      srv.once('error', reject)
    })
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      if (explicitPort) {
        if (await alive()) {
          log(`ensureCodexProxy: port ${port} taken; reusing EXPLICITLY-CONFIGURED proxy at ${url} (user opt-in; owning nothing, never signaling it)`)
          return true
        }
        console.error(`[scheherazade/main] ensureCodexProxy: explicit-port listener (pid(s) ${listenerPidsForLog()}) does not answer at ${url} -- not routing the agent at it`)
        return false
      }
      console.error(
        `[scheherazade/main] ensureCodexProxy: BLOCKED -- pid(s) ${listenerPidsForLog()} already listen on the default proxy port (${url}) ` +
          'and are not this app. Routing the agent at an unrecognized local service would hand it the whole conversation ' +
          'stream. If that listener is YOUR codex-as-api, set the proxy port explicitly in settings to opt in; otherwise ' +
          'quit the other process and relaunch.'
      )
      return false
    }
    console.error('[scheherazade/main] ensureCodexProxy: in-process proxy failed to start:', err)
    return false
  }

  // Track post-listen errors loudly (NO AUTO-RESTART rule above).
  codexProxyServer.on('error', (err) => {
    console.error('[scheherazade/main] ensureCodexProxy: in-process proxy server error:', err)
  })

  // RECEIPT, not hope: the proxy's own /health reports the model it will
  // actually send. If the passthrough didn't take (env read too late, a
  // future codex-as-api changing its config surface), serving a silently
  // different model than the dropdown shows is the exact defect this lane
  // just had -- fail closed and loud instead.
  if (desiredModel) {
    let reported = null
    try {
      const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).json()
      reported = health && health.model ? String(health.model) : null
    } catch (err) {
      log(`ensureCodexProxy: /health probe failed (${err.message}) -- cannot verify model passthrough`)
    }
    if (reported !== desiredModel) {
      console.error(`[scheherazade/main] ensureCodexProxy: model passthrough FAILED -- picked ${desiredModel}, proxy /health reports ${reported ?? 'unknown'}. Not spawning the agent on a silently different model.`)
      killCodexProxy()
      return false
    }
  }

  codexProxyModel = desiredModel
  log(`ensureCodexProxy: in-process proxy up at ${url} (model ${desiredModel || 'proxy default'}, /health-verified)`)
  return true
}

function killCodexProxy() {
  if (!codexProxyServer) return // in-process only -- an external/reused proxy is never ours to touch
  try {
    codexProxyServer.close()
    log('killCodexProxy: in-process proxy server closed')
  } catch (err) {
    log(`killCodexProxy: close failed (${err.message}) -- proceeding`)
  }
  codexProxyServer = null
  codexProxyModel = null
}

// Reentrancy sentinel (Codex re-review finding #2, 2026-07-07): the awaited
// chatgpt proxy gate inside the locked body opened a window where two
// concurrent spawn attempts (e.g. repeated onboarding-complete callbacks)
// both pass the agentChild + PIDFILE checks before either sets agentChild
// -- two supervisors on one Discord token. Set SYNCHRONOUSLY before any
// await, cleared on every exit; same pattern as loginStarting in
// http-server.cjs.
let agentSpawning = false

// Intentional-stop mode (control-panel stop/restart, 2026-07-09). null means
// "any supervisor exit is an unexpected crash" -- the historical assumption
// baked into child.on('exit') below, which stamps 'failed'. The control panel
// deliberately kills the supervisor (user turned the agent off, or swapped its
// model), so those paths set this flag FIRST and the exit handler consumes it:
//   'stop'    -- user turned the agent off: exit -> setAgentStatus('stopped').
//   'restart' -- model swap / manual restart: exit -> leave status untouched,
//                the immediately-following spawnRealAgentChild() re-stamps
//                'connecting'. Reset to null by whichever exit handler consumes
//                it (single-shot), never left dangling for the next real crash.
let intentionalStopMode = null

// Set once, irreversibly, when the app is tearing down (fatal() / before-quit).
// spawnRealAgentChild() checks it and refuses to spawn: without this, a control
// action awaiting a stop when the user quits could resume AFTER quit cleanup
// (killAgentSupervisor) already ran and spawn a fresh detached supervisor that
// outlives the app -- an orphan on the Discord token (Codex red-team, 2026-07-09).
let shuttingDown = false

async function spawnRealAgentChild() {
  if (shuttingDown) {
    log('agent spawn skipped: app is shutting down (quit cleanup already ran)')
    return null
  }
  if (agentSpawning) {
    log('agent spawn skipped: another spawn attempt is already in progress')
    return null
  }
  agentSpawning = true
  try {
    return await spawnRealAgentChildLocked()
  } finally {
    agentSpawning = false
  }
}

async function spawnRealAgentChildLocked() {
  if (agentChild) {
    log(`agent spawn skipped: a child is already alive (pid=${agentChild.pid})`)
    return agentChild
  }

  // Harness gate (nogabi issue #6). The boot refresh re-renders CLAUDE.md,
  // ONTOLOGY_GUIDE.md and system_prompt.md so a shipped fix reaches installs
  // that already onboarded. When that render fails it used to log a line and
  // let the agent start anyway, which mixes a new runtime with an older
  // harness and is visible nowhere the user looks. Fail closed instead, in the
  // same shape as the provider blockers below: an explicit failed state with a
  // reason the UI renders. A later boot that renders cleanly deletes the marker
  // and the agent starts again with no user action, which is the whole point of
  // refreshing every boot.
  const harnessFailure = readHarnessFailure()
  if (harnessFailure) {
    const reason = `the agent harness could not be re-rendered at boot, so the agent was not started against an out-of-date harness: ${harnessFailure.message}`
    console.error(`[scheherazade/main] BLOCKER: ${reason}`)
    setAgentStatus('failed', 'harness_stale', reason)
    return null
  }

  // Fix C: cross-process guard. `agentChild` above only protects against a
  // double-spawn WITHIN this same Electron process's lifetime -- on
  // quit+reopen, that variable is gone (fresh process), but a previous
  // supervisor can still be alive (window-all-closed doesn't kill it, and
  // before this fix nothing did on quit either). Check the on-disk PIDFILE
  // run.sh's own start_agent()/stop_agent() use before spawning a second
  // one.
  const existingPid = readPidFromFile(AGENT_PIDFILE)
  if (existingPid && isOurSupervisor(existingPid)) {
    log(`agent spawn skipped: a supervisor is already running per ${AGENT_PIDFILE} (pid=${existingPid}, identity verified via ps)`)
    agentSupervisorPid = existingPid // so app-quit still cleans this up, see killAgentSupervisor()
    // Attach topology: the adopted supervisor is a tmux pane -- wire the
    // logfile tail (pipe-pane mirror, see startAttachLogTail) and stamp
    // spawn-info from config so the shell's model/effort details aren't
    // blank for a supervisor this app process never spawned.
    if (agentTopologyIsAttach()) {
      startAttachLogTail()
      stampAttachSpawnInfo()
    }
    // Timeout-backstop gap fix (Step 5 onboarding-wiring, cross-model codex
    // review follow-up, 2026-07-03): stamp 'connecting' on THIS attach path
    // too, not just the fresh-spawn path below. Without it, reopening the
    // app onto an alive-but-HUNG supervisor (alive per PIDFILE, but stuck
    // before channel.mjs's Discord ClientReady -- no fresh .agent-live
    // marker, and no .agent-failed.json either) left proc.state at 'idle',
    // and computeAgentStatus()'s TIMEOUT_MS backstop only fires from
    // 'connecting' -- so it fell through to 'connecting' FOREVER, the exact
    // stuck-connecting the backstop exists to catch, bypassed by the attach
    // path. With this stamp, `since` is set now: a HEALTHY attached
    // supervisor still resolves to 'live' the instant its fresh marker is
    // read (live beats the connecting-timeout in computeAgentStatus's
    // precedence), and only a HUNG one falls through to a 60s timeout ->
    // failed code=timeout. Placed BEFORE startFailurePoll() (order doesn't
    // matter -- neither reads the other's effect -- but keeps the "declare
    // we're connecting, then start watching" reading).
    setAgentStatus('connecting')
    startFailurePoll() // still watch for failures even though we didn't spawn this run
    return null
  }
  if (existingPid) {
    // Bug 1 fix: either dead, or alive-but-not-ours (pid recycled by
    // macOS to an unrelated process) -- both cases are "stale" from this
    // PIDFILE's perspective. Clear it and spawn fresh rather than silently
    // trusting an unverified pid.
    log(`stale/unverified PIDFILE at ${AGENT_PIDFILE} (pid=${existingPid} not confirmed as our supervisor -- dead, or pid recycled to an unrelated process), clearing before spawn`)
    fs.rmSync(AGENT_PIDFILE, { force: true })
  }

  const config = readAgentConfig()
  if (config.ONBOARDING_COMPLETE !== '1') {
    log('agent spawn skipped: onboarding not complete yet (no validated provider/Discord token on file)')
    return null
  }

  // ── attach topology (0.1.0 prep) ──────────────────────────────────────
  // AGENT_TOPOLOGY=attach: the supervisor lives in a user-bootstrapped tmux
  // pane (terminal-descended, TCC-stable). The app NEVER spawns it -- it
  // adopts a live one (the PIDFILE path above already did, for a running
  // pane), revives a dead pane via respawn-pane (server-descended, safe), or
  // reports that bootstrap is needed. It never falls through to the spawn
  // code below, and it never creates a tmux server (attach-topology.cjs's
  // allowlist enforces that invariant mechanically).
  if ((config.AGENT_TOPOLOGY || 'spawn') === 'attach') {
    return attachStartFromSession(config)
  }

  const resolved = resolveClaudeBin()
  if (!resolved) {
    const reason =
      'claude CLI not found -- expected the bundled binary at Resources/claude-cli/claude ' +
      '(electron-builder extraResources, see resolveClaudeBin() above) to be present and ' +
      'executable, and it is not; system PATH has no `claude` either.'
    console.error(
      `[scheherazade/main] BLOCKER: ${reason} The real agent cannot be spawned. If this fires ` +
        'in a packaged build, the extraResources copy is missing/corrupt/non-executable -- ' +
        'check the build output. Onboarding UI stays usable.'
    )
    // Cause-code wiring (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1):
    // no dedicated code exists for "bundled CLI binary missing" -- it isn't
    // one of the enumerated causes (crash_loop/discord_token_bad/
    // provider_not_wired/key_error/timeout), so 'unknown' is the honest
    // fallback rather than overloading a more specific code that doesn't fit.
    setAgentStatus('failed', 'unknown', reason)
    return null
  }

  if (!fs.existsSync(RUN_SH_PATH)) {
    const reason = `internal launcher not found at ${RUN_SH_PATH} (run.sh missing from the packaged/unpacked app -- check build.files/build.asarUnpack)`
    console.error(`[scheherazade/main] BLOCKER: ${reason}`)
    // Same 'unknown' reasoning as the claude-CLI-missing branch above.
    setAgentStatus('failed', 'unknown', reason)
    return null
  }

  // Critical A (agent-lifecycle model-divergent review, 2026-07-03):
  // BYOK key forward. A fresh Mac where `claude` was never authenticated
  // has NO credentials of its own -- without this, the CLI hangs at its own
  // auth prompt inside run.sh's PTY forever (nothing in the expect script
  // above matches an auth prompt, so it just sits past `set timeout -1;
  // expect eof`). PROVIDER is written by onboarding/http-server.cjs's
  // POST /api/onboarding/complete handler (see writeAgentConfig call
  // there); readProviderKey() decrypts the safeStorage-encrypted key
  // in-memory only -- see this function's own doc comment in
  // http-server.cjs -- and it is injected directly into THIS child's env
  // below, never written to any file.
  //
  // 4-provider-mode wiring (2026-07-04): all 4 onboarding-selectable
  // PROVIDERS values (claude, claude-subscription, chatgpt, ollama) now
  // route through buildProviderEnv() (provider-env.cjs) -- a pure,
  // Electron-free function so it can be unit-tested standalone (see
  // scripts/test-provider-env.mjs). This function stays a flat if/else on
  // buildProviderEnv()'s return shape; see provider-env.cjs's own doc
  // comment on `buildProviderEnv` for the full contract (env fields to
  // spread over the base env, and the 3 error.kind values below).
  const provider = config.PROVIDER || 'claude'
  const providerEnvResult = buildProviderEnv(provider, config, { readProviderKey })
  if (providerEnvResult.error) {
    const { kind, reason } = providerEnvResult.error
    if (kind === 'key_error') {
      console.error(`[scheherazade/main] buildProviderEnv(${provider}) key_error, cannot spawn agent: ${reason}`)
      setAgentStatus('failed', 'key_error', reason)
      return null
    }
    if (kind === 'not_ready') {
      // Quiet skip, matching this codebase's existing "no key yet" behavior
      // -- no setAgentStatus call, see provider-env.cjs's own doc comment on
      // this error.kind.
      log(`agent spawn skipped: ${reason}`)
      return null
    }
    // 'provider_not_wired' (or any future unrecognized kind -- defense in
    // depth, same fallback this codebase's pre-existing `else` branch used).
    console.error(`[scheherazade/main] BLOCKER: buildProviderEnv(${provider}) provider_not_wired: ${reason}`)
    setAgentStatus('failed', 'provider_not_wired', reason)
    return null
  }

  // chatgpt provider: a trusted proxy must be CONFIRMED up before the agent
  // spawns -- awaited, fail-closed (Codex security review finding #1; see
  // ensureCodexProxy's header). No dedicated agent-status code exists for
  // this blocker ('unknown' per the enum's own never-guess rule).
  if (provider === 'chatgpt') {
    let proxyOk = false
    try {
      proxyOk = await ensureCodexProxy(config)
    } catch (err) {
      console.error('[scheherazade/main] ensureCodexProxy threw unexpectedly:', err)
    }
    if (!proxyOk) {
      setAgentStatus('failed', 'unknown', 'no trusted codex-as-api proxy is available (see app log) -- agent not spawned')
      return null
    }
  }

  // ollama provider: same gate shape as chatgpt above -- a trusted daemon
  // must be CONFIRMED up before the agent spawns (a bootstrap-installed
  // Ollama.app has no launched GUI, so nothing else ever starts one; see
  // onboarding/ollama-daemon.cjs's header for the full rules). Awaited,
  // fail-closed, 'unknown' code per the enum's never-guess rule.
  if (provider === 'ollama') {
    let daemonOk = false
    try {
      daemonOk = await ensureOllamaDaemon()
    } catch (err) {
      console.error('[scheherazade/main] ensureOllamaDaemon threw unexpectedly:', err)
    }
    if (!daemonOk) {
      setAgentStatus('failed', 'unknown', 'no trusted ollama daemon is available (see app log) -- agent not spawned')
      return null
    }
  }

  // Multichannel (v0.0.18): resolve the ACTIVE backend's credentials + home
  // id at spawn time. Same seam discipline as the original Discord-only
  // path: decrypt HERE, inject into this child's env only, never write back
  // to disk. HOME_CHANNEL_ID stays the ONE generic key every channel script
  // reads (discord channel id / slack channel id / telegram chat id) --
  // main resolves which stored id it means. The injected value beats the
  // channel scripts' dotenv read (dotenv never overrides existing env
  // vars), so a stale .env HOME_CHANNEL_ID from the discord era cannot
  // leak into a slack/telegram run.
  const channelBackend = String(config.CHANNEL_BACKEND || 'discord').toLowerCase()
  const channelEnv = {}
  let homeChannelId
  if (channelBackend === 'slack') {
    let slackBot, slackApp
    try {
      slackBot = readSlackBotToken()
      slackApp = readSlackAppToken()
    } catch (err) {
      console.error('[scheherazade/main] slack token read failed, cannot spawn agent:', err)
      setAgentStatus('failed', 'unknown', `slack token read failed: ${err.message}`)
      return null
    }
    if (!slackBot || !slackApp) {
      log('agent spawn skipped: slack backend active but bot/app token missing')
      return null
    }
    homeChannelId = config.SLACK_HOME_CHANNEL_ID
    if (!homeChannelId) {
      log('agent spawn skipped: slack backend active but no SLACK_HOME_CHANNEL_ID yet')
      return null
    }
    channelEnv.SLACK_BOT_TOKEN = slackBot
    channelEnv.SLACK_APP_TOKEN = slackApp
  } else if (channelBackend === 'telegram') {
    let tgToken
    try {
      tgToken = readTelegramToken()
    } catch (err) {
      console.error('[scheherazade/main] telegram token read failed, cannot spawn agent:', err)
      setAgentStatus('failed', 'unknown', `telegram token read failed: ${err.message}`)
      return null
    }
    if (!tgToken) {
      log('agent spawn skipped: telegram backend active but no validated bot token yet')
      return null
    }
    homeChannelId = config.TELEGRAM_HOME_CHAT_ID
    if (!homeChannelId) {
      log('agent spawn skipped: telegram backend active but no TELEGRAM_HOME_CHAT_ID yet')
      return null
    }
    channelEnv.TELEGRAM_BOT_TOKEN = tgToken
  } else {
    // discord -- the default AND the unknown-value fallback, mirroring
    // http-server.cjs's activeChannelBackend() so spawn and .mcp.json can
    // never disagree about which backend a weird config value means.
    let token
    try {
      token = readDiscordToken()
    } catch (err) {
      console.error('[scheherazade/main] readDiscordToken failed, cannot spawn agent:', err)
      // No dedicated code for a local safeStorage/Keychain read failure on the
      // DISCORD token specifically (key_error is reserved for the PROVIDER
      // key path above, discord_token_bad is reserved for the marker-driven
      // missing/rejected-token paths in channel.mjs) -- 'unknown' fallback.
      setAgentStatus('failed', 'unknown', `readDiscordToken failed: ${err.message}`)
      return null
    }
    if (!token) {
      log('agent spawn skipped: no validated Discord bot token on file yet')
      return null
    }
    homeChannelId = readHomeChannelId()
    if (!homeChannelId) {
      log('agent spawn skipped: no HOME_CHANNEL_ID on file yet')
      return null
    }
    channelEnv.DISCORD_BOT_TOKEN = token
  }

  const agentName = config.AGENT_NAME || FIXED_AGENT_NAME
  const model = config.MODEL || 'claude-opus-4-6' // same default as run.sh's own MODEL fallback

  log(
    `spawning real agent via internal launcher: launcher=${RUN_SH_PATH} bin=${resolved.bin} ` +
      `(${resolved.source}) model=${model} name=${agentName} dataHome=${DATA_HOME}`
  )

  // BOT-TOKEN SEAM (security review, 2026-07-03; forwarding EMPIRICALLY
  // CONFIRMED, 2026-07-03, agent-lifecycle fix PART 3): decrypted here, at
  // the moment of spawn, and injected directly into this child's own env --
  // never written back to any on-disk config. Confirmed by direct test
  // (bundled claude.exe + a scratch .mcp.json whose env block deliberately
  // carried NO token, matching production's ensureMcpJsonAgentName() shape,
  // + a throwaway MCP child that echoed its own process.env back to a
  // receipt file): the `claude` CLI forwards its FULL parent env (151
  // inherited keys, +1 = 152 when DISCORD_BOT_TOKEN was set; 0 when it
  // wasn't -- positive/negative control, repeated) to every MCP server
  // child it spawns, merged with (not replaced by) that server's own
  // declared `env` block in .mcp.json. So DISCORD_BOT_TOKEN set on THIS
  // child's env below reaches channel.mjs unchanged, with no code change
  // needed here and no token ever touching .mcp.json or any other on-disk
  // file. run.sh's `run_loop` re-exports CLAUDE_CMD/AGENT_NAME/MEM for its
  // own use but never touches or logs DISCORD_BOT_TOKEN, so it passes
  // through run.sh -> expect -> claude -> channel.mjs untouched at every
  // hop.
  // --dangerously-skip-permissions is NOT set here -- and correctly so: this
  // spawn() call's target is BASH_BIN (bash running run.sh), not the
  // `claude` CLI binary itself, and the flag only means anything on the
  // `claude` command line. run.sh owns the actual claude invocation (its own
  // /usr/bin/expect-wrapped CLI spawn) and, per Mino's 2026-07-04 directive,
  // now passes --dangerously-skip-permissions THERE (see run.sh's own
  // comment on its claude invocation for the current reasoning -- this
  // comment previously and incorrectly claimed the flag was deliberately
  // unused system-wide; that was true of run.sh's OLD behavior, not its
  // current one, and never described this spawn() call either way).
  const supervisorEnv = {
    ...process.env,
    ...channelEnv,
    HOME_CHANNEL_ID: homeChannelId,
    AGENT_NAME: agentName,
    MODEL: model,
    // Effort selector (Mino 07-13 click-test item 2): only forwarded when
    // the user picked one -- absent, run.sh's own `${EFFORT_LEVEL:-high}`
    // default applies. The stop-path spawns deliberately don't carry this
    // (run.sh stop never reads it).
    ...(config.EFFORT_LEVEL ? { EFFORT_LEVEL: config.EFFORT_LEVEL } : {}),
    CLAUDE_BIN: resolved.bin,
    AGENT_DATA_HOME: DATA_HOME, // see run.sh's own comment: MEM = AGENT_DATA_HOME override
    // 4-provider-mode wiring (2026-07-04): spread LAST so buildProviderEnv()'s
    // fields (provider-env.cjs, computed above as providerEnvResult.env)
    // win over both ...process.env AND this object's own MODEL field --
    // e.g. ollama mode returns its own MODEL (a real Ollama model tag,
    // never the generic Anthropic-model default set above). See
    // provider-env.cjs's own doc comment on `env` for the full merge-order
    // contract, including `undefined`-valued keys meaning "actively unset".
    ...providerEnvResult.env,
  }
  // node shim, hoisted to the SHARED env layer (v0.0.21): v0.0.15 implemented
  // ensureNodeShim inside supervisor.mjs's own spawn path -- the NODE lane
  // only. Production spawns the BASH lane (run.sh, the launcher line in this
  // very function), so packaged installs never got the shim and every Claude
  // Code hook died with `/bin/sh: node: command not found`. Live receipt:
  // Mino's 07-16 18:01 log paste (the /logs viewer's first real catch) --
  // stop-reply-guard was among the dead, which is exactly why the agent's
  // promised Discord reply was never bounced back into an actual send.
  // Patched HERE so both lanes inherit it: bash lane via this env, node lane
  // idempotently (its own ensureNodeShim call sees the dir already on PATH).
  // Single-sourced from supervisor.mjs via dynamic import (ESM); on any
  // failure the child keeps the unpatched PATH = the pre-fix behavior, loud.
  try {
    const { ensureNodeShim } = await import(pathToFileURL(SUPERVISOR_MJS_PATH).href)
    supervisorEnv.PATH = ensureNodeShim({ mem: DATA_HOME }, { env: supervisorEnv, log })
  } catch (err) {
    log(`node shim setup failed at the shared env layer (${err.message}) -- hook lane will depend on system node`)
  }
  // sudo askpass (0.1.0 prep): `sudo -A` inside the agent resolves the
  // password through this helper -> the app's vault endpoint. Env carries
  // only a script PATH, never a secret; serving is double-gated (per-boot
  // token + settings toggle) in http-server.cjs. Attach lane gets the same
  // var baked into its bootstrap command (attach-bootstrap.sh template).
  supervisorEnv.SUDO_ASKPASS = path.join(DATA_HOME, 'sudo-askpass.sh')
  // SUPERVISOR_LANE seam (Windows-port Phase 1): identical env, stdio, and
  // detached process-group contract in both lanes -- only the runtime
  // differs (bash running run.sh vs Electron-as-node running
  // supervisor.mjs). supervisor.mjs resolves the same config from this same
  // env (its resolveConfig mirrors run.sh:38-109) and participates in the
  // same PIDFILE/STOPFLAG/FAILFILE contract.
  const child = SUPERVISOR_LANE === 'node'
    ? spawn(process.execPath, [SUPERVISOR_MJS_PATH, '__loop'], {
        cwd: DATA_HOME,
        env: { ...supervisorEnv, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // same Fix-C group isolation as the bash lane below
      })
    : spawn(BASH_BIN, [RUN_SH_PATH, '__loop'], {
        cwd: DATA_HOME,
        env: supervisorEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Fix C: own process group (setsid-equivalent), so the app-quit handler
        // below can SIGTERM the WHOLE tree (run.sh -> expect -> claude) with one
        // negative-pid group signal without also taking down Electron's own
        // process group. Without this, `cmd &` in bash inherits the parent's
        // group (verified empirically, see run.sh's run_expect() comment on the
        // exact same fact from the bash side) and a group-kill here would be
        // unsafe.
        detached: true,
      })

  agentChild = child
  agentSupervisorPid = child.pid
  // Spawn-time reality record for GET /api/agent/spawn-info ("셸은 현실",
  // IA v0.0.9): what THIS child was born with. Config can drift the moment
  // the user touches a dropdown; this snapshot cannot -- the shell and the
  // settings apply-state line read it instead of guessing from config.
  // Deliberately NOT cleared on stop: "last run's reality" plus the status
  // endpoint's 'stopped' is the honest pair.
  lastSpawnInfo = {
    model: config.MODEL || null,
    effort: config.EFFORT_LEVEL || null,
    provider: config.PROVIDER || null,
    at: new Date().toISOString(),
  }
  // Timeout backstop (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 2):
  // this is the SPAWN ATTEMPT moment -- agent-status.cjs's setAgentStatus()
  // re-stamps `since` on every call, so calling it here (not once at
  // onboarding-complete, and not conditionally) means `since` always means
  // "since this exact spawn attempt" and resets cleanly on every relaunch
  // (quit+reopen, or a future manual respawn) -- see the "existingPid &&
  // isOurSupervisor(existingPid)" branch above for the one path that does
  // NOT call this (this process merely discovered an already-alive
  // supervisor rather than spawning one itself; see that branch's own
  // comment). http-server.cjs's computeAgentStatus() reads this `since` as
  // its TIMEOUT_MS backstop input -- no separate connectingSince field
  // needed, this IS it.
  setAgentStatus('connecting')

  // Fix C: participate in run.sh's own PIDFILE convention (see
  // AGENT_PIDFILE's doc comment above) so a future launch of this app (or
  // a manual `run.sh start`/`stop` from a terminal) can see this supervisor
  // is alive.
  try {
    fs.writeFileSync(AGENT_PIDFILE, String(child.pid))
  } catch (err) {
    console.error(`[scheherazade/main] failed to write PIDFILE ${AGENT_PIDFILE} (non-fatal, spawn already succeeded):`, err)
  }
  startFailurePoll()

  child.stdout.on('data', (chunk) => {
    console.log(`[scheherazade/main] ${new Date().toISOString()} [agent stdout] ${chunk.toString().trim()}`)
    // NOT routed through log(): the buffer keys renderer coloring off the
    // stream tag, and agent output must read as 'agent', not 'main'.
    logBuffer.append('agent', chunk.toString())
  })
  child.stderr.on('data', (chunk) => {
    // Fail loud: surface child stderr immediately, don't buffer-and-drop.
    console.error(`[scheherazade/agent stderr] ${chunk.toString()}`)
    logBuffer.append('agent!', chunk.toString())
  })
  child.on('error', (err) => {
    // e.g. ENOENT on BASH_BIN -- never swallow. This is the launcher
    // process itself failing to spawn at all, not a claude crash inside
    // run.sh's own loop (that's absorbed by run.sh's restart ladder).
    console.error('[scheherazade/main] agent child spawn error:', err)
    logBuffer.append('main!', `agent child spawn error: ${err.message}`)
    // No dedicated code for the launcher process itself failing to spawn
    // (distinct from run.sh's OWN crash-loop detector, which only fires
    // once run.sh is actually running and restarting claude inside itself)
    // -- 'unknown' fallback.
    setAgentStatus('failed', 'unknown', `spawn error: ${err.message}`)
    agentChild = null
    agentSupervisorPid = null
    stopFailurePoll()
    fs.rmSync(AGENT_PIDFILE, { force: true })
  })
  child.on('exit', (code, signal) => {
    // run.sh's run_loop() only exits on SIGTERM/SIGINT (trapped, clean) or an
    // internal `set -euo pipefail` failure. Historically ANY exit here meant a
    // crash (stamp 'failed'). The control panel added two DELIBERATE kill paths
    // (user turned the agent off, or swapped its model); those set
    // intentionalStopMode before killing this supervisor. Consume it single-
    // shot. (App-quit via killAgentSupervisor() leaves the flag null and still
    // lands in the 'failed' branch -- fine, the app is quitting and no UI reads
    // it again.) No stale-child guard needed: the control paths AWAIT confirmed
    // death (agentChild nulled here) before respawning, so a new child never
    // coexists with an unfired old exit.
    const wasIntentional = intentionalStopMode
    intentionalStopMode = null
    log(`agent child exited code=${code} signal=${signal}${wasIntentional ? ` (intentional: ${wasIntentional})` : ''}`)
    agentChild = null
    agentSupervisorPid = null
    stopFailurePoll()
    fs.rmSync(AGENT_PIDFILE, { force: true })
    if (wasIntentional === 'stop') {
      // User turned the agent off from the control panel.
      setAgentStatus('stopped')
    } else if (wasIntentional === 'restart') {
      // Model swap / manual restart: restartAgent() re-spawns immediately after
      // this exit and re-stamps 'connecting'. Leave status untouched so the UI
      // never flickers through 'failed'/'stopped' mid-restart.
    } else {
      // Unexpected exit of the SUPERVISOR itself. Same reasoning as the 'error'
      // handler above -- no dedicated code; 'unknown' fallback.
      setAgentStatus('failed', 'unknown', `agent process exited unexpectedly (code=${code} signal=${signal})`)
    }
  })

  return child
}

// Fix C: app-quit cleanup. Quitting the app used to leave the supervisor
// running with no cleanup at all -- orphaned, still holding the Discord
// token, PIDFILE stale from this process's perspective. Two layers:
//
//   1. Best-effort direct signal, fast path. Correct ONLY when run.sh's
//      run_expect() took its manual-watchdog fallback (no `timeout`/
//      `gtimeout` binary on PATH) -- that path never re-groups its
//      children, so a single process-group SIGTERM at the run.sh pid
//      really does reach run.sh -> expect -> claude in one shot.
//   2. Reliable path, ALWAYS also run: `bash run.sh stop`. EMPIRICALLY
//      CONFIRMED NECESSARY (2026-07-03 verification pass): when
//      `timeout`(1) IS present (GNU coreutils' timeout, common via
//      Homebrew -- run_expect() prefers it), it puts ITS monitored
//      command (expect, and everything expect spawns, including claude)
//      into a **new, separate process group** so it can kill that subtree
//      on its own 12h ceiling -- confirmed via `ps -o pgid=`, expect/
//      claude's pgid was NOT run.sh's pgid in that mode. Sending
//      `kill(-run.sh_pid)` in that mode signals ONLY run.sh's own group
//      (bash itself, and NOTHING else) -- and bash won't even run its own
//      TERM trap until its foreground `wait` on that (differently-
//      grouped, still-alive) `timeout` child returns, which can be up to
//      12h. Verified this leaves the ENTIRE tree alive indefinitely with
//      layer 1 alone. run.sh's OWN stop_agent() (STOPFLAG + `pkill -f
//      PKILL_PATTERN`, already proven in this fork's lineage -- see
//      run.sh) reaches the claude process by COMMAND-LINE PATTERN
//      MATCH, which is completely unaffected by which process group it
//      landed in -- that's why it, not a raw group signal, is the
//      reliable mechanism. Uses freshly-read config (same
//      AGENT_NAME/MODEL/CLAUDE_BIN resolution spawnRealAgentChild() uses)
//      so PKILL_PATTERN/PIDFILE match exactly, whether this process
//      spawned the supervisor itself or merely discovered it alive via
//      AGENT_PIDFILE. Fired detached + unref'd so it can finish its own
//      short poll-and-kill loop (up to ~15s, see run.sh's stop_agent())
//      even after Electron itself has quit.
// ── attach-lane helpers (0.1.0 prep, docs/design-0016-attach-topology.md) ──
// The pane mirrors its output to DATA_HOME/logs/agent.log via pipe-pane
// (bootstrap + every respawn re-apply it); the app tails that file into the
// same logBuffer the spawn lane feeds from child stdio, so /logs works
// identically in both topologies. Started once per app process, kept running
// across agent stop/start (a dead agent writes nothing; a 1s stat poll on a
// local file is noise-free).
const ATTACH_LOGFILE = path.join(DATA_HOME, 'logs', 'agent.log')
let attachLogTailTimer = null
let attachLogTailPos = -1

function startAttachLogTail() {
  if (attachLogTailTimer) return
  log(`attach: tailing ${ATTACH_LOGFILE} into the log buffer`)
  const tick = () => {
    try {
      const stat = fs.statSync(ATTACH_LOGFILE)
      if (attachLogTailPos < 0) {
        // First sight of the file: start at the tail minus a small replay so
        // the /logs pane opens with context instead of a void. History stays
        // in the file itself.
        attachLogTailPos = Math.max(0, stat.size - 16 * 1024)
      }
      if (stat.size < attachLogTailPos) attachLogTailPos = 0 // truncated/rotated
      if (stat.size > attachLogTailPos) {
        const fd = fs.openSync(ATTACH_LOGFILE, 'r')
        try {
          const len = stat.size - attachLogTailPos
          const buf = Buffer.alloc(len)
          fs.readSync(fd, buf, 0, len, attachLogTailPos)
          attachLogTailPos = stat.size
          const text = buf.toString('utf8')
          if (text) logBuffer.append('agent', text)
        } finally {
          fs.closeSync(fd)
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log(`attach log tail error (kept polling): ${err.message}`)
    }
    attachLogTailTimer = setTimeout(tick, 1000)
  }
  attachLogTailTimer = setTimeout(tick, 0)
}

function stampAttachSpawnInfo(config) {
  const cfg = config || readAgentConfig()
  lastSpawnInfo = {
    model: cfg.MODEL || null,
    effort: cfg.EFFORT_LEVEL || null,
    provider: cfg.PROVIDER || null,
    at: new Date().toISOString(),
    lane: 'attach',
  }
}

// Attach-mode start path (called from spawnRealAgentChildLocked when
// AGENT_TOPOLOGY=attach and no live supervisor was adopted above). Three
// honest outcomes, none of which spawn anything app-descended:
//   1. dead pane in a live session -> respawn-pane (server-descended) + adopt
//   2. live pane the PIDFILE missed -> adopt it directly
//   3. no session/server/tmux -> status carries bootstrap-needed; the user
//      runs DATA_HOME/attach-bootstrap.sh in their terminal (task-4 UI
//      surfaces the exact command via /api/topology).
async function attachStartFromSession(config) {
  const state = attachTopology.attachSessionState()
  if (!state.tmuxPresent) {
    setAgentStatus('failed', 'bootstrap-needed', 'attach 모드인데 tmux가 없습니다. 터미널에서 `brew install tmux` 후 부트스트랩을 실행하세요.')
    return null
  }
  if (!state.sessionPresent) {
    setAgentStatus('failed', 'bootstrap-needed', `attach 세션이 없습니다. 터미널에서 실행: ${attachTopology.bootstrapCommand(DATA_HOME)}`)
    return null
  }
  let panePid = state.panePid
  if (state.paneDead) {
    const r = attachTopology.respawnAttachPane({ logFile: ATTACH_LOGFILE })
    if (!r.ok) {
      setAgentStatus('failed', 'unknown', `attach respawn 실패: ${r.error}`)
      return null
    }
    panePid = r.panePid
    log(`attach: respawned dead pane -> new supervisor pid=${panePid} (server-descended, attribution preserved)`)
  } else {
    log(`attach: adopting live pane supervisor pid=${panePid} (PIDFILE was stale/missing)`)
  }
  // Adopt-identity guard (design-0016 §Review card 1): a session named
  // 'agent' on our socket is NOT proof the pane runs OUR supervisor. Without
  // this check, a user's manual `tmux -L scheherazade new -s agent` decoy --
  // or plain experimentation -- would be adopted here, and stop would then
  // kill their shell. Same ps-signature check the PIDFILE-adopt path already
  // runs (asymmetry closed). Also refuses the transient list-panes failure
  // where panePid arrives null and String(null) would corrupt PIDFILE.
  const pidValid = Number.isInteger(panePid) && panePid > 0
  if (!pidValid) {
    setAgentStatus('failed', 'bootstrap-needed',
      `attach 세션은 있는데 pane pid를 읽지 못했습니다 (tmux 일시 오류일 수 있음). 앱을 다시 열어 재시도하거나 터미널에서 확인하세요: tmux -L ${attachTopology.ATTACH_SOCKET} list-panes -t ${attachTopology.ATTACH_SESSION}`)
    return null
  }
  // A freshly respawned pane can still sit in its `sh -c` pre-exec window,
  // where ps shows the quoted bootstrap string that the supervisor matcher
  // deliberately rejects. Two short retries absorb that window without
  // loosening the shared matcher for everyone else.
  let identityOk = false
  for (let attempt = 0; attempt < 3 && !identityOk; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200))
    identityOk = isOurSupervisor(panePid)
  }
  if (!identityOk) {
    setAgentStatus('failed', 'bootstrap-needed',
      `attach 세션(${attachTopology.ATTACH_SESSION})의 pane(pid=${panePid})이 우리 supervisor 시그니처가 아닙니다. 터미널에서 세션을 정리한 뒤 부트스트랩을 다시 실행하세요: tmux -L ${attachTopology.ATTACH_SOCKET} kill-session -t ${attachTopology.ATTACH_SESSION}`)
    return null
  }
  try {
    fs.writeFileSync(AGENT_PIDFILE, String(panePid))
  } catch (err) {
    console.error(`[scheherazade/main] attach: failed to write PIDFILE (non-fatal): ${err.message}`)
  }
  agentSupervisorPid = panePid
  stampAttachSpawnInfo(config)
  setAgentStatus('connecting')
  startFailurePoll()
  startAttachLogTail()
  return null
}

// Attach-mode counterpart of waitForAgentHandleCleared(): there is no
// in-process child handle to clear (the app never spawned one), so
// "confirmed dead" must come from the same identity check run.sh uses --
// poll until the PIDFILE pid stops verifying as our supervisor. Without
// this, stop/restart in attach mode would confirm instantly-and-vacuously
// (agentChild is always null here) and restart could double-book the token.
function waitForSupervisorDeath(timeoutMs = 5000, stepMs = 100) {
  return new Promise((resolve) => {
    const started = Number(process.hrtime.bigint() / 1000000n)
    const tick = () => {
      const pid = readPidFromFile(AGENT_PIDFILE) || agentSupervisorPid
      if (!pid || !isOurSupervisor(pid)) return resolve(true)
      const elapsed = Number(process.hrtime.bigint() / 1000000n) - started
      if (elapsed >= timeoutMs) {
        log('waitForSupervisorDeath: timed out; external supervisor did NOT confirm exit')
        return resolve(false)
      }
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

function agentTopologyIsAttach() {
  try {
    return (readAgentConfig().AGENT_TOPOLOGY || 'spawn') === 'attach'
  } catch {
    return false
  }
}

function killAgentSupervisor(signal = 'SIGTERM') {
  if (agentSupervisorPid == null) return
  // Attach topology: the agent deliberately OUTLIVES the app (session
  // survival is one of the two differentiators in design-0016). App quit
  // must leave the external supervisor untouched -- the control panel's
  // intentional stopAgent() path still works (it goes through run.sh stop,
  // not through here).
  if (agentTopologyIsAttach()) {
    log('app quit: attach topology -- external agent left running (by design; stop it from the control panel or `run.sh stop` if you mean it)')
    return
  }
  try {
    if (agentChild) {
      // Our own live child -- Node's own bookkeeping guarantees this pid
      // hasn't been reaped/recycled since we still hold the ChildProcess
      // handle and haven't seen its 'exit' event, so it's safe to
      // group-signal without an extra identity re-check.
      process.kill(-agentSupervisorPid, signal)
      log(`sent ${signal} to agent supervisor process group (pgid=${agentSupervisorPid}) -- best-effort fast path`)
    } else if (isOurSupervisor(agentSupervisorPid)) {
      // Bug 1 fix: this pid was DISCOVERED via AGENT_PIDFILE (not spawned
      // by this process instance), so re-verify identity right before
      // signaling -- time may have passed since discovery, and a bare
      // isPidAlive() re-check alone would still be identity-blind to a
      // since-recycled pid.
      process.kill(agentSupervisorPid, signal)
      log(`sent ${signal} to discovered agent supervisor (pid=${agentSupervisorPid}, identity re-verified via ps) -- best-effort fast path`)
    } else {
      log(`skipping direct signal to agentSupervisorPid=${agentSupervisorPid}: no longer verifiable as our supervisor (dead, or pid recycled) -- relying on the 'run.sh stop' cleanup path below instead, which is identity-safe via PKILL_PATTERN command-line matching`)
    }
  } catch (err) {
    if (err.code !== 'ESRCH') console.error('[scheherazade/main] failed to signal agent supervisor process group:', err)
  }

  try {
    const config = readAgentConfig()
    const resolved = resolveClaudeBin()
    const agentName = config.AGENT_NAME || FIXED_AGENT_NAME
    const model = config.MODEL || 'claude-opus-4-6'
    const stopCmd = supervisorStopCommand()
    const stopper = spawn(stopCmd.bin, stopCmd.args, {
      cwd: DATA_HOME,
      env: {
        ...process.env,
        AGENT_NAME: agentName,
        MODEL: model,
        CLAUDE_BIN: resolved ? resolved.bin : (config.CLAUDE_BIN || 'claude'),
        AGENT_DATA_HOME: DATA_HOME,
        ...stopCmd.extraEnv,
      },
      stdio: 'ignore',
      detached: true,
    })
    stopper.unref()
    log(`spawned '${stopCmd.lane}-lane stop' (pid=${stopper.pid}) as the reliable cleanup path (identity-safe on its own side of the PIDFILE)`)
  } catch (err) {
    console.error('[scheherazade/main] failed to spawn run.sh stop cleanup:', err)
  }
}

// ── control-panel agent lifecycle (2026-07-09) ────────────────────────────
// stop / start / restart for the in-app control panel (#4 model swap, #5
// on/off). The app's FIRST intentional agent-lifecycle paths -- see
// intentionalStopMode's declaration and child.on('exit')'s branch on it.
//
// Why NOT reuse killAgentSupervisor(): it fires `run.sh stop` DETACHED + unref
// (fire-and-forget, correct for app-quit where nothing waits). A restart MUST
// serialize -- run.sh's PKILL_PATTERN is `--name AGENT_NAME` (model-agnostic,
// see run.sh's own comment on why --model was dropped), so a stop still in
// flight would pkill the freshly-spawned replacement (a same-name new child).
// stopAgentAwaited() AWAITS run.sh stop to completion (it blocks up to ~15s:
// touch STOPFLAG, pkill leaf, poll, force-kill, remove PIDFILE) so the pkill
// window is fully closed before any respawn.

function stopAgentAwaited() {
  // Resolves (never rejects) when `run.sh stop` has exited -- supervisor + leaf
  // confirmed dead, STOPFLAG + PIDFILE cleaned up. A failed stop still resolves
  // (logged) so the caller's next step can't hang on a stop error.
  return new Promise((resolve) => {
    let config = {}
    try {
      config = readAgentConfig()
    } catch (err) {
      console.error('[scheherazade/main] stopAgentAwaited: readAgentConfig failed, using defaults:', err)
    }
    const resolved = resolveClaudeBin()
    const agentName = config.AGENT_NAME || FIXED_AGENT_NAME
    const model = config.MODEL || 'claude-opus-4-6'
    let stopper
    const stopCmd = supervisorStopCommand()
    try {
      stopper = spawn(stopCmd.bin, stopCmd.args, {
        cwd: DATA_HOME,
        env: {
          ...process.env,
          AGENT_NAME: agentName,
          MODEL: model,
          CLAUDE_BIN: resolved ? resolved.bin : (config.CLAUDE_BIN || 'claude'),
          AGENT_DATA_HOME: DATA_HOME,
          ...stopCmd.extraEnv,
        },
        stdio: 'ignore',
      })
    } catch (err) {
      console.error(`[scheherazade/main] stopAgentAwaited: failed to spawn ${stopCmd.lane}-lane stop:`, err)
      resolve(false)
      return
    }
    stopper.on('exit', (code) => {
      log(`stopAgentAwaited: ${stopCmd.lane}-lane stop exited code=${code}`)
      resolve(code === 0)
    })
    stopper.on('error', (err) => {
      console.error(`[scheherazade/main] stopAgentAwaited: ${stopCmd.lane}-lane stop process error:`, err)
      resolve(false)
    })
  })
}

// Poll until child.on('exit') has cleared the in-process supervisor handle --
// i.e. the OS process REALLY died and Node reaped it (the exit handler nulls
// agentChild). This is the AUTHORITATIVE "supervisor is gone" signal, more
// reliable than run.sh stop's exit code, which is 0 even when it killed nothing
// (missing/stale PIDFILE -- Codex red-team, 2026-07-09). On timeout it does NOT
// null defensively: a still-alive agentChild means the stop did NOT kill it, and
// nulling would (a) let a restart double-spawn a second supervisor on one
// Discord token, (b) drop the pid app-quit needs to clean up. Callers treat
// `false` as "not confirmed dead" and bail to 'failed' rather than respawn.
function waitForAgentHandleCleared(timeoutMs = 3000, stepMs = 50) {
  return new Promise((resolve) => {
    const started = Number(process.hrtime.bigint() / 1000000n)
    const tick = () => {
      if (agentChild == null) return resolve(true)
      const elapsed = Number(process.hrtime.bigint() / 1000000n) - started
      if (elapsed >= timeoutMs) {
        log('waitForAgentHandleCleared: timed out; supervisor did NOT confirm exit (handles left intact)')
        return resolve(false)
      }
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

// NOTE on intentionalStopMode (accepted limitation): the flag is global and
// reason-blind, so a REAL crash inside a stop/restart's own window (flag set ->
// run.sh stop actually kills) is consumed as intentional rather than stamped
// 'failed'. Low harm and self-correcting: the user's intent (stop/restart)
// matches the outcome anyway, and for a crash-LOOP the flag is single-shot --
// the very next crash (flag already null) surfaces as 'failed'.
//
// Concurrency (Mino 2026-07-09, YAGNI): these actions are deliberately NOT
// serialized server-side. Overlapping control actions (a user mashing stop/
// start/model) are prevented at the source -- the control-panel UI disables its
// buttons while an action is in flight. The single-action safety that IS load-
// bearing lives right here: each action AWAITS CONFIRMED process death before
// respawning, because run.sh stop's pkill is `--name` only (model-agnostic) and
// would kill a too-early replacement even on a lone click. Confirmed-death also
// makes the respawn strictly ordered after the old child's exit, so no stale-
// exit-vs-new-handle race exists to guard against.

// #5 OFF: turn the agent off. Marks the stop intentional so the exit handler
// lands on 'stopped' (not 'failed'), then awaits CONFIRMED death. Only stamps
// 'stopped' if the supervisor actually exited; otherwise 'failed' (and keeps the
// handles so quit-cleanup can still target a still-alive supervisor).
async function stopAgent() {
  log('control panel: stopping agent (intentional)')
  intentionalStopMode = 'stop'
  await stopAgentAwaited()
  // Attach mode has no in-process child handle to clear -- confirmation must
  // come from the external supervisor's actual death (see the fn's comment).
  const cleared = agentTopologyIsAttach() ? await waitForSupervisorDeath() : await waitForAgentHandleCleared()
  if (!cleared) {
    intentionalStopMode = null
    setAgentStatus('failed', 'unknown', 'stop did not confirm agent exit; it may still be running')
    return
  }
  setAgentStatus('stopped')
}

// #5 ON: (re)start from a stopped/idle state. spawnRealAgentChild() already
// guards double-spawn (agentSpawning + agentChild + PIDFILE attach) and refuses
// during shutdown, so this is a thin wrapper -- but clear any stale intentional
// flag first so a crash right after start isn't misread as intentional.
async function startAgent() {
  log('control panel: starting agent')
  intentionalStopMode = null
  await spawnRealAgentChild()
}

// #4 RESTART / model swap: the model write itself is the caller's job (the API
// route validates + writeAgentConfig({MODEL}) BEFORE calling here); this just
// cycles the process so the fresh spawnRealAgentChild() picks up the new
// config.MODEL. intentional 'restart' -> awaited stop -> CONFIRMED death ->
// fresh spawn. If death isn't confirmed, do NOT respawn (that would put a second
// supervisor on one token) -- bail to 'failed'.
async function restartAgent() {
  log('control panel: restarting agent (intentional)')
  intentionalStopMode = 'restart'
  await stopAgentAwaited()
  // Same attach-aware confirmation as stopAgent() above.
  const cleared = agentTopologyIsAttach() ? await waitForSupervisorDeath() : await waitForAgentHandleCleared()
  if (!cleared) {
    intentionalStopMode = null
    setAgentStatus('failed', 'unknown', 'restart aborted: prior agent did not confirm exit')
    return
  }
  // Exit handler consumes the flag; ensure it's clear before respawn so the new
  // child's own future crash isn't misattributed to this restart.
  intentionalStopMode = null
  await spawnRealAgentChild()
}

// BUG 1 fix (agent-lifecycle, 2026-07-03): passed to every
// startOnboardingServer() call below. spawnRealAgentChild() is itself a
// no-op-with-a-clear-log-line if onboarding isn't complete / no token yet /
// claude CLI missing -- safe to hand this callback in unconditionally,
// including on the very first boot-time call, since ONBOARDING_COMPLETE is
// checked fresh (readAgentConfig()) every time spawnRealAgentChild() runs,
// not just once at boot.
const onOnboardingComplete = () => {
  log('onboarding-complete callback fired -- attempting agent spawn')
  // async now (awaits the chatgpt proxy gate); rejection must not escape
  // into unhandledRejection->fatal for a spawn-side problem -- agent-status
  // is the fail-loud surface here, same rationale as the caller's own
  // try/catch around this callback in http-server.cjs.
  spawnRealAgentChild().catch((err) => {
    console.error('[scheherazade/main] spawnRealAgentChild rejected in onboarding-complete path:', err)
    setAgentStatus('failed', 'unknown', `agent spawn attempt threw: ${err.message}`)
  })
}

// Live proxy receipt for GET /api/proxy/health (IA v0.0.9, "셸은 현실"). The
// answer is ALWAYS the proxy's own /health at this moment -- never
// codexProxyModel or config (those are intent; a state variable can outlive
// the process it described, which is the exact live-lie class the 07-14
// passthrough catch was about). codexProxyServer only annotates ownership.
// Covers the explicitly-configured EXTERNAL proxy too: whatever answers on
// the resolved port IS the reality the agent's calls would hit.
async function proxyHealth() {
  const portResult = resolveChatgptProxyPort(readAgentConfig().CHATGPT_PROXY_PORT)
  if (portResult.error) return { running: false }
  try {
    const res = await fetch(`http://localhost:${portResult.port}/health`, { signal: AbortSignal.timeout(1500) })
    const health = await res.json()
    return {
      running: true,
      model: health && health.model ? String(health.model) : null,
      authAvailable: health ? Boolean(health.auth_available) : null,
      inProcess: Boolean(codexProxyServer),
    }
  } catch {
    // Nothing listening, or the listener is not a codex-as-api (non-JSON):
    // either way there is no proxy reality to report.
    return { running: false }
  }
}

// Control-panel lifecycle fns bundled for injection into the onboarding server's
// agent routes (POST /api/agent/{stop,start,restart,model}). Same injection
// channel as onOnboardingComplete: these run in THIS Electron main process and
// mutate its agent-child state, so they can't live in http-server.cjs -- it
// calls back into them.
// resolveClaudeBin injected for the MCP-connector intercept (IA v0.0.9,
// 춘식3 design): http-server's own resolveBin is FIXED-locations-only and
// cannot find the bundled/native claude, but THIS resolver already locates
// the exact binary the agent itself spawns (bundled claude-cli in packaged
// builds, PATH claude in dev). The connector-auth child reads the user's
// ~/.claude login from that binary, same as the agent. Returns the path
// string or null. Same injection channel as proxyHealth/spawnInfo above.
const agentControls = {
  stopAgent,
  startAgent,
  restartAgent,
  proxyHealth,
  spawnInfo: () => lastSpawnInfo,
  resolveClaudeBin: () => { const r = resolveClaudeBin(); return r ? r.bin : null },
}

// ── boot sequence ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    // TCC folder-permission trigger (Mino directive, 2026-07-05): actually
    // touch Documents/Downloads/Desktop on this very first post-ready tick,
    // BEFORE the onboarding window even opens, so macOS's native TCC prompts
    // for all 3 folders fire at first launch = onboarding entry (not
    // whenever some later code path happens to touch one of them, which
    // would surprise the user mid-flow with no context). Idempotent + safe
    // every boot (see tcc-probe.cjs's own doc comment) -- a denied/failed
    // folder is fail-loud logged here but never throws, so a user who denies
    // one prompt does not lose the rest of app boot.
    const tccResults = probeUserFolders({ homedir: os.homedir(), log })
    log(`tcc-probe summary: ${JSON.stringify(tccResults)}`)

    const { url } = await startOnboardingServer(onOnboardingComplete, agentControls)
    createMainWindow(url)

    // Long-lived; deliberately not awaited to exit -- see
    // spawnRealAgentChild()'s own comment. Returns null (onboarding
    // incomplete, no token yet, or claude CLI not found) without throwing;
    // only a real error inside the function body should reach fatal(). This
    // is the "returning already-onboarded user" path -- ONBOARDING_COMPLETE
    // is already '1' on disk from a prior run, so this spawns immediately.
    // A FRESH-onboarding user's spawn instead happens later, via the
    // onOnboardingComplete callback above, the moment they finish the
    // Discord step -- see onboarding/http-server.cjs's /api/discord/validate
    // handler. Awaited (async since the chatgpt proxy gate, 2026-07-07) so a
    // real throw still reaches this fatal() exactly as before.
    await spawnRealAgentChild()
  } catch (err) {
    fatal('boot sequence failed', err)
  }

  app.on('activate', () => {
    // macOS convention: clicking the dock icon with no windows open
    // re-shows one. Not exercised by this headless spike, kept for
    // correctness since electron-builder targets mac.
    if (BrowserWindow.getAllWindows().length === 0) {
      startOnboardingServer(onOnboardingComplete, agentControls)
        .then(({ url }) => createMainWindow(url))
        .catch((err) => fatal('activate: failed to reopen window', err))
    }
  })
})

app.on('window-all-closed', () => {
  // macOS convention: apps stay resident after last window closes. Once
  // this app is actually supervising the claude CLI + proxy as background
  // daemons (P1), window-all-closed should NOT quit those daemons --
  // that's a menu-bar-app pattern, not implemented in this spike (see
  // task note: "dock/menu-bar presence is a plus, not required").
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Graceful shutdown (v0.0.4, Mino 2026-07-13 19:33 directive): quit no
// longer kills the agent mid-thought. First quit attempt writes
// DATA_HOME/.shutdown-request; channel.mjs's watcher injects a [SYSTEM]
// turn telling the agent to flush checkpoint/session-notes/memory and touch
// .shutdown-ack; we proceed on ack or on the HARD timeout -- a hung agent
// must never hold quit hostage (my design weld, posted to home 19:4x). The
// deepseek swap earlier today live-proved WHY: continuity survived the swap
// precisely because the agent wrote checkpoint right before it.
// Only attempted when agentChild is non-null: an ADOPTED supervisor (app
// reinstalled over a live agent, run.sh "already running" path) has
// agentChild == null and takes the immediate-kill path exactly as before --
// no regression, just no grace (v1 scope).
const SHUTDOWN_REQUEST_PATH = path.join(DATA_HOME, '.shutdown-request')
const SHUTDOWN_ACK_PATH = path.join(DATA_HOME, '.shutdown-ack')
const SHUTDOWN_GRACE_MS = 75 * 1000
const SHUTDOWN_ACK_POLL_MS = 500
let gracefulQuitDone = false

// Boot-time stale-marker sweep (red-team finding #1, 2026-07-13 spark pass):
// a kill -9 / OS crash between the request write and the graceful path's
// cleanup leaves .shutdown-request on disk; a fresh boot's channel.mjs
// watcher would honor it and inject a phantom shutdown turn. Unlink both
// markers before any agent can spawn. channel.mjs additionally ignores
// requests older than 5 minutes -- two layers, either alone suffices.
try { fs.unlinkSync(SHUTDOWN_REQUEST_PATH) } catch { /* absent = normal boot */ }
try { fs.unlinkSync(SHUTDOWN_ACK_PATH) } catch { /* absent = normal boot */ }

async function requestAgentShutdownGrace() {
  // Stale ack from a previous cycle must not satisfy this cycle instantly.
  try { fs.unlinkSync(SHUTDOWN_ACK_PATH) } catch { /* absent = fine */ }
  fs.writeFileSync(SHUTDOWN_REQUEST_PATH, JSON.stringify({ requested_at: new Date().toISOString() }) + '\n')
  log(`graceful quit: shutdown-request written, waiting up to ${SHUTDOWN_GRACE_MS / 1000}s for agent ack`)
  const deadline = Date.now() + SHUTDOWN_GRACE_MS
  while (Date.now() < deadline) {
    if (fs.existsSync(SHUTDOWN_ACK_PATH)) {
      log('graceful quit: agent acked shutdown flush')
      break
    }
    await new Promise((r) => setTimeout(r, SHUTDOWN_ACK_POLL_MS))
  }
  if (!fs.existsSync(SHUTDOWN_ACK_PATH)) log('graceful quit: grace window expired without ack, proceeding with shutdown')
  // Always clean both markers so the next cycle starts fresh.
  try { fs.unlinkSync(SHUTDOWN_REQUEST_PATH) } catch { /* already gone */ }
  try { fs.unlinkSync(SHUTDOWN_ACK_PATH) } catch { /* already gone */ }
}

// Fix C (agent-lifecycle model-divergent review, 2026-07-03): a real
// Cmd+Q / Quit used to leave the agent supervisor running with no cleanup
// at all -- it became an orphan (still alive, still holding the Discord
// token, PIDFILE now stale from this process's perspective since the
// in-memory `agentChild` reference is gone). before-quit fires once per
// quit attempt, before windows close; the kill path stays synchronous
// signal-and-continue (SIGTERM is fire-and-forget, and run.sh's own
// `trap ... TERM INT` handler removes the PIDFILE on its side). The
// graceful branch above it defers the quit ONCE via preventDefault, then
// re-enters with gracefulQuitDone set.
app.on('before-quit', (event) => {
  if (!gracefulQuitDone && agentChild != null) {
    event.preventDefault()
    gracefulQuitDone = true
    requestAgentShutdownGrace()
      .catch((err) => console.error('[scheherazade/main] graceful quit path threw (proceeding with quit):', err))
      .finally(() => app.quit())
    return
  }
  shuttingDown = true // stop any queued control action from respawning after this cleanup
  killAgentSupervisor('SIGTERM')
  killCodexProxy() // closes OUR in-process proxy server only; external/reused proxies are untouchable by construction
  killAllLoginChildren('SIGTERM') // detached login children must not outlive the app (Codex finding #3)
  killOllamaDaemon('SIGTERM') // OUR managed daemon child only; a reused external daemon is never ours to touch
})

process.on('uncaughtException', (err) => {
  fatal('uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  fatal('unhandledRejection', reason)
})

// ── P1 wiring points (where the real pieces plug in) ────────────────────
// 1. Real `claude` CLI agent child -- DONE this revision, including the
//    bundling blocker from the prior packaging-bugfix task (see
//    resolveClaudeBin()'s RESOLVED comment above for the full writeup) AND
//    the agent-lifecycle fix (2026-07-03, model-divergent/GPT review, see
//    the big comment block above resolveClaudeBin() for the full BUG
//    1-3/REQUIREMENT 4 writeup):
//    - run.sh is REVIVED as an internal bundled launcher (this revision
//      corrects a prior comment here that called it "DEAD" on a mis-read
//      directive -- reviving it as an internal launcher, never exposed as a
//      CLI surface to the user, is intended and approved). run_loop()'s
//      proven exponential-backoff restart ladder (KST-aware reset,
//      5/10/20/40/120s) + /usr/bin/expect PTY + trust-prompt handling is
//      what actually keeps the agent alive now -- spawnRealAgentChild()
//      spawns `bash run.sh __loop` (RUN_SH_PATH), not `claude` directly.
//    - BOT-TOKEN SEAM (security review, 2026-07-03) -- WIRED, and env
//      forwarding through claude -> its MCP children EMPIRICALLY CONFIRMED
//      (2026-07-03): readDiscordToken() is decrypted at the moment of spawn
//      and injected directly into the child's own `env: {...}`, alongside
//      readHomeChannelId(). Never written back to any on-disk config. See
//      spawnRealAgentChild()'s own BOT-TOKEN SEAM comment for the test
//      methodology and result.
//    - RESOLVED (bundle-claude-cli task, 2026-07-03): `@anthropic-ai/claude-code`
//      is now a package.json dependency; its postinstall places the real
//      standalone arm64 Mach-O binary at
//      node_modules/@anthropic-ai/claude-code/bin/claude.exe, and
//      electron-builder's build.extraResources copies that file to
//      Contents/Resources/claude-cli/claude -- exactly the path
//      resolveClaudeBin() looks for in a packaged app. Verified: DMG builds,
//      binary is present+executable inside the built .app, and runs
//      `--version` from that bundled path with no system claude/node needed.
//    - Liveness gate (REQUIREMENT 4) -- WIRED: onboarding/agent-status.cjs
//      tracks this child's spawn/error/exit; http-server.cjs's
//      GET /api/agent/status combines that with channel.mjs's
//      DATA_HOME/.agent-live Discord-heartbeat marker for the Step 5 UI to
//      poll. NOT yet wired: killing this child on app quit (window-all-
//      closed intentionally leaves it running, matching the daemon-survives
//      pattern noted below -- but a full Cmd+Q quit currently leaves it
//      orphaned rather than gracefully stopped; open follow-up, not part of
//      this revision's four-bug scope).
//
// 2. Provider proxy child:
//    - No such process exists yet anywhere in this fork. P1 needs to spawn
//      it the same way as (1) -- same supervision primitives
//      (spawn/stdout-capture/exit-handling) demonstrated above apply
//      directly, just against a different binary/script.
//    - Port allocation for the proxy needs the same ephemeral-port pattern
//      startOnboardingServer() uses (server.listen(0, ...) then read
//      server.address().port) so it doesn't collide with the onboarding
//      server or a second app instance.
//
// 3. Real onboarding wizard -- DONE (this revision):
//    - Static files under onboarding/public/ served via node:http + a tiny
//      static-file router (onboarding/http-server.cjs), option (a) from the
//      original note here. No preload/contextBridge needed after all --
//      "call back into main" turned out to fit entirely inside the
//      localhost server's own JSON API (fetch() from the sandboxed
//      renderer), so the BrowserWindow stays contextIsolation/no-Node/
//      sandboxed exactly as the P0 spike had it.
//    - BYOK key storage uses Electron safeStorage (Keychain-backed), not a
//      write-to-.env pattern -- deliberately, to keep provider keys off
//      disk in plaintext.
//    - Config write DOES extend setup.sh's .agent-config format (now
//      multi-key + quoted) rather than duplicate setup.sh's full bootstrap
//      (CLAUDE.md/settings.local.json rendering, self_persona.md,
//      checkpoint.md creation) -- that fuller bootstrap is still setup.sh's
//      job and out of this revision's scope. Discord token + home channel
//      still land in .env, matching setup.sh's existing field names exactly
//      so a later setup.sh run or run.sh launch reads them unchanged.
//    - Fixed a latent config-drift bug while wiring this up: the checked-in
//      .mcp.json had AGENT_NAME=companion (leftover from the agent-portable
//      fork) for both its "agent-channel" and "memory" MCP server entries.
//      Since memory/server.mjs resolves its DB path from AGENT_NAME at
//      import time, that mismatch would have made the wizard's memory
//      writes and the live agent's future memory MCP server point at two
//      different databases. onboarding/http-server.cjs corrects this at
//      server boot (see ensureMcpJsonAgentName()).
//
// 4. Packaging + localhost-auth hardening (security review, 2026-07-03):
//    - .agent-config/.env/.mcp.json moved from REPO_ROOT (read-only once
//      packaged inside app.asar -- writing there was boot-fatal) to
//      DATA_HOME, a FIXED directory (~/Documents/Scheherazade, pinned to
//      the literal product name, not to AGENT_NAME or the user-renameable
//      DISPLAY_NAME) that memory.db already lived in. A rename from the
//      Settings page edits only a DISPLAY_NAME value inside .agent-config
//      -- it never moves DATA_HOME. See onboarding/http-server.cjs's
//      DATA_HOME comment and memory/server.mjs's matching DB_PATH comment.
//    - The onboarding server now requires a per-launch secret token
//      (`X-Onboard-Token` header) on every mutating request, rejects
//      requests whose Host header isn't this server's own
//      127.0.0.1:<port>/localhost:<port> (DNS-rebinding), and rejects
//      mutating requests carrying a cross-origin Origin header. See
//      onboarding/http-server.cjs's createOnboardingServer().

// Testability seam (verification harness only, no runtime effect in the
// real app -- Electron loads this file as its main-process entry point and
// never reads/uses module.exports on it, it only relies on the top-level
// app.whenReady().then(...) side effect above having already run). Lets a
// plain-`node` harness (with 'electron' and onboarding/http-server.cjs
// swapped for controlled fakes via a Module._load intercept) exercise
// spawnRealAgentChild()'s decision logic -- Critical A's provider branch,
// Fix C's PIDFILE/quit-handler behavior -- without a real display. Mirrors
// channel.mjs's own isMainModule guard, added for the identical reason.
module.exports = {
  spawnRealAgentChild,
  resolveClaudeBin,
  killAgentSupervisor,
  isPidAlive,
  readPidFromFile,
  pollFailureMarker,
  startFailurePoll,
  stopFailurePoll,
  AGENT_PIDFILE,
  AGENT_FAILFILE,
}
