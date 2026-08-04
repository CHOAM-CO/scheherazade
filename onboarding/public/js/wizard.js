// wizard.js — client-side step machine for the onboarding wizard.
// No framework, no build step: plain DOM + fetch() against the same-origin
// API served by onboarding/http-server.cjs.

;(function () {
  const C = window.COPY

  // CHANGE A (UI-scope lock, decoupled from the backend's routerWired
  // capability flag): which of the backend's 4 real PROVIDERS
  // ('claude','claude-subscription','chatgpt','ollama') this BUILD exposes
  // as a clickable tab. ROUTER_WIRED flipped true server-side 2026-07-04
  // (own-infra-first found no router build was needed, direct env wiring
  // suffices) -- that is a BACKEND capability fact, separate from the
  // 22:02 Mino-approved UI-scope lock (Claude-only ships v1, chatgpt/ollama
  // = v1.1). Gating tab-enable on routerWired would wrongly ENABLE those
  // two tabs the instant the server flag flips, regardless of UI-scope
  // intent -- this const is the single place that decision lives instead.
  // v1.1 FLIP (2026-07-07, login shell-out): chatgpt/ollama exposed. Their
  // Step-1 area is the in-app LOGIN flow (renderLoginArea below -- button
  // driving POST /api/onboarding/login/:provider), not the key field.
  const EXPOSED_PROVIDERS = ['claude', 'chatgpt', 'ollama']

  // AUTHORED (not in copy.js): the frozen copy file's 2026-07-04 §Step 1
  // redesign added `copyCommand` (the literal string to copy) but defines
  // no button label for the copy-command widget itself. Minimal placeholder
  // in the same spirit as copy.js's own "AUTHORED (not in copy file)"
  // entries -- flagged here, replace if a real copy pass adds a sourced
  // string for this.
  const COPY_BUTTON_LABEL = 'Copy'
  const COPY_BUTTON_COPIED_LABEL = 'Copied'

  const state = {
    provider: null,
    displayName: null,
    tone: null,
    primaryTask: '',
    proactiveEnabled: null,
    proactiveWindowStart: '09:00',
    proactiveWindowEnd: '22:00',
    tutorialIndex: 0,
    discordGuildId: null,
    discordChannelId: null,
    // Discord home-channel name, populated from /api/discord/validate's
    // result.channelName (CHANGE D). Consumed by renderStep5Live(); guarded
    // there in case it's ever missing/empty.
    discordChannelName: null,
    // model/proxyPort (4-provider-mode wiring, CHANGE C): dormant in v1 --
    // no Step 1 UI sets these yet, chatgpt/ollama tabs are UI-scope disabled
    // (see EXPOSED_PROVIDERS) -- but the fields exist here so the
    // /api/onboarding/complete POST body builder (renderStep3) has a stable
    // shape to read from, zero rework once a v1.1 UI populates them.
    model: null,
    proxyPort: null,
  }

  function $(id) { return document.getElementById(id) }
  function showStep(name) {
    document.querySelectorAll('.step').forEach((el) => el.classList.add('hidden'))
    const target = document.querySelector(`.step[data-step="${name}"]`)
    if (!target) throw new Error(`no such step section: ${name}`) // fail loud on a wiring bug
    target.classList.remove('hidden')
  }

  async function api(path, options) {
    const opts = options ? { ...options } : {}
    // localhost-auth gate (security review 2026-07-03; widened to ALL
    // requests 2026-08-04): every /api request must carry the per-launch
    // token -- GETs included, the server rejects tokenless reads too.
    opts.headers = { ...(opts.headers || {}), 'X-Onboard-Token': window.getOnboardToken() || '' }
    const res = await fetch(path, opts)
    let body
    try {
      body = await res.json()
    } catch (err) {
      throw new Error(`non-JSON response from ${path}: ${err.message}`)
    }
    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status} from ${path}`)
    }
    return body
  }

  // ── Step 0 ────────────────────────────────────────────────────────────
  function renderStep0() {
    $('s0-title').textContent = C.step0.title
    $('s0-body').textContent = C.step0.body
    $('s0-next').textContent = C.step0.button
    $('s0-next').onclick = () => {
      stopFdaPoll() // don't keep polling FDA status after leaving Step 0
      showStep('1')
    }
    // Full Disk Access is a macOS (TCC) concept. On Windows the card rendered
    // a button that opens an x-apple.systempreferences: URL -- i.e. nothing --
    // under a heading about "your Mac". Mino hit this on the first Windows
    // install (2026-08-03). No card at all is the honest state there.
    if (window.IS_MAC) renderFdaCard()
  }

  // ── Full Disk Access card (Step 0, 2026-07-07) ──────────────────────────
  // macOS offers no programmatic grant and no official status API: the
  // server's /api/onboarding/fda/status is an explicit heuristic, the pane
  // deep-link is the most the app can do, and a grant only applies after
  // relaunch (TCC caches at launch). Step 0's next button is NEVER blocked
  // on this -- the heuristic can false-negative, and wedging onboarding on
  // an unverifiable check would be worse than proceeding.
  let fdaPollTimer = null
  function stopFdaPoll() {
    if (fdaPollTimer) {
      clearInterval(fdaPollTimer)
      fdaPollTimer = null
    }
  }
  function renderFdaCard() {
    const F = C.step0.fda
    const section = document.querySelector('section[data-step="0"]')
    let card = $('s0-fda-card')
    if (!card) {
      card = document.createElement('div')
      card.id = 's0-fda-card'
      card.className = 'field'
      section.insertBefore(card, section.querySelector('.step-actions'))
    }

    // paneOpened distinguishes "granted since before" (no restart needed
    // -- the running process was launched under the grant) from "granted
    // during this session via the pane" (restart required for TCC).
    let paneOpened = false
    function paint(granted) {
      card.innerHTML = ''
      const title = document.createElement('strong')
      title.textContent = F.title
      card.appendChild(title)
      const body = document.createElement('p')
      body.className = 'field-hint'
      card.appendChild(body)

      if (granted && !paneOpened) {
        body.textContent = F.bodyGranted
        stopFdaPoll()
        return
      }
      if (granted && paneOpened) {
        body.textContent = F.bodyGrantedPendingRestart
        const relaunchBtn = document.createElement('button')
        relaunchBtn.type = 'button'
        relaunchBtn.textContent = F.relaunchButton
        relaunchBtn.onclick = () => {
          api('/api/onboarding/fda/relaunch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {})
        }
        card.appendChild(relaunchBtn)
        stopFdaPoll()
        return
      }
      body.textContent = F.bodyMissing
      const openBtn = document.createElement('button')
      openBtn.type = 'button'
      openBtn.textContent = F.openButton
      openBtn.onclick = async () => {
        paneOpened = true
        try {
          await api('/api/onboarding/fda/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        } catch (err) {
          console.error('fda/open failed:', err)
        }
        // Watch for the toggle flipping while the user is in System
        // Settings; repaint into the restart prompt when it does.
        stopFdaPoll()
        fdaPollTimer = setInterval(async () => {
          try {
            const s = await api('/api/onboarding/fda/status')
            if (s.granted) paint(true)
          } catch (err) {
            // transient; keep polling
          }
        }, 3000)
      }
      card.appendChild(openBtn)
      const skip = document.createElement('div')
      skip.className = 'field-hint'
      skip.textContent = F.skipHint
      card.appendChild(skip)
    }

    api('/api/onboarding/fda/status')
      .then((s) => paint(Boolean(s.granted)))
      .catch(() => paint(false))
  }

  // ── Step 1: provider connect ─────────────────────────────────────────
  // v2 (2026-07-04 copy.js §Step 1 redesign): claude's tab has two
  // sub-modes -- PRIMARY (claude setup-token) and a collapsible BYOK
  // fallback (sk-ant paste). THIS IS THE FIX FOR CODEX FINDING #3: the two
  // sub-modes MUST submit under distinct provider ids -- routing a
  // setup-token as an Anthropic x-api-key fails outright. Contract (verified
  // in this task's report): primary submits provider:'claude-subscription',
  // fallback submits provider:'claude'. See renderClaudeArea() below, the
  // single place state.provider is set for this tab.
  function renderStep1() {
    $('s1-title').textContent = C.step1.title
    $('s1-body').textContent = C.step1.body
    const tabsEl = $('s1-tabs')
    tabsEl.innerHTML = ''
    let activeTab = EXPOSED_PROVIDERS[0] // 'claude' -- the only v1-exposed tab, so also the only ever-active one
    let claudeSubMode = 'primary' // 'primary' (setup-token) | 'fallback' (sk-ant BYOK) -- claude tab only

    const claudeTab = C.step1.tabs.find((t) => t.id === 'claude')
    const claudeFallbackHint = C.step1.fallback.tabs.find((t) => t.id === 'claude')

    // CHANGE A: tab enable/disable is UI-scope only (EXPOSED_PROVIDERS),
    // never the server's routerWired capability flag (see that const's own
    // header comment for why). Note text below the tab bar follows the same
    // UI-scope decision, not routerWired.
    const noteEl = $('s1-router-note')
    const anyTabDisabled = C.step1.tabs.some((t) => !EXPOSED_PROVIDERS.includes(t.id))
    if (anyTabDisabled) {
      noteEl.textContent = C.step1.routerDisabledNote
      noteEl.classList.remove('hidden')
    } else {
      noteEl.classList.add('hidden')
      noteEl.textContent = ''
    }

    const keyFieldWrap = $('s1-key').parentElement
    let extraEl = null // lazily-mounted container for claude's primary-panel + fallback-toggle; inserted once, right before keyFieldWrap

    // ── zero-auth consent card (2026-07-13) ─────────────────────────────
    // If this Mac already has a Claude Code CLI login, offer to reuse it IN
    // PLACE and skip auth entirely. Detection is server-side and
    // existence-only (http-server.cjs's computeAvailableProviders) -- the
    // credential file is never opened, so there is nothing here that could
    // leak it.
    //
    // Fetches its own status rather than waiting on init()'s cfg, mirroring
    // renderFdaCard: renderStep1 is deliberately synchronous and must not
    // start awaiting (see init()'s comment). Non-blocking in the same way,
    // too -- if the probe fails, the card simply never appears and the normal
    // tabs carry the user, exactly as before this feature existed.
    function renderFoundLoginCard() {
      const F = C.step1.foundLogin
      const card = $('s1-found-login')
      api('/api/config')
        .then((cfg) => {
          const providers = Array.isArray(cfg.availableProviders) ? cfg.availableProviders : []
          if (!providers.includes('claude-cli')) return // nothing found -> normal flow, no card
          $('s1-found-login-title').textContent = F.title
          $('s1-found-login-body').textContent = F.body
          $('s1-found-login-cost').textContent = F.cost
          $('s1-found-login-stale').textContent = F.staleHint
          $('s1-found-login-alt').textContent = F.alt
          const useBtn = $('s1-found-login-use')
          useBtn.textContent = F.use
          useBtn.onclick = () => {
            // Consent is this click, and this click is the entire flow: there
            // is no key to validate and nothing to store, so the provider is
            // simply chosen and the user moves on. /api/onboarding/complete
            // writes PROVIDER=claude-cli, and provider-env.cjs's claude-cli
            // branch then injects NOTHING, which is what makes the CLI fall
            // back to the login we found.
            state.provider = 'claude-cli'
            state.key = ''
            stopLoginPoll()
            showStep('2')
          }
          card.classList.remove('hidden')
        })
        .catch((err) => {
          // A failed probe must never block onboarding -- worst case the user
          // connects a provider by hand, which is the pre-existing path.
          console.error('found-login probe failed (card stays hidden):', err)
        })
    }

    // ── login shell-out poll plumbing (v1.1, 2026-07-07) ────────────────
    let loginPollTimer = null
    function stopLoginPoll() {
      if (loginPollTimer) {
        clearInterval(loginPollTimer)
        loginPollTimer = null
      }
    }

    // chatgpt/ollama Step-1 area: an in-app login button (the server runs
    // `codex login` / `ollama signin` for the user -- backend commit
    // d628e22), a 2s status poll (S5_POLL pattern), and for ollama the
    // required cloud-model field (provider-env.cjs demands MODEL). The key
    // field is hidden -- these are no-secret providers; nothing is pasted
    // or stored. Next is gated on login success (+ model for ollama) and
    // goes straight to Step 2: /api/byok/validate would store nothing for
    // these providers anyway (PROVIDERS_REQUIRING_STORED_CREDENTIAL).
    function renderLoginArea(provider) {
      const L = C.step1.login
      const P = L[provider]
      const nextBtn = $('s1-next')
      const statusEl = $('s1-status')
      state.provider = provider
      keyFieldWrap.classList.add('hidden')
      nextBtn.textContent = C.step1.button
      nextBtn.disabled = true

      // Lazy dependency bootstrap (2026-07-07): the provider's CLI is only
      // downloaded when the user actually picks this tab -- a Claude-only
      // user never sees a download at all. Dep mapping: chatgpt needs the
      // codex CLI, ollama needs Ollama.app's CLI.
      const DEP = provider === 'chatgpt' ? 'codex' : 'ollama'
      const DEP_DISPLAY = provider === 'chatgpt' ? 'Codex' : 'Ollama'
      const areaEl = document.createElement('div')
      extraEl.appendChild(areaEl)

      api('/api/onboarding/bootstrap/status')
        .then((bs) => {
          const dep = bs[DEP]
          if (dep && (dep.present || dep.state === 'installed')) buildLoginUI()
          else if (dep && dep.managed === false) buildManualInstallUI() // win: detection-only, no managed download
          else buildInstallUI()
        })
        .catch(() => buildLoginUI()) // status probe failed: fall through to login UI; its cli_missing path still guards

      // Windows v1 (detection-only deps, Mino locked 07-13): the server has
      // no managed installer on this platform -- offer the official install
      // page (opened server-side, fixed URL) and a re-detect button that
      // re-probes resolveBin until the CLI shows up.
      function buildManualInstallUI() {
        areaEl.innerHTML = ''
        const lead = document.createElement('p')
        lead.textContent = L.install.manualNeeded(DEP_DISPLAY)
        areaEl.appendChild(lead)
        const openBtn = document.createElement('button')
        openBtn.type = 'button'
        openBtn.textContent = L.install.manualOpenButton
        areaEl.appendChild(openBtn)
        const redetectBtn = document.createElement('button')
        redetectBtn.type = 'button'
        redetectBtn.textContent = L.install.redetectButton
        areaEl.appendChild(redetectBtn)
        openBtn.onclick = async () => {
          try {
            await api(`/api/onboarding/bootstrap/${DEP}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            statusEl.className = 'status-line pending'
            statusEl.textContent = L.install.manualOpened
          } catch (err) {
            statusEl.className = 'status-line failure'
            statusEl.textContent = C.genericError(err.message)
          }
        }
        redetectBtn.onclick = async () => {
          redetectBtn.disabled = true
          try {
            const bs = await api('/api/onboarding/bootstrap/status')
            if (bs[DEP] && bs[DEP].present) {
              statusEl.className = 'status-line success'
              statusEl.textContent = L.install.done
              buildLoginUI()
            } else {
              statusEl.className = 'status-line failure'
              statusEl.textContent = L.install.stillMissing(DEP_DISPLAY)
            }
          } catch (err) {
            statusEl.className = 'status-line failure'
            statusEl.textContent = C.genericError(err.message)
          } finally {
            redetectBtn.disabled = false
          }
        }
      }

      function buildInstallUI() {
        areaEl.innerHTML = ''
        const lead = document.createElement('p')
        lead.textContent = L.install.needed(DEP_DISPLAY)
        areaEl.appendChild(lead)
        const installBtn = document.createElement('button')
        installBtn.type = 'button'
        installBtn.textContent = L.install.button
        areaEl.appendChild(installBtn)

        installBtn.onclick = async () => {
          installBtn.disabled = true
          statusEl.className = 'status-line pending'
          statusEl.textContent = L.install.downloading(null)
          try {
            await api(`/api/onboarding/bootstrap/${DEP}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          } catch (err) {
            statusEl.className = 'status-line failure'
            statusEl.textContent = C.genericError(err.message)
            installBtn.disabled = false
            installBtn.textContent = L.install.retryButton
            return
          }
          stopLoginPoll()
          loginPollTimer = setInterval(async () => {
            try {
              const bs = await api('/api/onboarding/bootstrap/status')
              const dep = bs[DEP]
              if (!dep) return
              if (dep.state === 'downloading') {
                statusEl.className = 'status-line pending'
                statusEl.textContent = L.install.downloading(dep.progress)
              } else if (dep.state === 'installing') {
                statusEl.className = 'status-line pending'
                statusEl.textContent = L.install.installing
              } else if (dep.state === 'installed') {
                stopLoginPoll()
                statusEl.className = 'status-line success'
                statusEl.textContent = L.install.done
                buildLoginUI()
              } else if (dep.state === 'failed') {
                stopLoginPoll()
                statusEl.className = 'status-line failure'
                statusEl.textContent = dep.detail || L.install.failed
                installBtn.disabled = false
                installBtn.textContent = L.install.retryButton
              }
            } catch (err) {
              // transient poll failure: keep polling
            }
          }, 2000)
        }
      }

      function buildLoginUI() {
      areaEl.innerHTML = ''
      const panel = areaEl
      const leadEl = document.createElement('p')
      leadEl.textContent = P.lead
      panel.appendChild(leadEl)

      const loginBtn = document.createElement('button')
      loginBtn.type = 'button'
      loginBtn.textContent = P.button
      panel.appendChild(loginBtn)

      const reloginBtn = document.createElement('button')
      reloginBtn.type = 'button'
      reloginBtn.className = 'link hidden'
      reloginBtn.textContent = L.reloginLabel
      panel.appendChild(reloginBtn)

      let modelInput = null
      if (provider === 'ollama') {
        const field = document.createElement('div')
        field.className = 'field'
        const label = document.createElement('label')
        label.textContent = P.modelLabel
        modelInput = document.createElement('input')
        modelInput.type = 'text'
        modelInput.placeholder = P.modelPlaceholder
        modelInput.value = state.model || ''
        const hint = document.createElement('div')
        hint.className = 'field-hint'
        hint.textContent = P.modelHint
        field.appendChild(label)
        field.appendChild(modelInput)
        field.appendChild(hint)
        panel.appendChild(field)
        modelInput.oninput = updateNextGate
      }

      let loginState = 'idle'
      function updateNextGate() {
        const modelOk = provider !== 'ollama' || Boolean(modelInput && modelInput.value.trim())
        nextBtn.disabled = !(loginState === 'success' && modelOk)
      }

      function applyStatus(s) {
        loginState = s.state
        if (s.state === 'running') {
          statusEl.className = 'status-line pending'
          statusEl.textContent = C.step1.loginWaiting
        } else if (s.state === 'success') {
          stopLoginPoll()
          statusEl.className = 'status-line success'
          statusEl.textContent = L.successNoPlan
          reloginBtn.classList.remove('hidden')
        } else if (s.state === 'failed') {
          stopLoginPoll()
          statusEl.className = 'status-line failure'
          // cli_missing carries the server's Korean install pointer in
          // `detail`; every other failure detail is deliberately coarse
          // server-side (stderr never rides the wire), so map by code.
          if (s.code === 'cli_missing') statusEl.textContent = s.detail || C.step1.loginFailure
          else if (s.code === 'cancelled') statusEl.textContent = L.cancelled
          else if (s.code === 'timeout') statusEl.textContent = L.timeout
          else statusEl.textContent = C.step1.loginFailure
        }
        updateNextGate()
      }

      async function startLogin(force) {
        statusEl.className = 'status-line pending'
        statusEl.textContent = L.starting
        try {
          const s = await api(`/api/onboarding/login/${provider}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(force ? { force: true } : {}),
          })
          applyStatus(s)
          if (s.state === 'running') {
            stopLoginPoll()
            loginPollTimer = setInterval(async () => {
              try {
                applyStatus(await api(`/api/onboarding/login/${provider}/status`))
              } catch (err) {
                // transient poll failure: keep polling, terminal states
                // arrive from the server on the next tick
              }
            }, 2000)
          }
        } catch (err) {
          statusEl.className = 'status-line failure'
          statusEl.textContent = C.genericError(err.message)
        }
      }

      loginBtn.onclick = () => startLogin(false)
      reloginBtn.onclick = () => startLogin(true)

      // warn-once gate (2026-08-04 tester #1): "connected" used to mean only
      // "signin worked" -- the typed model was never checked, so a missing/
      // unpulled cloud model sailed through and died at runtime. First Next
      // click checks the model against the daemon's list; if absent, the
      // server's actionable detail renders here and the click does NOT
      // advance. Fixing the name re-arms the check; pressing Next again on
      // the same name proceeds anyway (pull-it-later is legitimate).
      let warnedModel = null
      nextBtn.onclick = async () => {
        if (provider === 'ollama') {
          const m = modelInput.value.trim()
          if (m !== warnedModel) {
            nextBtn.disabled = true
            try {
              const v = await api('/api/agent/validate-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'ollama', model: m }),
              })
              if (v && v.modelPresent === false) {
                warnedModel = m
                statusEl.className = 'status-line failure'
                statusEl.textContent = `${v.detail || ''} ${P.modelMissingProceed}`.trim()
                return
              }
            } catch (err) {
              // validation unreachable -> fall through to the old behavior;
              // blocking setup on a broken checker would be worse than the bug
            } finally {
              nextBtn.disabled = false
              updateNextGate()
            }
          }
          state.model = m
        }
        state.provider = provider
        showStep('2')
      }

      // On tab entry, surface where we already stand -- a prior success
      // (or an already-logged-in fast path from a previous visit) renders
      // immediately without spawning anything.
      api(`/api/onboarding/login/${provider}/status`).then(applyStatus).catch(() => {})
      } // end buildLoginUI
    }

    // Renders Step 1's lower half for the current activeTab/claudeSubMode.
    // claude gets the two-submode UI (this is the load-bearing branch);
    // chatgpt/ollama get the login-button area (renderLoginArea above).
    function renderClaudeArea() {
      const keyInput = $('s1-key')
      const hintEl = $('s1-hint')
      const nextBtn = $('s1-next')

      if (!extraEl) {
        extraEl = document.createElement('div')
        keyFieldWrap.parentElement.insertBefore(extraEl, keyFieldWrap)
      }
      extraEl.innerHTML = ''
      // Reset shared surfaces on every tab/submode re-render: stop any
      // login poll, restore the key field + status line + next button that
      // a login tab may have hidden/overridden.
      stopLoginPoll()
      keyFieldWrap.classList.remove('hidden')
      nextBtn.disabled = false
      keyInput.value = ''
      $('s1-status').textContent = ''
      $('s1-status').className = 'status-line'

      if (activeTab === 'chatgpt' || activeTab === 'ollama') {
        renderLoginArea(activeTab)
        return
      }
      // claude tab from here down -- both submodes re-wire the key-validate
      // next handler (the login area installs its own).
      wireValidateNext()
      if (claudeSubMode === 'primary') {
        const primary = claudeTab.primary
        const A = primary.inApp
        const statusEl = $('s1-status')
        const panel = document.createElement('div')

        // ── in-app capture (default path) ───────────────────────────────
        // The app runs `claude setup-token` itself and reads the token out
        // of that child, so the 1-year credential never reaches the
        // clipboard. The manual Terminal steps below are preserved verbatim
        // and reachable in one click -- this adds a default, it does not
        // remove a path. If the spawn fails on some machine, the flow the
        // user had yesterday is still right there.
        //
        // Polling reuses loginPollTimer on purpose: renderClaudeArea calls
        // stopLoginPoll() on every tab/submode change, so switching away
        // cancels this poll through machinery that already exists rather
        // than a second timer nobody remembers to clear.
        const inAppPanel = document.createElement('div')
        const leadEl = document.createElement('p')
        leadEl.textContent = A.lead
        inAppPanel.appendChild(leadEl)

        const btnRow = document.createElement('div')
        btnRow.className = 'step-actions'
        const loginBtn = document.createElement('button')
        loginBtn.type = 'button'
        loginBtn.textContent = A.button
        const cancelBtn = document.createElement('button')
        cancelBtn.type = 'button'
        cancelBtn.className = 'secondary hidden'
        cancelBtn.textContent = A.cancel
        btnRow.appendChild(loginBtn)
        btnRow.appendChild(cancelBtn)
        inAppPanel.appendChild(btnRow)

        // Fallback code box. Hidden unless the CLI actually asks -- it races
        // a localhost callback against its own paste prompt, and on most
        // machines the redirect wins and this never appears. Showing it up
        // front would present an optional step as a required one.
        const codeField = document.createElement('div')
        codeField.className = 'field hidden'
        const codeHint = document.createElement('div')
        codeHint.className = 'field-hint'
        codeHint.textContent = A.codePrompt
        const codeInner = document.createElement('div')
        codeInner.className = 'step-actions'
        const codeInput = document.createElement('input')
        codeInput.type = 'text'
        codeInput.autocomplete = 'off'
        const codeBtn = document.createElement('button')
        codeBtn.type = 'button'
        codeBtn.className = 'secondary'
        codeBtn.textContent = A.codeButton
        codeInner.appendChild(codeInput)
        codeInner.appendChild(codeBtn)
        codeField.appendChild(codeHint)
        codeField.appendChild(codeInner)
        inAppPanel.appendChild(codeField)
        panel.appendChild(inAppPanel)

        function applySetupStatus(s) {
          const st = s && s.state
          if (st === 'running' || st === 'awaiting_code') {
            statusEl.className = 'status-line pending'
            statusEl.textContent = A.waiting
            loginBtn.disabled = true
            cancelBtn.classList.remove('hidden')
            // awaiting_code means the fallback is AVAILABLE, not required.
            if (st === 'awaiting_code') codeField.classList.remove('hidden')
          } else if (st === 'validating') {
            statusEl.className = 'status-line pending'
            statusEl.textContent = A.validating
            loginBtn.disabled = true
          } else if (st === 'connected') {
            stopLoginPoll()
            statusEl.className = 'status-line success'
            statusEl.textContent = A.success
            loginBtn.disabled = false
            cancelBtn.classList.add('hidden')
            codeField.classList.add('hidden')
            // The server already validated AND stored the credential, so
            // Next must NOT re-run the key-validate handler -- there is no
            // key in the form to send. Advance directly.
            nextBtn.disabled = false
            nextBtn.onclick = () => { state.provider = 'claude-subscription'; showStep('2') }
          } else if (st === 'failed' || st === 'cancelled') {
            stopLoginPoll()
            statusEl.className = 'status-line failure'
            statusEl.textContent = A.failure(s.reason)
            loginBtn.disabled = false
            cancelBtn.classList.add('hidden')
            codeField.classList.add('hidden')
          }
        }

        // ONE definition of the poll, used by both the button and the resume
        // path below. Written twice, the resume copy is the one that silently
        // drifts -- and it is the copy nobody exercises by hand.
        function startSetupPoll() {
          stopLoginPoll()
          loginPollTimer = setInterval(async () => {
            try { applySetupStatus(await api('/api/setup-token/status')) } catch (err) { /* transient: keep polling */ }
          }, 2000)
        }

        loginBtn.onclick = async () => {
          loginBtn.disabled = true
          statusEl.className = 'status-line pending'
          statusEl.textContent = A.starting
          try {
            applySetupStatus(await api('/api/setup-token/start', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            }))
          } catch (err) {
            statusEl.className = 'status-line failure'
            statusEl.textContent = C.genericError(err.message)
            loginBtn.disabled = false
            return
          }
          startSetupPoll()
        }

        cancelBtn.onclick = async () => {
          try { applySetupStatus(await api('/api/setup-token/cancel', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          })) } catch (err) { stopLoginPoll() }
        }

        codeBtn.onclick = async () => {
          const code = codeInput.value.trim()
          if (!code) return
          codeBtn.disabled = true
          try {
            const s = await api('/api/setup-token/code', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
            })
            if (s.ok === false && s.reason === 'invalid_code') {
              statusEl.className = 'status-line failure'
              statusEl.textContent = A.codeInvalid
            } else {
              codeInput.value = ''
              applySetupStatus(s)
            }
          } catch (err) {
            statusEl.className = 'status-line failure'
            statusEl.textContent = C.genericError(err.message)
          } finally {
            codeBtn.disabled = false
          }
        }

        // ── manual Terminal path (preserved, one click away) ─────────────
        const manualToggle = document.createElement('button')
        manualToggle.type = 'button'
        manualToggle.className = 'link'
        manualToggle.textContent = A.manualToggle
        panel.appendChild(manualToggle)

        const manualPanel = document.createElement('div')
        manualPanel.className = 'hidden'
        manualToggle.onclick = () => {
          const opening = manualPanel.classList.contains('hidden')
          manualPanel.classList.toggle('hidden')
          // The manual path submits the pasted token through the normal
          // key-validate handler, so the key field and that handler come
          // back only while this panel is open.
          keyFieldWrap.classList.toggle('hidden', !opening)
          if (opening) { wireValidateNext(); nextBtn.disabled = false }
        }

        const precondEl = document.createElement('p')
        precondEl.textContent = primary.precondition
        manualPanel.appendChild(precondEl)

        const stepsEl = document.createElement('ol')
        primary.steps.forEach((stepText) => {
          const li = document.createElement('li')
          li.textContent = stepText
          stepsEl.appendChild(li)
        })
        manualPanel.appendChild(stepsEl)

        // Command-copy widget. AUTHORED button label (see COPY_BUTTON_LABEL's
        // own header comment) -- copy.js's redesign added `copyCommand` (the
        // literal string to copy) but defines no button text for the widget.
        const cmdRow = document.createElement('div')
        cmdRow.className = 'field'
        const cmdInner = document.createElement('div')
        cmdInner.className = 'step-actions'
        const cmdText = document.createElement('div')
        cmdText.className = 'field-hint'
        cmdText.textContent = primary.copyCommand
        const copyBtn = document.createElement('button')
        copyBtn.type = 'button'
        copyBtn.className = 'secondary'
        copyBtn.textContent = COPY_BUTTON_LABEL
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(primary.copyCommand)
            copyBtn.textContent = COPY_BUTTON_COPIED_LABEL
            setTimeout(() => { copyBtn.textContent = COPY_BUTTON_LABEL }, 1500)
          } catch (err) {
            console.error('clipboard write failed:', err)
          }
        }
        cmdInner.appendChild(cmdText)
        cmdInner.appendChild(copyBtn)
        cmdRow.appendChild(cmdInner)
        manualPanel.appendChild(cmdRow)

        const subtextEl = document.createElement('p')
        subtextEl.className = 'field-hint'
        subtextEl.textContent = primary.subtext
        manualPanel.appendChild(subtextEl)

        panel.appendChild(manualPanel)
        extraEl.appendChild(panel)

        const toggleBtn = document.createElement('button')
        toggleBtn.type = 'button'
        toggleBtn.className = 'link'
        toggleBtn.textContent = C.step1.fallback.toggleLabel
        toggleBtn.onclick = () => {
          claudeSubMode = 'fallback'
          renderClaudeArea()
        }
        extraEl.appendChild(toggleBtn)

        hintEl.textContent = ''
        keyInput.placeholder = 'Paste the token'
        // ACCEPTANCE TEST CONTRACT: primary (setup-token) sub-mode submits
        // provider:'claude-subscription' -- never 'claude'. Both paths in
        // this sub-mode honour it: the manual paste goes through
        // validateNextHandler with state.provider set here, and the in-app
        // capture stores under the same id server-side (PROVIDER_ID in
        // setup-token-session.cjs).
        nextBtn.textContent = primary.button
        state.provider = 'claude-subscription'
        // In-app capture is the default, so the key field starts hidden and
        // Next starts gated -- there is nothing to submit until either the
        // capture connects or the user opens the manual panel. The reset at
        // the top of renderClaudeArea un-hides the field for every tab, so
        // this must come AFTER it.
        keyFieldWrap.classList.add('hidden')
        nextBtn.disabled = true
        // Surface where we already stand, same as the login tabs: a flow left
        // running (or already connected) renders immediately without
        // spawning anything. Failure to reach it degrades to the buttons
        // above, which is exactly the pre-existing manual onboarding.
        api('/api/setup-token/status').then((s) => {
          if (!s || s.state === 'idle') return
          applySetupStatus(s)
          // A flow still IN FLIGHT needs its poll restarted, not just its
          // status line repainted. The session is a module-scope singleton on
          // the server and outlives this page, but the interval driving it
          // died with the previous render -- a reload, or navigating away and
          // back, mid-login. Without this the user sits on "waiting for the
          // browser login to finish" forever while the child has already
          // completed and stored the credential. Found by walking my own
          // orderings, not by a test; the pin for it is in
          // test-setup-token-copy.mjs.
          if (s.state === 'running' || s.state === 'awaiting_code' || s.state === 'validating') startSetupPoll()
        }).catch(() => {})
      } else {
        // claude, fallback (BYOK sk-ant) sub-mode
        const introEl = document.createElement('p')
        introEl.textContent = C.step1.fallback.body
        extraEl.appendChild(introEl)

        hintEl.textContent = claudeFallbackHint ? claudeFallbackHint.hint : ''
        keyInput.placeholder = 'Paste the key'
        // ACCEPTANCE TEST CONTRACT: fallback (sk-ant BYOK) sub-mode submits
        // provider:'claude' -- never 'claude-subscription'.
        nextBtn.textContent = C.step1.button
        state.provider = 'claude'
      }
    }

    C.step1.tabs.forEach((tab) => {
      const disabled = !EXPOSED_PROVIDERS.includes(tab.id)
      const el = document.createElement('div')
      el.className = 'tab' + (tab.id === activeTab ? ' active' : '') + (disabled ? ' disabled' : '')
      el.textContent = disabled ? tab.disabledLabel : tab.label
      if (!disabled) {
        el.onclick = () => {
          activeTab = tab.id
          claudeSubMode = 'primary'
          tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
          el.classList.add('active')
          renderClaudeArea()
        }
      }
      tabsEl.appendChild(el)
    })

    // Key-validate next handler, (re-)installed by renderClaudeArea for the
    // claude tab's submodes -- extracted into a function (2026-07-07)
    // because the login tabs install their own next handler, so switching
    // back to claude must restore this one. NOTE: the initial
    // renderClaudeArea() call sits BELOW validateNextHandler's const
    // declaration (TDZ) -- do not move it back above.
    function wireValidateNext() {
      $('s1-next').onclick = validateNextHandler
    }
    const validateNextHandler = async () => {
      const key = $('s1-key').value.trim()
      const statusEl = $('s1-status')
      const btn = $('s1-next')
      btn.disabled = true
      statusEl.className = 'status-line pending'
      // Status copy branches by sub-mode (Codex front-end finding #3 fix,
      // Idea sourced primary.validating/.failure 2026-07-04): setup-token
      // (claude-subscription) uses token-worded primary.* strings; sk-ant
      // BYOK (claude) keeps the key-worded fallback.* strings. success is
      // shared: fallback.success ("연결됐습니다") is provider-agnostic.
      const isSub = state.provider === 'claude-subscription'
      statusEl.textContent = isSub ? claudeTab.primary.validating : C.step1.fallback.validating
      try {
        const result = await api('/api/byok/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: state.provider, key }),
        })
        if (result.ok) {
          statusEl.className = 'status-line success'
          statusEl.textContent = C.step1.fallback.success
          showStep('2')
        } else {
          statusEl.className = 'status-line failure'
          statusEl.textContent = isSub
            ? claudeTab.primary.failure(result.reason || 'unknown error')
            : C.step1.fallback.failure(result.reason || 'unknown error')
        }
      } catch (err) {
        statusEl.className = 'status-line failure'
        statusEl.textContent = C.genericError(err.message)
      } finally {
        btn.disabled = false
      }
    }

    // Initial render -- MUST stay below validateNextHandler (TDZ; see
    // wireValidateNext's comment).
    renderClaudeArea()
    // Offer the existing login, if there is one. Mounted AFTER the normal tab
    // render on purpose: the manual path is fully wired and usable whether or
    // not this card ever appears, so a probe that hangs or fails degrades to
    // exactly the pre-existing onboarding rather than to a dead step.
    renderFoundLoginCard()
  }

  // ── Step 2: name ─────────────────────────────────────────────────────
  function renderStep2() {
    $('s2-title').textContent = C.step2.title
    $('s2-body').textContent = C.step2.body
    $('s2-next').textContent = C.step2.button
    if (!$('s2-name').value) $('s2-name').value = state.displayName || C.step2.defaultName
    $('s2-next').onclick = () => {
      const name = $('s2-name').value.trim() || C.step2.defaultName
      state.displayName = name
      showStep('3')
    }
  }

  // ── Step 3: persona (3 questions) ───────────────────────────────────
  function renderStep3() {
    $('s3-title').textContent = C.step3.title
    $('s3-q1-label').textContent = C.step3.q1Label
    const q1El = $('s3-q1-options')
    q1El.innerHTML = ''
    C.step3.q1Options.forEach((opt, idx) => {
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 's3-q1'
      input.value = opt.value
      if (idx === 0) input.checked = true
      label.appendChild(input)
      label.appendChild(document.createTextNode(' ' + opt.label))
      q1El.appendChild(label)
    })

    $('s3-q2-label').textContent = C.step3.q2Label
    const chipsEl = $('s3-q2-chips')
    chipsEl.innerHTML = ''
    C.step3.q2Chips.forEach((chip) => {
      const el = document.createElement('div')
      el.className = 'chip'
      el.textContent = chip
      el.onclick = () => {
        const field = $('s3-q2-text')
        if (!field.value.trim()) field.value = chip
        else if (!field.value.includes(chip)) field.value += ', ' + chip
      }
      chipsEl.appendChild(el)
    })

    $('s3-q3-label').textContent = C.step3.q3Label
    $('s3-q3-yes-prefix').textContent = C.step3.q3YesPrefix
    $('s3-q3-yes-suffix').textContent = C.step3.q3YesSuffix
    $('s3-q3-no').textContent = C.step3.q3No
    $('s3-q3-note').textContent = C.step3.q3Note
    document.querySelector('input[name="s3-q3"][value="no"]').checked = true

    $('s3-next').textContent = C.step3.button
    $('s3-status').classList.add('hidden')

    $('s3-next').onclick = async () => {
      const tone = document.querySelector('input[name="s3-q1"]:checked').value
      const primaryTask = $('s3-q2-text').value.trim()
      const proactive = document.querySelector('input[name="s3-q3"]:checked').value
      const proactiveEnabled = proactive === 'yes'
      state.tone = tone
      state.primaryTask = primaryTask
      state.proactiveEnabled = proactiveEnabled
      state.proactiveWindowStart = $('s3-q3-start').value
      state.proactiveWindowEnd = $('s3-q3-end').value

      const btn = $('s3-next')
      btn.disabled = true
      // CHANGE C: mode-specific fields, only for the provider that needs
      // them -- never sent for claude/claude-subscription. Dormant in v1
      // (state.model/state.proxyPort are always null -- those tabs are
      // UI-scope disabled, see EXPOSED_PROVIDERS) but structurally wired so
      // the direct-API path and a v1.1 chatgpt/ollama config UI need zero
      // backend-contract rework.
      const completeBody = {
        displayName: state.displayName,
        provider: state.provider,
        tone: state.tone,
        primaryTask: state.primaryTask,
        proactiveEnabled: state.proactiveEnabled,
        proactiveWindowStart: state.proactiveWindowStart,
        proactiveWindowEnd: state.proactiveWindowEnd,
      }
      if (state.provider === 'ollama') completeBody.model = state.model
      if (state.provider === 'chatgpt') completeBody.proxyPort = state.proxyPort
      try {
        await api('/api/onboarding/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(completeBody),
        })
        renderStep4()
        showStep('4')
      } catch (err) {
        const statusEl = $('s3-status')
        statusEl.classList.remove('hidden')
        statusEl.textContent = C.genericError(err.message)
      } finally {
        btn.disabled = false
      }
    }
  }

  // ── Step 4: where to talk (in-app chat slice 5) ─────────────────────
  // In-app chat is the primary action: one click completes onboarding
  // (POST /api/channels/local/complete stamps the config and fires the
  // spawn callback server-side, same contract as the discord validate
  // route) and lands on /chat, where the agent's boot greeting is the
  // first thing the pane shows. The messenger buttons stay as optional
  // upgrades; the old "later" escape to /waiting is gone -- it ended
  // setup with an agent the user could not reach.
  function renderStep4() {
    $('s4-title').textContent = C.step4.title
    $('s4-body').textContent = C.step4.body(state.displayName)
    $('s4-start-chat').textContent = C.step4.startChat
    $('s4-chat-note').textContent = C.step4.startChatNote
    $('s4-connect-discord').textContent = C.step4.connectDiscord
    $('s4-discord-note').textContent = C.step4.connectDiscordNote
    $('s4-connect-slack').textContent = C.step4.connectSlack
    $('s4-slack-note').textContent = C.step4.supportSoonNote
    $('s4-connect-telegram').textContent = C.step4.connectTelegram
    $('s4-telegram-note').textContent = C.step4.supportSoonNote
    $('s4-start-chat').onclick = async () => {
      const btn = $('s4-start-chat')
      btn.disabled = true
      try {
        await api('/api/channels/local/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        window.location.href = '/chat'
      } catch (err) {
        // The note under the button is the failure surface; the button
        // re-enables so the click can be retried.
        $('s4-chat-note').textContent = C.genericError(err.message)
        btn.disabled = false
      }
    }
    $('s4-connect-discord').onclick = () => {
      window.open(C.step4.links.discord, '_blank', 'noopener')
      state.tutorialIndex = -1 // 2FA pre-warning intro, before step 1 of 6
      renderTutorialStep()
      showStep('4b')
    }
    $('s4-connect-slack').onclick = () => {
      window.open(C.step4.links.slack, '_blank', 'noopener')
    }
    $('s4-connect-telegram').onclick = () => {
      window.open(C.step4.links.telegram, '_blank', 'noopener')
    }
  }

  // ── Step 4b: Discord tutorial (2FA pre-warning intro + 6 numbered
  // steps, last one validates) ─────────────────────────────────────────
  // state.tutorialIndex === -1 is the intro screen (source file's "시작
  // 전 안내" -- shown before step 1 of 6, not itself a numbered step).
  // Folding it into the same prev/next index keeps this a single small
  // state machine instead of a parallel one.
  function renderTutorialStep() {
    const steps = C.discordTutorial.steps
    const idx = state.tutorialIndex
    const isIntro = idx === -1
    const isLast = idx === steps.length - 1

    $('s4b-title').textContent = C.step4.title
    const bodyEl = $('s4b-tutorial-body')
    bodyEl.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'tutorial-step'

    if (isIntro) {
      const textEl = document.createElement('div')
      textEl.className = 'step-text'
      textEl.textContent = C.discordTutorial.preWarning
      wrap.appendChild(textEl)
    } else {
      const idxEl = document.createElement('div')
      idxEl.className = 'step-index'
      idxEl.textContent = `${idx + 1} / ${steps.length}`
      const textEl = document.createElement('div')
      textEl.className = 'step-text'
      textEl.textContent = steps[idx].text(state.displayName)
      wrap.appendChild(idxEl)
      wrap.appendChild(textEl)
      if (steps[idx].shot) {
        const shot = document.createElement('div')
        shot.className = 'screenshot-slot'
        shot.textContent = `[Screenshot ${idx + 1}: real capture pending — see docs/discord-tutorial-shotlist.md]`
        wrap.appendChild(shot)
      }
    }
    bodyEl.appendChild(wrap)

    $('s4b-progress').textContent = isIntro ? '' : `${idx + 1} / ${steps.length}`
    $('s4b-prev').textContent = C.discordTutorial.prevButton
    $('s4b-prev').disabled = isIntro
    $('s4b-prev').onclick = () => {
      state.tutorialIndex -= 1
      renderTutorialStep()
    }

    const tokenField = $('s4b-token-field')
    const statusEl = $('s4b-status')
    statusEl.classList.add('hidden')
    statusEl.textContent = ''

    if (isIntro) {
      tokenField.classList.add('hidden')
      $('s4b-action').textContent = C.discordTutorial.nextButton
      $('s4b-action').disabled = false
      $('s4b-action').onclick = () => {
        state.tutorialIndex += 1
        renderTutorialStep()
      }
    } else if (isLast) {
      tokenField.classList.remove('hidden')
      $('s4b-token-label').textContent = C.discordTutorial.tokenFieldLabel

      // Invite URL minted from the token (Mino 07-13 click-test: the bare
      // authorize link installs nothing useful). A bot token's first
      // dot-segment is base64url of the bot's user ID, which for bots equals
      // the application (client) ID -- so no separate ID field is needed.
      // Permissions integer = View Channel 1024 + Send Messages 2048 +
      // Read Message History 65536 + Add Reactions 64 (🤔 indicator) +
      // Attach Files 32768 (send_file_to_discord) + Embed Links 16384.
      const INVITE_PERMISSIONS = 117824
      const deriveClientId = (token) => {
        const seg = (token.split('.')[0] || '').replace(/-/g, '+').replace(/_/g, '/')
        try {
          const id = atob(seg)
          return /^\d{15,21}$/.test(id) ? id : null
        } catch {
          return null
        }
      }
      const inviteRow = $('s4b-invite-row')
      const refreshInvite = () => {
        const clientId = deriveClientId($('s4b-token').value.trim())
        if (!clientId) {
          inviteRow.classList.add('hidden')
          return
        }
        inviteRow.classList.remove('hidden')
        const btn = $('s4b-invite-open')
        btn.textContent = C.discordTutorial.inviteButton
        btn.onclick = () =>
          window.open(
            `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${INVITE_PERMISSIONS}`,
            '_blank',
            'noopener',
          )
        $('s4b-invite-note').textContent = C.discordTutorial.inviteHint
      }
      $('s4b-token').oninput = refreshInvite
      refreshInvite()

      $('s4b-action').textContent = C.discordTutorial.validateButton
      $('s4b-action').onclick = async () => {
        const token = $('s4b-token').value.trim()
        const btn = $('s4b-action')
        btn.disabled = true
        statusEl.classList.remove('hidden')
        statusEl.className = 'status-line pending'
        statusEl.textContent = C.discordTutorial.validating
        try {
          const result = await api('/api/discord/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          })
          if (result.ok) {
            state.discordGuildId = result.guildId
            state.discordChannelId = result.channelId
            // CHANGE D: result.channelName (2026-07-04, http-server.cjs:940)
            // -- consumed on the Step 5 live/success screen, see
            // renderStep5Live(). '' rather than undefined/null so downstream
            // truthiness checks there stay a simple falsy check.
            state.discordChannelName = result.channelName || ''
            statusEl.className = 'status-line success'
            statusEl.textContent = C.discordTutorial.success(state.displayName)
            renderStep5()
            showStep('5')
          } else {
            statusEl.className = 'status-line failure'
            statusEl.textContent = C.discordTutorial.failures[result.branch] || C.genericError('unknown failure')
          }
        } catch (err) {
          statusEl.className = 'status-line failure'
          statusEl.textContent = C.genericError(err.message)
        } finally {
          btn.disabled = false
        }
      }
    } else {
      tokenField.classList.add('hidden')
      $('s4b-action').textContent = C.discordTutorial.nextButton
      $('s4b-action').disabled = false
      $('s4b-action').onclick = () => {
        state.tutorialIndex += 1
        renderTutorialStep()
      }
    }
  }

  // ── Step 5: handoff, liveness-gated, 3-state ─────────────────────────
  // REQUIREMENT 4 (PO, agent-lifecycle fix 2026-07-03): do not show the
  // "waiting for you in Discord" success copy until the agent is actually
  // confirmed live (GET /api/agent/status, backed by main.cjs's child
  // process state + channel.mjs's DATA_HOME/.agent-live heartbeat marker).
  // Three states: connecting (state==='connecting') / live (state==='live')
  // / failed (state==='failed', with a stable `code` enum). The server
  // never sends a free-form reason string to render -- `result.reason` was
  // renamed to `result.code` (stable enum, drives the copy.js cause table)
  // + `result.detail` (free-form debug prose, console-only, never put in
  // the DOM -- Melchior 2026-07-03: that's the "English leaks into the
  // user's screen" bug class).
  let s5PollTimer = null
  const S5_POLL_INTERVAL_MS = 2000

  function stopS5Poll() {
    if (s5PollTimer) {
      clearTimeout(s5PollTimer)
      s5PollTimer = null
    }
  }

  // Renders the step-actions button row. Used by all three states so the
  // connecting -> live transition can reuse the identical single-button
  // layout (grey/disabled -> enabled is the "obvious progress" signal;
  // Melchior impl call 16:44, Idea confirmed) while failed gets its own
  // cause-specific button set.
  function renderStep5Buttons(buttons) {
    const el = $('s5-buttons')
    el.innerHTML = ''
    buttons.forEach((b) => {
      const btn = document.createElement('button')
      if (b.secondary) btn.className = 'secondary'
      btn.textContent = b.label
      btn.disabled = !!b.disabled
      if (b.title) btn.title = b.title
      if (b.onClick) btn.onclick = b.onClick
      el.appendChild(btn)
    })
  }

  function renderStep5Connecting() {
    $('s5-title').textContent = C.step5.connecting.title
    $('s5-body').textContent = C.step5.connecting.body(state.displayName)
    // Same button, same slot, disabled -- not hidden. Layout doesn't jump
    // when this flips to live.
    renderStep5Buttons([{ label: C.step5.connecting.button, disabled: true }])
  }

  function renderStep5Live() {
    $('s5-title').textContent = C.step5.live.title
    // CHANGE D (coordinator directive 2026-07-04, copy.js finalized after
    // this file's first read): step5.live.body is now `(name, channelName)`
    // and already contains the DM-exposure line -- do not append DM text
    // here. step5.live.button is now `(channelName) => ...`. Both hard-embed
    // `#${channelName}` with no separate "generic, no channel" variant, so a
    // missing/empty channelName is guarded here (not inside copy.js) to
    // avoid ever rendering a bare "#" or "undefined". Should be unreachable
    // off a real successful /api/discord/validate (channelName is always
    // present there -- see s4b-action's capture) -- defensive only.
    const channelName = state.discordChannelName
    if (channelName) {
      $('s5-body').textContent = C.step5.live.body(state.displayName, channelName)
    } else {
      // AUTHORED fallback (not sourced from copy.js -- see comment above).
      $('s5-body').textContent = `${state.displayName} is waiting on Discord. It also takes DMs. Its first message already reflects the settings you just entered.`
    }
    renderStep5Buttons([
      {
        label: channelName ? C.step5.live.button(channelName) : C.step5.connecting.button,
        onClick: async () => {
          try {
            await api('/api/discord/open', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guildId: state.discordGuildId, channelId: state.discordChannelId }),
            })
          } catch (err) {
            alert(C.genericError(err.message))
          }
        },
      },
    ])
  }

  function renderStep5Failed(code) {
    const causes = C.step5.failed.causes
    const row = causes[code] || causes.unknown
    $('s5-title').textContent = C.step5.failed.title
    $('s5-body').textContent = `${row.cause(state.displayName)} ${row.action(state.displayName)}`

    const buttons = row.buttons.map((kind) => {
      if (kind === 'openSettings') {
        // Real navigation -- /settings is a served static route.
        return { label: C.step5.buttonLabels.openSettings, secondary: true, onClick: () => { window.location.href = '/settings' } }
      }
      if (kind === 'backToToken') {
        // Real navigation -- back to the tutorial's last (token-paste) step.
        return {
          label: C.step5.buttonLabels.backToToken,
          secondary: true,
          onClick: () => {
            stopS5Poll()
            state.tutorialIndex = C.discordTutorial.steps.length - 1
            renderTutorialStep()
            showStep('4b')
          },
        }
      }
      if (kind === 'retry') {
        // No respawn endpoint exists yet (source copy file 🔒 #4: "재시도
        // 배선 TODO" -- respawn is explicitly a future ticket, not this
        // task's backend). The honest thing the UI can do today: re-enter
        // connecting and re-poll the real status endpoint. This does not
        // itself restart the agent process.
        return {
          label: C.step5.buttonLabels.retry,
          secondary: true,
          onClick: () => renderStep5(),
        }
      }
      // 'openLogs' (and any future unmapped kind): no log-open route, no
      // exposed log path, no preload/IPC bridge exists anywhere in this
      // codebase today. Rendered per the copy table (button must be
      // present) but disabled rather than wired to a dead click -- a dead
      // click is worse than an honest disabled state. Title text is
      // AUTHORED (not in the copy file), flagged for whoever wires a real
      // log-open endpoint.
      return {
        label: C.step5.buttonLabels[kind] || kind,
        secondary: true,
        disabled: true,
        title: "Log opening isn't wired up yet.",
      }
    })
    renderStep5Buttons(buttons)
  }

  async function pollAgentStatus() {
    try {
      const result = await api('/api/agent/status')
      if (result.state === 'live') {
        stopS5Poll()
        // Land the user in the steady-state home (/memory) on go-live. Rendering
        // the success screen here dead-ended it: the only path to /memory was a
        // fresh GET / (app reboot). renderStep5Live kept below for reuse.
        window.location.href = '/memory'
        return
      }
      if (result.state === 'failed') {
        stopS5Poll()
        // result.detail is free-form debug prose -- log it, never render
        // it. result.code is the stable enum that drives the cause table.
        if (result.detail) console.error('agent failed:', result.code, result.detail)
        renderStep5Failed(result.code)
        return
      }
      renderStep5Connecting()
    } catch (err) {
      // Fail loud (console), but don't hard-stop polling on one transient
      // fetch error against our own localhost server -- the connecting
      // screen already correctly reflects "not confirmed live yet".
      console.error('agent status poll failed:', err)
    }
    s5PollTimer = setTimeout(pollAgentStatus, S5_POLL_INTERVAL_MS)
  }

  function renderStep5() {
    renderStep5Connecting()
    stopS5Poll()
    pollAgentStatus()
  }

  // ── init: resume support for the /waiting -> ?step=4 round trip ───────
  // CHANGE A: Step 1's tab enable/disable no longer depends on this fetch's
  // cfg.routerWired (see EXPOSED_PROVIDERS) -- config is still fetched once,
  // up front, purely for the ?step=4 resume path below (DISPLAY_NAME/
  // PROVIDER), so renderStep1() itself no longer needs to wait on it.
  async function init() {
    let cfg = null
    try {
      cfg = await api('/api/config')
    } catch (err) {
      // Fail loud (console); the ?step=4 resume path below just no-ops if
      // config can't be read (falls through to showStep('0')).
      console.error('config fetch failed:', err)
    }

    renderStep0()
    renderStep1()
    renderStep2()
    renderStep3()

    const params = new URLSearchParams(window.location.search)
    const resumeStep = params.get('step')
    if (resumeStep === '4' && cfg) {
      state.displayName = cfg.DISPLAY_NAME || C.step2.defaultName
      state.provider = cfg.PROVIDER || null
      renderStep4()
      showStep('4')
      return
    }

    showStep('0')
  }

  init()
})()
