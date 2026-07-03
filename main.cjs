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
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const {
  createOnboardingServer,
  readAgentConfig,
  readDiscordToken,
  readHomeChannelId,
  toUnpackedPath,
  AGENT_NAME: FIXED_AGENT_NAME,
  DATA_HOME,
} = require('./onboarding/http-server.cjs')
const { setAgentStatus } = require('./onboarding/agent-status.cjs')

// ── stdout/stderr hygiene ───────────────────────────────────────────────
// Electron's main process log is just the terminal it was launched from
// (or Console.app once packaged). No stdio-protocol constraint here like
// channel.mjs's MCP stdio channel has, so plain console.* is fine.
function log(...args) {
  console.log(`[scheherazade/main] ${new Date().toISOString()}`, ...args)
}
function fatal(msg, err) {
  console.error(`[scheherazade/main] FATAL: ${msg}`, err ?? '')
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

// Tracks the currently-live agent child (the persistent run.sh __loop
// supervisor process, not an individual `claude` crash inside it -- those
// are absorbed by run.sh's own restart/backoff ladder and never reach
// here). Guards against double-spawn (PART 1 requirement): both the
// boot-time call and the onOnboardingComplete callback can legitimately
// race/overlap (e.g. a returning already-onboarded user who somehow also
// re-triggers validate), and spawning two supervisors for the same agent
// would fight over the same Discord token/MCP servers.
let agentChild = null

// Spawns the real agent as a long-lived background child -- unlike the old
// demo, this does NOT return a promise that resolves on exit (that would
// block the boot sequence for the agent's entire lifetime). It spawns (or
// logs a clear reason + returns null if it can't) and returns immediately;
// exit/error update onboarding/agent-status.cjs's shared status (read by
// http-server.cjs's GET /api/agent/status) for fail-loud surfacing to the
// UI, in addition to the existing console logging.
function spawnRealAgentChild() {
  if (agentChild) {
    log(`agent spawn skipped: a child is already alive (pid=${agentChild.pid})`)
    return agentChild
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
    setAgentStatus('failed', reason)
    return null
  }

  if (!fs.existsSync(RUN_SH_PATH)) {
    const reason = `internal launcher not found at ${RUN_SH_PATH} (run.sh missing from the packaged/unpacked app -- check build.files/build.asarUnpack)`
    console.error(`[scheherazade/main] BLOCKER: ${reason}`)
    setAgentStatus('failed', reason)
    return null
  }

  let token
  try {
    token = readDiscordToken()
  } catch (err) {
    console.error('[scheherazade/main] readDiscordToken failed, cannot spawn agent:', err)
    setAgentStatus('failed', `readDiscordToken failed: ${err.message}`)
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
  // --dangerously-skip-permissions is intentionally NOT used here, matching
  // run.sh's own header-comment reasoning: .claude/settings.local.json's
  // permissions.allow already scopes this agent's tools without a blanket
  // bypass.
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  agentChild = child
  setAgentStatus('connecting')

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
    setAgentStatus('failed', `spawn error: ${err.message}`)
    agentChild = null
  })
  child.on('exit', (code, signal) => {
    // run.sh's run_loop() only exits on SIGTERM/SIGINT (trapped, clean) or
    // an internal `set -euo pipefail` failure -- there is no intentional
    // "stop the agent" path anywhere in this app yet, so ANY exit here is
    // unexpected and worth surfacing as failed, not silently re-idle.
    log(`agent child exited code=${code} signal=${signal}`)
    setAgentStatus('failed', `agent process exited unexpectedly (code=${code} signal=${signal})`)
    agentChild = null
  })

  return child
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
  spawnRealAgentChild()
}

// ── boot sequence ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
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
    // handler.
    spawnRealAgentChild()
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
