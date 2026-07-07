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
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {
  createOnboardingServer,
  readAgentConfig,
  readDiscordToken,
  readHomeChannelId,
  readProviderKey,
  toUnpackedPath,
  resolveBin,
  killAllLoginChildren,
  AGENT_NAME: FIXED_AGENT_NAME,
  DATA_HOME,
} = require('./onboarding/http-server.cjs')
const { setAgentStatus } = require('./onboarding/agent-status.cjs')
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
function log(...args) {
  console.log(`[scheherazade/main] ${new Date().toISOString()}`, ...args)
}
function fatal(msg, err) {
  console.error(`[scheherazade/main] FATAL: ${msg}`, err ?? '')
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
  // Same Bug-2 reasoning for OUR codex-as-api proxy child (2026-07-07):
  // app.exit(1) bypasses before-quit, and an orphaned proxy would keep the
  // port bound across app restarts. No-ops when we never spawned one
  // (reused/external proxies are never signaled -- ownership token).
  try {
    killCodexProxy('SIGTERM')
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
  if (app.isPackaged) {
    // electron-builder extraResources target -- see package.json's
    // build.extraResources (`claude-cli/claude`) and the RESOLVED comment
    // above for how this gets populated at build time.
    const bundled = path.join(process.resourcesPath, 'claude-cli', 'claude')
    if (fs.existsSync(bundled)) {
      try {
        fs.accessSync(bundled, fs.constants.X_OK)
        return { bin: bundled, source: 'bundled' }
      } catch {
        // present but not executable -- fall through to PATH
      }
    }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, 'claude')
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
  if (!isPidAlive(pid)) return false
  let commandLine
  try {
    commandLine = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch (err) {
    log(`isOurSupervisor(${pid}): ps lookup failed (${err.message}) -- treating as UNVERIFIED, fail-safe`)
    return false
  }
  return commandLine.includes(`${RUN_SH_PATH} __loop`)
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

// codex-as-api proxy child (login shell-out / chatgpt provider, 2026-07-07).
// OWNERSHIP TOKEN: non-null ONLY for a proxy THIS process spawned. A proxy
// that was already answering on the port (e.g. an externally-supervised
// instance on a dev machine -- on the MAGI machine, proxy-supervisor.sh runs
// one 24/7 that other agents depend on) is REUSED and this stays null, so
// killCodexProxy() can never signal a process we don't own. Same
// dual-supervisor mutual-kill class as the 07-06 run-agent incident, guarded
// by construction rather than by a check.
let codexProxyChild = null

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
// ── codex-as-api proxy supervision (chatgpt provider, 2026-07-07) ────────
// The chatgpt provider mode routes the agent at http://localhost:<port>
// (provider-env.cjs), assuming a codex-as-api proxy is listening. On MAGI's
// machine that proxy is an always-on external daemon; an end-user Mac has
// none -- so the app spawns one itself, making "login once -> auto-setup"
// actually true for chatgpt. Rules:
//   - FAIL-CLOSED ON UNKNOWN LISTENERS (Codex security review finding #1,
//     2026-07-07 -- replaces the earlier reuse-first draft): the agent's
//     entire conversation stream goes to whatever answers on this port, so
//     an unrecognized listener on the DEFAULT port is treated as hostile
//     and blocks the agent spawn (returns false), loudly. Reuse is allowed
//     ONLY when the user EXPLICITLY configured CHATGPT_PROXY_PORT (wizard
//     advanced field) -- an explicit port is an informed opt-in ("my proxy
//     lives there"), same trust class as a BYOK base URL. This also keeps
//     the co-located-MAGI case working (dev sets 18080 explicitly) without
//     ever signaling or health-checking that external proxy.
//   - OWNERSHIP: see codexProxyChild's ownership-token comment above. No
//     teardown/health-restart of anything we didn't spawn, ever.
//   - NO AUTO-RESPAWN in v1.1: if OUR proxy dies, the agent's calls fail
//     visibly and run.sh's own restart/backoff ladder re-attempts; next
//     spawnRealAgentChild() pass re-runs this. Loud log, no silent loop.
//   - AWAITED by spawnRealAgentChild() (Codex finding #1 follow-through):
//     returns true only when a proxy we trust (ours, confirmed listening,
//     or explicit-port opt-in) is up; the agent does not spawn on false.
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
  const port = portResult.port
  const url = `http://localhost:${port}`
  const alive = async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(750) })
      return true // any HTTP response = something listens (same contract as checkLocalLiveness)
    } catch {
      return false
    }
  }
  // Listener IDENTITY check (Codex re-review finding #1, 2026-07-07): an
  // HTTP response is NOT identity -- between our free-port pre-check and
  // our child's bind, a hostile process can win the port and answer. The
  // decisive question is "which PID owns the LISTEN socket", asked of the
  // OS (lsof) AFTER binding, and compared against the child WE hold. This
  // closes the bind-race TOCTOU: attacker binds first -> lsof pid != our
  // child pid -> fail closed. Residual (documented, accepted): a same-uid
  // attacker using SO_REUSEPORT tricks -- but a same-uid attacker can read
  // ~/.codex/auth.json directly, so that boundary is already gone.
  const listenerPid = () => {
    try {
      const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
        timeout: 3000,
      })
      const pids = out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number)
      return pids.length ? pids : null
    } catch {
      return null // no listener (lsof exits 1) or lsof failed -- treated as "nobody"
    }
  }
  if (codexProxyChild) {
    const pids = listenerPid()
    if (pids && pids.includes(codexProxyChild.pid) && (await alive())) {
      log(`ensureCodexProxy: our own proxy child (pid=${codexProxyChild.pid}) owns ${url}`)
      return true
    }
    console.error(
      `[scheherazade/main] ensureCodexProxy: proxy child handle exists (pid=${codexProxyChild.pid}) but the ${url} listener is ` +
        `${pids ? `pid(s) ${pids.join(',')}` : 'absent'} -- identity mismatch, not routing the agent at it`
    )
    return false
  }
  {
    const pids = listenerPid()
    if (pids) {
      if (explicitPort) {
        // Opt-in reuse still requires the route to actually answer on
        // loopback (Codex round-3 finding #1: lsof seeing a listener does
        // not prove localhost reachability).
        if (await alive()) {
          log(`ensureCodexProxy: reusing EXPLICITLY-CONFIGURED proxy at ${url} (user opt-in; owning nothing, never signaling it)`)
          return true
        }
        console.error(`[scheherazade/main] ensureCodexProxy: explicit-port listener (pid(s) ${pids.join(',')}) does not answer at ${url} -- not routing the agent at it`)
        return false
      }
      console.error(
        `[scheherazade/main] ensureCodexProxy: BLOCKED -- pid(s) ${pids.join(',')} already listen on the default proxy port (${url}) ` +
          'and were not spawned by this app. Routing the agent at an unrecognized local service would hand it the whole ' +
          'conversation stream. If that listener is YOUR codex-as-api, set the proxy port explicitly in settings to opt in; ' +
          'otherwise quit the other process and relaunch.'
      )
      return false
    }
  }
  const binPath = resolveBin('codex-as-api')
  if (!binPath) {
    // Honest Path-A failure: no proxy binary anywhere we trust. The
    // dependency-bootstrap step (or the wizard's install pointer) is the
    // fix; the agent does not spawn into a dead route.
    console.error(
      `[scheherazade/main] ensureCodexProxy: no proxy answering at ${url} and no codex-as-api binary found ` +
        '(app-managed bin dir, well-known install locations, PATH). The chatgpt-provider agent cannot reach a model until one exists.'
    )
    return false
  }
  log(`ensureCodexProxy: spawning ${binPath} (CODEX_AS_API_PORT=${port})`)
  const child = spawn(binPath, [], {
    env: { ...process.env, CODEX_AS_API_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own pgroup: our SIGTERM at quit reaps it + descendants, and the agent supervisor's group signals never catch it
  })
  codexProxyChild = child
  child.stdout.resume()
  child.stderr.resume()
  child.on('error', (err) => {
    console.error('[scheherazade/main] ensureCodexProxy: spawn failed:', err)
    if (codexProxyChild === child) codexProxyChild = null
  })
  child.on('close', (code) => {
    log(`ensureCodexProxy: our proxy child exited (code=${code})`)
    if (codexProxyChild === child) codexProxyChild = null
  })
  // Bind confirmation, bounded: poll up to 10s. IDENTITY-checked (Codex
  // re-review finding #1): the socket owner must be OUR child's pid, not
  // just "something answering" -- if an attacker won the bind race, our
  // child dies with EADDRINUSE and this loop fail-closes on the pid
  // mismatch instead of trusting the attacker's HTTP response.
  for (let i = 0; i < 20; i++) {
    const pids = listenerPid()
    if (pids && pids.includes(child.pid)) {
      if (await alive()) {
        log(`ensureCodexProxy: our proxy (pid=${child.pid}) is up at ${url}`)
        return true
      }
    } else if (pids) {
      console.error(
        `[scheherazade/main] ensureCodexProxy: BLOCKED -- spawned pid=${child.pid} but pid(s) ${pids.join(',')} own the ${url} listener ` +
          '(bind race lost / port hijack). Not routing the agent at it.'
      )
      reapFailedProxyChild(child)
      return false
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error(`[scheherazade/main] ensureCodexProxy: spawned ${binPath} but ${url} still not confirmed after 10s -- not routing the agent at it; check its stderr in the app log`)
  reapFailedProxyChild(child)
  return false
}

// Post-spawn failure cleanup (Codex round-3 finding #2): a spawned-but-
// unconfirmed proxy child must not linger as a stale handle -- it would
// wedge every future ensureCodexProxy() pass into the handle-vs-listener
// mismatch branch until app quit. Only ever signals the child WE spawned
// this pass (ownership token discipline unchanged).
function reapFailedProxyChild(child) {
  try {
    process.kill(-child.pid, 'SIGTERM')
    log(`reapFailedProxyChild: sent SIGTERM to unconfirmed proxy pgroup (pgid=${child.pid})`)
  } catch (err) {
    log(`reapFailedProxyChild: SIGTERM to pgid=${child.pid} failed (${err.message}) -- likely already gone`)
  }
  if (codexProxyChild === child) codexProxyChild = null
}

function killCodexProxy(signal = 'SIGTERM') {
  if (!codexProxyChild) return // never signals a reused/external proxy -- ownership token is the child handle itself
  try {
    process.kill(-codexProxyChild.pid, signal)
    log(`killCodexProxy: sent ${signal} to our proxy process group (pgid=${codexProxyChild.pid})`)
  } catch (err) {
    log(`killCodexProxy: ${signal} to pgid=${codexProxyChild.pid} failed (${err.message}) -- likely already gone`)
  }
  codexProxyChild = null
}

// Reentrancy sentinel (Codex re-review finding #2, 2026-07-07): the awaited
// chatgpt proxy gate inside the locked body opened a window where two
// concurrent spawn attempts (e.g. repeated onboarding-complete callbacks)
// both pass the agentChild + PIDFILE checks before either sets agentChild
// -- two supervisors on one Discord token. Set SYNCHRONOUSLY before any
// await, cleared on every exit; same pattern as loginStarting in
// http-server.cjs.
let agentSpawning = false

async function spawnRealAgentChild() {
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

  const homeChannelId = readHomeChannelId()
  if (!homeChannelId) {
    log('agent spawn skipped: no HOME_CHANNEL_ID on file yet')
    return null
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
  const child = spawn(BASH_BIN, [RUN_SH_PATH, '__loop'], {
    cwd: DATA_HOME,
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: token,
      HOME_CHANNEL_ID: homeChannelId,
      AGENT_NAME: agentName,
      MODEL: model,
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
    },
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

  child.stdout.on('data', (chunk) => log(`[agent stdout] ${chunk.toString().trim()}`))
  child.stderr.on('data', (chunk) => {
    // Fail loud: surface child stderr immediately, don't buffer-and-drop.
    console.error(`[scheherazade/agent stderr] ${chunk.toString()}`)
  })
  child.on('error', (err) => {
    // e.g. ENOENT on BASH_BIN -- never swallow. This is the launcher
    // process itself failing to spawn at all, not a claude crash inside
    // run.sh's own loop (that's absorbed by run.sh's restart ladder).
    console.error('[scheherazade/main] agent child spawn error:', err)
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
    // run.sh's run_loop() only exits on SIGTERM/SIGINT (trapped, clean) or
    // an internal `set -euo pipefail` failure -- there is no intentional
    // "stop the agent" path anywhere in this app yet, so ANY exit here is
    // unexpected and worth surfacing as failed, not silently re-idle. (A
    // deliberate app-quit SIGTERM, via killAgentSupervisor() below, is the
    // one intentional case -- it's still fine to mark 'failed' here since
    // the app is quitting anyway and no UI will read this status again.)
    log(`agent child exited code=${code} signal=${signal}`)
    // Same reasoning as the 'error' handler above -- an unexpected exit of
    // the SUPERVISOR itself has no dedicated code; 'unknown' fallback.
    setAgentStatus('failed', 'unknown', `agent process exited unexpectedly (code=${code} signal=${signal})`)
    agentChild = null
    agentSupervisorPid = null
    stopFailurePoll()
    fs.rmSync(AGENT_PIDFILE, { force: true })
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
function killAgentSupervisor(signal = 'SIGTERM') {
  if (agentSupervisorPid == null) return
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
    const stopper = spawn(BASH_BIN, [RUN_SH_PATH, 'stop'], {
      cwd: DATA_HOME,
      env: {
        ...process.env,
        AGENT_NAME: agentName,
        MODEL: model,
        CLAUDE_BIN: resolved ? resolved.bin : (config.CLAUDE_BIN || 'claude'),
        AGENT_DATA_HOME: DATA_HOME,
      },
      stdio: 'ignore',
      detached: true,
    })
    stopper.unref()
    log(`spawned 'run.sh stop' (pid=${stopper.pid}) as the reliable cleanup path (PKILL_PATTERN, not process-group dependent)`)
  } catch (err) {
    console.error('[scheherazade/main] failed to spawn run.sh stop cleanup:', err)
  }
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

    const { url } = await startOnboardingServer(onOnboardingComplete)
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
      startOnboardingServer(onOnboardingComplete)
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

// Fix C (agent-lifecycle model-divergent review, 2026-07-03): a real
// Cmd+Q / Quit used to leave the agent supervisor running with no cleanup
// at all -- it became an orphan (still alive, still holding the Discord
// token, PIDFILE now stale from this process's perspective since the
// in-memory `agentChild` reference is gone). before-quit fires once per
// quit attempt, before windows close; synchronous signal-and-continue is
// enough here (no async work to await -- SIGTERM is fire-and-forget, and
// run.sh's own `trap ... TERM INT` handler removes the PIDFILE on its
// side).
app.on('before-quit', () => {
  killAgentSupervisor('SIGTERM')
  killCodexProxy('SIGTERM') // no-ops unless WE spawned a proxy (ownership token = child handle)
  killAllLoginChildren('SIGTERM') // detached login children must not outlive the app (Codex finding #3)
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
