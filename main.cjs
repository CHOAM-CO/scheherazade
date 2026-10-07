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

const { app, BrowserWindow, shell, dialog } = require('electron')

// 0.2.9 UNIFICATION (the owner 2026-08-21 "진짜 통합"): the dsh track is the main
// line now. userData goes back to the 0.1.x dir ('scheherazade') so the
// unified app IS the upgrade of a 0.1.x install -- one profile dir, one
// Safe Storage keychain item ("Scheherazade Safe Storage"). The 0.2-test
// isolation ('scheherazade02', 2026-08-19) existed so a testbed could run
// BESIDE a live 0.1.x agent; that concern is over. Known cost, mac 0.2-track
// testers only: credentials sealed under the test item ("Scheherazade 0.2
// Safe Storage") don't decrypt under the unified item -- re-enter keys once.
// Windows DPAPI is per-user, not per-app: win credentials survive as-is.
// Must run before app.whenReady(). (inline require: the shared `path` const
// below this block isn't initialized yet when this line runs)
app.setPath('userData', require('node:path').join(app.getPath('appData'), 'scheherazade'))

const { spawn } = require('node:child_process')
// One process-control seam for all three platforms (design-0023 P3):
// killTree, the ps/CIM command-line read and the port-owner lookup used to
// be hand-copied here, in supervisor.mjs, in the onboarding server and in
// ollama-daemon -- four branches of differing quality, so a Linux fix meant
// four edits. proc.cjs is the one implementation now.
const proc = require('./proc.cjs')
const attachTopology = require('./attach-topology.cjs')
const { startShimmedProxy } = require('./codex-proxy-shim.cjs')
const { createRouteProxy } = require('./route-proxy.cjs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const os = require('node:os')

// One-time data-home fold-in (0.2.9 unification). The 0.2 test track kept
// its own Documents/Scheherazade02 so a testbed could run beside a live
// 0.1.x agent (9f27d33: .agent-config/memory.db/channel-token contention).
// Now that this IS the main line, fold the test home back into the
// canonical Documents/Scheherazade:
//   - canonical absent + 02 present  -> rename 02 -> canonical (atomic,
//     same volume; carries config, credentials store, memory, journals,
//     bin, and the dsh lane home in one move)
//   - BOTH present -> the long-lived canonical home wins (that machine had
//     a real 0.1.x agent); the 02 home stays untouched on disk for manual
//     salvage. Log only -- never merge two agent histories silently.
//   - neither -> fresh onboarding, nothing to do.
// Runs synchronously at module load: MUST precede createOnboardingServer()
// (whose first-boot side effects mkdir/seed the canonical home -- a later
// fold-in would then see "both" and silently strand the 02 data).
;(() => {
  const fold = (from, to, label) => {
    try {
      if (!fs.existsSync(from)) return
      if (!fs.existsSync(to)) {
        fs.renameSync(from, to)
        console.error(`[main] ${label} fold-in: ${from} -> ${to}`)
      } else {
        console.error(`[main] ${label} fold-in: both exist; keeping ${to}, leaving ${from} untouched`)
      }
    } catch (e) {
      // FAIL LOUD posture, but a fold-in failure must not brick boot: the
      // app still runs -- against the canonical location -- and the 02 data
      // stays where it was. Surface it in the log the support flow asks for.
      console.error(`[main] ${label} fold-in FAILED (continuing on canonical):`, e.message)
    }
  }
  fold(
    path.join(os.homedir(), 'Documents', 'Scheherazade02'),
    path.join(os.homedir(), 'Documents', 'Scheherazade'),
    'data-home'
  )
  // userData must fold WITH the data home: on Windows, Electron safeStorage
  // is Chromium OSCrypt -- the blobs in DATA_HOME/.credentials decrypt only
  // with the os_crypt key in userData's 'Local State'. Moving the home
  // without its userData leaves every stored credential undecryptable
  // (measured on the Windows box 2026-08-21: readDiscordToken threw, agent never
  // spawned). Electron has not touched the new userData dir yet at module
  // load, so the rename is safe here and Chromium opens the folded dir as
  // its own. macOS keys live in the Keychain under the productName, so this
  // fold is a no-op for mac crypto (0.2-track mac testers still re-enter
  // keys once) -- moving the dir is still harmless there.
  fold(
    path.join(app.getPath('appData'), 'scheherazade02'),
    path.join(app.getPath('appData'), 'scheherazade'),
    'user-data'
  )
})()
const channelBackendsLib = require('./channel-backends.cjs')
const {
  createOnboardingServer,
  migrateChannelBackendsOnDisk,
  readAgentConfig,
  readDiscordToken,
  readSlackBotToken,
  readSlackAppToken,
  readTelegramToken,
  readHomeChannelId,
  readProviderKey,
  readHarnessFailure,
  laneVision,
  toUnpackedPath,
  killAllLoginChildren,
  AGENT_NAME: FIXED_AGENT_NAME,
  DATA_HOME,
  bootPathFor,
} = require('./onboarding/http-server.cjs')
const { setAgentStatus } = require('./onboarding/agent-status.cjs')
// The one bounded app-quit path (see quit-sequencer.cjs's header for the
// unbounded event chain it replaced).
const { createQuitSequencer } = require('./quit-sequencer.cjs')
const { killOllamaDaemon } = require('./onboarding/ollama-daemon.cjs') // ensureOllamaDaemon unused since cloud key-mode (2026-08-04) -- kill stays for pre-cloud-session cleanup
// Log viewer tap (v0.0.20): every line log()/fatal() and the agent child's
// stdout/stderr emit is mirrored into this ring buffer + DATA_HOME/logs/
// app.log, so GET /api/logs (-> /logs page) can show a live session log.
// Sink dir is handed over here rather than computed in the module — see
// log-buffer.cjs's own header on the require-cycle this avoids.
const logBuffer = require('./onboarding/log-buffer.cjs')
logBuffer.initSink(path.join(DATA_HOME, 'logs'))
const { buildProviderEnv, resolveChatgptProxyPort, refreshClaudeCliToken, CLAUDE_CLI_PROVIDER_ID, routeClassOf, credentialClassOf, decideRouteChange, ROUTE_PROXY_DUMMY_KEY } = require('./provider-env.cjs')
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
// Assigned once the app is ready (see its definition next to app.on('activate')
// far below): re-opens the window when the app is resident but windowless.
// Declared up here because 'second-instance' can fire before that point.
let reopenMainWindow = null
app.on('second-instance', () => {
  // A second launch attempt while this instance is running -- focus our
  // existing window instead of doing nothing (or, worse, without the lock
  // above, spawning a competing agent supervisor).
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return
  }
  // Windowless but alive. Since design-0023 P3 that is a NORMAL state on
  // win/linux too (closing the window leaves the agent supervising, as it
  // always has on mac), and re-launching the app is how a Windows or Linux
  // user asks for their window back -- there is no dock to click. Without
  // this the second launch would silently do nothing and the app would look
  // hung with no way in.
  if (reopenMainWindow) reopenMainWindow()
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
  // Bug 2 fix: app.exit(1) below force-exits WITHOUT emitting 'before-quit',
  // so the killAgentSupervisor('SIGTERM') wired there (see app.on('before-
  // quit', ...) further down) is bypassed entirely. fatal() is wired to
  // uncaughtException/unhandledRejection, so ANY uncaught error after the
  // agent has spawned would otherwise orphan the whole supervisor -> lane ->
  // claude tree, still holding the Discord token, with no cleanup at all.
  // Best-effort, belt-and-suspenders: the synchronous group-SIGTERM inside
  // killAgentSupervisor() is the part that reliably fires before app.exit()
  // tears this process down; the async 'supervisor stop' child it also spawns
  // may or may not survive the immediate exit below, which is fine here --
  // it's the secondary/reliable path for the ORDINARY quit case, not this
  // crash-path's only line of defense. Wrapped in try/catch so a failure
  // in cleanup can NEVER mask the original fatal error or block the exit.
  // When fatal() fires before any agent ever spawned there is no pid to
  // signal; killAgentSupervisor() then only fires its identity-safe
  // `supervisor stop` child, which no-ops on a missing/foreign PIDFILE.
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
  // And for detached login children: an orphaned
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
// Frosted glass: options come from window-glass.cjs (effect and solid
// fallback are exclusive -- 0.59 carried both and the fallback painted over
// the effect on every platform; full story in that module's header).
const { glassOptions } = require(path.join(__dirname, 'window-glass.cjs'))
const AppearanceModel = require(path.join(__dirname, 'onboarding', 'public', 'js', 'appearance-model.cjs'))

function readSavedMacMaterial() {
  if (process.platform !== 'darwin') return null
  try {
    // v3: macMaterial is DERIVED from the blur level (off/soft/strong ->
    // null/'under-window'/'hud'). null here means the user chose blur OFF,
    // which must construct flat — distinct from "no config" (catch below),
    // which means default. 'none' is glassOptions' explicit-off sentinel.
    return AppearanceModel.normalize(
      JSON.parse(fs.readFileSync(path.join(DATA_HOME, 'appearance.json'), 'utf8'))
    ).macMaterial || 'none'
  } catch {
    return null // no config yet -> glassOptions default
  }
}

function createMainWindow(url) {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    // The page body is a dark rgba wash over whichever backdrop
    // glassOptions() picked -- see window-glass.cjs. On macOS the material
    // comes from the user's Appearance config (live-switchable from the
    // Appearance tab via setVibrancy; this read makes it stick across
    // relaunches). Junk/missing config falls back to the default material.
    ...glassOptions(process.platform, os.release(), readSavedMacMaterial()),
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

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // Two filters, both load-bearing. ERR_ABORTED (-3) is what Chromium raises
    // for an ORDINARY cancelled navigation -- including the ones during our own
    // teardown: the uninstall route trashes the bundle and exits 300ms later,
    // and the FDA route calls app.relaunch(); app.exit(0). Treating those as
    // fatal flipped a clean exit into exit(1) and ran the crash cleanup instead.
    // A subframe failure is likewise not a reason to kill the app.
    if (errorCode === -3) return
    if (isMainFrame === false) {
      console.error(`[scheherazade/main] subframe did-fail-load (non-fatal): ${errorCode} ${errorDescription}`)
      return
    }
    fatal(`did-fail-load: ${errorCode} ${errorDescription}`)
  })

  // Every renderer window.open() (wizard's Discord/Slack/Telegram console
  // links, bot-invite OAuth, connector auth URLs) goes to the USER'S DEFAULT
  // BROWSER (the owner 07-30). Electron's default without this handler is a bare
  // chromium child window: no address bar, no user sessions/passwords -- so
  // "log into the Discord developer portal" landed the user in a browser
  // where they are logged into nothing. http/https only: openExternal with
  // any other scheme (file:, app protocols) is a classic Electron escape
  // hatch, and no in-app link has a legitimate non-web target.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target).catch((err) => {
        console.error(`[scheherazade/main] openExternal(${target}) failed:`, err)
      })
    }
    return { action: 'deny' }
  })

  return win
}

// ── (c) real agent child spawn ──────────────────────────────────────────
// Spawns the actual long-lived agent via supervisor.mjs (an internal
// bundled launcher, never exposed as a CLI surface to the user), triggered
// both at boot (already-onboarded installs) and from the onboarding-complete
// callback (fresh installs) -- see spawnRealAgentChildLocked() below for the
// current spawn logic, and resolveClaudeBin() for how the bundled binary is
// located in a packaged app. (history: docs/HISTORY.md)
// npm -g bin locations, searched after PATH. A packaged Electron app is not
// launched from a login shell, so process.env.PATH can be as bare as
// /usr/bin:/bin -- which is exactly where an `npm i -g @anthropic-ai/claude-code`
// never lands. Before 2026-08-03 this did not matter because a copy shipped
// inside the app; now that the user brings their own, PATH alone would report
// "not installed" to people who installed it correctly.
const NPM_GLOBAL_BIN_DIRS = () => {
  const home = os.homedir()
  return process.platform === 'win32'
    ? [
        path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
        // Where OUR OWN recommended install lands. CLAUDE_INSTALL_COMMAND on
        // win32 is `irm https://claude.ai/install.ps1 | iex`, and the native
        // installer writes %USERPROFILE%\.local\bin\claude.exe. Omitting it
        // meant a user who followed the app's own instruction was told to
        // install the thing they had just installed -- the packaged app's PATH
        // is inherited from explorer.exe and predates the installer's user-PATH
        // edit, so PATH alone does not see it until they log out.
        path.join(home, '.local', 'bin'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude'),
        // WinGet's shim directory. Measured, not assumed: on the Windows box
        // (2026-08-04) `Get-Command claude` resolves to
        // C:\Users\winuser\AppData\Local\Microsoft\WinGet\Links\claude.exe and
        // nothing else -- that box's only Claude Code is a WinGet install.
        //
        // It is found today ONLY because that dir happens to be on the
        // inherited PATH, which is precisely the thing this list exists to not
        // depend on: a packaged app inherits explorer.exe's PATH, and a
        // freshly-installed shim dir is not in it until the user logs out.
        // These are real .exe shims, so unlike claude.cmd they spawn fine.
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
      ]
    : [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.volta', 'bin'),
      ]
}

// The claude CLI is NOT redistributed with this app: its LICENSE.md is
// "(c) Anthropic PBC. All rights reserved." with no redistribution grant, so
// shipping a copy inside the dmg was not ours to do. The user installs it
// themselves -- see ensureClaudeCli() for the install-assist path -- and this
// resolver only locates what is already on their machine.
function resolveClaudeBin() {
  const isWin = process.platform === 'win32'
  // PATH first. On win, ONLY claude.exe: detection must mirror what the
  // supervisor's pty.spawn can actually exec -- a claude.cmd npm shim would
  // "detect" here and then fail at ConPTY spawn time (CreateProcess does not
  // interpret .cmd), a false-working state worse than a clean not-found.
  // UNVERIFIED on the Windows box (flag class as supervisor.mjs's win lanes).
  const exeName = isWin ? 'claude.exe' : 'claude'
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const [dirs, source] of [
    [pathDirs, 'system-path'],
    [NPM_GLOBAL_BIN_DIRS(), 'npm-global'],
  ]) {
    for (const dir of dirs) {
      const candidate = path.join(dir, exeName)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return { bin: candidate, source }
      } catch {
        // not here, keep looking
      }
    }
  }
  return null
}

// What the UI needs to say when the CLI is absent. Returned as DATA, not as a
// side effect: nothing here installs anything. The install is the user's act
// on the user's machine, so the command is shown, the license is named, and
// the decision stays theirs.
// The NATIVE installer, deliberately not npm. Anthropic's own docs call this
// one "Native Install (Recommended)" and it needs nothing a normal person
// would not already have: curl ships with macOS, irm is built into PowerShell.
// The npm route needs Node 22+, and Homebrew/WinGet need a package manager --
// all three are "no ordinary user has this" dependencies, which is the whole
// class we are trying not to create. It lands at ~/.local/bin/claude on POSIX
// and %USERPROFILE%\.local\bin\claude.exe on Windows -- NPM_GLOBAL_BIN_DIRS
// covers BOTH branches now (the win branch did not until 2026-08-03, so this
// comment used to be false exactly where it mattered).
// Docs: https://code.claude.com/docs/en/setup
const CLAUDE_INSTALL_COMMAND =
  process.platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash'

// Windows only, and only reached when resolveClaudeBin() found nothing.
//
// `npm i -g @anthropic-ai/claude-code` on Windows does not write claude.exe --
// it writes claude.cmd (and claude.ps1), shims that only a shell interprets.
// resolveClaudeBin deliberately refuses to return those, because the supervisor
// spawns through ConPTY and CreateProcess cannot exec a .cmd: detecting one
// would produce a "found it" that dies at spawn, which is worse than a clean
// not-found. That refusal is right and stays.
//
// What was wrong is what we then SAY. A user who ran the widely-documented npm
// install is told "Claude Code is not installed on this machine", which they
// know to be false, so the honest instruction that follows reads as a bug and
// they stop there. The command we recommend does fix it -- the native installer
// writes a real .exe -- but only if they believe us enough to run it.
//
// So: look for the shim, and if it is there, say the true thing instead. This
// changes the SENTENCE only. Nothing here makes a shim spawnable.
function findClaudeShim() {
  if (process.platform !== 'win32') return null
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...NPM_GLOBAL_BIN_DIRS()]
  for (const dir of dirs) {
    for (const name of ['claude.cmd', 'claude.bat', 'claude.ps1']) {
      const candidate = path.join(dir, name)
      try {
        fs.accessSync(candidate, fs.constants.F_OK)
        return candidate
      } catch {
        // not here, keep looking
      }
    }
  }
  return null
}

function ensureClaudeCli() {
  const resolved = resolveClaudeBin()
  if (resolved) return { status: 'found', ...resolved }
  const shim = findClaudeShim()
  return {
    status: 'missing',
    // Present only when the user DOES have Claude Code, in a form this app
    // cannot drive. Callers that ignore it lose nothing.
    shimOnlyPath: shim,
    installCommand: CLAUDE_INSTALL_COMMAND,
    // Claude Code needs a PAID plan: "Claude Code requires a Pro, Max, Team,
    // Enterprise, or Console account. The free Claude.ai plan does not include
    // Claude Code access." Saying this up front beats a stranger installing
    // everything and only then discovering their free account cannot run it.
    planRequirement: 'Pro, Max, Team, Enterprise, or Console (the free plan cannot run Claude Code)',
    // Surfaced so the user agrees to Anthropic's terms with Anthropic, not with
    // us. We are not a party to that install and do not want to look like one.
    licenseUrl: 'https://code.claude.com/docs/en/legal-and-compliance',
    docsUrl: 'https://code.claude.com/docs/en/setup',
    searched: [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...NPM_GLOBAL_BIN_DIRS()],
  }
}

// The internal bundled launcher: supervisor.mjs, on EVERY platform
// (design-0023 P3). Until 0.3.0 mac and Linux ran a bash `run.sh` loop and
// only Windows ran this file, selected by a SUPERVISOR_LANE seam -- two
// supervisors, three watchdog implementations, and a /bin/bash hardcode that
// ENOENTs on minimal Linux images. There is one lane now: the app spawns its
// OWN runtime (process.execPath under ELECTRON_RUN_AS_NODE) on supervisor.mjs,
// which is also what makes the engine's runtime deterministic instead of
// "whatever `node` PATH resolves first on this machine".
// toUnpackedPath (reused from onboarding/http-server.cjs, same helper
// CHANNEL_SCRIPT_PATH/MEMORY_SERVER_SCRIPT_PATH there use) maps this to the
// real on-disk unpacked copy in a packaged app -- see package.json's
// build.files/build.asarUnpack, both of which list supervisor.mjs. No-op in
// dev (REPO_ROOT never contains "/app.asar/" there).
const SUPERVISOR_MJS_PATH = toUnpackedPath(path.join(__dirname, 'supervisor.mjs'))
// The CONTIGUOUS spawn signature every identity check matches on. See
// isOurSupervisor below for why contiguity (not two independent substring
// tests) is load-bearing.
const SUPERVISOR_SIGNATURE = `${SUPERVISOR_MJS_PATH} __loop`
// Upgrade path, recognition ONLY: an install updating from <=0.2.20 can have a
// live `bash .../run.sh __loop` supervisor on this same PIDFILE. Nothing here
// can spawn one any more, but failing to RECOGNIZE it would read a live agent
// as stale and double-spawn a second supervisor onto one Discord token -- the
// exact Fix-C disaster. So: recognized, adopted for the purpose of stopping it,
// never treated as stale while alive. Remove once no install can still be
// running a 0.2.x lane.
const LEGACY_BASH_SIGNATURE = 'run.sh __loop'

// Fix C: this used to spawn the loop directly, bypassing the launcher's OWN
// start_agent() PIDFILE entirely -- quit+reopen (or a second
// app instance) could spawn a
// second supervisor while the first was still alive and orphaned, and the
// two would fight over the same Discord token via pkill inside their
// respective run_loop()s (and, worse, both reply on Discord). This process
// now participates in the exact same PIDFILE the supervisor's own
// startAgent()/stopAgent() use, at the same path -- `$MEM/.agent.pid`, a
// LOCKED contract name (docs/supervisor-design.md)
// (MEM == DATA_HOME here, since AGENT_DATA_HOME is always set below to
// this exact value).
const AGENT_PIDFILE = path.join(DATA_HOME, '.agent.pid')
// Critical B's second half: the supervisor's writeFailureMarker() and
// channel.mjs's both write this same path -- see FAILFILE in supervisor.mjs
// and FAILURE_MARKER_PATH in channel.mjs. Polled below (see
// pollFailureMarker()) so a bad token/repeated-crash-loop reaches the user
// as a 'failed' status within a bounded time instead of infinite
// 'connecting'.
const AGENT_FAILFILE = path.join(DATA_HOME, '.agent-failed.json')
const FAILURE_POLL_MS = 3_000

// Shared by Fix C (PIDFILE liveness check) and Fix D's sibling check in
// http-server.cjs -- one implementation in proc.cjs since design-0023 P3.
const isPidAlive = proc.isPidAlive

// Kill a detached child AND its descendants: POSIX process-group signal,
// taskkill /T on win32 (where negative-pid signals do not exist and every such
// call used to throw into its catch and kill NOTHING -- detached login flows
// survived app quit as orphans, and an orphaned OAuth flow can still finish
// and write credentials after the app is gone). See proc.cjs.
const killTree = proc.killTree

function isOurSupervisor(pid) {
  return readSupervisorCommandLine(pid) !== null
}

// Returns the verified command line when pid is a live supervisor of ours,
// else null.
//
// Bug 1 fix (agent-lifecycle, 2026-07-03, cross-model adversarial review):
// isPidAlive() alone is IDENTITY-BLIND -- it only proves *some* process holds
// this pid right now. A stale PIDFILE surviving a crash/reboot, combined with
// the OS recycling that pid, would otherwise make this app either silently
// never spawn its own agent (UI stuck 'connecting' with no clue why) or, on
// quit, signal an unrelated process.
//   Fix A -- `-ww` (inside proc.readCommandLine) forces the FULL, un-truncated
//     command line; a supervisor launched from a long path inside a *.app
//     bundle otherwise gets `__loop` truncated off and false-negates.
//   Fix B -- match the CONTIGUOUS substring `<path> __loop`, not two
//     independent `.includes()` tests, which both pass for a recycled pid
//     whose argv merely mentions each token separately.
// Fail SAFE: a lookup that errors, is unavailable or returns nothing resolves
// to "not verified" -- never trusted as already-running, never signaled.
function readSupervisorCommandLine(pid) {
  if (!isPidAlive(pid)) return null
  let commandLine
  // proc.readCommandLine: `ps -ww` on POSIX, Get-CimInstance on Windows
  // (which has no `ps` -- without that branch EVERY lookup threw, so every
  // supervisor read as UNVERIFIED and the next launch double-spawned onto the
  // same Discord token).
  try {
    commandLine = proc.readCommandLine(pid)
  } catch (err) {
    log(`readSupervisorCommandLine(${pid}): process lookup failed (${err.message}) -- treating as UNVERIFIED, fail-safe`)
    return null
  }
  if (commandLine.includes(SUPERVISOR_SIGNATURE) || commandLine.includes(LEGACY_BASH_SIGNATURE)) return commandLine
  return null
}

// One stopper on every platform. It was a router while two lanes shared this
// PIDFILE (each lane's stopper only recognized its own signature, and the
// wrong one would "clean up" a live supervisor's pidfile). supervisor.mjs's
// own `stop` handles both shapes now -- ours by signature, a leftover 0.2.x
// bash loop as a legacy owner -- so there is nothing left to route.
function supervisorStopCommand() {
  return { bin: process.execPath, args: [SUPERVISOR_MJS_PATH, 'stop'], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
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

// Tracks the currently-live agent child (the persistent `supervisor.mjs
// __loop` process, not an individual lane crash inside it -- those
// are absorbed by the supervisor's own restart/backoff ladder and never reach
// here). Guards against double-spawn (PART 1 requirement): both the
// boot-time call and the onOnboardingComplete callback can legitimately
// race/overlap (e.g. a returning already-onboarded user who somehow also
// re-triggers validate), and spawning two supervisors for the same agent
// would fight over the same Discord token/MCP servers. Fix C adds a SECOND,
// cross-process guard on top (the PIDFILE check below) for the quit+reopen
// case, where this in-memory variable itself was reset by the process
// restart and can't help.
// The onboarding server is started ONCE and reused; app.on('activate') reads
// this instead of starting a second one (see its comment).
let onboardingServerUrl = null
// The http.Server behind onboardingServerUrl. Kept so app-quit can actually
// CLOSE it (quitTeardown) -- until 2026-09-08 the boot path destructured only
// `url` off the resolve and the listener, its keep-alive sockets and its
// per-launch cookie state were simply abandoned at quit.
let onboardingServer = null
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
// there is no external process we could ever signal by mistake (a
// dual-supervisor mutual-kill class is structurally impossible here), no
// orphan on crash (server dies with the process), and no binary
// resolution/spawn surface at all. (history: docs/HISTORY.md)
// Last spawn's birth config (model/effort/provider/at) -- set at the spawn
// moment in spawnRealAgentChild, served via agentControls.spawnInfo() for
// GET /api/agent/spawn-info. null until the first spawn of this app run.
let lastSpawnInfo = null
// Route proxy state (route-proxy.cjs, 2026-10-07 live model/effort switching).
// lastSpawnEnv: the provider env the proxy's live config currently mirrors --
// the buildProviderEnv() result BEFORE main rewrote DSH_ROUTE_BASE_URL/key
// to point the lane at the proxy. decideRouteChange compares the next build
// against it. liveRoute: what the proxy sends RIGHT NOW {model, effort,
// since}; reset to the spawn pick at every spawn/attach stamp and served as
// spawn-info.live so the lane chip and nav show the proxied truth.
let routeProxy = null
let lastSpawnEnv = null
let liveRoute = null

let codexProxyServer = null
// The MODEL the live in-process proxy was built for (null = proxy default).
// Compared on every ensure so a model swap rebuilds the proxy instead of
// silently serving the previous pick (see ensureCodexProxy's passthrough
// comment).
let codexProxyModel = null
// The port the live in-process proxy is ACTUALLY bound to. Since 2026-08-04
// the default bind is ephemeral, so this cannot be recomputed from config --
// it is the only record of the answer the kernel gave, and both the reuse
// check and GET /api/proxy/health read it. null when no proxy of ours is up.
let codexProxyPort = null

// Critical B: polls AGENT_FAILFILE (written by the supervisor's marker on
// a quick-fail restart streak, or by channel.mjs's writeFailureMarker() on
// a Discord login/token failure) and surfaces it via setAgentStatus so the
// Step 5 UI's poll (GET /api/agent/status) sees 'failed' within
// FAILURE_POLL_MS of either layer detecting the problem, instead of
// sitting on 'connecting' forever. mtime-gated so a repeatedly-rewritten
// marker (the supervisor re-writes it on every quick-fail restart)
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
        : 'agent supervisor reported a failure (see the supervisor/channel.mjs logs)'
    // Cause-code wiring (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1):
    // the marker is written by two independent emitters -- the supervisor's
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
    // ENOENT (no marker yet, or since cleared by clearFailureMarker()):
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
// (provider-env.cjs), assuming a codex-as-api proxy is listening. On the reference fleet's
// machine that proxy is an always-on external daemon; an end-user Mac has
// none -- so the app runs one ITSELF, in-process, via the codex-as-api npm
// package's createApp() (pinned dependency; it reads/refreshes
// ~/.codex/auth.json on its own). Making "login once -> auto-setup"
// actually true for chatgpt with ZERO new spawn surface. Rules:
//   - EPHEMERAL BY DEFAULT (2026-08-04, from the Codex read -- its
//     responses-api-proxy takes --port as OPTIONAL and writes the chosen
//     port to a server-info file the parent reads, so there is no default
//     port and therefore no collision policy to get wrong).
//
//     Ours is IN-PROCESS, so nothing outside the app ever needs to know the
//     port in advance: we bind 0, ask the kernel what we got, and hand that
//     to the agent. There is no shared filename to invent because the reader
//     is the same process that bound it.
//
//     What this DELETES is a whole failure class. The old default of 18080
//     could be occupied by anything -- another Scheherazade, a dev's fleet
//     proxy, an unrelated service -- and the only safe response was to
//     refuse to spawn the agent at all, because routing the conversation
//     stream at an unidentified local listener is worse than not starting.
//     That refusal was correct and is now unreachable: an ephemeral port is
//     free by construction.
//
//   - BIND-FIRST FAIL-CLOSED, still, for the EXPLICIT-PORT path (the only
//     one left that can collide): we do not pre-check then bind (TOCTOU) --
//     we just bind. The kernel arbitrates atomically: EADDRINUSE means
//     someone else owns the port, and an explicitly-configured
//     CHATGPT_PROXY_PORT (informed opt-in, same trust class as a BYOK
//     base URL) may then be reused after a loopback liveness check. lsof is
//     kept for the diagnostic message only, never for the decision.
//     This keeps the co-located-fleet case working (dev opts in to the
//     fleet proxy explicitly) without ever signaling that external proxy.
//   - NO AUTO-RESTART in v1.1: if our in-process server errors, the
//     agent's calls fail visibly and the next spawnRealAgentChild() pass
//     re-runs this. Loud log, no silent loop.
//   - AWAITED by spawnRealAgentChild(): returns { ok, port } and the agent
//     does not spawn unless ok. `port` is the port actually bound (or the
//     explicit one being reused) -- the CALLER MUST use it rather than
//     recomputing from config, because with an ephemeral bind the config
//     does not know the answer. buildProviderEnv() runs before this and
//     CLEARS DSH_ROUTE_BASE_URL for exactly that reason; see the caller for
//     the fill-in.
// One codex-as-api app + shim on `port` (0 = kernel-assigned), /health-verified
// for `model`. Does NOT touch codexProxyServer/Port/Model -- the caller owns
// the handle: ensureCodexProxy installs it as THE proxy, applyRoute's
// handover (0.3.14) runs a second instance beside the live one. Model
// passthrough: codex-as-api's anthropic route sends its MODULE-LEVEL default
// model for any body.model its table does not know (resolveAnthropicBackend
// Model) -- the module reads CODEX_AS_API_MODEL once at load, hence env set
// BEFORE require and the require-cache evicted per instance so each one's
// fallback is its own model. That is how gpt-6 ids (absent from the 0.6.5
// table) are served at all. Fail-closed: /health must report `model`.
// Returns { ok, server, port } or { ok: false, err?, reason }.
async function startCodexProxyInstance({ model, port: requestedPort = 0 }) {
  const desiredModel = model || null
  let createApp
  try {
    // Installed CLI/cache versions prevent new models being rejected as old clients.
    const cliVersion = require('./model-discovery.cjs').resolveCodexVersion()
    if (cliVersion) process.env.CODEX_AS_API_CODEX_CLI_VERSION = cliVersion
    if (desiredModel) process.env.CODEX_AS_API_MODEL = desiredModel
    else delete process.env.CODEX_AS_API_MODEL
    // Evict so the module-level MODEL constant re-reads the env we just set;
    // the bundle re-requires only cached stateless deps (express et al).
    try { delete require.cache[require.resolve('codex-as-api')] } catch {}
    ;({ createApp } = require('codex-as-api'))
  } catch (err) {
    console.error('[scheherazade/main] codex proxy: codex-as-api package failed to load (bundling problem?):', err)
    return { ok: false, reason: 'codex-as-api failed to load' }
  }
  let server
  try {
    // Loopback-only bind, deliberately narrower than the CLI's default.
    // Shimmed (codex-proxy-shim.cjs): pi-ai stamps eager_input_streaming:true
    // on every tool and codex-as-api 0.6.5 400s on it -- the shim strips the
    // hint fields in front of the real app. close() closes both servers (the
    // shim wraps close). 2026-08-20 cto field-test fix.
    //
    // requestedPort is 0 unless the user configured one; the shim's OUTER
    // server is the one that takes it, so an ephemeral request lands on the
    // server the agent actually talks to (the inner codex-as-api app has
    // always bound its own ephemeral port).
    server = await startShimmedProxy({ app: createApp(), port: requestedPort, log: (m) => log(m) })
  } catch (err) {
    if (!(err && err.code === 'EADDRINUSE')) console.error('[scheherazade/main] codex proxy: in-process proxy failed to start:', err)
    return { ok: false, err, reason: err && err.message ? err.message : String(err) }
  }
  // The kernel's answer, not our request. Everything downstream -- the
  // /health receipt, the log line, the URL handed to the agent -- reads
  // this, so an ephemeral bind can never be described by a number nobody
  // is listening on.
  const bound = server.address()
  if (!bound || typeof bound.port !== 'number' || bound.port <= 0) {
    console.error(`[scheherazade/main] codex proxy: bound but address() reports no usable port (${JSON.stringify(bound)}) -- refusing to route the agent at a guess`)
    try { server.close() } catch {}
    return { ok: false, reason: 'no usable port' }
  }
  const port = bound.port
  const url = `http://localhost:${port}`
  // Track post-listen errors loudly (NO AUTO-RESTART rule above).
  server.on('error', (err) => {
    console.error('[scheherazade/main] codex proxy: in-process proxy server error:', err)
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
      log(`codex proxy: /health probe failed (${err.message}) -- cannot verify model passthrough`)
    }
    if (reported !== desiredModel) {
      console.error(`[scheherazade/main] codex proxy: model passthrough FAILED -- picked ${desiredModel}, proxy /health reports ${reported ?? 'unknown'}. Not routing the agent at a silently different model.`)
      try { server.close() } catch {}
      return { ok: false, reason: `model passthrough failed (/health reports ${reported ?? 'unknown'})` }
    }
  }
  return { ok: true, server, port }
}

// Handover instance (applyRoute, 0.3.14): a NEW codex proxy for `model` on
// a fresh ephemeral port, beside the live one, which keeps serving in-flight
// streams until retireCodexProxy closes it. Never installs itself.
async function spawnCodexProxyInstance(model) {
  return startCodexProxyInstance({ model, port: 0 })
}

// Old handover instances waiting out their grace period. Closed early by
// killCodexProxy (quit / fatal) so nothing outlives the app.
const CODEX_PROXY_RETIRE_GRACE_MS = 60_000
const retiringCodexProxies = new Set()
function retireCodexProxy(server, port, model, graceMs = CODEX_PROXY_RETIRE_GRACE_MS) {
  if (!server) return
  const entry = { server, port, model, timer: null }
  retiringCodexProxies.add(entry)
  // http.Server.close(): stops accepting, lets in-flight responses (the SSE
  // stream the lane may still be reading) finish, closes idle keep-alives.
  entry.timer = setTimeout(() => {
    retiringCodexProxies.delete(entry)
    try { server.close(); log(`retireCodexProxy: old codex proxy :${port} (model ${model || 'default'}) closed after ${graceMs}ms grace`) } catch (err) { log(`retireCodexProxy: close failed (${err.message})`) }
  }, graceMs)
  if (entry.timer.unref) entry.timer.unref()
  log(`retireCodexProxy: old codex proxy :${port} (model ${model || 'default'}) retiring in ${graceMs}ms`)
}

async function ensureCodexProxy(config) {
  const rawPort = config.CHATGPT_PROXY_PORT
  const explicitPort = rawPort != null && String(rawPort).trim() !== ''
  const portResult = resolveChatgptProxyPort(rawPort)
  if (portResult.error) {
    // buildProviderEnv() already rejected this config upstream; belt-and-
    // suspenders only.
    console.error(`[scheherazade/main] ensureCodexProxy: bad port config: ${portResult.error.reason}`)
    return { ok: false, port: null }
  }
  // 0 = "kernel, pick one". Only reached when the user configured nothing;
  // an explicit port is honoured exactly as before.
  const requestedPort = explicitPort ? Number(portResult.port) : 0
  // Provisional. Rewritten from srv.address() after listen, because with
  // requestedPort 0 this string is a lie until the bind returns.
  let port = requestedPort
  let url = `http://localhost:${port}`
  // Model passthrough: codex-as-api's anthropic route sends its
  // MODULE-LEVEL default model and only ECHOES body.model back
  // (dist/index.js: `requestModel = MODEL; clientModel = body.model`) --
  // so a dropdown model pick can silently never reach the engine. The
  // module reads CODEX_AS_API_MODEL once at load, hence: env set BEFORE
  // require, require-cache evicted per (re)build so a model swap reloads
  // the constant, and the proxy's own /health `model` field is the RECEIPT
  // gate after listen -- if the engine-side model doesn't match the user's
  // pick, the proxy dies loudly rather than serving a silently different
  // model. Only gpt-* ids are forwarded; anything else leaves the proxy
  // default. An explicitly-configured EXTERNAL proxy (the dev/fleet opt-in
  // below) is not ours to configure -- its operator owns its model.
  // (history: docs/HISTORY.md)
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
    // proc.listenerPids: /usr/sbin/lsof on mac, PATH lsof or `ss -ltnp` on
    // linux (where /usr/sbin/lsof does not exist and this always returned
    // 'unknown'), Get-NetTCPConnection on win32.
    const pids = proc.listenerPids(port)
    return pids.length ? pids.join(',') : 'unknown'
  }

  if (codexProxyServer) {
    // Reuse checks the port we ACTUALLY bound last time, not the requested
    // one -- with an ephemeral bind those differ on every launch, and probing
    // `url` (still holding the provisional 0) would ask localhost:0.
    const livePort = codexProxyPort || port
    const liveUrl = `http://localhost:${livePort}`
    const liveAlive = async () => {
      try {
        await fetch(liveUrl, { signal: AbortSignal.timeout(750) })
        return true
      } catch {
        return false
      }
    }
    // ...and the REQUESTED port, not just the model (gpt-6-astra review, P2):
    // an explicit CHATGPT_PROXY_PORT change with the model kept used to hit
    // the reuse path and route the new agent at the OLD port. With no explicit
    // port the request is 0/ephemeral and any live bind satisfies it, so only
    // an explicit request can disagree with what we are actually bound to.
    const portMatches = !explicitPort || requestedPort === livePort
    if (codexProxyServer.listening && codexProxyModel === desiredModel && portMatches && (await liveAlive())) {
      log(`ensureCodexProxy: our in-process proxy already serves ${liveUrl} (model ${codexProxyModel || 'proxy default'})`)
      return { ok: true, port: livePort }
    }
    log(codexProxyServer.listening && codexProxyModel !== desiredModel
      ? `ensureCodexProxy: model changed (${codexProxyModel || 'default'} -> ${desiredModel || 'default'}) -- rebuilding proxy`
      : codexProxyServer.listening && !portMatches
        ? `ensureCodexProxy: port changed (${livePort} -> ${requestedPort}) -- rebuilding proxy`
        : 'ensureCodexProxy: stale in-process proxy server handle -- closing and re-creating')
    killCodexProxy()
  }

  const inst = await startCodexProxyInstance({ model: desiredModel, port: requestedPort })
  if (!inst.ok) {
    const err = inst.err
    if (err && err.code === 'EADDRINUSE') {
      // Only reachable with an explicit port now. An ephemeral bind cannot
      // collide, so the old "default port is occupied, refuse to spawn"
      // branch is gone rather than merely unlikely.
      if (explicitPort) {
        if (await alive()) {
          log(`ensureCodexProxy: port ${port} taken; reusing EXPLICITLY-CONFIGURED proxy at ${url} (user opt-in; owning nothing, never signaling it)`)
          return { ok: true, port }
        }
        console.error(`[scheherazade/main] ensureCodexProxy: explicit-port listener (pid(s) ${listenerPidsForLog()}) does not answer at ${url} -- not routing the agent at it`)
        return { ok: false, port: null }
      }
      // Kept as a loud impossibility rather than deleted: if the kernel ever
      // hands back EADDRINUSE for port 0, the assumption this whole change
      // rests on is wrong and we want to hear about it, not silently fall
      // back to a fixed port.
      console.error('[scheherazade/main] ensureCodexProxy: EADDRINUSE on an EPHEMERAL bind -- this should be impossible; not routing the agent anywhere')
      return { ok: false, port: null }
    }
    return { ok: false, port: null }
  }
  codexProxyServer = inst.server
  port = inst.port
  url = `http://localhost:${port}`

  codexProxyModel = desiredModel
  codexProxyPort = port
  log(`ensureCodexProxy: in-process proxy up at ${url} (model ${desiredModel || 'proxy default'}, ${explicitPort ? 'explicit port' : 'kernel-assigned port'}, /health-verified)`)
  return { ok: true, port }
}

function killCodexProxy() {
  for (const entry of retiringCodexProxies) {
    clearTimeout(entry.timer)
    try { entry.server.close() } catch { /* already down */ }
  }
  retiringCodexProxies.clear()
  if (!codexProxyServer) return // in-process only -- an external/reused proxy is never ours to touch
  try {
    codexProxyServer.close()
    log('killCodexProxy: in-process proxy server closed')
  } catch (err) {
    log(`killCodexProxy: close failed (${err.message}) -- proceeding`)
  }
  codexProxyServer = null
  codexProxyModel = null
  codexProxyPort = null
}

// ── route proxy (route-proxy.cjs) ─────────────────────────────────────────
// The agent's LLM route ALWAYS targets this loopback proxy (every provider
// row); model/effort picks update its live config instead of cycling the
// agent when decideRouteChange says the switch stays in one protocol +
// credential class. Bound once per app run, kernel-assigned port, torn down
// in quitTeardown. Same NO AUTO-RESTART posture as ensureCodexProxy: if it
// dies, the next spawn re-creates it and the log says so.
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'
async function ensureRouteProxy() {
  if (routeProxy && routeProxy.server && routeProxy.server.listening) return routeProxy
  routeProxy = null
  routeProxy = await createRouteProxy({ log: (m) => log(m) })
  routeProxy.server.on('error', (err) => {
    console.error('[scheherazade/main] route-proxy: server error:', err)
  })
  log(`ensureRouteProxy: route proxy up at 127.0.0.1:${routeProxy.port}`)
  return routeProxy
}

function killRouteProxy() {
  if (!routeProxy) return
  try {
    routeProxy.close()
    log('killRouteProxy: route proxy closed')
  } catch (err) {
    log(`killRouteProxy: close failed (${err.message}) -- proceeding`)
  }
  routeProxy = null
}

// Route config the proxy needs for a BUILT provider env, and the rewrite the
// lane gets instead. Pure over `env`; the caller applies `laneEnv`.
//   keyMode 'api-key'     real secret -> proxy injects it; lane gets a dummy
//                         (spawnEngine tolerates any non-empty value).
//   keyMode 'passthrough' OAuth (sk-ant-oat: pi-ai's OAuth mode is decided IN
//                         the lane from the prefix and the proxy must not touch
//                         the headers/system block) and placeholder rows.
function routeConfigFor(env) {
  const cls = routeClassOf(env)
  const cred = credentialClassOf(env)
  const keyMode = cred === 'api-key' ? 'api-key' : 'passthrough'
  const keyEnv = env.DSH_ROUTE_KEY_ENV
  return {
    cls,
    route: {
      upstreamBase: env.DSH_ROUTE_BASE_URL || ANTHROPIC_DEFAULT_BASE_URL,
      model: env.DSH_MODEL,
      effort: env.DSH_EFFORT,
      key: keyMode === 'api-key' && keyEnv ? env[keyEnv] : null,
      keyMode,
      protocol: cls === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      // chatgpt row (0.3.14): codex-as-api honours output_config.effort on
      // any body, so the proxy sets it even though the lane shapes a
      // budget thinking block for this declared model (route-proxy.cjs).
      effortAlwaysSupported: env.DSH_PROVIDER === 'codex',
    },
    laneEnv: (port) => ({
      DSH_ROUTE_BASE_URL: `http://127.0.0.1:${port}${cls === 'anthropic' ? '/anthropic' : '/openai/v1'}`,
      ...(keyMode === 'api-key' && keyEnv ? { [keyEnv]: ROUTE_PROXY_DUMMY_KEY } : {}),
    }),
  }
}

// Best-effort: tell the lane's session about the new model/effort so the
// engine's context window / compaction / vision gating follow the proxied
// model on the CATALOG route (dsh-lane.mjs POST /select-model; declared
// routes answer applied:false for the MODEL and keep the spawn window).
// Effort rides every call, effort-only switches included: the lane applies
// it on any route and moves its own DSH_EFFORT (0.3.15). Never throws.
async function notifyLaneSelectModel(model, effort) {
  let ep
  try {
    ep = JSON.parse(fs.readFileSync(path.join(DATA_HOME, '.ingest-endpoint.json'), 'utf8'))
    if (!Number.isInteger(ep.port) || typeof ep.token !== 'string' || !ep.token) return { ok: false, reason: 'no endpoint' }
  } catch (err) {
    return { ok: false, reason: `endpoint file: ${err.message}` }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${ep.port}/select-model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': ep.token },
      body: JSON.stringify({ model, effort }),
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${body.error || ''}` }
    return { ok: true, ...body }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

// applyRoute (agentControls): the model/effort routes call this INSTEAD of
// restartAgent. Rebuilds the provider env from the config just written,
// asks decideRouteChange whether the proxy can absorb it, and either updates
// the proxy's live config (mode 'live', resolves at once) or fires the
// existing restartAgent (mode 'restart', the restart itself is not awaited --
// same fire-and-forget the routes always had). Serialized among its own
// calls; restartAgent's spawn is already guarded by agentSpawning.
let routeApplyChain = Promise.resolve()
function applyRoute() {
  const run = routeApplyChain.then(() => applyRouteInner())
  routeApplyChain = run.catch(() => {})
  return run
}
// Shared by applyRouteInner and previewRoute: build the candidate env for
// `config` and ask decideRouteChange. Pure over state -- writes nothing,
// restarts nothing. Returns { decision, next, provider }; `next` is null when
// the decision was made before an env existed.
function routeDecisionFor(config) {
  const restart = (reason) => ({ decision: { mode: 'restart', reason }, next: null, provider: null })
  if (shuttingDown) return restart('app is shutting down')
  if (!routeProxy || !routeProxy.server.listening || !lastSpawnEnv) return restart('no proxied agent to update')
  if (!agentChild && !agentSupervisorPid) return restart('agent not running')
  const provider = config.PROVIDER || 'claude'
  const built = buildProviderEnv(provider, config, { readProviderKey })
  if (built.error) return restart(`buildProviderEnv(${provider}) ${built.error.kind}: ${built.error.reason}`)
  const next = built.env
  // chatgpt row: buildProviderEnv CLEARS the route base URL (the port is
  // only known once ensureCodexProxy bound, see spawnRealAgentChild). The
  // live codex proxy from THIS spawn is the upstream -- fill it in exactly
  // as the spawn did, or refuse: an empty base would fall to
  // api.anthropic.com in routeConfigFor and send GPT traffic there.
  if (provider === 'chatgpt') {
    if (!codexProxyServer || !Number.isInteger(codexProxyPort) || codexProxyPort <= 0) return restart('chatgpt row: no live codex proxy to keep (rebuild on restart)')
    next.DSH_ROUTE_BASE_URL = `http://localhost:${codexProxyPort}`
  }
  return { decision: decideRouteChange(lastSpawnEnv, next), next, provider }
}

// Confirm-dialog preview (GET /api/agent/route-preview, 0.3.14): what
// applyRoute WOULD decide for the current config with these overrides.
// Reads only; never writes config, never restarts, never moves the proxy.
function previewRoute(overrides = {}) {
  let config
  try { config = { ...readAgentConfig() } } catch (err) { return { mode: 'restart', reason: `config unreadable: ${err.message}` } }
  if (typeof overrides.model === 'string' && overrides.model) config.MODEL = overrides.model
  if (typeof overrides.provider === 'string' && overrides.provider) config.PROVIDER = overrides.provider
  if (typeof overrides.effort === 'string' && overrides.effort) config.EFFORT_LEVEL = overrides.effort
  const { decision } = routeDecisionFor(config)
  return { mode: decision.mode, reason: decision.reason }
}

async function applyRouteInner() {
  const fallback = (reason) => {
    log(`applyRoute: restart (${reason})`)
    restartAgent().catch((err) => console.error('[scheherazade/main] applyRoute: restartAgent threw:', err))
    return { mode: 'restart', reason }
  }
  if (shuttingDown) return { mode: 'restart', reason: 'app is shutting down' }
  const config = readAgentConfig()
  const provider = config.PROVIDER || 'claude'
  if (provider === CLAUDE_CLI_PROVIDER_ID) {
    try { await refreshClaudeCliToken() } catch (e) { log(`applyRoute: login refresh threw: ${e && e.message ? e.message : String(e)}`) }
  }
  const { decision, next } = routeDecisionFor(config)
  if (decision.mode !== 'live' || !next) return fallback(decision.reason)
  if (decision.handover) {
    // codex -> codex onto an id codex-as-api's table does not know: the live
    // instance would serve its own fallback (the OLD model), so a second
    // instance is started for the new one and the route proxy is pointed at
    // it. The old instance is NOT killed here -- killCodexProxy before
    // setRoute would cut the stream the lane may be mid-way through; it
    // retires after a grace period (retireCodexProxy). Health failure ->
    // the restart this pick always had.
    const inst = await spawnCodexProxyInstance(next.DSH_MODEL)
    if (!inst.ok) return fallback(`codex proxy handover failed for ${next.DSH_MODEL}: ${inst.reason || 'unknown'}`)
    const old = { server: codexProxyServer, port: codexProxyPort, model: codexProxyModel }
    codexProxyServer = inst.server
    codexProxyPort = inst.port
    codexProxyModel = next.DSH_MODEL
    next.DSH_ROUTE_BASE_URL = `http://localhost:${inst.port}`
    log(`applyRoute: codex handover ${old.model || 'default'}@${old.port} -> ${next.DSH_MODEL}@${inst.port} (/health-verified)`)
    retireCodexProxy(old.server, old.port, old.model)
  }
  const { cls, route } = routeConfigFor(next)
  routeProxy.setRoute(cls, route)
  // Declared routes keep the spawn-time contextWindow (the engine read it
  // from the patch at boot); say so when the catalog disagrees so a wrong
  // compaction window is a logged fact, not a surprise.
  try {
    const { dshContextWindowFor } = require('./onboarding/public/js/model-catalog.cjs')
    if (next.DSH_ROUTE !== 'anthropic-catalog' && dshContextWindowFor(next.DSH_MODEL) !== dshContextWindowFor(lastSpawnEnv.DSH_MODEL)) {
      log(`applyRoute: WARNING declared route keeps the spawn model's context window (${lastSpawnEnv.DSH_MODEL}: ${dshContextWindowFor(lastSpawnEnv.DSH_MODEL)}) while serving ${next.DSH_MODEL} (${dshContextWindowFor(next.DSH_MODEL)}); restart to re-declare`)
    }
  } catch { /* catalog unreadable: nothing to warn with */ }
  lastSpawnEnv = { ...next }
  liveRoute = { model: next.DSH_MODEL || null, effort: next.DSH_EFFORT || null, provider, since: new Date().toISOString() }
  log(`applyRoute: live (${decision.reason})`)
  notifyLaneSelectModel(next.DSH_MODEL, next.DSH_EFFORT).then((r) => {
    log(r.ok ? `applyRoute: lane select-model ${r.applied ? 'applied' : 'not applied'}${r.reason ? ` (${r.reason})` : ''}` : `applyRoute: lane select-model skipped (${r.reason})`)
  })
  return { mode: 'live', reason: decision.reason }
}

// Reentrancy sentinel: the awaited chatgpt proxy gate inside the locked body
// opened a window where two concurrent spawn attempts (e.g. repeated
// onboarding-complete callbacks) both pass the agentChild + PIDFILE checks
// before either sets agentChild -- two supervisors on one Discord token. Set
// SYNCHRONOUSLY before any await, cleared on every exit; same pattern as
// loginStarting in http-server.cjs.
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

// ── companion channels (0.3.7 multi-channel) ──────────────────────────────
// Messengers beyond the primary run as their own supervised child processes
// (channel-companions.mjs), each with only its own credentials. Started right
// after the supervisor spawns, ended whenever the supervisor is.
let companionManager = null
let companionPrimary = null
async function startChannelCompanions(backends, config, agentName) {
  stopChannelCompanions()
  if (!backends.length) return
  let mod, supMod
  try {
    mod = await import(pathToFileURL(path.join(__dirname, 'channel-companions.mjs')).href)
    supMod = await import(pathToFileURL(SUPERVISOR_MJS_PATH).href)
  } catch (err) {
    log(`companion channels unavailable (module load failed: ${err.message}) -- primary channel only`)
    return
  }
  const scriptFor = { discord: 'channel.mjs', slack: 'channel-slack.mjs', telegram: 'channel-telegram.mjs' }
  const specs = []
  for (const backend of backends) {
    if (!scriptFor[backend]) continue // 'local' never runs as a companion
    const creds = resolveChannelCredentials(backend, config)
    if (!creds.ok) { log(`companion ${backend} skipped: ${creds.logMsg}`); continue }
    // A clean, minimal env: NOT process.env's channel secrets (Electron's env may carry
    // none, but never inherit another messenger's token by accident).
    const env = { ...process.env }
    for (const k of ['DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'TELEGRAM_BOT_TOKEN']) delete env[k]
    Object.assign(env, creds.channelEnv, {
      HOME_CHANNEL_ID: creds.homeChannelId,
      AGENT_NAME: agentName,
      AGENT_DATA_HOME: DATA_HOME,
      ELECTRON_RUN_AS_NODE: '1',
      SCHEHERAZADE_CHANNEL_ROLE: 'companion',
      SCHEHERAZADE_CHANNEL_SURFACE: backend,
    })
    specs.push({ backend, cmd: process.execPath, args: [toUnpackedPath(path.join(__dirname, scriptFor[backend]))], cwd: DATA_HOME, env })
  }
  if (!specs.length) return
  companionManager = mod.createCompanionManager({
    spawn: (spec) => spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] }),
    dataHome: DATA_HOME,
    backoffFor: supMod.backoffFor,
    log: (m) => log(m),
  })
  companionManager.start(specs)
  log(`companion channels started: ${specs.map((x) => x.backend).join(', ')}`)
}
function stopChannelCompanions() {
  if (!companionManager) return
  try { companionManager.stopAll((c) => { if (c.pid) killTree(c.pid, 'SIGTERM') }) } catch (err) { log(`companion stop failed: ${err.message}`) }
  companionManager = null
}
// Per-channel status for Settings: the primary (agent's own MCP channel) plus companions.
function channelStatus() {
  const out = {}
  let cfg = {}
  try { cfg = readAgentConfig() } catch { /* unreadable config: report nothing */ }
  const list = channelBackendsLib.parseBackends(cfg)
  const primary = list[0]
  let connected = false
  try {
    const live = JSON.parse(fs.readFileSync(path.join(DATA_HOME, '.agent-live'), 'utf8'))
    connected = Date.now() - Date.parse(live.lastHeartbeat) <= 150_000
  } catch { /* no marker */ }
  out[primary] = { role: 'primary', state: agentChild ? 'running' : 'stopped', connected: Boolean(agentChild && connected) }
  const comp = companionManager ? companionManager.status() : {}
  for (const b of list.slice(1)) out[b] = { role: 'companion', ...(comp[b] || { state: agentChild ? 'not_started' : 'stopped', connected: false }) }
  return out
}

// ── per-backend credential resolution (0.3.7 multi-channel) ───────────────
// Pure lookup extracted from spawnRealAgentChildLocked so the PRIMARY channel
// (injected into the supervisor env, which the claude CLI hands to the one
// agent-channel MCP server) and every COMPANION channel (its own child process,
// spawned below) resolve credentials through the same code. Each caller injects
// ONLY the env this returns -- a companion never sees another messenger's token.
// Returns { ok:true, channelEnv, homeChannelId } or
//         { ok:false, logMsg, isError?, status?:[state, code, message] }.
function resolveChannelCredentials(backend, config) {
  const channelEnv = {}
  let homeChannelId
  if (backend === 'slack') {
    let slackBot, slackApp
    try {
      slackBot = readSlackBotToken()
      slackApp = readSlackAppToken()
    } catch (err) {
      return { ok: false, isError: true, logMsg: `slack token read failed, cannot spawn agent: ${err}`, status: ['failed', 'channel_token_error', `slack token read failed: ${err.message}`] }
    }
    if (!slackBot || !slackApp) return { ok: false, logMsg: 'agent spawn skipped: slack backend active but bot/app token missing' }
    // SLACK_HOME_CHANNEL_ID is OPTIONAL since DM-default mode (2026-08-04): tokens alone are
    // a complete slack config -- the conversation binds to whoever DMs the bot.
    homeChannelId = config.SLACK_HOME_CHANNEL_ID || ''
    channelEnv.SLACK_BOT_TOKEN = slackBot
    channelEnv.SLACK_APP_TOKEN = slackApp
  } else if (backend === 'telegram') {
    let tgToken
    try {
      tgToken = readTelegramToken()
    } catch (err) {
      return { ok: false, isError: true, logMsg: `telegram token read failed, cannot spawn agent: ${err}`, status: ['failed', 'channel_token_error', `telegram token read failed: ${err.message}`] }
    }
    if (!tgToken) return { ok: false, logMsg: 'agent spawn skipped: telegram backend active but no validated bot token yet' }
    homeChannelId = config.TELEGRAM_HOME_CHAT_ID
    if (!homeChannelId) return { ok: false, logMsg: 'agent spawn skipped: telegram backend active but no TELEGRAM_HOME_CHAT_ID yet' }
    channelEnv.TELEGRAM_BOT_TOKEN = tgToken
  } else if (backend === 'local') {
    // In-app chat: no third-party credential, nothing to gate the spawn on.
    // supervisorEnv always carries a HOME_CHANNEL_ID, so hand it the backend's
    // own constant (channel-local.mjs LOCAL_CHANNEL_ID), not a leftover id.
    homeChannelId = 'in-app'
  } else {
    // discord -- the default AND the unknown-value fallback (mirrors http-server.cjs
    // activeChannelBackend() so spawn and .mcp.json cannot disagree).
    let token
    try {
      token = readDiscordToken()
    } catch (err) {
      // log(), not console.error: stderr never reaches app.log (the Windows OSCrypt case).
      // 'channel_token_error' is distinct from key_error (provider key) and
      // discord_token_bad (marker-driven rejected token).
      return { ok: false, logMsg: `readDiscordToken failed, cannot spawn agent: ${(err && err.message) || err}`, status: ['failed', 'channel_token_error', `readDiscordToken failed: ${err.message}`] }
    }
    if (!token) return { ok: false, logMsg: 'agent spawn skipped: no validated Discord bot token on file yet' }
    homeChannelId = readHomeChannelId()
    if (!homeChannelId) return { ok: false, logMsg: 'agent spawn skipped: no HOME_CHANNEL_ID on file yet' }
    channelEnv.DISCORD_BOT_TOKEN = token
  }
  return { ok: true, channelEnv, homeChannelId }
}

async function spawnRealAgentChildLocked() {
  if (agentChild) {
    log(`agent spawn skipped: a child is already alive (pid=${agentChild.pid})`)
    return agentChild
  }

  // Harness gate (harness-refresh issue #6). The boot refresh re-renders CLAUDE.md,
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
  // the supervisor's own start/stop verbs use before spawning a second
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
    } else {
      // 0.1.4 fix (field report 2026-08-11, GLM5.2+ollama): the DEFAULT
      // topology's adoption path left lastSpawnInfo null for the entire app
      // run -- laneVision(null) = 'unknown', which silently disabled the
      // Gemma vision stand-in AND handed the agent the 'unknown' marker that
      // invites a Read-tool image read. A non-vision lane then 400s on the
      // image block every turn ("Model call failed" repeating) until a
      // forced restart happened to take the real spawn path and re-stamp.
      // The adopted supervisor runs from the same config this app process
      // reads, so stamping from config is as truthful here as it is for
      // attach.
      stampAttachSpawnInfo(null, 'adopted')
    }
    // Timeout-backstop gap fix: stamp 'connecting' on THIS attach path
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
  // ...but only where the lane exists. attachStartFromSession walks straight
  // into `!state.tmuxPresent` -> setAgentStatus('failed', 'bootstrap-needed')
  // on a platform that ships no tmux, and the agent then never starts at all.
  // The Settings card is hidden off mac so the UI cannot get here -- but the
  // manual tells the agent it may edit .agent-config itself, which makes this
  // a reachable self-brick, and "you asked for a lane this machine does not
  // have" is not a reason to refuse to boot. Fall through to spawn, loudly:
  // the app comes up, and the log says exactly what was ignored and why.
  const attachAsked = (config.AGENT_TOPOLOGY || 'spawn') === 'attach'
  if (attachAsked && !require('./onboarding/platform.cjs').host().attachLane) {
    log(`AGENT_TOPOLOGY=attach ignored: this platform (${process.platform}) has no attach lane -- `
      + 'the vendored tmux ships on macOS only. Starting in the spawn topology instead; '
      + 'remove AGENT_TOPOLOGY from .agent-config to silence this.')
  } else if (attachAsked) {
    return attachStartFromSession(config)
  }

  // 0.2.2 full harness swap: the agent engine is the bundled dsh lane --
  // Claude Code is NOT required to spawn. resolveClaudeBin is best-effort
  // now: its result rides only into CLAUDE_BIN for the legacy
  // LANE_KIND=headless escape hatch, and its absence must not block a
  // launch that will never exec it. The cli_missing gate below fires only
  // when that escape hatch is actually selected.
  const resolved = resolveClaudeBin()
  if (!resolved && String(config.LANE_KIND || '') === 'headless') {
    const need = ensureClaudeCli()
    // Two different sentences, because two different things are true. Telling
    // someone who just ran `npm i -g @anthropic-ai/claude-code` that it is not
    // installed is false to them, and once one sentence is visibly false the
    // correct instruction under it stops being believed.
    const reason = need.shimOnlyPath
      ? `Claude Code is installed here as a shell shim (${need.shimOnlyPath}), which this app cannot launch directly -- ` +
        'it drives the CLI through a real console process, and a .cmd shim is not one. ' +
        `Install the native build alongside it with: ${need.installCommand}  ` +
        `then run 'claude' once to sign in. Requires ${need.planRequirement}.`
      : 'Claude Code is not installed on this machine. Scheherazade runs on top of your own ' +
        `Claude Code -- it does not ship one. Install it with: ${need.installCommand}  ` +
        `then run 'claude' once to sign in. Requires ${need.planRequirement}.`
    console.error(
      `[scheherazade/main] BLOCKER: ${reason} The real agent cannot be spawned. Searched PATH ` +
        `and npm global bin dirs: ${need.searched.join(', ')}. If the user DID install it, this ` +
        'is a PATH-visibility bug in a packaged app, not a missing install -- widen ' +
        'NPM_GLOBAL_BIN_DIRS rather than telling them to reinstall. Onboarding UI stays usable.'
    )
    // 2026-08-04: this used to be 'unknown', on the honest grounds that no
    // enumerated code fitted. That was right about the enum and wrong about
    // what to do -- the answer was to add the code, not to shrug. Of the 13
    // 'unknown' sites this was the worst one: `reason` above contains the
    // literal install command, and the UI answered "we don't know why it
    // failed, wait a moment and click Check status again".
    setAgentStatus('failed', 'cli_missing', reason)
    return null
  }

  // Launcher gate: one file, one lane.
  if (!fs.existsSync(SUPERVISOR_MJS_PATH)) {
    const reason = `internal launcher not found at ${SUPERVISOR_MJS_PATH} (supervisor.mjs missing from the packaged/unpacked app -- check build.files/build.asarUnpack)`
    console.error(`[scheherazade/main] BLOCKER: ${reason}`)
    // NOT cli_missing: that one is "you have not installed Claude Code",
    // which the user fixes. This one is "a file we ship is absent from our
    // own bundle" -- nothing the user did, and the only thing they can do is
    // reinstall. Two different sentences, so two different codes.
    setAgentStatus('failed', 'app_files_missing', reason)
    return null
  }

  // Critical A: BYOK key forward. A fresh Mac where `claude` was never
  // authenticated has NO credentials of its own -- without this, the CLI
  // hangs at its own auth prompt forever, with nothing to answer it.
  // PROVIDER is written by onboarding/http-server.cjs's
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
  // tests/test-provider-env.mjs). This function stays a flat if/else on
  // buildProviderEnv()'s return shape; see provider-env.cjs's own doc
  // comment on `buildProviderEnv` for the full contract (env fields to
  // spread over the base env, and the 3 error.kind values below).
  const provider = config.PROVIDER || 'claude'
  // CLI-login route: rotate an expired/expiring Claude Code login via its
  // refresh token BEFORE the sync read below (2026-10-07, Mino: re-login in
  // Sera did not refresh; only running `claude` did). Failure is logged and
  // falls through to buildProviderEnv's honest not_ready.
  if (provider === CLAUDE_CLI_PROVIDER_ID) {
    try {
      const r = await refreshClaudeCliToken()
      if (r.refreshed) console.log(`[scheherazade/main] ${provider}: login token refreshed (expires ${new Date(r.expiresAt).toISOString()})`)
      else if (r.error) console.warn(`[scheherazade/main] ${provider}: login refresh skipped: ${r.error}`)
    } catch (e) {
      console.warn(`[scheherazade/main] ${provider}: login refresh threw: ${e && e.message ? e.message : String(e)}`)
    }
  }
  const providerEnvResult = buildProviderEnv(provider, config, { readProviderKey })
  if (providerEnvResult.error) {
    const { kind, reason, fix } = providerEnvResult.error
    // `reason` is the diagnosis, `fix` the instruction (provider-env.cjs).
    // The status pill shows `detail` and nothing else, so a detail without the
    // fix leaves the user reading an accurate sentence they cannot act on.
    const detail = fix ? `${reason} -- ${fix}` : reason
    if (kind === 'key_error') {
      console.error(`[scheherazade/main] buildProviderEnv(${provider}) key_error, cannot spawn agent: ${reason}`)
      setAgentStatus('failed', 'key_error', detail)
      return null
    }
    if (kind === 'not_ready') {
      // Quiet skip, matching this codebase's existing "no key yet" behavior
      // -- no setAgentStatus call, see provider-env.cjs's own doc comment on
      // this error.kind. So the fix below reaches the app log only; it is
      // logged rather than dropped so that a support conversation has it,
      // NOT because the user will see it.
      log(`agent spawn skipped: ${detail}`)
      return null
    }
    // 'provider_not_wired' (or any future unrecognized kind -- defense in
    // depth, same fallback this codebase's pre-existing `else` branch used).
    console.error(`[scheherazade/main] BLOCKER: buildProviderEnv(${provider}) provider_not_wired: ${reason}`)
    setAgentStatus('failed', 'provider_not_wired', detail)
    return null
  }

  // chatgpt provider: a trusted proxy must be CONFIRMED up before the agent
  // spawns -- awaited, fail-closed (Codex security review finding #1; see
  // ensureCodexProxy's header). Reported as 'proxy_unavailable' (2026-08-04;
  // was 'unknown' when the enum had no row for it -- the enum was the thing
  // that needed changing).
  if (provider === 'chatgpt') {
    let proxy = { ok: false, port: null }
    try {
      proxy = await ensureCodexProxy(config)
    } catch (err) {
      console.error('[scheherazade/main] ensureCodexProxy threw unexpectedly:', err)
    }
    if (!proxy || !proxy.ok) {
      setAgentStatus('failed', 'proxy_unavailable', 'no trusted codex-as-api proxy is available (see app log) -- agent not spawned')
      return null
    }
    // THE PORT IS ONLY KNOWN NOW (2026-08-04). buildProviderEnv ran above and
    // could not know it: with an ephemeral bind the config has no answer, so
    // its chatgpt row CLEARS the route base URL and this line fills it in with
    // the port the kernel actually gave us. The field is DSH_ROUTE_BASE_URL
    // since the 0.2.2 dsh swap -- the chatgpt row is a declared
    // anthropic-messages route now, not an ANTHROPIC_BASE_URL CLI override.
    //
    // Asserted rather than assumed. If a future edit reorders these two so
    // the env is built after the proxy, or drops the placeholder, this catches
    // it here instead of at the far end -- where the symptom is an agent
    // quietly talking to nothing on a port nobody is listening on.
    if (!Number.isInteger(proxy.port) || proxy.port <= 0) {
      console.error(`[scheherazade/main] BLOCKER: proxy reported ok with an unusable port (${proxy.port}) -- not spawning`)
      setAgentStatus('failed', 'proxy_unavailable', 'the local proxy started but did not report a usable port -- agent not spawned')
      return null
    }
    providerEnvResult.env.DSH_ROUTE_BASE_URL = `http://localhost:${proxy.port}`
  }

  // Route proxy (2026-10-07): every row's route now targets route-proxy.cjs,
  // whose live config starts EQUAL to this spawn's (same model, effort,
  // upstream, key) so requests pass through unchanged until a UI pick moves
  // it (applyRoute). DSH_MODEL stays the REAL model id: the catalog lookup,
  // compaction window, vision list, thinking shape, cost rows and subagent
  // options all key on it. lastSpawnEnv keeps the pre-rewrite build for
  // decideRouteChange. Proxy failure is loud and falls back to the direct
  // route (every later pick then restarts, as before).
  lastSpawnEnv = null
  try {
    const rp = await ensureRouteProxy()
    const { cls, route, laneEnv } = routeConfigFor(providerEnvResult.env)
    lastSpawnEnv = { ...providerEnvResult.env }
    rp.setRoute(cls, route)
    Object.assign(providerEnvResult.env, laneEnv(rp.port))
    log(`route proxy: ${provider} rides ${cls} class via ${providerEnvResult.env.DSH_ROUTE_BASE_URL} (key ${route.keyMode}) -> ${route.upstreamBase}`)
  } catch (err) {
    console.error('[scheherazade/main] route proxy unavailable -- agent spawns on the direct route; model/effort picks will restart it:', err)
  }

  // ollama provider: NO local gate anymore (2026-08-04, the owner "ollama ->
  // API키"). The lane is ollama.com CLOUD via ANTHROPIC_BASE_URL + a stored
  // API key (provider-env.cjs's ollama row) -- there is no local daemon to
  // confirm, and gating the spawn on ensureOllamaDaemon() here would block
  // a perfectly valid cloud config on any machine without Ollama.app
  // installed. Missing key/model still fail closed via buildProviderEnv's
  // not_ready path below, same as every credentialed lane. killOllamaDaemon
  // in the quit path stays -- it only cleans up a daemon WE spawned in a
  // pre-cloud session, and is a no-op otherwise.

  // Multichannel (v0.0.18): resolve the ACTIVE backend's credentials + home
  // id at spawn time. Same seam discipline as the original Discord-only
  // path: decrypt HERE, inject into this child's env only, never write back
  // to disk. HOME_CHANNEL_ID stays the ONE generic key every channel script
  // reads (discord channel id / slack channel id / telegram chat id) --
  // main resolves which stored id it means. The injected value beats the
  // channel scripts' dotenv read (dotenv never overrides existing env
  // vars), so a stale .env HOME_CHANNEL_ID from the discord era cannot
  // leak into a slack/telegram run.
  // Which messengers are on (channel-backends.cjs; legacy CHANNEL_BACKEND still
  // read). The FIRST is the primary: its credentials ride the supervisor env and
  // it is the claude CLI's agent-channel MCP server. The rest start as companion
  // processes after the supervisor is up (startChannelCompanions).
  const enabledBackends = channelBackendsLib.parseBackends(config)
  migrateChannelBackendsOnDisk() // legacy CHANNEL_BACKEND-only config -> list form, once (behaviour unchanged)
  const channelBackend = enabledBackends[0]
  const primaryCreds = resolveChannelCredentials(channelBackend, config)
  if (!primaryCreds.ok) {
    if (primaryCreds.isError) console.error(`[scheherazade/main] ${primaryCreds.logMsg}`)
    else log(primaryCreds.logMsg)
    if (primaryCreds.status) setAgentStatus(...primaryCreds.status)
    return null
  }
  const { channelEnv, homeChannelId } = primaryCreds

  const agentName = config.AGENT_NAME || FIXED_AGENT_NAME
  const model = config.MODEL || 'claude-opus-4-6' // same default as the supervisor's own MODEL fallback

  log(
    `spawning real agent via internal launcher: launcher=${SUPERVISOR_MJS_PATH} bin=${resolved ? `${resolved.bin} (${resolved.source})` : 'none (dsh lane; Claude Code not required)'} ` +
      `model=${model} name=${agentName} dataHome=${DATA_HOME}`
  )

  // BOT-TOKEN SEAM: decrypted here, at the moment of spawn, and injected
  // directly into this child's own env -- never written back to any
  // on-disk config. The `claude` CLI forwards its full parent env to every
  // MCP server child it spawns, merged with (not replaced by) that server's
  // own declared `env` block in .mcp.json. So DISCORD_BOT_TOKEN set on THIS
  // child's env below reaches channel.mjs unchanged, with no code change
  // needed here and no token ever touching .mcp.json or any other on-disk
  // file. The supervisor re-exports AGENT_NAME/MEM/CLAUDE_BIN/MODEL for the
  // lane's own use but never touches or logs DISCORD_BOT_TOKEN, so it passes
  // through supervisor -> lane -> engine -> channel.mjs untouched at every
  // hop. (history: docs/HISTORY.md)
  // --dangerously-skip-permissions is NOT set here -- and correctly so: this
  // spawn() call's target is our own runtime running supervisor.mjs, not the
  // `claude` CLI binary, and the flag only means anything on the `claude`
  // command line (headless-lane.mjs's buildArgs adds it there).
  const supervisorEnv = {
    ...process.env,
    ...channelEnv,
    HOME_CHANNEL_ID: homeChannelId,
    // The lane's cross-channel turn gate (turn-gate.mjs) and the primary's own
    // inbound surface name (which messenger this MCP process speaks for).
    SCHEHERAZADE_CHANNEL_SURFACE: channelBackend,
    ...(enabledBackends.length > 1 ? { SCHEHERAZADE_MULTI_CHANNEL: '1' } : { SCHEHERAZADE_MULTI_CHANNEL: '' }),
    AGENT_NAME: agentName,
    MODEL: model,
    // Effort selector (the owner 07-13 click-test item 2): only forwarded when
    // the user picked one -- absent, the supervisor's own EFFORT_LEVEL
    // default applies. The stop-path spawns deliberately don't carry this
    // (the stop verb never reads it).
    ...(config.EFFORT_LEVEL ? { EFFORT_LEVEL: config.EFFORT_LEVEL } : {}),
    // 0.2.2: best-effort -- absent Claude Code is fine, the dsh lane never
    // execs it (see the softened cli_missing gate above).
    CLAUDE_BIN: resolved ? resolved.bin : (config.CLAUDE_BIN || 'claude'),
    AGENT_DATA_HOME: DATA_HOME, // the one data-home spelling this app writes (data-home.cjs)
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
  // ensureNodeShim inside supervisor.mjs's own spawn path, which production
  // (the bash lane, until 0.3.0) never took -- so packaged installs never got
  // the shim and every Claude Code hook died with `/bin/sh: node: command not
  // found`, stop-reply-guard among them, which is exactly why a promised
  // Discord reply could go unbounced. Patched HERE as well as there: the
  // supervisor's own ensureNodeShim call is idempotent (it sees the dir
  // already on PATH). Single-sourced from supervisor.mjs via dynamic import (ESM); on
  // any failure the child keeps the unpatched PATH = the pre-fix behavior,
  // loud. (history: docs/HISTORY.md)
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
  // v0.1.11: lane vision verdict, exported to the agent child so
  // hooks/pre-tool-vision-guard.mjs can hard-block image/PDF Reads on
  // no-vision lanes BEFORE they poison the transcript (the GLM5.2+ollama
  // 400-every-turn wedge -- see the 0.1.4 adoption-path post-mortem
  // earlier in spawnRealAgentChildLocked). Same
  // laneVision() policy the chat upload route applies to attachments;
  // supervisorEnv.MODEL is read AFTER the provider-env spread, so an
  // ollama lane's real model tag (not the generic Anthropic default)
  // decides. Read AT SPAWN on purpose -- a provider flip respawns the
  // agent, so env staleness cannot outlive the lane it described.
  supervisorEnv.SCHEHERAZADE_LANE_VISION = laneVision({
    provider: config.PROVIDER, model: supervisorEnv.MODEL || config.MODEL,
  })
  // ONE lane, every platform (design-0023 P3): our own runtime as node, on
  // supervisor.mjs, detached so it leads its own process group. The group is
  // what lets app-quit signal the WHOLE tree (supervisor -> lane -> engine)
  // with one negative-pid signal without touching Electron's own group; on
  // win32, where no such thing exists, proc.killTree does taskkill /T instead.
  const child = spawn(process.execPath, [SUPERVISOR_MJS_PATH, '__loop'], {
    cwd: DATA_HOME,
    env: { ...supervisorEnv, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  agentChild = child
  agentSupervisorPid = child.pid
  startChannelCompanions(enabledBackends.slice(1), config, agentName).catch((err) => log(`companion start failed: ${err.message}`))
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
    // 0.2.6 UI pass: the shell header shows the agent's NAME instead of the
    // generic "AGENT" label when a spawn has one (nav.js reads this).
    // 2026-09-28: DISPLAY_NAME first. The name the user typed in Settings is
    // the name of the agent; AGENT_NAME is the build's default and only wins
    // when nothing was ever set.
    name: config.DISPLAY_NAME || config.AGENT_NAME || null,
    at: new Date().toISOString(),
  }
  liveRoute = { model: lastSpawnInfo.model, effort: lastSpawnInfo.effort, provider: lastSpawnInfo.provider, since: lastSpawnInfo.at }
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

  // Fix C: participate in the supervisor's own PIDFILE convention (see
  // AGENT_PIDFILE's doc comment above) so a future launch of this app (or
  // a manual `supervisor.mjs start`/`stop` from a terminal) can see this supervisor
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
    // e.g. the runtime itself failing to exec -- never swallow. This is the
    // launcher process failing to spawn at all, not a lane crash inside the
    // supervisor's loop (that one is absorbed by its restart ladder).
    console.error('[scheherazade/main] agent child spawn error:', err)
    logBuffer.append('main!', `agent child spawn error: ${err.message}`)
    // 'spawn_failed': the launcher process itself never started. Distinct from
    // the supervisor's OWN crash-loop detector, which can only fire once the
    // supervisor IS running and restarting the lane inside itself
    // (2026-08-04; was 'unknown').
    setAgentStatus('failed', 'spawn_failed', `spawn error: ${err.message}`)
    agentChild = null
    agentSupervisorPid = null
    stopChannelCompanions()
    stopFailurePoll()
    fs.rmSync(AGENT_PIDFILE, { force: true })
  })
  child.on('exit', (code, signal) => {
    // The supervisor's loop only exits on SIGTERM/SIGINT (handled, clean), on
    // the STOPFLAG, or on a fatal it reports through the failure marker.
    // Historically ANY exit here meant a crash (stamp 'failed'). The control panel added two DELIBERATE kill paths
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
    stopChannelCompanions()
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
      // Unexpected exit of the SUPERVISOR itself -- it started and then died,
      // which is not the same failure as never starting (2026-08-04; both
      // were 'unknown').
      setAgentStatus('failed', 'agent_exited', `agent process exited unexpectedly (code=${code} signal=${signal})`)
    }
  })

  return child
}

// Fix C: app-quit cleanup. Quitting the app used to leave the supervisor
// running with no cleanup at all -- orphaned, still holding the Discord
// token, PIDFILE stale from this process's perspective. Two layers, both
// still worth having now that there is one lane:
//
//   1. Best-effort direct signal, fast path: proc.killTree at the supervisor
//      pid. The supervisor is spawned detached, so it leads its own process
//      group and one negative-pid SIGTERM reaches supervisor -> lane ->
//      engine in one shot (taskkill /T on win32, which has no groups).
//   2. Reliable path, ALWAYS also run: `supervisor.mjs stop`. It does not
//      depend on this process's view of the world -- it re-reads the PIDFILE,
//      re-verifies identity by COMMAND LINE (unaffected by pid recycling),
//      writes the STOPFLAG so the loop cannot respawn under us, waits out the
//      lane's own shutdown, and only then forces. It also covers the case
//      where this app merely DISCOVERED a running supervisor (adopted via
//      AGENT_PIDFILE) rather than spawning it, and the upgrade case where the
//      live supervisor is a leftover 0.2.x bash loop. Fired detached +
//      unref'd so it can finish its own poll-and-kill window (up to ~15s)
//      even after Electron itself has quit. (history: docs/HISTORY.md)
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

function stampAttachSpawnInfo(config, lane = 'attach') {
  const cfg = config || readAgentConfig()
  lastSpawnInfo = {
    model: cfg.MODEL || null,
    effort: cfg.EFFORT_LEVEL || null,
    provider: cfg.PROVIDER || null,
    // name was omitted here while the spawn path carried it, so an
    // attach/adopted run left the shell header on the generic "AGENT" label
    // even though the user had named the agent (2026-09-28). Same
    // DISPLAY_NAME-first rule as the spawn path above.
    name: cfg.DISPLAY_NAME || cfg.AGENT_NAME || null,
    at: new Date().toISOString(),
    lane,
  }
  // An attached/adopted supervisor was not spawned through the route proxy:
  // nothing to update live, so every pick restarts (applyRoute fallback).
  lastSpawnEnv = null
  liveRoute = { model: lastSpawnInfo.model, effort: lastSpawnInfo.effort, provider: lastSpawnInfo.provider, since: lastSpawnInfo.at }
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
    // v0.0.35: the app ships its own tmux (synced into DATA_HOME/bin at every
    // boot), so "no tmux" now means that sync failed or never ran -- brew is
    // no longer the remedy, a relaunch is.
    setAgentStatus('failed', 'bootstrap-needed', 'attach 모드인데 tmux가 아직 준비되지 않았습니다. 앱을 한 번 재시작하면 내장 tmux가 자동으로 준비됩니다.')
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
      setAgentStatus('failed', 'attach_failed', `attach respawn 실패: ${r.error}`)
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
      `attach 세션은 있는데 pane pid를 읽지 못했습니다 (tmux 일시 오류일 수 있음). 앱을 다시 열어 재시도하거나 터미널에서 확인하세요: "${attachTopology.resolveTmuxBin() || 'tmux'}" -L ${attachTopology.ATTACH_SOCKET} list-panes -t ${attachTopology.ATTACH_SESSION}`)
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
      `attach 세션(${attachTopology.ATTACH_SESSION})의 pane(pid=${panePid})이 우리 supervisor 시그니처가 아닙니다. 터미널에서 세션을 정리한 뒤 부트스트랩을 다시 실행하세요: "${attachTopology.resolveTmuxBin() || 'tmux'}" -L ${attachTopology.ATTACH_SOCKET} kill-session -t ${attachTopology.ATTACH_SESSION}`)
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
// "confirmed dead" must come from the same identity check the supervisor uses --
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
  stopChannelCompanions() // companions die with the supervisor tree, on every stop path
  // NOTE (2026-09-08): a null agentSupervisorPid used to return here, which
  // ALSO skipped the identity-safe `supervisor stop` cleanup below -- exactly
  // the case where it is most needed. The supervisor dying (or being killed)
  // during the quit's own grace window nulls this pid in the child 'exit'
  // handler, and its lane/engine/MCP grandchildren then had nothing left to
  // reap them. The direct signal needs a pid; the stop verb does not (it
  // re-reads the PIDFILE and verifies by command line), so only the first half
  // is now pid-gated.
  // Attach topology: the agent deliberately OUTLIVES the app (session
  // survival is one of the two differentiators in design-0016). App quit
  // must leave the external supervisor untouched -- the control panel's
  // intentional stopAgent() path still works (it goes through the supervisor's
  // stop verb, not through here).
  if (agentTopologyIsAttach()) {
    log('app quit: attach topology -- external agent left running (by design; stop it from the control panel if you mean it)')
    return
  }
  try {
    if (agentSupervisorPid == null) {
      log('app quit: no supervisor pid in hand (never spawned, or already exited) -- going straight to the identity-safe stop path')
    } else if (agentChild) {
      // Our own live child -- Node's own bookkeeping guarantees this pid
      // hasn't been reaped/recycled since we still hold the ChildProcess
      // handle and haven't seen its 'exit' event, so it's safe to
      // group-signal without an extra identity re-check.
      killTree(agentSupervisorPid, signal)
      log(`sent ${signal} to agent supervisor process tree (pid=${agentSupervisorPid}) -- best-effort fast path`)
    } else if (isOurSupervisor(agentSupervisorPid)) {
      // Bug 1 fix: this pid was DISCOVERED via AGENT_PIDFILE (not spawned
      // by this process instance), so re-verify identity right before
      // signaling -- time may have passed since discovery, and a bare
      // isPidAlive() re-check alone would still be identity-blind to a
      // since-recycled pid.
      // killTree (not a bare process.kill): on win32 a single-process kill
      // leaves the supervisor -> headless-lane -> claude -> MCP subtree alive
      // (no POSIX process groups), orphaning the MCP stdio children on quit.
      // killTree does taskkill /PID /T /F on win32 and a POSIX process-group
      // signal (-pid) on mac/Linux -- the same teardown the agentChild fast
      // path above already uses, and the discovered supervisor is the same
      // detached `supervisor.mjs __loop` group leader.
      killTree(agentSupervisorPid, signal)
      log(`sent ${signal} to discovered agent supervisor process tree (pid=${agentSupervisorPid}, identity re-verified via ps) -- best-effort fast path`)
    } else {
      log(`skipping direct signal to agentSupervisorPid=${agentSupervisorPid}: no longer verifiable as our supervisor (dead, or pid recycled) -- relying on the 'supervisor stop' cleanup path below instead, which is identity-safe via its own command-line check`)
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
    console.error('[scheherazade/main] failed to spawn the supervisor stop cleanup:', err)
  }
}

// ── control-panel agent lifecycle (2026-07-09) ────────────────────────────
// stop / start / restart for the in-app control panel (#4 model swap, #5
// on/off). The app's FIRST intentional agent-lifecycle paths -- see
// intentionalStopMode's declaration and child.on('exit')'s branch on it.
//
// Why NOT reuse killAgentSupervisor(): it fires the stop DETACHED + unref
// (fire-and-forget, correct for app-quit where nothing waits). A restart MUST
// serialize -- the supervisor's orphan sweep matches the lane by SCRIPT PATH
// (never by a post-spawn-mutable field like --model), so a stop still in
// flight would reap a freshly-spawned replacement's lane too.
// stopAgentAwaited() AWAITS the stop to completion (it blocks up to ~15s:
// write STOPFLAG, signal the group, poll, force-kill, remove PIDFILE) so that
// window is fully closed before any respawn.

function stopAgentAwaited() {
  // Resolves (never rejects) when the stop verb has exited -- supervisor + lane
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
// reliable than the stop verb's exit code, which is 0 even when it killed nothing
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
// the stop actually kills) is consumed as intentional rather than stamped
// 'failed'. Low harm and self-correcting: the user's intent (stop/restart)
// matches the outcome anyway, and for a crash-LOOP the flag is single-shot --
// the very next crash (flag already null) surfaces as 'failed'.
//
// Concurrency (the owner 2026-07-09, YAGNI): these actions are deliberately NOT
// serialized server-side. Overlapping control actions (a user mashing stop/
// start/model) are prevented at the source -- the control-panel UI disables its
// buttons while an action is in flight. The single-action safety that IS load-
// bearing lives right here: each action AWAITS CONFIRMED process death before
// respawning, because the stop's sweep matches the lane by script path and
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
    setAgentStatus('failed', 'stop_unconfirmed', 'stop did not confirm agent exit; it may still be running')
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
    setAgentStatus('failed', 'stop_unconfirmed', 'restart aborted: prior agent did not confirm exit')
    return
  }
  // Exit handler consumes the flag; ensure it's clear before respawn so the new
  // child's own future crash isn't misattributed to this restart.
  intentionalStopMode = null
  await spawnRealAgentChild()
}

// Clear the in-app transcript through the local chat surface's loopback
// endpoint (channel-local.mjs POST /clear). main.cjs runs in the Electron main
// process; the transcript store lives in the SUPERVISED agent child, so it is
// unreachable by a direct call -- the loopback surface is the only seam. The
// child owns the port + bearer token in DATA_HOME/local-channel.json (0600).
// Best-effort: returns false if the child is down or the file is stale; the
// caller then falls back to a direct disk clear (see newConversation).
async function clearLocalTranscriptViaLoopback() {
  let info
  try {
    info = JSON.parse(fs.readFileSync(path.join(DATA_HOME, 'local-channel.json'), 'utf8'))
  } catch {
    return false // no surface file: child down or never wrote it
  }
  if (!info || !info.port || !info.token) return false
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/clear`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}

// Disk fallback for the transcript clear when the live surface is unreachable
// (child already dead by the time we clear). Rewrites the persisted transcript
// to an empty queue while PRESERVING seq -- the exact invariant clearTranscript
// keeps, reimplemented here because main.cjs cannot import the ESM store. Read
// the existing seq so a page cursor held across the clear still reads "nothing
// new" instead of rewinding. Fail-soft: a missing/corrupt file just becomes an
// empty {seq:0,queue:[]}, which is the honest fresh-start state anyway. MUST
// run only while the child is confirmed dead (no writer to race the rename).
function clearLocalTranscriptOnDisk() {
  const file = path.join(DATA_HOME, 'chat-transcript.json')
  let priorSeq = 0
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Number.isFinite(raw.seq)) priorSeq = raw.seq
  } catch { /* absent/corrupt: seq 0 is the correct fresh baseline */ }
  try {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ seq: priorSeq, queue: [] }, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    log(`new-conversation: on-disk transcript clear failed (chat may replay old history): ${err.message}`)
  }
}

// "New conversation" — a genuine fresh session with a CLEAN BREAK (2026-08-18,
// owner-confirmed). Unlike restartAgent (which RESUMES via the session file),
// this forgets the current thread entirely:
//   1. Fresh context   -- drop DATA_HOME/.headless-session.json so the next
//      spawn carries NO --resume (headless-lane readPriorSession -> null).
//   2. Empty transcript -- clear the in-app chat, durably (survives reload).
//   3. CLEAN BREAK      -- deliberately does NOT fire the context-pressure
//      checkpoint-flush handoff turn. That flush is fired ONLY by the running
//      lane's rotateTimer when its in-memory rotatePending is set; killing the
//      lane (stopAgentAwaited -> SIGTERM -> shutdown(), which only ends stdin
//      and kills) fires nothing, and a fresh boot consumes any on-disk rotate
//      marker BEFORE rotatePending is read (headless-lane.mjs: unlink at the
//      boot check precedes the existsSync at spawn), so rotatePending is false.
//      No [SYSTEM] handoff turn is ever sent. The user asked to forget, so
//      nothing is handed off.
//   4. Memory INTACT    -- the memory MCP db (memory.db: user_facts /
//      open_threads / corrections / preferences) is never touched. Only the
//      conversation session pointer and the in-app transcript are cleared.
// Requires a UI confirm (irreversible) -- enforced at the button.
async function newConversation() {
  log('control panel: NEW conversation -- clean break (fresh session, transcript cleared, memory.db untouched, NO checkpoint handoff)')
  // Clear the live transcript through the surface before the lane dies: keeps
  // seq monotonic and flushes the empty state to disk (channel-local /clear).
  const clearedLive = await clearLocalTranscriptViaLoopback()
  if (!clearedLive) log('new-conversation: loopback /clear did not confirm (child may be down); disk fallback runs after stop')
  intentionalStopMode = 'restart'
  await stopAgentAwaited()
  // Same attach-aware confirmation as restartAgent(): never touch on-disk state
  // or respawn until the prior lane's death is CONFIRMED.
  const cleared = agentTopologyIsAttach() ? await waitForSupervisorDeath() : await waitForAgentHandleCleared()
  if (!cleared) {
    intentionalStopMode = null
    setAgentStatus('failed', 'stop_unconfirmed', 'new conversation aborted: prior agent did not confirm exit')
    return
  }
  // The lane is DOWN now -- it cannot rewrite either file. Drop the session id
  // (fresh context) and, if the live clear did not confirm, clear the on-disk
  // transcript directly so the empty state is guaranteed before the respawn's
  // boot restore reads it. memory.db is NOT among these paths.
  try { fs.unlinkSync(path.join(DATA_HOME, '.headless-session.json')) } catch { /* already gone */ }
  if (!clearedLive) clearLocalTranscriptOnDisk()
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
    setAgentStatus('failed', 'spawn_failed', `agent spawn attempt threw: ${err.message}`)
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
  // Port precedence, and the order is the whole point (2026-08-04):
  //
  //   1. codexProxyPort -- the port our in-process proxy is ACTUALLY bound
  //      to. Since the default bind became ephemeral, this is the only place
  //      the answer exists; recomputing it from config would report health
  //      for a port nobody is listening on, which is the live-lie class this
  //      function's own header was written against.
  //   2. an EXPLICITLY-configured port -- covers the external/reused proxy,
  //      where the config genuinely is the source of truth.
  //   3. neither -> nothing of ours is up and nothing was configured, so
  //      there is no proxy reality to report. Not an error, just `false`.
  const raw = readAgentConfig().CHATGPT_PROXY_PORT
  const explicit = raw != null && String(raw).trim() !== ''
  let port = codexProxyPort
  if (!port && explicit) {
    const portResult = resolveChatgptProxyPort(raw)
    if (portResult.error) return { running: false }
    port = Number(portResult.port)
  }
  if (!port) return { running: false }
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1500) })
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
// internal design): http-server's own resolveBin is FIXED-locations-only and
// cannot find the bundled/native claude, but THIS resolver already locates
// the exact binary the agent itself spawns (bundled claude-cli in packaged
// builds, PATH claude in dev). The connector-auth child reads the user's
// ~/.claude login from that binary, same as the agent. Returns the path
// string or null. Same injection channel as proxyHealth/spawnInfo above.
const agentControls = {
  stopAgent,
  startAgent,
  restartAgent,
  newConversation,
  proxyHealth,
  // live: what the route proxy sends right now (model/effort), reset to the
  // spawn pick at every stamp -- readers prefer spawn.live over spawn.model.
  spawnInfo: () => (lastSpawnInfo ? { ...lastSpawnInfo, live: liveRoute } : null),
  applyRoute,
  previewRoute,
  channelStatus,
  resolveClaudeBin: () => { const r = resolveClaudeBin(); return r ? r.bin : null },
  // Install-assist info (2026-08-04, the owner "2로 가자"): the wizard's CLI
  // preflight renders install command / plan requirement / license link from
  // this -- data only, the install itself runs via startClaudeCliInstall.
  claudeCliInfo: () => ensureClaudeCli(),
}

// ── boot sequence ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    // TCC folder-permission trigger (the owner directive, 2026-07-05): actually
    // touch Documents/Downloads/Desktop on this very first post-ready tick,
    // BEFORE the onboarding window even opens, so macOS's native TCC prompts
    // for all 3 folders fire at first launch = onboarding entry (not
    // whenever some later code path happens to touch one of them, which
    // would surprise the user mid-flow with no context). Idempotent + safe
    // every boot (see tcc-probe.cjs's own doc comment) -- a denied/failed
    // folder is fail-loud logged here but never throws, so a user who denies
    // one prompt does not lose the rest of app boot.
    // darwin only: TCC is a macOS permission system. On Windows this wrote,
    // read and deleted a probe file in Documents/Downloads/Desktop on every
    // single launch to trigger consent prompts that do not exist -- and on a
    // OneDrive-redirected or offline folder it logged three alarming
    // DENIED/FAILED lines into the user's /logs pane for nothing.
    if (process.platform === 'darwin') {
      const tccResults = probeUserFolders({ homedir: os.homedir(), log })
      log(`tcc-probe summary: ${JSON.stringify(tccResults)}`)
    }

    const { url, server } = await startOnboardingServer(onOnboardingComplete, agentControls)
    onboardingServerUrl = url
    onboardingServer = server
    // Load through /boot so the window acquires the UI session cookie that
    // HTML serving now requires (page-scrape fix, 2026-08-07). /boot 302s
    // to "/" which lands wizard or /memory as before.
    createMainWindow(new URL(bootPathFor('/'), url).href)

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

  // Self-update (0.1.5): deliberately OUTSIDE the try above -- an updater
  // problem must never take the boot path to fatal(). initAutoUpdate never
  // throws by contract (see updater.cjs); win=auto-install, mac=notify-only
  // (unsigned build), dev=off. First check fires ~15s after boot.
  require('./updater.cjs').initAutoUpdate({ app, dialog, shell, log })

  // OS notification on agent replies landing while the window is unfocused
  // (0.1.11). Same placement contract as the updater: outside the boot try,
  // never throws, and a failure only costs the notification, never the chat
  // (see notify-agent-reply.cjs).
  require('./notify-agent-reply.cjs').initReplyNotifications({
    app, Notification: require('electron').Notification, BrowserWindow, DATA_HOME, log,
  })

  // Re-open the window when the app is resident but windowless. TWO callers,
  // one per platform convention: mac's dock click ('activate'), and win/linux's
  // "launch it again" ('second-instance', wired at the top of this file) --
  // which is the ONLY way back in on those platforms now that closing the last
  // window no longer quits (see window-all-closed).
  //
  // REUSE the running server. This used to call startOnboardingServer() again
  // on every dock click: nothing ever closes the previous one, so each click
  // leaked a bound, fully-authenticated listener on a new ephemeral port,
  // re-ran the whole boot prelude (re-seeding config, rewriting .mcp.json,
  // re-rendering the harness), and rotated the askpass token out from under
  // the pages already open. It also re-entered the boot-seed failure path with
  // fatal() as its catch, so a config that went bad after boot killed the app
  // on a dock click.
  reopenMainWindow = () => {
    if (BrowserWindow.getAllWindows().length !== 0) return
    if (onboardingServerUrl) {
      // Through /boot again: the Electron session usually still holds the
      // cookie, but a fresh session partition (or cleared storage) must not
      // reopen onto a 403 — /boot re-issues the same per-launch cookie.
      createMainWindow(new URL(bootPathFor('/'), onboardingServerUrl).href)
      return
    }
    startOnboardingServer(onOnboardingComplete, agentControls)
      .then(({ url, server }) => {
        onboardingServerUrl = url
        onboardingServer = server
        createMainWindow(new URL(bootPathFor('/'), url).href)
      })
      .catch((err) => fatal('reopen: failed to reopen window', err))
  }

  app.on('activate', reopenMainWindow)
})

app.on('window-all-closed', () => {
  // Deliberately EMPTY on every platform (design-0023 P3 #6). This used to
  // app.quit() on non-darwin, which ran before-quit and tore the agent down:
  // closing the window STOPPED THE AGENT on Windows and Linux but not on mac
  // -- the same gesture with two different meanings, and the one platform
  // where an agent is most likely to be left running overnight was the one
  // that killed it. The app supervises a background agent; the window is a
  // control panel for it, not its life support.
  //
  // Getting back in: mac clicks the dock ('activate'); win/linux launch the
  // app again ('second-instance' -> reopenMainWindow). Quitting for real is
  // Cmd/Ctrl-Q or File > Quit from the default menu, which goes through the
  // graceful-shutdown path below and stops the agent on purpose.
  //
  // Still owed (windows-port-scoping.md:261): a tray icon, so a windowless
  // resident app is VISIBLE as one on win/linux. Not P3's scope.
})

// Graceful shutdown (v0.0.4, the owner 2026-07-13 19:33 directive): quit no
// longer kills the agent mid-thought. First quit attempt writes
// DATA_HOME/.shutdown-request; channel.mjs's watcher injects a [SYSTEM]
// turn telling the agent to flush checkpoint/session-notes/memory and touch
// .shutdown-ack; we proceed on ack or on the HARD timeout -- a hung agent
// must never hold quit hostage. (history: docs/HISTORY.md)
// Only attempted when agentChild is non-null: an ADOPTED supervisor (app
// reinstalled over a live agent, the "already running" path) has
// agentChild == null and takes the immediate-kill path exactly as before --
// no regression, just no grace (v1 scope).
const SHUTDOWN_REQUEST_PATH = path.join(DATA_HOME, '.shutdown-request')
const SHUTDOWN_ACK_PATH = path.join(DATA_HOME, '.shutdown-ack')
const SHUTDOWN_GRACE_MS = 75 * 1000
const SHUTDOWN_ACK_POLL_MS = 500

// Which CHANNEL backends can actually write .shutdown-ack. The watcher that
// turns a .shutdown-request into a [SYSTEM] flush turn exists in exactly ONE
// transport, channel.mjs (Discord). channel-local / channel-slack /
// channel-telegram have no such watcher -- but all four write the same
// DATA_HOME/.agent-live heartbeat through channel-runtime's createMarkerStore,
// which is what the no-acker fast path below reads. So on every non-Discord
// backend the fast path saw a healthy "acker", waited the full 75s, and quit
// only after a deadline that felt like a hang (2026-09-08 dev-run repro:
// CHANNEL_BACKEND=local, SIGTERM -> exit measured at 76s). Liveness answers
// "is a channel process alive", not "can it ack"; this set answers the second
// question, and it is the ONLY thing that decides whether the wait is worth
// anything. Add a backend here the moment it grows the watcher, not before.
const ACK_CAPABLE_BACKENDS = new Set(['discord'])

// Boot-time stale-marker sweep (red-team finding #1, 2026-07-13 spark pass):
// a kill -9 / OS crash between the request write and the graceful path's
// cleanup leaves .shutdown-request on disk; a fresh boot's channel.mjs
// watcher would honor it and inject a phantom shutdown turn. Unlink both
// markers before any agent can spawn. channel.mjs additionally ignores
// requests older than 5 minutes -- two layers, either alone suffices.
try { fs.unlinkSync(SHUTDOWN_REQUEST_PATH) } catch { /* absent = normal boot */ }
try { fs.unlinkSync(SHUTDOWN_ACK_PATH) } catch { /* absent = normal boot */ }

async function requestAgentShutdownGrace() {
  // An ADOPTED supervisor (app reinstalled over a live agent) has agentChild
  // == null: we did not spawn it, we take the immediate path, no grace. This
  // check used to live in the before-quit handler; it belongs with the rest of
  // the "can anything ack?" reasoning.
  if (agentChild == null) {
    log('graceful quit: no agent child of ours -- skipping grace window')
    return 'skipped'
  }
  let backend = 'discord'
  try { backend = channelBackendsLib.parseBackends(readAgentConfig())[0] } catch { /* unreadable config: assume the default */ }
  if (!ACK_CAPABLE_BACKENDS.has(backend)) {
    log(`graceful quit: channel backend '${backend}' has no shutdown-ack watcher -- nothing can ack, skipping grace window`)
    return 'skipped'
  }
  // No-acker fast path (0.1.17, the Windows box live receipt 2026-08-18): the ack
  // comes from a [SYSTEM] turn the CHANNEL process injects after seeing
  // .shutdown-request — so when no channel process is alive (lane dead or
  // mid-respawn at quit time), nothing can ever ack and the full grace
  // window is waited for nothing (observed: 75s against a lane that was
  // between respawns). The channel heartbeats DATA_HOME/.agent-live every
  // 60s; stale/absent (same 150s freshness the status poller uses, one
  // missed beat tolerated) ⇒ skip the grace entirely. A healthy IDLE agent
  // still gets the window on purpose: the flush turn (checkpoint/session
  // notes) is the feature, not the wait.
  try {
    const live = JSON.parse(fs.readFileSync(path.join(DATA_HOME, '.agent-live'), 'utf8'))
    if (Date.now() - Date.parse(live.lastHeartbeat) > 150_000) {
      log('graceful quit: liveness marker stale -- no channel process to ack, skipping grace window')
      return 'skipped'
    }
  } catch {
    log('graceful quit: no liveness marker -- no channel process to ack, skipping grace window')
    return 'skipped'
  }
  // Stale ack from a previous cycle must not satisfy this cycle instantly.
  try { fs.unlinkSync(SHUTDOWN_ACK_PATH) } catch { /* absent = fine */ }
  fs.writeFileSync(SHUTDOWN_REQUEST_PATH, JSON.stringify({ requested_at: new Date().toISOString() }) + '\n')
  log(`graceful quit: shutdown-request written, waiting up to ${SHUTDOWN_GRACE_MS / 1000}s for agent ack`)
  const deadline = Date.now() + SHUTDOWN_GRACE_MS
  let acked = false
  while (Date.now() < deadline) {
    if (fs.existsSync(SHUTDOWN_ACK_PATH)) {
      log('graceful quit: agent acked shutdown flush')
      acked = true
      break
    }
    await new Promise((r) => setTimeout(r, SHUTDOWN_ACK_POLL_MS))
  }
  if (!acked) log('graceful quit: grace window expired without ack, proceeding with shutdown')
  // Always clean both markers so the next cycle starts fresh.
  try { fs.unlinkSync(SHUTDOWN_REQUEST_PATH) } catch { /* already gone */ }
  try { fs.unlinkSync(SHUTDOWN_ACK_PATH) } catch { /* already gone */ }
  return acked ? 'acked' : 'expired'
}

// Everything this process owns, torn down in one place so the quit path is a
// list you can read instead of an event chain you have to trace. Each step is
// independently try/caught: a throw in one must not strand the ones after it
// (that is how the codex proxy from ensureCodexProxy and the onboarding
// listener stayed open across quit -- they were the last two statements of a
// handler whose earlier statements could throw). Called EXACTLY once, by the
// quit sequencer, which bounds it.
async function quitTeardown() {
  shuttingDown = true // stop any queued control action from respawning after this cleanup
  const step = (name, fn) => {
    try { fn() } catch (err) { console.error(`[scheherazade/main] quit teardown: ${name} failed (continuing):`, err) }
  }
  step('stopFailurePoll', () => stopFailurePoll())
  step('attach log tail', () => {
    if (attachLogTailTimer) { clearTimeout(attachLogTailTimer); attachLogTailTimer = null }
  })
  step('killAgentSupervisor', () => killAgentSupervisor('SIGTERM'))
  step('killCodexProxy', () => killCodexProxy()) // OUR in-process proxy server only; external/reused proxies are untouchable by construction
  step('killRouteProxy', () => killRouteProxy())
  step('killAllLoginChildren', () => killAllLoginChildren('SIGTERM')) // detached login children must not outlive the app (Codex finding #3)
  step('killOllamaDaemon', () => killOllamaDaemon('SIGTERM')) // OUR managed daemon child only; a reused external daemon is never ours to touch
  await closeOnboardingServer()
  // The window is closed by US, with destroy() rather than close(). MEASURED
  // (2026-09-08 dev repro, with will-quit/quit logging on): after a
  // preventDefault'd before-quit, the re-entered app.quit() emitted before-quit
  // again, was let through -- and then WILL-QUIT NEVER FIRED. Chromium's
  // CloseAllWindows step never completed, so NotifyAndShutdown was never
  // reached and the process sat there indefinitely. That is the actual "app
  // never exits after the grace window" mechanism from the E2E, and no timeout
  // on the ack could ever have fixed it. destroy() skips the close/unload
  // handshake entirely (the renderer is being thrown away anyway; the page
  // holds no unsaved state -- the chat transcript lives on disk), which leaves
  // app.quit() with an empty window list and a straight path to shutdown.
  step('destroy windows', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.destroy() } catch (err) { log(`quit teardown: window destroy failed (${err.message})`) }
    }
  })
}

// close() alone is not enough: the control panel holds keep-alive sockets to
// this listener (status polling, the chat SSE-ish poll), and http.Server.close
// waits for every one of them to go idle -- forever, in practice. Node 18.2+
// closeAllConnections() is the half that actually ends them. Bounded by the
// sequencer regardless; the 2s here is so the common case does not spend it.
function closeOnboardingServer() {
  const server = onboardingServer
  onboardingServer = null
  if (!server) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      log('quit teardown: onboarding server did not close in 2s -- leaving it to process exit')
      resolve()
    }, 2000)
    try {
      server.close(() => { log('quit teardown: onboarding server closed'); done() })
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    } catch (err) {
      log(`quit teardown: onboarding server close failed (${err.message}) -- proceeding`)
      done()
    }
  })
}

// The ONE exit. Preferred route is still a normal app.quit() so that anything
// hooked on 'will-quit'/'quit' runs -- electron-updater's autoInstallOnAppQuit
// installer spawn is exactly that, and force-exiting past it would silently
// break Windows self-update. The teardown has already happened by now, so the
// only thing left for a natural quit to do is end the process; if it has not
// done so in 5s, we stop asking. process.exit() is the last word after that.
function finishQuit(code) {
  quitFinalizing = true
  if (code === 0) {
    try { app.quit() } catch (err) { console.error('[scheherazade/main] finishQuit: app.quit() threw:', err) }
  }
  const forceTimer = setTimeout(() => {
    log(`quit: process still alive ${code === 0 ? '5s after app.quit()' : 'after a forced quit'} -- app.exit(${code})`)
    try { app.exit(code) } catch (err) { console.error('[scheherazade/main] finishQuit: app.exit() threw:', err) }
    const lastResort = setTimeout(() => process.exit(code), 2000)
    if (typeof lastResort.unref === 'function') lastResort.unref()
  }, code === 0 ? 5000 : 0)
  if (typeof forceTimer.unref === 'function') forceTimer.unref()
}

// Set once finishQuit() has handed the process to app.quit(): from that point
// before-quit must get out of the way instead of re-entering the sequencer.
let quitFinalizing = false

const quitSequencer = createQuitSequencer({
  log,
  graceMs: SHUTDOWN_GRACE_MS,
  teardownMs: 10_000,
  waitForAck: requestAgentShutdownGrace,
  teardown: quitTeardown,
  exit: finishQuit,
})

// SIGTERM / SIGINT are now OURS. Until 2026-09-08 main.cjs registered no
// signal handler at all: a `kill` on the app was handled by whatever Chromium
// happened to do with the signal, which on the dev run turned into an
// app.quit() and on the E2E box looked like nothing at all. Both signals now
// enter the same bounded sequence as Cmd-Q, and the sequencer is idempotent,
// so an impatient second SIGTERM joins the run instead of starting a second
// teardown.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received -- starting bounded quit sequence`)
    quitSequencer.run(sig)
  })
}

// Fix C (agent-lifecycle model-divergent review, 2026-07-03): a real
// Cmd+Q / Quit used to leave the agent supervisor running with no cleanup
// at all -- it became an orphan (still alive, still holding the Discord
// token, PIDFILE now stale from this process's perspective since the
// in-memory `agentChild` reference is gone). The kill itself still lives in
// killAgentSupervisor() (synchronous signal-and-continue; SIGTERM is
// fire-and-forget and the supervisor's own `trap ... TERM INT` removes the
// PIDFILE on its side) -- what changed on 2026-09-08 is WHO calls it: the
// quit sequencer's teardown, not this handler.
app.on('before-quit', (event) => {
  // The sequencer owns the quit from here on. Two states:
  //   - finalizing: teardown is DONE and finishQuit() called app.quit() -- let
  //     it through, this is the quit that actually ends the process (and the
  //     one electron-updater's install hook wants to see).
  //   - anything else: defer, and run (or join) the sequence. Its last step
  //     re-enters here with quitFinalizing set.
  if (quitFinalizing) { log('quit: before-quit re-entered after teardown -- letting the quit through'); return }
  event.preventDefault()
  quitSequencer.run('before-quit')
})

// Diagnostics only. The quit sequencer no longer DEPENDS on these firing --
// finishQuit()'s force path covers the case where they do not -- but which of
// them is reached is exactly what you need in the log the next time a quit
// looks slow, and it is the difference between "Chromium is still closing
// windows" and "nothing is happening at all".
app.on('will-quit', () => log('quit: will-quit'))
app.on('quit', (_e, code) => log(`quit: quit event (code=${code})`))

process.on('uncaughtException', (err) => {
  fatal('uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  fatal('unhandledRejection', reason)
})

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
  ensureClaudeCli,
  killAgentSupervisor,
  isPidAlive,
  readPidFromFile,
  pollFailureMarker,
  startFailurePoll,
  stopFailurePoll,
  AGENT_PIDFILE,
  AGENT_FAILFILE,
}
