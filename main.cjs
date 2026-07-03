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
  AGENT_NAME: FIXED_AGENT_NAME,
  DATA_HOME,
} = require('./onboarding/http-server.cjs')

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
// BLOCKER (2026-07-03, packaging-bugfix task -- see resolveClaudeBin()
// just below): the `claude` CLI is NOT bundled anywhere in this fork.
// Confirmed by direct inspection: no `@anthropic-ai/claude-code` entry in
// package.json dependencies, no such package under node_modules/, no
// vendored binary anywhere in the repo tree (`find . -iname '*claude*'`
// under the repo root turns up nothing but this file's own comments and
// CLAUDE.md). It exists ONLY as whatever the user's machine separately
// installed globally (setup.sh's `npm install -g @anthropic-ai/claude-code`
// path, or the native installer -- both land a real platform binary
// OUTSIDE this repo, e.g. this dev machine's ~/.local/bin/claude, a Mach-O
// executable). That means: on a clean end-user Mac with nothing installed
// beyond the Scheherazade.app itself, resolveClaudeBin() below returns
// null and the real agent CANNOT be spawned -- not a bug in this file, a
// missing product decision (bundle @anthropic-ai/claude-code via
// extraResources/asarUnpack -- real network fetch of a native binary per
// platform at npm-install time, real weight added to the .app -- vs.
// require users to have `claude` pre-installed). Per instruction, this file
// does NOT fabricate a fake bundled path to paper over that; it fails loud
// and skips the spawn (app + onboarding UI stay usable either way) with a
// clear actionable log line pointing at this comment.
function resolveClaudeBin() {
  if (app.isPackaged) {
    // Where a real bundled copy would land (electron-builder extraResources
    // target `claude-cli`) -- always absent today, see BLOCKER above.
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

// Spawns the real agent as a long-lived background child -- unlike the old
// demo, this does NOT return a promise that resolves on exit (that would
// block the boot sequence for the agent's entire lifetime). It spawns (or
// logs a clear reason + returns null if it can't) and returns immediately;
// exit/error are handled by listeners for logging only. No restart/backoff
// loop yet -- porting run.sh's exponential-backoff ladder (5/10/20/40/120s,
// KST-date-rollover reset) is still separate, open P1 work, not fabricated
// here.
function spawnRealAgentChild() {
  const config = readAgentConfig()
  if (config.ONBOARDING_COMPLETE !== '1') {
    log('agent spawn skipped: onboarding not complete yet (no validated provider/Discord token on file)')
    return null
  }

  const resolved = resolveClaudeBin()
  if (!resolved) {
    console.error(
      '[scheherazade/main] BLOCKER: claude CLI not found -- not bundled in this build ' +
        '(no extraResources/claude-cli, no @anthropic-ai/claude-code dependency) and not on ' +
        'system PATH. The real agent cannot be spawned. See the resolveClaudeBin() comment ' +
        'above for the bundling decision this needs. Onboarding UI stays usable.'
    )
    return null
  }

  let token
  try {
    token = readDiscordToken()
  } catch (err) {
    console.error('[scheherazade/main] readDiscordToken failed, cannot spawn agent:', err)
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
  const model = config.MODEL || 'claude-opus-4-6' // same default as agent-portable's run.sh

  log(`spawning real agent: bin=${resolved.bin} (${resolved.source}) model=${model} name=${agentName} cwd=${DATA_HOME}`)

  // BOT-TOKEN SEAM (security review, 2026-07-03): decrypted here, at the
  // moment of spawn, and injected directly into this child's own env --
  // never written back to any on-disk config. The `claude` CLI inherits
  // DISCORD_BOT_TOKEN/HOME_CHANNEL_ID/AGENT_NAME, and inherits them again
  // down to channel.mjs when the CLI spawns it as an MCP server per
  // .mcp.json (see onboarding/http-server.cjs's ensureMcpJsonAgentName --
  // that file's generated .mcp.json deliberately carries no token field).
  // --dangerously-skip-permissions is intentionally NOT used here, matching
  // run.sh's own reasoning (see agent-portable/run.sh's header comment):
  // .claude/settings.local.json's permissions.allow already scopes this
  // agent's tools without a blanket bypass.
  const child = spawn(resolved.bin, ['--model', model, '--name', agentName], {
    cwd: DATA_HOME,
    env: { ...process.env, DISCORD_BOT_TOKEN: token, HOME_CHANNEL_ID: homeChannelId, AGENT_NAME: agentName },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => log(`[agent stdout] ${chunk.toString().trim()}`))
  child.stderr.on('data', (chunk) => {
    // Fail loud: surface child stderr immediately, don't buffer-and-drop.
    console.error(`[scheherazade/agent stderr] ${chunk.toString()}`)
  })
  child.on('error', (err) => console.error('[scheherazade/main] agent child spawn error:', err)) // e.g. ENOENT -- never swallow
  child.on('exit', (code, signal) => {
    log(`agent child exited code=${code} signal=${signal} -- no restart/backoff loop wired yet (separate P1)`)
  })

  return child
}

// ── boot sequence ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    const { url } = await startOnboardingServer()
    createMainWindow(url)

    // Long-lived; deliberately not awaited to exit -- see
    // spawnRealAgentChild()'s own comment. Returns null (onboarding
    // incomplete, no token yet, or claude CLI not found) without throwing;
    // only a real error inside the function body should reach fatal().
    spawnRealAgentChild()
  } catch (err) {
    fatal('boot sequence failed', err)
  }

  app.on('activate', () => {
    // macOS convention: clicking the dock icon with no windows open
    // re-shows one. Not exercised by this headless spike, kept for
    // correctness since electron-builder targets mac.
    if (BrowserWindow.getAllWindows().length === 0) {
      startOnboardingServer()
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
// 1. Real `claude` CLI agent child -- DONE this revision, MODULO an open
//    blocker (see resolveClaudeBin()'s comment above for the full
//    writeup):
//    - run.sh is DEAD (Mino directive, 2026-07-03) -- its CLI/bash restart
//      loop is not shelled out to. spawnRealAgentChild() above spawns
//      `claude` directly. Its exponential-backoff/restart ladder (KST-aware
//      reset, 5/10/20/40/120s) is NOT ported yet -- still separate, open P1
//      work, deliberately not fabricated here since a single spawn +
//      exit-logging was the scope of this revision's bugfix task.
//    - BOT-TOKEN SEAM (security review, 2026-07-03) -- WIRED: readDiscordToken()
//      is decrypted at the moment of spawn and injected directly into the
//      child's own `env: {...}`, alongside readHomeChannelId(). Never
//      written back to any on-disk config. See spawnRealAgentChild()'s own
//      comment.
//    - BLOCKER: the `claude` CLI itself is not bundled in this fork (no
//      @anthropic-ai/claude-code dependency, no vendored binary --
//      confirmed by direct inspection). resolveClaudeBin() only finds it
//      via a future extraResources path (not populated) or the system
//      PATH (works today only because this dev machine has a global
//      install; NOT guaranteed on a clean end-user Mac). This is a
//      packaging decision for the product owner, not something this file
//      can resolve on its own -- see the packaging-bugfix task report.
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
