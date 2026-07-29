// onboarding/routes/agent-lifecycle.cjs -- agent lifecycle & runtime-status routes (group 5)
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
    sendJson, readJsonBody, computeAgentStatus, fs, path, DATA_HOME, contextCapForModel,
    MODEL_ID_PATTERN, PROVIDERS, rejectIfRouterNotWired, computeAvailableProviders,
    readAgentConfig, writeAgentConfig, clearMuteStrikes, readMuteStrikes, MUTE_STRIKE_THRESHOLD,
    EFFORT_LEVELS,
  } = staticCtx
  return [
    // ── chatgpt proxy live receipt ("셸은 현실" principle) ────────────────────
    // Surfaces what the proxy's own /health reports RIGHT NOW rather than a
    // config-inferred guess (see main.cjs's ensureCodexProxy for why that gap
    // is live, not theoretical -- history: docs/HISTORY.md). Delegates to
    // main.cjs (it owns the proxy port/lifecycle); running:false when not
    // wired or nothing answers.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/proxy/health',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        if (!agentControls || typeof agentControls.proxyHealth !== 'function') {
          sendJson(res, 200, { running: false })
          return
        }
        sendJson(res, 200, await agentControls.proxyHealth())
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/agent/status',
      handler: async (req, res, callCtx) => {
        sendJson(res, 200, computeAgentStatus())
        return
      },
    },
    // GET /api/context-status — context-occupancy gauge. Read side of
    // hooks/context-gauge.mjs's DATA_HOME/context-status.json snapshot
    // (written atomically on every Stop + SessionStart). Attaches the
    // model→cap table here, NOT in the hook, so cap knowledge updates ship
    // with the app instead of being frozen into old snapshots. Read-only GET,
    // no secrets in the payload.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/context-status',
      handler: async (req, res, callCtx) => {
        let snap = null
        try {
          snap = JSON.parse(fs.readFileSync(path.join(DATA_HOME, 'context-status.json'), 'utf8'))
        } catch { /* absent or torn-mid-write (rename makes torn ~impossible) */ }
        if (!snap || typeof snap.contextTokens !== 'number') {
          sendJson(res, 200, { available: false })
          return
        }
        const { cap, capSource } = contextCapForModel(snap.model)
        sendJson(res, 200, {
          available: true,
          ts: snap.ts,
          model: snap.model,
          contextTokens: snap.contextTokens,
          usage: snap.usage || null,
          cap,
          capSource,
          pct: cap ? Math.min(100, Math.round((snap.contextTokens / cap) * 100)) : null,
          // Ghost-snapshot marker (2026-07-28): true when this number belongs
          // to a PREVIOUS session, kept only so the gauge is not blank before
          // the new session's first turn. The UI must say so.
          carriedOver: snap.carriedOver === true,
        })
        return
      },
    },
    // Spawn-time reality (IA v0.0.9): what the CURRENT/LAST child was born
    // with, recorded at the spawn moment in main.cjs -- the shell's model/
    // effort display and settings' apply-state line read this instead of
    // config, so a changed dropdown can never masquerade as a running state.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/agent/spawn-info',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        const spawn = agentControls && typeof agentControls.spawnInfo === 'function' ? agentControls.spawnInfo() : null
        sendJson(res, 200, { spawn })
        return
      },
    },
    // ── control panel: agent lifecycle (2026-07-09) ─────────────────────────
    // #5 on/off + #4 restart/model-swap. Delegate to main.cjs's serialized
    // lifecycle fns (passed in as agentControls; the pkill-race + intentional-
    // stop handling lives there, see stopAgentAwaited/intentionalStopMode). All
    // are token-gated like every /api route (X-Onboard-Token check above).
    //
    // Fire-and-forget + 202, matching the onboarding-complete pattern above:
    // stop/restart await run.sh stop (up to ~15s worst case), so the client must
    // NOT block on that -- it fires the action and polls GET /api/agent/status
    // (the same poll the Step 5 screen already uses) until state settles
    // (stopped for #5-off, connecting->live for start/restart). Errors surface
    // via agent-status ('failed') or the logged .catch, never a hung request.
    // Overlapping control actions are prevented by the UI (buttons disabled while
    // an action is in flight), so these are NOT serialized/busy-guarded here
    // (Mino 2026-07-09, YAGNI) -- the load-bearing safety is main.cjs awaiting
    // CONFIRMED process death before any respawn.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/agent/stop',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        if (!agentControls || typeof agentControls.stopAgent !== 'function') {
          sendJson(res, 500, { error: 'agent controls not wired' })
          return
        }
        agentControls.stopAgent().catch((err) => console.error('[scheherazade/onboarding] stopAgent threw:', err))
        sendJson(res, 202, { ok: true })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/agent/start',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        if (!agentControls || typeof agentControls.startAgent !== 'function') {
          sendJson(res, 500, { error: 'agent controls not wired' })
          return
        }
        agentControls.startAgent().catch((err) => console.error('[scheherazade/onboarding] startAgent threw:', err))
        sendJson(res, 202, { ok: true })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/agent/restart',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        if (!agentControls || typeof agentControls.restartAgent !== 'function') {
          sendJson(res, 500, { error: 'agent controls not wired' })
          return
        }
        agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] restartAgent threw:', err))
        sendJson(res, 202, { ok: true })
        return
      },
    },
    // POST /api/agent/model {model, provider?} -- #4 model swap: write MODEL
    // (and, when the model lives under a different provider, PROVIDER) to
    // config then restart so the fresh spawn picks it up. Pattern-validated as
    // defense (the value becomes `--model <MODEL>` argv). The provider field
    // is the promised SERVER-SIDE gating half (07-13 multi-provider unlock):
    // allowlist + rejectIfRouterNotWired + computeAvailableProviders, so a
    // crafted request can't switch to a provider with no usable credential.
    // The X-Onboard-Token gate + 127.0.0.1-only bind already bound WHO can
    // reach this route.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/agent/model',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        if (!agentControls || typeof agentControls.restartAgent !== 'function') {
          sendJson(res, 500, { error: 'agent controls not wired' })
          return
        }
        const { model, provider } = await readJsonBody(req)
        const value = typeof model === 'string' ? model.trim() : ''
        if (!value || value.length > 200 || !MODEL_ID_PATTERN.test(value)) {
          sendJson(res, 400, { error: 'invalid model id' })
          return
        }
        let providerValue = null
        if (provider !== undefined && provider !== null && provider !== '') {
          providerValue = typeof provider === 'string' ? provider.trim() : ''
          if (!PROVIDERS.includes(providerValue)) {
            sendJson(res, 400, { error: `invalid provider: ${String(providerValue).slice(0, 80)}` })
            return
          }
          if (rejectIfRouterNotWired(res, providerValue)) return
          if (!computeAvailableProviders().includes(providerValue)) {
            sendJson(res, 409, { error: `provider not authenticated: ${providerValue}` })
            return
          }
        }
        // Record where we came FROM before overwriting it -- this is the only
        // thing that makes the mute-revert offer possible (see clearMuteStrikes'
        // header and hooks/stop-reply-guard.mjs). Read the live config first: the
        // pre-swap MODEL/PROVIDER is about to be clobbered by writeAgentConfig.
        const prior = readAgentConfig()
        const previousFields = {}
        if (prior.MODEL && prior.MODEL !== value) {
          previousFields.PREVIOUS_MODEL = prior.MODEL
          previousFields.PREVIOUS_PROVIDER = prior.PROVIDER || ''
        }
        writeAgentConfig({
          ...previousFields,
          ...(providerValue ? { MODEL: value, PROVIDER: providerValue } : { MODEL: value }),
        })
        // A strike ledger is about ONE model. Swapping makes every prior strike a
        // statement about a model that is no longer running -- carrying them
        // forward would fire a revert prompt against the innocent new model.
        clearMuteStrikes()
        agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] restartAgent (model swap) threw:', err))
        sendJson(res, 202, { ok: true, model: value, ...(providerValue ? { provider: providerValue } : {}) })
        return
      },
    },
    // GET /api/agent/mute-status -- is the running model failing to SPEAK?
    //
    // Feeds the UI's revert offer. Source of truth is the strike ledger written
    // by hooks/stop-reply-guard.mjs (see its header for why this is a post-swap
    // convicter and not a pre-swap probe: a probe against the known-mute model
    // could only ever have manufactured false acquittals -- history:
    // docs/HISTORY.md). A strike = the guard told the agent to send and it
    // still didn't, after a retry.
    //
    // Read-only and fail-open: a missing/corrupt ledger reports "no strikes"
    // rather than 500ing the settings page.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/agent/mute-status',
      handler: async (req, res, callCtx) => {
        const cfg = readAgentConfig()
        const ledger = readMuteStrikes()
        // Only offer a revert to a model the ledger is actually about. If the
        // ledger names a different model than the one running, it's stale -- and a
        // stale ledger must not push the user to revert a model that never failed.
        const stale = Boolean(ledger.model && cfg.MODEL && ledger.model !== cfg.MODEL)
        sendJson(res, 200, {
          strikes: stale ? 0 : (ledger.strikes || 0),
          threshold: MUTE_STRIKE_THRESHOLD,
          model: cfg.MODEL || '',
          previousModel: cfg.PREVIOUS_MODEL || '',
          previousProvider: cfg.PREVIOUS_PROVIDER || '',
        })
        return
      },
    },
    // POST /api/agent/effort {effort} -- Mino 07-13 click-test item 2, same
    // shape as the model route: write EFFORT_LEVEL then restart. main.cjs
    // forwards it into the spawn env only when set; run.sh:56 defaults 'high'.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/agent/effort',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        if (!agentControls || typeof agentControls.restartAgent !== 'function') {
          sendJson(res, 500, { error: 'agent controls not wired' })
          return
        }
        const { effort } = await readJsonBody(req)
        const effortValue = typeof effort === 'string' ? effort.trim() : ''
        if (!EFFORT_LEVELS.includes(effortValue)) {
          sendJson(res, 400, { error: `invalid effort level (expected one of: ${EFFORT_LEVELS.join(', ')})` })
          return
        }
        writeAgentConfig({ EFFORT_LEVEL: effortValue })
        agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] restartAgent (effort swap) threw:', err))
        sendJson(res, 202, { ok: true, effort: effortValue })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
