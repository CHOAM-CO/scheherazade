// main.cjs — Electron main process, P0 packaging-shell spike.
//
// GOAL of this file: retire the #1 project risk (can we ship a Mac-native
// .app/.dmg that supervises child processes and serves a localhost
// onboarding page?) as early as possible. This is a stub, not the product.
//
// CommonJS on purpose even though the rest of the repo (channel.mjs) is
// ESM ("type": "module" in package.json) -- Electron's main-process ESM
// support is still version-sensitive/experimental in places, and a `.cjs`
// extension always forces CommonJS regardless of the package.json "type"
// field. For a risk-retiring spike, the boring/safe choice wins.
//
// Three things this file proves, each isolated in its own function so a
// P1 implementation can lift them out wholesale:
//   1. startOnboardingServer() -- plain node:http server on an ephemeral
//      port, serving a placeholder onboarding page. P1: replace the HTML
//      string with the real onboarding wizard (see docs/ARCHITECTURE.md
//      wiring notes at the bottom of this file).
//   2. createMainWindow(url) -- BrowserWindow that loads that localhost URL.
//   3. demoChildProcessSupervision() -- spawns a trivial child, captures
//      stdout, logs its exit code. P1: this is the exact shape that will
//      later supervise (a) the `claude` CLI agent process and (b) a
//      provider proxy process -- see wiring notes at bottom.
//
// FAIL LOUD: no empty catches anywhere below. Every error path either
// rethrows, logs to stderr and exits non-zero, or is a fatal dialog.

'use strict'

const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const { spawn } = require('node:child_process')

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
// Ephemeral port (0 = OS picks a free one) -- P1 will likely pin this or
// keep it ephemeral-and-discovered, undecided; either way the pattern
// (listen, read the OS-assigned port off the server object, hand that URL
// to the BrowserWindow) carries forward unchanged.
const PLACEHOLDER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Scheherazade Onboarding (placeholder)</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; background: #111; color: #eee;
             display: flex; flex-direction: column; align-items: center; justify-content: center;
             height: 100vh; margin: 0; gap: 1rem; }
      button { font-size: 1rem; padding: 0.6rem 1.4rem; border-radius: 8px; border: none;
               background: #5b8dee; color: white; cursor: pointer; }
      button:hover { background: #4877d6; }
      p { color: #999; font-size: 0.85rem; max-width: 32rem; text-align: center; }
    </style>
  </head>
  <body>
    <h1>Scheherazade onboarding</h1>
    <p>P0 spike placeholder. Served from an in-process localhost HTTP server,
       loaded into a real BrowserWindow. The real onboarding wizard (API key
       entry, provider choice, first-run agent bootstrap) replaces this page
       in P1 -- see main.cjs wiring notes.</p>
    <button id="next">Next</button>
    <p id="status">child-process demo runs in the terminal this app was launched from (or Console.app once packaged) -- check main-process logs.</p>
    <script>
      document.getElementById('next').addEventListener('click', () => {
        document.getElementById('status').textContent = 'Next clicked (placeholder -- no step 2 yet).'
      })
    </script>
  </body>
</html>`

function startOnboardingServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PLACEHOLDER_HTML)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    })

    server.on('error', (err) => reject(err)) // fail loud, no swallow

    // port 0 = OS-assigned ephemeral port
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const url = `http://127.0.0.1:${port}/`
      log(`onboarding server listening on ${url}`)
      resolve({ server, url })
    })
  })
}

// ── (a) BrowserWindow ────────────────────────────────────────────────────
function createMainWindow(url) {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'Scheherazade',
    webPreferences: {
      // No preload / no Node integration in the renderer -- the placeholder
      // page needs zero Node/Electron APIs. P1's real onboarding wizard
      // will need a preload.js + contextBridge for e.g. "save API key"
      // IPC calls back to main; that preload does not exist yet (see
      // wiring notes at bottom of this file).
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
// 3. Real onboarding wizard replacing PLACEHOLDER_HTML:
//    - Swap the inline HTML string in startOnboardingServer() for either
//      (a) static files under a new onboarding/ directory served via
//      node:http + a tiny static-file router, or (b) a proper bundler
//      output (Vite/esbuild) if the wizard grows interactive state.
//    - Needs a preload.js + contextBridge (currently absent -- see
//      createMainWindow()'s webPreferences comment) once the wizard needs
//      to call back into main (e.g. "save API key to keychain", "launch
//      setup.sh", "write .env").
//    - setup.sh already asks for the exact fields (Discord token, home
//      channel ID, agent name) an onboarding wizard would collect --
//      the wizard's job is to become setup.sh's GUI front-end, not to
//      duplicate its logic.
