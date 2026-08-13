// onboarding/routes/onboarding-meta.cjs -- onboarding meta / dependency-bootstrap routes (group 1)
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
    sendJson, readJsonBody, readAgentConfig, writeAgentConfig, readHomeChannelId, ROUTER_WIRED,
    computeAvailableProviders, hasStoredCustomApiKey, PROVIDERS,
    PROVIDERS_REQUIRING_STORED_CREDENTIAL, rejectIfRouterNotWired, readProviderKey, LOGIN_SPECS,
    fs, ensureMcpJsonAgentName, AGENT_NAME, writePersonaPreferences, renderAgentSubstrate,
    LOGIN_PROVIDERS, getLoginStatus, startProviderLogin, cancelProviderLogin, BOOTSTRAP_DEPS,
    getBootstrapStatus, resolveBin, MANAGED_INSTALL_SUPPORTED, MANUAL_INSTALL_PAGES,
    getElectron, startBootstrap,
    fetchClaudeSubscriptionUsage, fetchCodexUsage, fetchOllamaUsage, checkForUpdate,
    extractClaudeModelsFromBin, fetchOllamaCloudCatalog,
    startClaudeCliInstall, getClaudeInstallStatus,
    readAppearance, writeAppearance, AppearanceModel,
    path, DATA_HOME,
  } = staticCtx
  return [
    {
      // Claude CLI install-assist status (2026-08-04, Mino "2로 가자").
      // `present` is the live artifact truth (agentControls.resolveClaudeBin,
      // the SAME resolver the agent spawn uses -- never a cached flag), and
      // the install command/plan/license info rides along so the wizard can
      // render the manual fallback + the honesty notices from one call.
      method: 'GET',
      match: (pathname) => pathname === '/api/onboarding/claude-cli/status',
      handler: async (req, res, callCtx) => {
        const info = callCtx.agentControls && typeof callCtx.agentControls.claudeCliInfo === 'function'
          ? callCtx.agentControls.claudeCliInfo()
          : { status: 'unknown' }
        sendJson(res, 200, {
          ...getClaudeInstallStatus(),
          present: info.status === 'found',
          bin: info.status === 'found' ? info.bin : null,
          installCommand: info.installCommand || null,
          planRequirement: info.planRequirement || null,
          licenseUrl: info.licenseUrl || null,
          docsUrl: info.docsUrl || null,
          managed: process.platform !== 'win32',
        })
        return
      },
    },
    {
      // Prerequisite doctor (2026-08-06, 0.67 clean-mac feedback: agent
      // silently dead with no claude/codex installed -- "실패해도 되는데
      // 원인은 알아야지"). Data only; labels live in copy.js. Two rows:
      //  - claude-cli: the ONE universal runtime dep (every provider mode
      //    executes through the claude CLI -- headless-lane spawns it).
      //    Truth = agentControls.claudeCliInfo(), the SAME resolver the
      //    spawn gate uses, never a cached flag.
      //  - provider credential: readiness of the CONFIGURED provider per
      //    computeAvailableProviders() -- the same single source of truth
      //    the model-swap gate uses (stored credential for claude/
      //    claude-subscription/ollama, codex auth.json artifact for
      //    chatgpt, machine login artifact for claude-cli, saved base URL
      //    for custom). No provider configured -> no row.
      method: 'GET',
      match: (pathname) => pathname === '/api/doctor',
      handler: async (req, res, callCtx) => {
        const info = callCtx.agentControls && typeof callCtx.agentControls.claudeCliInfo === 'function'
          ? callCtx.agentControls.claudeCliInfo()
          : { status: 'unknown' }
        const rows = [{
          id: 'claude-cli',
          required: true,
          present: info.status === 'found',
          detail: info.status === 'found' ? info.bin : null,
          installCommand: info.installCommand || null,
          docsUrl: info.docsUrl || null,
        }]
        const provider = (readAgentConfig().PROVIDER || '').trim() || null
        if (provider) {
          let available = []
          try { available = computeAvailableProviders() } catch (err) { console.error('[doctor] availableProviders failed:', err.message) }
          rows.push({
            id: 'provider-credential',
            provider,
            required: true,
            present: available.includes(provider),
            detail: null,
          })
        }
        sendJson(res, 200, { ok: rows.every((r) => !r.required || r.present), rows })
        return
      },
    },
    {
      // Last turn error (2026-08-04, Mino "클로드도 동작안함" -- a
      // rate-limited/auth-dead lane produced ZERO user-visible signal).
      // Reads the lane's .last-turn-error.json marker; `fresh` = within 10
      // minutes, which is what the nav banner shows. Older errors stay
      // available (fresh:false) for a diagnostics surface later.
      method: 'GET',
      match: (pathname) => pathname === '/api/agent/turn-error',
      handler: async (req, res) => {
        let marker = null
        try {
          marker = JSON.parse(fs.readFileSync(path.join(DATA_HOME, '.last-turn-error.json'), 'utf8'))
        } catch { /* absent/corrupt = no error to report */ }
        if (!marker || !Number(marker.ts)) {
          sendJson(res, 200, { present: false })
          return
        }
        sendJson(res, 200, {
          present: true,
          fresh: Date.now() - Number(marker.ts) < 10 * 60_000,
          ts: Number(marker.ts),
          subtype: String(marker.subtype || 'error').slice(0, 80),
          detail: String(marker.detail || '').slice(0, 600),
        })
        return
      },
    },
    {
      // Start the managed install (darwin only; POST = mutating, so the
      // per-launch X-Onboard-Token gate applies automatically). Fixed argv,
      // detached child, exit-0-plus-artifact success bar -- see
      // startClaudeCliInstall's own header in http-server.cjs.
      method: 'POST',
      match: (pathname) => pathname === '/api/onboarding/claude-cli/install',
      handler: async (req, res, callCtx) => {
        const resolveBinFn = callCtx.agentControls && typeof callCtx.agentControls.resolveClaudeBin === 'function'
          ? () => callCtx.agentControls.resolveClaudeBin()
          : () => null
        startClaudeCliInstall({ resolveClaudeBin: resolveBinFn })
        sendJson(res, 200, getClaudeInstallStatus())
        return
      },
    },
    {
      // Usage gauges (2026-08-04 evening, Mino: "ollama/Codex/Claude 사용량
      // 게이지 ... 이게 킥임"). claude = OAuth usage endpoint (setup-token
      // 403 -> CLI-session fallback); codex = CodexBar's wham/usage source;
      // ollama = undocumented /api/usage probe (shape binds on first
      // real-key receipt). Each fetcher carries its own 60s cache +
      // stale-on-error; see their headers in http-server.cjs.
      // Dynamic Claude model catalog (2026-08-13, Mino: "모델 리스트 하드코딩
      // 말고 ... 다이나믹하게"). Scans the INSTALLED claude CLI binary's own
      // model table (see extractClaudeModelsFromBin in http-server.cjs) --
      // the picker's Claude group follows CLI updates instead of app
      // releases. models:[] on any failure; the UI's static catalog is the
      // fallback, so this route degrading NEVER empties the picker.
      method: 'GET',
      match: (pathname) => pathname === '/api/model-catalog/claude',
      handler: async (req, res, callCtx) => {
        const bin = callCtx && callCtx.agentControls && typeof callCtx.agentControls.resolveClaudeBin === 'function'
          ? callCtx.agentControls.resolveClaudeBin()
          : null
        sendJson(res, 200, { ok: true, source: 'claude-cli-binary', bin: bin || null, models: extractClaudeModelsFromBin(bin) })
        return
      },
    },
    {
      // Ollama half of the dynamic catalog -- live ollama.com /api/tags,
      // 10min cache, [] on failure (static rows stand).
      method: 'GET',
      match: (pathname) => pathname === '/api/model-catalog/ollama',
      handler: async (req, res) => {
        sendJson(res, 200, { ok: true, source: 'ollama.com/api/tags', models: await fetchOllamaCloudCatalog() })
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/usage/claude',
      handler: async (req, res) => {
        // ?force=1 = the Refresh button bypassing the 60s cache (2026-08-05,
        // Mino: manual refresh must actually parse). Page-enter loads omit it.
        sendJson(res, 200, await fetchClaudeSubscriptionUsage({ force: /[?&]force=1(&|$)/.test(String(req.url || '')) }))
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/usage/codex',
      handler: async (req, res) => {
        sendJson(res, 200, await fetchCodexUsage({ force: /[?&]force=1(&|$)/.test(String(req.url || '')) }))
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/usage/ollama',
      handler: async (req, res) => {
        sendJson(res, 200, await fetchOllamaUsage({ force: /[?&]force=1(&|$)/.test(String(req.url || '')) }))
        return
      },
    },
    {
      // Appearance tab (2026-08-05, Mino "어피어런스 탭 만들고 ... CSS들
      // 게이지로 쭉 나열"). GET returns the saved (normalized) config plus
      // the model's option catalog so the page renders choices from ONE
      // source; PUT saves whatever survives normalize() — invalid fields
      // silently fall back to defaults rather than 400ing a slider drag.
      method: 'GET',
      match: (pathname) => pathname === '/api/appearance',
      handler: async (req, res) => {
        sendJson(res, 200, {
          values: readAppearance(),
          defaults: AppearanceModel.DEFAULTS,
          fonts: Object.keys(AppearanceModel.FONTS),
          accents: AppearanceModel.PRESET_ACCENTS,
          bgs: AppearanceModel.PRESET_BGS,
          fgs: AppearanceModel.PRESET_FGS,
          blurLevels: AppearanceModel.BLUR_LEVELS,
        })
        return
      },
    },
    {
      method: 'PUT',
      match: (pathname) => pathname === '/api/appearance',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const values = writeAppearance(body)
        // Apply the blur level LIVE. Fail-soft outside a real Electron main
        // process (dev-serve-ui) or on unsupported platforms.
        // macOS: setVibrancy is runtime-mutable (visualEffectState is not,
        // electron#25513). Electron reuses the existing vibrant view and
        // only calls setMaterial: on a direct swap, which does not reliably
        // force a repaint (native_window_mac.mm; docs: "animating between
        // different types of vibrancy is not supported") — so go through
        // null first, then set the target on the next tick: the
        // remove-and-reattach path lays out the view every time.
        // values.macMaterial: null = blur off (vibrancy stays removed).
        if (process.platform === 'darwin') {
          try {
            const win = getElectron().BrowserWindow.getAllWindows()[0]
            if (win) {
              win.setVibrancy(null)
              if (values.macMaterial) setTimeout(() => { try { win.setVibrancy(values.macMaterial) } catch { /* window died mid-tick */ } }, 0)
            }
          } catch { /* not running under Electron -- config-only save */ }
        }
        // Windows: acrylic has no strength axis — blur is on/off only
        // (soft and strong both mean acrylic). setBackgroundMaterial is
        // runtime-callable on Win11 22H2+; 'none' drops to the solid look.
        if (process.platform === 'win32') {
          try {
            const win = getElectron().BrowserWindow.getAllWindows()[0]
            if (win && typeof win.setBackgroundMaterial === 'function') {
              win.setBackgroundMaterial(values.blur === 'off' ? 'none' : 'acrylic')
            }
          } catch { /* not running under Electron -- config-only save */ }
        }
        sendJson(res, 200, { ok: true, values })
        return
      },
    },
    {
      // Update check (tester request 2026-08-04): notify + download link.
      // In-place auto-update needs a signed mac app -- deferred (Mino 16:16,
      // then re-scoped 16:21 to "check + one-click download page" v1).
      method: 'GET',
      match: (pathname) => pathname === '/api/update/check',
      handler: async (req, res) => {
        // ?force=1 = the Settings "Check now" button bypassing the 6h cache.
        const force = /[?&]force=1(&|$)/.test(String(req.url || ''))
        sendJson(res, 200, await checkForUpdate(force))
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/config',
      handler: async (req, res, callCtx) => {
        // routerWired (PIECE 3, consumer 1): a static capability flag, not
        // proc-state, so it rides along with the rest of the config bag every
        // page here already fetches (see wizard.js/settings.js/memory.js/
        // waiting.js's own `api('/api/config')` calls) rather than needing a
        // new route. camelCase key deliberately, to stay visually distinct from
        // readAgentConfig()'s UPPER_SNAKE_CASE on-disk fields -- this one isn't
        // a stored config value, it's a build-time constant.
        // homeChannelId rides along camelCase like routerWired: it's read from
        // .env (readHomeChannelId), not a readAgentConfig() on-disk field. The
        // memory pane's Discord-open button needs guild+channel as a pair;
        // duplicating the channel id into .agent-config would risk drift.
        // availableProviders rides along camelCase like the two above: computed
        // live (credential store + login artifacts), never a stored field.
        // hasCustomApiKey rides along the same way (custom-provider addition,
        // 2026-07-25): computed live from the safeStorage credential store,
        // boolean-only (see hasStoredCustomApiKey()'s own header for why this
        // is never the key itself).
        sendJson(res, 200, {
          ...readAgentConfig(),
          homeChannelId: readHomeChannelId(),
          routerWired: ROUTER_WIRED,
          availableProviders: computeAvailableProviders(),
          hasCustomApiKey: hasStoredCustomApiKey(),
        })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/onboarding/complete',
      handler: async (req, res, callCtx) => {
        const body = await readJsonBody(req)
        // proxyPort/model added (4-provider-mode wiring, 2026-07-04): chatgpt's
        // optional local-proxy port and ollama's required local model tag --
        // see provider-env.cjs's buildProviderEnv() for how these feed the
        // spawned child's env.
        const { displayName, provider, tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd, proxyPort, model } = body
        if (!displayName || !provider || !tone) {
          sendJson(res, 400, { error: 'displayName, provider, and tone are required' })
          return
        }
        if (!PROVIDERS.includes(provider)) {
          sendJson(res, 400, { error: `unknown provider: ${String(provider).slice(0, 80)}` })
          return
        }
        // 4-provider-mode wiring (2026-07-04): ollama has no user secret, but
        // DOES need a real local model tag -- unlike the credential check below
        // (which chatgpt/ollama are exempt from), this is provider-specific and
        // fails loud here rather than letting main.cjs's buildProviderEnv()
        // discover it missing at spawn time (see that function's 'not_ready'
        // guard for ollama, which this mirrors at the earlier, more useful
        // moment).
        if (provider === 'ollama' && (!model || !String(model).trim())) {
          sendJson(res, 400, { error: 'ollama provider requires a model name' })
          return
        }
        // PIECE 3 enforcement, defense-in-depth: /api/byok/validate above
        // already refuses to validate/store a key for a non-wired provider, so
        // this should be unreachable via the normal wizard flow -- but
        // onboarding-complete is a separate crafted-request surface (a client
        // could, in principle, POST here directly with a provider it never
        // actually validated a key for, though the credential check right below
        // would already catch that case too). Belt-and-suspenders: check
        // ROUTER_WIRED here as well so this endpoint alone is never the gap.
        if (rejectIfRouterNotWired(res, provider)) return
        // Onboarding-complete gate (security review, 2026-07-03; relaxed
        // 2026-07-04, 4-provider-mode wiring): completing setup used to accept
        // ANY provider string with no check that its key was ever actually
        // validated. readProviderKey(provider) can only return non-null if
        // storeProviderKeyVerified() previously succeeded for this exact
        // provider -- the only code path that ever writes
        // CREDENTIALS_DIR/${provider}.key.enc is the /api/byok/validate success
        // branch above -- so this single check proves BOTH "the key was
        // validated" AND "a safeStorage credential exists" at once.
        // ONLY applies to PROVIDERS_REQUIRING_STORED_CREDENTIAL (claude,
        // claude-subscription) -- chatgpt/ollama route to a local proxy/daemon
        // with NO user secret at all (provider-env.cjs), so nothing is ever
        // stored for them via /api/byok/validate; gating their completion on a
        // credential that will never exist would deadlock those two providers
        // forever.
        if (PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes(provider)) {
          let credential
          try {
            credential = readProviderKey(provider)
          } catch (err) {
            console.error('[scheherazade/onboarding] readProviderKey failed during onboarding-complete gate:', err)
            credential = null // a corrupt/unreadable Keychain entry reads as "not validated yet", not a 500
          }
          if (!credential) {
            sendJson(res, 400, { error: `no validated ${provider} key on file -- validate a key in step 1 before completing setup` })
            return
          }
        }
        // Codex finding #6 (login shell-out review 2026-07-07; deferred while the
        // bootstrap step was unbuilt, closed now that it shipped): chatgpt/ollama
        // are exempt from the stored-credential gate above BY DESIGN (their auth
        // lives in the CLIs' own files, never in our Keychain) -- which left this
        // endpoint accepting completion for them with a login that never
        // happened. The wizard already gates Next on login success client-side;
        // this is the server-side check for the crafted-POST surface, same
        // belt-and-suspenders posture as the ROUTER_WIRED check above. The gate
        // is the login flow's own success artifact (LOGIN_SPECS), i.e. the
        // durable half of the "exit 0 AND artifact present" bar -- durable
        // across app restarts where the in-memory login-status singleton is not,
        // and it correctly accepts a user whose codex/ollama login predates this
        // app. For ollama this inherits the identity-key heuristic documented at
        // LOGIN_SPECS (can false-positive on a never-linked key); the gate is
        // deliberately no STRICTER than the login step itself claims to be.
        const loginSpec = LOGIN_SPECS[provider]
        if (loginSpec && !fs.existsSync(loginSpec.artifact())) {
          sendJson(res, 400, { error: `${provider} 로그인이 완료되지 않았습니다 -- 1단계에서 로그인을 마친 뒤 설정을 완료해주세요` })
          return
        }
        ensureMcpJsonAgentName()
        writeAgentConfig({
          AGENT_NAME,
          DISPLAY_NAME: displayName,
          PROVIDER: provider,
          TONE: tone,
          PRIMARY_TASK: primaryTask || '',
          PROACTIVE: proactiveEnabled ? 'yes' : 'no',
          PROACTIVE_WINDOW_START: proactiveEnabled ? proactiveWindowStart || '' : '',
          PROACTIVE_WINDOW_END: proactiveEnabled ? proactiveWindowEnd || '' : '',
          ONBOARDING_STEP: '3',
          // 4-provider-mode wiring (2026-07-04): written unconditionally (as ''
          // when not applicable) so a provider SWITCH away from chatgpt/ollama
          // doesn't leave a stale port/model value silently readable under the
          // new provider -- writeAgentConfig() merges onto existing fields, so
          // an omitted key here would otherwise never get cleared. MODEL in
          // particular: main.cjs's `config.MODEL || 'claude-opus-4-6'` fallback
          // treats '' the same as unset, so clearing it here on a non-ollama
          // provider is safe and prevents a stale ollama model tag (e.g.
          // "llama3.1:8b") from silently surviving a later switch back to
          // claude/claude-subscription and getting sent as an Anthropic model
          // id (this codebase has no re-onboarding/provider-switch UI today --
          // see this task's report -- but onboarding-complete is a POST
          // endpoint any client could call twice, so this is cheap defense
          // regardless).
          CHATGPT_PROXY_PORT: provider === 'chatgpt' && proxyPort ? String(proxyPort).trim() : '',
          MODEL: provider === 'ollama' ? String(model).trim() : '',
          // 'custom' deliberately NOT handled here (custom-provider addition,
          // 2026-07-25): this endpoint has no CUSTOM_BASE_URL/apiKey fields in
          // its body, and there is no onboarding-wizard tab for 'custom' either
          // (see PROVIDERS' own comment above) -- the settings page's POST
          // /api/agent/custom-provider is the only supported way to configure
          // it. A crafted onboarding-complete POST naming provider='custom'
          // still completes (same as claude-subscription/chatgpt/ollama could
          // before their own wizard UI shipped), but spawns nothing until that
          // route runs once -- buildProviderEnv() reports 'not_ready' for a
          // missing CUSTOM_BASE_URL, a quiet skip, not a crash.
        })
        await writePersonaPreferences({ tone, primaryTask, proactiveEnabled, proactiveWindowStart, proactiveWindowEnd })
        renderAgentSubstrate({ displayName, tone, primaryTask })
        sendJson(res, 200, { ok: true })
        return
      },
    },
    // ── login shell-out routes (2026-07-07, see engine above handleApi) ────
    // POST   /api/onboarding/login/:provider        -- start (body: {force?})
    // GET    /api/onboarding/login/:provider/status -- poll (S5_POLL pattern)
    // DELETE /api/onboarding/login/:provider        -- cancel
    {
      // method: null -- GET+POST+DELETE split INSIDE the body (the provider
      // allowlist 400 fires for ANY verb, as before); an unhandled verb (e.g.
      // PUT) writes no response and falls through to handleApi's 404.
      method: null,
      match: (pathname) => pathname.match(/^\/api\/onboarding\/login\/([a-z-]+)(\/status)?$/),
      handler: async (req, res, callCtx, loginMatch) => {
        const provider = loginMatch[1]
        const isStatusPath = Boolean(loginMatch[2])
        // Allowlist FIRST (before even the router gate): only login-capable
        // providers exist here at all. 'claude'/'claude-subscription' are not
        // login-shell-out providers (claude-subscription is an explicit defer,
        // spec v0.2 Q3) -- 400, not 404, to make the contract loud.
        if (!LOGIN_PROVIDERS.includes(provider)) {
          sendJson(res, 400, { error: `unknown login provider: ${String(provider).slice(0, 80)}` })
          return
        }
        if (isStatusPath && req.method === 'GET') {
          sendJson(res, 200, { provider, ...getLoginStatus(provider) })
          return
        }
        if (!isStatusPath && req.method === 'POST') {
          // Same PIECE 3 enforcement as /api/byok/validate: never start a
          // login flow for a provider the build can't select.
          if (rejectIfRouterNotWired(res, provider)) return
          const body = await readJsonBody(req)
          await startProviderLogin(provider, { force: Boolean(body && body.force) })
          sendJson(res, 200, { provider, ...getLoginStatus(provider) })
          return
        }
        if (!isStatusPath && req.method === 'DELETE') {
          cancelProviderLogin(provider)
          sendJson(res, 200, { provider, ...getLoginStatus(provider) })
          return
        }
        // fall through to the 404 below for anything else (e.g. PUT)
      },
    },
    // ── dependency-bootstrap routes (2026-07-07, see bootstrap.cjs) ────────
    // GET  /api/onboarding/bootstrap/status -- all deps: install-flow state
    //      + `present` (resolveBin says a usable binary already exists, e.g.
    //      brew/dev machines -- the wizard skips the download for those).
    // POST /api/onboarding/bootstrap/:dep   -- start download+install.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/onboarding/bootstrap/status',
      handler: async (req, res, callCtx) => {
        const out = {}
        for (const dep of BOOTSTRAP_DEPS) {
          // `managed: false` (win) tells the wizard to render the manual
          // link + re-detect UI instead of the download button -- detection
          // (`present`, via the win-aware resolveBin) works on both platforms.
          out[dep] = {
            ...getBootstrapStatus(dep),
            present: Boolean(resolveBin(dep)),
            managed: MANAGED_INSTALL_SUPPORTED,
            installUrl: MANUAL_INSTALL_PAGES[dep] || null,
          }
        }
        sendJson(res, 200, out)
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname.match(/^\/api\/onboarding\/bootstrap\/([a-z-]+)$/),
      handler: async (req, res, callCtx, bootstrapMatch) => {
        const dep = bootstrapMatch[1]
        if (!BOOTSTRAP_DEPS.includes(dep)) {
          sendJson(res, 400, { error: `unknown bootstrap dependency: ${dep}` })
          return
        }
        if (!MANAGED_INSTALL_SUPPORTED) {
          // Windows v1 = detection-only. Open the official install page -- a
          // FIXED constant, same shape as the fda/open route's pinned pane URL,
          // no request data near it -- and tell the wizard this is a manual flow.
          const installUrl = MANUAL_INSTALL_PAGES[dep]
          if (installUrl) {
            try { getElectron().shell.openExternal(installUrl) } catch (err) {
              console.error(`[scheherazade/onboarding] openExternal(${dep} install page) failed:`, err.message)
            }
          }
          sendJson(res, 200, { dep, state: 'manual', manual: true, installUrl: installUrl || null })
          return
        }
        // Fire-and-poll like the login flow: the response is the CURRENT
        // status, completion arrives via the status route.
        startBootstrap(dep).catch((err) => {
          console.error(`[scheherazade/onboarding] startBootstrap(${dep}) rejected unexpectedly:`, err)
        })
        sendJson(res, 200, { dep, ...getBootstrapStatus(dep) })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
