// onboarding/routes/permissions.cjs -- permissions / sudo / FDA / topology / diagnostics routes (group 7)
// (issue #9 PR-2 route grouping).
//
// Route BODIES ONLY, moved verbatim (comments included) from
// onboarding/http-server.cjs's old handleApi if-chain. Helper functions,
// constants, and mutable singletons STAY in http-server.cjs with exactly one
// owner; this file binds what its bodies need ONCE from staticCtx (one
// destructuring statement, below). Per-call values -- agentControls,
// onOnboardingComplete, the live askpassToken getter -- arrive via callCtx
// on every request (see http-server.cjs handleApi). The returned array's
// order IS the dispatch order and preserves the old chain's intra-group
// order exactly.
'use strict'

function createRoutes(staticCtx) {
  const {
    sendJson, readJsonBody, readAgentConfig, writeAgentConfig, fs, path, CREDENTIALS_DIR,
    DATA_HOME, storeProviderKeyVerified, readProviderKey, log, logBuffer, attachTopology,
    getElectron, permissionProbes,
  } = staticCtx
  return [
    // GET /api/logs?since=N — session log tail for the /logs viewer (v0.0.20,
    // the owner 07-16 "로그 터미널 창"). Cursor-polled: `since` = last seq the
    // client holds, response carries entries after it + nextSeq + dropped
    // (ring overflow gap) + the disk sink path for full-history grabs.
    // Read-only GET, localhost-bound server, and lines are token-redacted at
    // append time in log-buffer.cjs — same exposure class as /api/config.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/logs',
      handler: async (req, res, callCtx) => {
        const since = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('since') || 0)
        sendJson(res, 200, logBuffer.getSince(since))
        return
      },
    },
    // ── sudo askpass lane ─────────────────────────────────────────────────
    // Containment contract: the password lives ONLY as a safeStorage blob
    // (Keychain-backed, same vault mechanism as the Discord bot token) and is
    // decrypted exclusively inside GET /api/sudo/password below. It is never
    // logged, never echoed back to the settings page, never written to any
    // config/env file, and never enters a chat/transcript surface. `sudo -A`
    // works only while the app runs (the askpass helper fetches from this
    // server) -- that is the honest boundary of "앱에 컨테이닝", not a bug.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/sudo/config',
      handler: async (req, res, callCtx) => {
        sendJson(res, 200, {
          enabled: readAgentConfig().SUDO_ENABLED === 'yes',
          hasPassword: fs.existsSync(path.join(CREDENTIALS_DIR, 'sudo-pass.key.enc')),
        })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/sudo/config',
      handler: async (req, res, callCtx) => {
        const body = await readJsonBody(req)
        const enable = body.enabled === true
        const password = typeof body.password === 'string' ? body.password : ''
        const hasStored = fs.existsSync(path.join(CREDENTIALS_DIR, 'sudo-pass.key.enc'))
        if (password) {
          try {
            storeProviderKeyVerified('sudo-pass', password)
          } catch (err) {
            // Fail-loud WITHOUT the value: the error message from the store path
            // never contains the password (safeStorage availability/round-trip
            // wording only).
            sendJson(res, 500, { error: `비밀번호 저장 실패: ${err.message}` })
            return
          }
        } else if (enable && !hasStored) {
          sendJson(res, 400, { error: 'sudo를 켜려면 비밀번호가 필요합니다' })
          return
        }
        writeAgentConfig({ SUDO_ENABLED: enable ? 'yes' : 'no' })
        sendJson(res, 200, { ok: true })
        return
      },
    },
    // The askpass fetch itself. Double gate: per-boot random token (written
    // 0600 to DATA_HOME/.sudo-askpass-endpoint.json at listen time) AND the
    // config toggle. Plain text response -- this IS the `sudo -A` stdout.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/sudo/password',
      handler: async (req, res, callCtx) => {
        // LIVE read via callCtx: askpassToken is a mutable `let` in http-server.cjs,
        // WRITTEN in createOnboardingServer's listen() callback AFTER this route
        // table is built -- a destructured copy would freeze the pre-listen null
        // forever (design §5 risk 3). The body below is verbatim.
        const askpassToken = callCtx.getAskpassToken()
        if (!askpassToken || req.headers['x-askpass-token'] !== askpassToken) {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('forbidden')
          return
        }
        if (readAgentConfig().SUDO_ENABLED !== 'yes') {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('sudo disabled in settings')
          return
        }
        const password = readProviderKey('sudo-pass')
        if (!password) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('no password stored')
          return
        }
        // Audit line: the EVENT is logged, the value never is.
        log('sudo askpass consulted (password served to askpass helper; value not logged)')
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(password)
        return
      },
    },
    // ── attach topology (0.1.0 prep) ─────────────────────────────────────────
    // GET: one honest snapshot -- configured topology (intent) + live tmux
    // session state (reality) + the exact bootstrap line for the user's
    // terminal. attachSessionState() never spawns a server (allowlist-enforced,
    // see attach-topology.cjs header), so polling this is side-effect-free.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/topology',
      handler: async (req, res, callCtx) => {
        const state = attachTopology.attachSessionState()
        sendJson(res, 200, {
          topology: readAgentConfig().AGENT_TOPOLOGY || 'spawn',
          tmuxPresent: state.tmuxPresent,
          sessionPresent: state.sessionPresent,
          paneDead: state.paneDead,
          bootstrapCmd: attachTopology.bootstrapCommand(DATA_HOME),
          // Resolved binary, not bare `tmux`: on app-only machines the user's
          // terminal has no PATH tmux -- the paste line must name the
          // app-shipped copy (v0.0.35).
          attachCmd: `"${attachTopology.resolveTmuxBin() || 'tmux'}" -L ${attachTopology.ATTACH_SOCKET} attach -t ${attachTopology.ATTACH_SESSION}`,
        })
        return
      },
    },
    // POST: write intent only. Deliberately does NOT stop/restart anything --
    // a topology flip while an agent runs takes effect at the next
    // start/restart, and the UI says exactly that (no hidden lifecycle).
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/topology',
      handler: async (req, res, callCtx) => {
        const { topology } = await readJsonBody(req)
        if (topology !== 'spawn' && topology !== 'attach') {
          sendJson(res, 400, { error: `invalid topology: ${String(topology).slice(0, 80)}` })
          return
        }
        writeAgentConfig({ AGENT_TOPOLOGY: topology })
        sendJson(res, 200, { ok: true })
        return
      },
    },
    // ── Full Disk Access onboarding routes (2026-07-07) ────────────────────
    // No official FDA-status API exists (Apple DTS: "attempt the operation
    // and handle the error"), so `granted` is a HEURISTIC probe: read a
    // TCC-protected file. TimeMachine.plist chosen over TCC.db (the latter
    // false-negatives on 700-permission systems). Grant takes effect only
    // after APP RELAUNCH (TCC caches at process launch) -- hence /relaunch.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/onboarding/fda/status',
      handler: async (req, res, callCtx) => {
        let granted = false
        try {
          fs.readFileSync('/Library/Preferences/com.apple.TimeMachine.plist')
          granted = true
        } catch {
          granted = false
        }
        sendJson(res, 200, { granted, heuristic: true })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/onboarding/fda/open',
      handler: async (req, res, callCtx) => {
        const { shell } = getElectron()
        // Legacy pane URL -- still honored on macOS 14/15 per community docs;
        // Sequoia anchors are flaky, so fire twice with a beat between (the
        // documented workaround), harmless when the first one lands.
        const paneUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
        await shell.openExternal(paneUrl)
        setTimeout(() => {
          shell.openExternal(paneUrl).catch(() => {})
        }, 1000)
        sendJson(res, 200, { ok: true })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/onboarding/fda/relaunch',
      handler: async (req, res, callCtx) => {
        const { app } = getElectron()
        sendJson(res, 200, { ok: true })
        // Give the response a beat to flush before the process dies.
        setTimeout(() => {
          app.relaunch()
          app.exit(0)
        }, 300)
        return
      },
    },
    // ── Permission checklist routes (P0, 2026-07-15) ────────────────────────
    // Generalizes the FDA lane above to the full wall map the agent can hit
    // (docs/permission-visibility-design.md; probes live in
    // permission-probes.cjs with the three macOS facts documented there).
    // Status GET also drops a snapshot into DATA_HOME/permission-status.json
    // so the agent side can read "what this machine can't do" at session
    // start instead of rediscovering walls one crash at a time — P1's hook
    // covers the moment of impact, this file covers the map.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/permissions/status',
      handler: async (req, res, callCtx) => {
        const { systemPreferences } = getElectron()
        const { execFileSync } = require('node:child_process')
        // sudoState feeds probeSudo's tier 2 (2026-08-19): the askpass lane
        // being armed IS a form of "admin commands work" — the row said
        // Denied on machines where onboarding had already stored the key.
        const sudoState = {
          enabled: readAgentConfig().SUDO_ENABLED === 'yes',
          hasStored: fs.existsSync(path.join(CREDENTIALS_DIR, 'sudo-pass.key.enc')),
        }
        const rows = permissionProbes.probeAll({ readFileSync: fs.readFileSync, execFileSync, systemPreferences, sudoState })
        try {
          fs.writeFileSync(
            path.join(DATA_HOME, 'permission-status.json'),
            JSON.stringify({ checkedAt: new Date().toISOString(), rows }, null, 2)
          )
        } catch (err) {
          // Snapshot write is best-effort; the UI answer must not die with it.
          log(`permission-status.json write failed: ${err.message}`)
        }
        sendJson(res, 200, { rows, deepLinks: permissionProbes.DEEP_LINKS })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/permissions/open',
      handler: async (req, res, callCtx) => {
        const { cls } = await readJsonBody(req)
        const paneUrl = permissionProbes.DEEP_LINKS[cls]
        if (!paneUrl) {
          sendJson(res, 400, { error: `no settings pane for class "${String(cls).slice(0, 80)}" (SIP/sudo have no pane — that is the point)` })
          return
        }
        const { shell } = getElectron()
        // Sequoia anchors are flaky — double-fire with a beat, same workaround
        // as the FDA route above.
        await shell.openExternal(paneUrl)
        setTimeout(() => {
          shell.openExternal(paneUrl).catch(() => {})
        }, 1000)
        sendJson(res, 200, { ok: true })
        return
      },
    },
    // Sudo verify is POST + explicit because it actually RUNS `sudo -k -A
    // true` through the askpass helper — a wrong stored password writes a
    // PAM auth failure to the system log, so this fires on a user click
    // only, never on a status poll (same contract as probe-automation).
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/permissions/probe-sudo',
      handler: async (req, res, callCtx) => {
        const { execFileSync } = require('node:child_process')
        sendJson(res, 200, {
          row: permissionProbes.probeSudoVerified({
            execFileSync,
            askpassPath: path.join(DATA_HOME, 'sudo-askpass.sh'),
          }),
        })
        return
      },
    },
    // Automation probe is POST + explicit because it SENDS an Apple event and
    // may pop the macOS consent dialog — allowed on a user click (the dialog
    // is how the grant happens), never on a status poll.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/permissions/probe-automation',
      handler: async (req, res, callCtx) => {
        const { target } = await readJsonBody(req)
        const { execFileSync } = require('node:child_process')
        sendJson(res, 200, { row: permissionProbes.probeAutomation(target, { execFileSync }) })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
