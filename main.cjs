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
const { createOnboardingServer } = require('./onboarding/http-server.cjs')

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

// ── (c) child-process supervision demo ──────────────────────────────────
// Proves the shape that will later supervise:
//   - the `claude` CLI agent child (run.sh's job today, done in-process here)
//   - a provider proxy child
// Both are long-lived daemons in the real product; this demo child is
// deliberately trivial (one line, exits immediately) to isolate "can
// Electron main spawn + capture + reap a child" from "can it manage a
// long-lived one" -- the latter is P1 (backoff/restart logic already
// exists in run.sh and should be ported, not reinvented, from there).
function demoChildProcessSupervision() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', "console.log('child alive')"], {
      // ELECTRON_RUN_AS_NODE lets the bundled Electron binary act as a
      // plain Node runtime for this child -- avoids assuming a system
      // `node` is on PATH once packaged, which the real claude-CLI/proxy
      // children will also need to reckon with (P1 concern, noted below).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      // Fail loud: surface child stderr immediately, don't buffer-and-drop.
      console.error(`[scheherazade/child stderr] ${chunk.toString()}`)
    })

    child.on('error', (err) => reject(err)) // e.g. ENOENT -- never swallow

    child.on('exit', (code, signal) => {
      log(`child-process demo exited code=${code} signal=${signal} stdout=${JSON.stringify(stdout.trim())}`)
      if (code !== 0) {
        reject(new Error(`demo child exited non-zero: code=${code} signal=${signal}`))
        return
      }
      resolve({ code, stdout: stdout.trim() })
    })
  })
}

// ── boot sequence ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    const { url } = await startOnboardingServer()
    createMainWindow(url)

    const { stdout } = await demoChildProcessSupervision()
    log(`child-process supervision OK, captured stdout: ${JSON.stringify(stdout)}`)
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
// 1. Real `claude` CLI agent child:
//    - Replace demoChildProcessSupervision()'s spawn() call with the
//      run.sh restart-loop logic (expect-wrapped `claude --model M --name
//      N`, exponential backoff, trust-prompt handling) ported to JS, OR
//      shell out to run.sh itself and supervise *that* process tree.
//    - run.sh already has KST-aware backoff + PIDFILE/STOPFLAG/LOGFILE
//      conventions (see ~/Desktop/scheherazade/run.sh) -- port those, do
//      not reinvent.
//    - Needs a decision: does Electron main spawn `claude` directly, or
//      spawn run.sh (which itself expect-wraps claude)? Latter reuses more
//      of the existing harness; former gives Electron tighter control
//      over stdout/stdin framing. Not decided in this spike.
//    - BOT-TOKEN SEAM (security review, 2026-07-03): whatever eventually
//      spawns `claude`/channel.mjs here MUST NOT read DISCORD_BOT_TOKEN
//      from a .env file -- it is safeStorage-only now (see
//      onboarding/http-server.cjs's storeDiscordTokenVerified /
//      readDiscordToken). Decrypt it at the moment of spawn with
//      `require('./onboarding/http-server.cjs').readDiscordToken()` and
//      inject the result directly into that child's own `env: {...}`. It
//      must never be written back out to a .env file or any other on-disk
//      config -- that would reintroduce the exact plaintext-at-rest gap
//      this fix closed.
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
