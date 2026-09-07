// connectors.js — connectors page: provider auth (ChatGPT/Ollama) + Slack
// placeholder. Extracted verbatim from settings.js's post-onboarding
// provider-auth block (07-13 multi-provider unlock) per
// docs/ia-subpage-plan.md's /connectors split. Uses window.api() /
// window.showToast() from nav.js -- no local copies.
;(function () {
  const C = window.COPY.connectors
  const GEN = window.COPY.genericError
  // Engine cards moved here from settings.js (tab merge 2026-08-06) keep
  // their copy under COPY.settings.* -- S is their alias. Must be defined
  // above the moved blocks: MODEL_CATALOG reads S.* at module-eval time.
  const S = window.COPY.settings

  // Login-capable providers only -- claude/claude-subscription auth happens
  // in onboarding (key/token paste), not via a shell-out login flow, and the
  // server's /api/onboarding/login allowlist would 400 them anyway.
  const AUTH_PROVIDERS = ['chatgpt', 'ollama']
  const LOGIN_POLL_MS = 2000

  function $(id) { return document.getElementById(id) }

  // Status chip: a colored dot + short word instead of a status sentence
  // (대공사 2026-08-05 — 도형/인디케이터 우선). Transient flow messages
  // still overwrite with plain textContent, which simply drops the dot.
  function setChip(el, state, text) {
    if (!el) return
    el.textContent = ''
    el.classList.add('status-chip')
    const d = document.createElement('span')
    d.className = state ? `dot ${state}` : 'dot'
    el.appendChild(d)
    el.appendChild(document.createTextNode(text))
  }

  // ── post-onboarding provider auth ────────────────────────────────────────
  // Reuses the SAME server login lane the onboarding wizard uses
  // (POST /api/onboarding/login/:provider spawns `codex login` /
  // `ollama signin`, GET .../status polls it) -- the routes are not gated on
  // onboarding being incomplete, only on the per-launch X-Onboard-Token.
  // Availability truth comes from /api/config's availableProviders
  // (credential store + login artifacts, computed server-side).

  function failureText(provider, code) {
    const entry = C.providerAuthFailures[code] || C.providerAuthFailures.unknown
    return typeof entry === 'string' ? entry : entry[provider] || C.providerAuthFailures.unknown
  }

  // cfgIn: load-time consolidation (2026-08-07) — init() fetches /api/config
  // once and passes it down; event-driven re-renders call with no arg and
  // fetch fresh, because their whole point is picking up changed state.
  async function renderProviderAuth(cfgIn) {
    $('conn-providers-label').textContent = C.providersLabel
    // (subtitle removed in the 대공사 — the section label carries it now)

    // available=null means the config READ failed -- distinct from an empty
    // list (loaded, nothing connected). Conflating them painted every provider
    // "Not connected" on a transient /api/config blip, a false disconnected
    // state (UI audit 2026-08-13). On a read failure the rows show a neutral
    // "Status unavailable" instead of lying, and the auth buttons still work.
    let available = null
    try {
      const cfg = cfgIn || await api('/api/config')
      available = Array.isArray(cfg.availableProviders) ? cfg.availableProviders : []
    } catch (err) {
      console.error(err)
    }
    const loadFailed = available === null

    for (const provider of AUTH_PROVIDERS) {
      $(`conn-provider-${provider}-name`).textContent = C.providerNames[provider]
      const connected = !loadFailed && available.includes(provider)
      const statusEl = $(`conn-provider-${provider}-status`)
      const btn = $(`conn-provider-${provider}-btn`)
      if (loadFailed) setChip(statusEl, '', C.providerStatusUnknown)
      else setChip(statusEl, connected ? 'ok' : '', connected ? C.providerConnected : C.providerNotConnected)
      btn.textContent = C.providerAuthButton
      btn.classList.toggle('hidden', connected)
      btn.onclick = () => startAuth(provider, statusEl, btn)
      // A connected row used to be a dead end -- a bare "Connected" label
      // with no way to re-verify or re-auth (2026-08-04 external tester 2-1:
      // key rotation after a leak, or just "is this ACTUALLY working?", had
      // no surface). Test = live probe with the server's verbatim verdict;
      // Re-login = the same force-login the wizard uses.
      const testBtn = $(`conn-provider-${provider}-test`)
      const reloginBtn = $(`conn-provider-${provider}-relogin`)
      if (testBtn && reloginBtn) {
        testBtn.textContent = C.providerTestButton
        reloginBtn.textContent = C.providerReloginButton
        testBtn.classList.toggle('hidden', !connected)
        reloginBtn.classList.toggle('hidden', !connected)
        testBtn.onclick = () => runProviderTest(provider, statusEl, testBtn)
        reloginBtn.onclick = () => startAuth(provider, statusEl, reloginBtn, true)
      }
      if (provider === 'ollama') {
        // key-mode (2026-08-04, the owner "ollama -> API키"): there is no login
        // shell-out for ollama anymore -- POSTing one would just 400 against
        // the server's LOGIN_PROVIDERS allowlist. Connect and Re-login both
        // open the key-paste flow instead (which is ALSO the rotation
        // surface tester 2-1 asked for).
        btn.onclick = () => toggleOllamaKeyFlow(btn)
        if (reloginBtn) {
          reloginBtn.textContent = C.ollamaKeyReplace
          reloginBtn.onclick = () => toggleOllamaKeyFlow(reloginBtn)
        }
        wireOllamaKeyFlow(statusEl)
      }
    }
  }

  // ── ollama key flow (key-mode, 2026-08-04): same write-only paste pattern
  // as initClaudeKeyRow below -- the key is never rendered back; validation
  // is the server's real authenticated call against ollama.com and storage
  // happens there on success. ──────────────────────────────────────────────
  function toggleOllamaKeyFlow(btn) {
    const flow = $('conn-ollama-flow')
    if (!flow) return
    const opening = flow.classList.contains('hidden')
    flow.classList.toggle('hidden', !opening)
    if (btn) btn.blur()
  }

  function wireOllamaKeyFlow(statusEl) {
    const input = $('conn-ollama-key')
    const saveBtn = $('conn-ollama-save')
    const lineEl = $('conn-ollama-status-line')
    if (!input || !saveBtn || !lineEl) return
    input.placeholder = C.ollamaKeyPlaceholder
    saveBtn.textContent = C.ollamaKeySave
    // Straight line to the key console (0.67 feedback: the paste flow
    // stranded anyone who did not already HAVE a key). House pattern:
    // window.open -> main.cjs setWindowOpenHandler -> shell.openExternal.
    const getKeyBtn = $('conn-ollama-get-key')
    if (getKeyBtn) {
      getKeyBtn.textContent = C.ollamaKeyGet
      getKeyBtn.onclick = () => window.open(C.links.ollamaKeys, '_blank', 'noopener')
    }
    saveBtn.onclick = async () => {
      const key = input.value.trim()
      if (!key) return
      saveBtn.disabled = true
      lineEl.textContent = C.ollamaKeyValidating
      try {
        const body = { provider: 'ollama', key }
        try {
          const cfg = await api('/api/config')
          if (cfg.MODEL) body.model = cfg.MODEL // model verdict rides along when one is configured
        } catch (err) { /* key check still runs without the model hint */ }
        const result = await api('/api/byok/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!result.ok) {
          lineEl.textContent = GEN(result.reason || 'invalid key')
          return
        }
        // detail is the server's verbatim receipt (includes the soft
        // model-missing warning when modelPresent === false)
        lineEl.textContent = ''
        statusEl.textContent = result.detail || C.providerConnected
        showToast(C.ollamaKeySaved)
        $('conn-ollama-flow').classList.add('hidden')
        input.value = ''
      } catch (err) {
        lineEl.textContent = GEN(err.message)
      } finally {
        saveBtn.disabled = false
      }
    }
  }

  // ── usage gauge (tester request 2026-08-04): claude subscription only in
  // v1. The server's null-not-zero contract is honored verbatim here: a
  // null pct renders as 'unreadable', never as 0%. ────────────────────────
  // ── usage gauges, one line per lane (2026-08-04 evening, the owner: "ollama/
  // Codex/Claude 사용량 게이지 ... 이게 킥임") ──────────────────────────
  const at = (iso, dateToo) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return dateToo ? `resets ${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${t}` : `resets ${t}`
    } catch { return '' }
  }
  const staleNoteOf = (u) => (u.stale && u.asOf
    ? (() => { try { const d = new Date(u.asOf); return C.usageStaleNote(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) } catch { return '' } })()
    : '')

  // ── gauge DOM (2026-08-05, the owner: 텍스트 말고 진짜 게이지 "보기쉽게") ────
  // Thresholds per the owner 11:55 ("80퍼센트 넘으면 주황색 / 90퍼센트 넘으면
  // 빨간색"): <80 ok(green), 80-89 warn(orange), 90+ hot(red).
  // pctVal == null renders a striped track labeled unreadable — the server's
  // null-not-zero contract survives the move from text to bars.
  const GAUGE_WARN = 80
  const GAUGE_HOT = 90
  function gaugeSeg({ label, pctVal, meta }) {
    const seg = document.createElement('div')
    seg.className = 'usage-seg'
    const lab = document.createElement('span')
    lab.className = 'usage-seg-label'
    lab.textContent = label
    const bar = document.createElement('div')
    bar.className = 'usage-bar'
    const pctSpan = document.createElement('span')
    pctSpan.className = 'usage-seg-pct'
    if (pctVal == null) {
      bar.classList.add('unreadable')
      pctSpan.textContent = C.usageUnreadable
    } else {
      const fill = document.createElement('div')
      fill.className = 'usage-fill'
      if (pctVal >= GAUGE_HOT) fill.classList.add('hot')
      else if (pctVal >= GAUGE_WARN) fill.classList.add('warn')
      fill.style.width = `${Math.max(0, Math.min(100, pctVal))}%`
      bar.appendChild(fill)
      pctSpan.textContent = `${pctVal}%`
    }
    seg.appendChild(lab)
    seg.appendChild(bar)
    seg.appendChild(pctSpan)
    if (meta) {
      const m = document.createElement('span')
      m.className = 'usage-seg-meta'
      m.textContent = meta
      seg.appendChild(m)
    }
    return seg
  }
  // laneEl(id, name): reset the lane row to name + empty body, return body.
  function laneBody(id, name) {
    const lane = $(id)
    if (!lane) return null
    lane.textContent = ''
    const nameEl = document.createElement('span')
    nameEl.className = 'usage-lane-name'
    nameEl.textContent = name
    const body = document.createElement('div')
    body.className = 'usage-lane-body'
    lane.appendChild(nameEl)
    lane.appendChild(body)
    return body
  }
  function laneNote(body, text) {
    const n = document.createElement('div')
    n.className = 'usage-lane-note'
    n.textContent = text
    body.appendChild(n)
  }

  async function renderClaudeUsageLine(force) {
    let body = laneBody('conn-usage-lane-claude', C.usageLaneClaude)
    if (!body) return
    laneNote(body, C.usageLoading)
    let u
    try { u = await api(`/api/usage/claude${force ? '?force=1' : ''}`) } catch (err) {
      body = laneBody('conn-usage-lane-claude', C.usageLaneClaude); laneNote(body, GEN(err.message)); return
    }
    body = laneBody('conn-usage-lane-claude', C.usageLaneClaude)
    if (!u.ok) {
      laneNote(body, u.branch === 'no_token' ? C.usageNoToken : (u.detail || C.usageError))
      // The real fix for the stuck "HTTP 429" (2026-08-13): the setup-token
      // the app holds carries user:inference only, which the usage endpoint
      // refuses. Offer a one-click full-scope login that mints a credential
      // the meter can actually read. Shown on ANY failure -- a 429/403 here
      // is exactly the scope-refusal case, and no_token means nothing is
      // connected yet either.
      usageConnectBtn(body, force)
      return
    }
    body.appendChild(gaugeSeg({ label: '5h', pctVal: u.fiveHourPct, meta: at(u.fiveHourResetsAt, false) }))
    body.appendChild(gaugeSeg({ label: C.usageWinWeekly, pctVal: u.weeklyPct, meta: at(u.weeklyResetsAt, true) }))
    if (u.fablePct != null) body.appendChild(gaugeSeg({ label: C.usageWinFable, pctVal: u.fablePct }))
    // Name whose login the meter reads: cli-session = this machine's Claude
    // CLI; app-login = the setup-token (scope-limited, may degrade); the
    // full-scope usage-oauth credential needs no note (it is the intended one).
    const srcNote = u.source === 'cli-session' ? C.usageCliSourceNote
      : (u.source === 'app-login' ? C.usageSetupTokenSourceNote : '')
    const notes = [srcNote, staleNoteOf(u)].filter(Boolean)
    if (notes.length) laneNote(body, notes.join(' · '))
  }

  // Full-scope usage-login flow (loopback OAuth). Starts the server session,
  // opens the authorize URL in the browser (window.open -> shell.openExternal
  // in the app), then polls status until a terminal state. On 'connected' it
  // re-renders the gauge -- which now reads the fresh full-scope credential.
  const USAGE_LOGIN_POLL_MS = 1500
  function usageConnectBtn(body, force) {
    const btn = document.createElement('button')
    btn.className = 'secondary'
    btn.style.marginTop = '0.4rem'
    btn.textContent = C.usageConnectCta
    const status = document.createElement('div')
    status.className = 'usage-lane-note'
    btn.onclick = async () => {
      btn.disabled = true
      status.textContent = C.usageConnectStarting
      let r
      try {
        r = await api('/api/usage-login/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
      } catch (err) { btn.disabled = false; status.textContent = GEN(err.message); return }
      if (r && r.authorizeUrl) window.open(r.authorizeUrl, '_blank', 'noopener')
      status.textContent = C.usageConnectWaiting
      pollUsageLogin(btn, status, force)
    }
    body.appendChild(btn)
    body.appendChild(status)
  }

  function pollUsageLogin(btn, status, force) {
    setTimeout(async () => {
      let s
      try { s = await api('/api/usage-login/status') } catch (err) { status.textContent = GEN(err.message); btn.disabled = false; return }
      if (s.state === 'connected') { status.textContent = C.usageConnectDone; renderClaudeUsageLine(true); return }
      if (s.state === 'failed' || s.state === 'cancelled') {
        btn.disabled = false
        status.textContent = s.reason === 'timeout' ? C.usageConnectTimeout : C.usageConnectFailed
        return
      }
      pollUsageLogin(btn, status, force) // awaiting_authorize / exchanging -> keep polling
    }, USAGE_LOGIN_POLL_MS)
  }

  async function renderCodexUsageLine(force) {
    let body = laneBody('conn-usage-lane-codex', C.usageLaneCodex)
    if (!body) return
    laneNote(body, C.usageLoading)
    let u
    try { u = await api(`/api/usage/codex${force ? '?force=1' : ''}`) } catch (err) {
      body = laneBody('conn-usage-lane-codex', C.usageLaneCodex); laneNote(body, GEN(err.message)); return
    }
    body = laneBody('conn-usage-lane-codex', C.usageLaneCodex)
    if (!u.ok) {
      laneNote(body, u.branch === 'no_token' ? C.usageCodexNoLogin : (u.detail || C.usageError))
      return
    }
    // Window label from its actual length -- a prolite plan's PRIMARY
    // window is 7 days, never assume 5h (live receipt 19:3x).
    const winLabel = (w) => (w && w.windowSeconds
      ? (w.windowSeconds >= 6 * 86400 ? C.usageWinWeekly : (w.windowSeconds <= 6 * 3600 ? '5h' : `${Math.round(w.windowSeconds / 3600)}h`))
      : '')
    const windows = [u.primary, u.secondary].filter(Boolean)
    if (!windows.length) { laneNote(body, C.usageUnreadable) }
    for (const w of windows) {
      body.appendChild(gaugeSeg({ label: winLabel(w), pctVal: w.usedPct, meta: at(w.resetsAt, (w.windowSeconds || 0) >= 86400) }))
    }
    const notes = [u.planType || '', staleNoteOf(u)].filter(Boolean)
    if (notes.length) laneNote(body, notes.join(' · '))
  }

  async function renderOllamaUsageLine(force) {
    let body = laneBody('conn-usage-lane-ollama', C.usageLaneOllama)
    if (!body) return
    laneNote(body, C.usageLoading)
    let u
    try { u = await api(`/api/usage/ollama${force ? '?force=1' : ''}`) } catch (err) {
      body = laneBody('conn-usage-lane-ollama', C.usageLaneOllama); laneNote(body, GEN(err.message)); return
    }
    body = laneBody('conn-usage-lane-ollama', C.usageLaneOllama)
    if (!u.ok) {
      // unknown_shape carries the endpoint's field names -- the first
      // real-key refresh is the schema receipt (undocumented endpoint).
      const msg = u.branch === 'no_key' ? C.usageOllamaNoKey
        : u.branch === 'unknown_shape' ? C.usageOllamaUnknownShape(u.detail || '')
        : (u.detail || C.usageError)
      laneNote(body, msg)
      return
    }
    // Shape bound 19:38 (real-key receipt): session/weekly 0-1 fractions
    // served as pct; no reset timestamps in the payload -- none shown.
    body.appendChild(gaugeSeg({ label: C.usageLaneSession, pctVal: u.sessionPct }))
    body.appendChild(gaugeSeg({ label: C.usageWinWeekly, pctVal: u.weeklyPct, meta: u.weeklyRequests != null ? C.usageOllamaReqs(u.weeklyRequests) : '' }))
    const stale = staleNoteOf(u)
    if (stale) laneNote(body, stale)
  }

  // force=true (the Refresh icon) rides ?force=1 through to the server so a
  // manual refresh actually re-parses instead of bouncing off the 60s cache
  // (the owner 11:55: 진입 시 1회 파싱 + 수동 리프레시 — 주기 폴링은 원래 없음,
  // 이 페이지가 진입 시 한 번 부르고 끝이다).
  async function renderUsage(force) {
    const label = $('conn-usage-label')
    const btn = $('conn-usage-refresh')
    if (!label || !btn) return
    label.textContent = C.usageLabel
    btn.textContent = '↻'
    btn.title = C.usageRefresh
    btn.setAttribute('aria-label', C.usageRefresh)
    btn.onclick = () => renderUsage(true)
    // Three independent lanes -- one slow/failed fetch must not blank the
    // other two, so no await-chaining, no Promise.all.
    renderClaudeUsageLine(force)
    renderCodexUsageLine(force)
    renderOllamaUsageLine(force)
  }

  async function runProviderTest(provider, statusEl, btn) {
    btn.disabled = true
    statusEl.textContent = C.providerTestRunning
    try {
      const body = { provider }
      if (provider === 'ollama') {
        // include the live MODEL so the ollama branch checks the model the
        // agent will actually spawn with, not just the key. No key in the
        // body: the server falls back to the STORED key for exactly this
        // Test path (and the route never persists an empty key).
        try {
          const cfg = await api('/api/config')
          if (cfg.MODEL) body.model = cfg.MODEL
        } catch (err) { /* model check degrades to key-only check */ }
      }
      // path fix (2026-08-04): this used to POST /api/agent/validate-key,
      // a route that never existed -- the 404 surfaced as a generic error.
      const r = await api('/api/byok/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // the server's detail is the receipt -- show it verbatim, never a
      // synthesized "OK" the probe didn't actually say
      statusEl.textContent = r.detail || r.reason || (r.ok ? C.providerTestOk : C.providerTestFail)
    } catch (err) {
      statusEl.textContent = GEN(err.message)
    } finally {
      btn.disabled = false
    }
  }

  function startAuth(provider, statusEl, btn, force) {
    btn.disabled = true
    statusEl.textContent = C.providerAuthRunning
    api(`/api/onboarding/login/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(force ? { force: true } : {}),
    })
      .then(() => pollAuth(provider, statusEl, btn))
      .catch((err) => {
        btn.disabled = false
        statusEl.textContent = GEN(err.message)
      })
  }

  function pollAuth(provider, statusEl, btn) {
    setTimeout(async () => {
      let status
      try {
        status = await api(`/api/onboarding/login/${provider}/status`)
      } catch (err) {
        btn.disabled = false
        statusEl.textContent = GEN(err.message)
        return
      }
      if (status.state === 'success') {
        statusEl.textContent = C.providerConnected
        btn.disabled = false
        showToast(C.providerAuthSuccess)
        // Re-render the whole row set instead of hand-hiding the clicked
        // button: the caller can be the first-auth button OR the Re-login
        // button (2-1 fix), and renderProviderAuth() derives the correct
        // visibility for all three from live /api/config state.
        renderProviderAuth().catch(() => {})
        return
      }
      if (status.state === 'failed') {
        btn.disabled = false
        statusEl.textContent = failureText(provider, status.code)
        return
      }
      pollAuth(provider, statusEl, btn) // idle/running -> keep polling
    }, LOGIN_POLL_MS)
  }

  // ── Discord reconnect: MOVED to channels.js (multichannel v0.0.18) ──────
  // The messenger group (discord reconnect + slack/telegram) now lives on
  // /channels -- this page's axis narrowed to LLM-side connections only
  // (provider auth, BYOK key, claude.ai connectors, serving receipt).

  // ── chatgpt live serving receipt ("셸은 현실") ────────────────────────────
  // One-shot on page load: shows the proxy's own /health model when something
  // answers, nothing when it doesn't. Silence-when-down is honest -- a stale
  // "serving X" line would be the exact live-lie class this receipt exists
  // to kill.
  async function renderChatgptReceipt() {
    const el = $('conn-provider-chatgpt-receipt')
    el.textContent = ''
    try {
      const health = await api('/api/proxy/health')
      if (!health.running) return
      el.textContent = health.model ? C.chatgptServing(health.model) : C.chatgptServingUnknown
    } catch (err) {
      console.error('proxy health probe failed:', err)
    }
  }

  // ── Claude subscription re-login row (2026-08-04, the owner "connectors에서
  // 클로드도 re-login 가능하게 해야겠는데?" + "claude API Key는 없애버리고")
  // -- replaces the BYOK key-paste row. Same in-app `claude setup-token`
  // capture the wizard runs (/api/setup-token/* -- the server session is a
  // singleton, so wizard and this page can never race two children), with
  // the same resume-on-load rule: a flow left in flight by another page
  // restarts its poll here instead of sitting on a dead status line. ──────
  const SETUP_POLL_MS = 2000
  let setupPollTimer = null
  function stopSetupPoll() {
    if (setupPollTimer) { clearInterval(setupPollTimer); setupPollTimer = null }
  }

  function initClaudeSubRow(available) {
    $('conn-provider-claude-name').textContent = C.claudeSubName
    const statusEl = $('conn-provider-claude-status')
    // null available = config read failed -> neutral, not a false "Not
    // connected" (same fix as the provider rows above).
    const loadFailed = !Array.isArray(available)
    const connected = !loadFailed && available.includes('claude-subscription')
    if (loadFailed) setChip(statusEl, '', C.providerStatusUnknown)
    else setChip(statusEl, connected ? 'ok' : '', connected ? C.providerConnected : C.providerNotConnected)
    const btn = $('conn-provider-claude-btn')
    const cancelBtn = $('conn-claude-cancel')
    const flow = $('conn-claude-flow')
    const lineEl = $('conn-claude-status-line')
    const codeField = $('conn-claude-code-field')
    const codeInput = $('conn-claude-code')
    const codeBtn = $('conn-claude-code-btn')
    btn.textContent = connected ? C.claudeSubRelogin : C.claudeSubLogin
    // Unified row grammar (0.67 feedback "기능좀 일원화"): every connected
    // provider row carries the same Test + Re-login pair. Test reuses the
    // SAME generic probe the other rows hit -- the server's
    // claude-subscription branch falls back to the stored setup-token when
    // the body carries no key (mirroring the ollama fallback), so this
    // works keyless exactly like the ollama Test path.
    const testBtn = $('conn-provider-claude-test')
    if (testBtn) {
      testBtn.textContent = C.providerTestButton
      testBtn.classList.toggle('hidden', !connected)
      testBtn.onclick = () => runProviderTest('claude-subscription', statusEl, testBtn)
    }
    cancelBtn.textContent = C.claudeSubCancel
    $('conn-claude-code-hint').textContent = C.claudeSubCodePrompt
    codeBtn.textContent = C.claudeSubCodeButton

    // In-app Claude login via loopback OAuth (G15, drops the Claude Code CLI
    // dependency the old setup-token flow required). No paste code: the browser
    // redirect lands on the app's own 127.0.0.1 listener and the exchange runs
    // in-process, so the code-paste field stays hidden for this flow. States
    // come from oauth-usage-session.cjs: awaiting_authorize / exchanging are
    // pending, connected / failed / cancelled are terminal.
    codeField.classList.add('hidden') // loopback flow never pastes a code
    function applyStatus(s) {
      const st = s && s.state
      if (st === 'awaiting_authorize' || st === 'running') {
        flow.classList.remove('hidden')
        lineEl.className = 'status-line pending'
        lineEl.textContent = C.claudeSubWaiting
        btn.disabled = true
        cancelBtn.classList.remove('hidden')
      } else if (st === 'exchanging' || st === 'validating') {
        lineEl.className = 'status-line pending'
        lineEl.textContent = C.claudeSubValidating
        btn.disabled = true
      } else if (st === 'connected') {
        stopSetupPoll()
        lineEl.textContent = ''
        flow.classList.add('hidden')
        cancelBtn.classList.add('hidden')
        btn.disabled = false
        btn.textContent = C.claudeSubRelogin
        statusEl.textContent = C.providerConnected
        showToast(C.claudeSubSuccess)
      } else if (st === 'failed' || st === 'cancelled') {
        stopSetupPoll()
        lineEl.className = 'status-line failure'
        lineEl.textContent = C.claudeSubFailure(s.reason)
        cancelBtn.classList.add('hidden')
        btn.disabled = false
      }
    }

    function startSetupPoll() {
      stopSetupPoll()
      setupPollTimer = setInterval(async () => {
        try { applyStatus(await api('/api/claude-login/status')) } catch (err) { /* transient: keep polling */ }
      }, SETUP_POLL_MS)
    }

    btn.onclick = async () => {
      btn.disabled = true
      flow.classList.remove('hidden')
      lineEl.className = 'status-line pending'
      lineEl.textContent = C.claudeSubStarting
      let r
      try {
        r = await api('/api/claude-login/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
      } catch (err) {
        lineEl.className = 'status-line failure'
        lineEl.textContent = GEN(err.message)
        btn.disabled = false
        return
      }
      // Open the authorize page in the user's browser (window.open ->
      // main.cjs setWindowOpenHandler -> shell.openExternal). On a re-entrant
      // start the server may return no URL (a flow is already live); keep the
      // one the browser already has.
      if (r && r.authorizeUrl) window.open(r.authorizeUrl, '_blank', 'noopener')
      applyStatus(r)
      startSetupPoll()
    }

    cancelBtn.onclick = async () => {
      try {
        applyStatus(await api('/api/claude-login/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }))
      } catch (err) { stopSetupPoll() }
    }

    // Resume: a login left running (wizard hand-off or a reload of this page)
    // must restart its poll -- the server session outlives the page, the
    // interval does not.
    api('/api/claude-login/status').then((s) => {
      if (!s || s.state === 'idle') return
      applyStatus(s)
      if (s.state === 'awaiting_authorize' || s.state === 'running' || s.state === 'exchanging') startSetupPoll()
    }).catch(() => {})
  }

  // ── claude.ai connector intercept (IA v0.0.9, internal design) ───────────────
  // List connectors, authorize via the in-app URL-capture flow. The lane
  // warning renders FIRST when the running lane can't use connectors even
  // after authorizing -- honesty over a dead button.
  const MCP_POLL_MS = 2000

  async function renderMcpConnectors() {
    $('conn-mcp-label').textContent = C.mcpLabel
    // (subtitle removed in the 대공사 — the section label carries it now)
    const statusEl = $('conn-mcp-status')
    const entriesEl = $('conn-mcp-entries')
    const warnEl = $('conn-mcp-lane-warning')
    statusEl.textContent = C.mcpLoading
    entriesEl.innerHTML = ''

    let result
    try {
      result = await api('/api/mcp-connectors')
    } catch (err) {
      statusEl.textContent = GEN(err.message)
      return
    }

    if (result.laneWarning) {
      warnEl.textContent = C.mcpLaneWarning(result.laneWarning)
      warnEl.classList.remove('hidden')
    } else {
      warnEl.classList.add('hidden')
    }

    if (!result.ok && result.reason === 'cli_missing') { statusEl.textContent = C.mcpCliMissing; return }
    const connectors = Array.isArray(result.connectors) ? result.connectors : []
    if (connectors.length === 0) { statusEl.textContent = C.mcpNone; return }
    statusEl.textContent = ''

    for (const conn of connectors) {
      const row = document.createElement('div')
      row.className = 'entry-row'
      const main = document.createElement('div')
      main.className = 'entry-main'
      const nameEl = document.createElement('div')
      nameEl.className = 'entry-value'
      nameEl.textContent = conn.name
      const statusLine = document.createElement('div')
      statusLine.className = 'entry-meta'
      statusLine.textContent = conn.status === 'connected' ? C.mcpConnected : C.mcpNeedsAuth
      main.appendChild(nameEl)
      main.appendChild(statusLine)
      row.appendChild(main)
      if (conn.status !== 'connected') {
        const btn = document.createElement('button')
        btn.className = 'secondary'
        btn.textContent = C.mcpAuthButton
        btn.onclick = () => startMcpAuth(conn.name, statusLine, btn)
        row.appendChild(btn)
      }
      entriesEl.appendChild(row)
    }
  }

  function startMcpAuth(name, statusLine, btn) {
    btn.disabled = true
    statusLine.textContent = C.mcpAuthStarting
    api('/api/mcp-connector/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorName: name }),
    })
      .then(() => pollMcpAuth(name, statusLine, btn))
      .catch((err) => { btn.disabled = false; statusLine.textContent = GEN(err.message) })
  }

  function pollMcpAuth(name, statusLine, btn) {
    setTimeout(async () => {
      let status
      try {
        status = await api(`/api/mcp-connector/status?name=${encodeURIComponent(name)}`)
      } catch (err) {
        btn.disabled = false
        statusLine.textContent = GEN(err.message)
        return
      }
      if (status.state === 'url_ready') {
        // The URL is the deliverable. Render it as an open-page action plus
        // the "approve then restart" note -- approval is stored remotely and
        // only loads on the NEXT agent start.
        statusLine.textContent = C.mcpUrlReady
        btn.disabled = false
        btn.textContent = C.mcpOpenLink
        btn.onclick = () => { window.open(status.detail, '_blank', 'noopener') }
        return
      }
      if (status.state === 'failed') {
        btn.disabled = false
        statusLine.textContent = status.code === 'timeout' ? C.mcpAuthTimeout : C.mcpAuthFailed
        return
      }
      pollMcpAuth(name, statusLine, btn) // running -> keep polling
    }, MCP_POLL_MS)
  }


  // ══ ENGINE CARDS (moved from settings.js, tab merge 2026-08-06 — the owner
  // "Settings 탭에 너무 많은 기능" → engine cluster lives beside the
  // provider sign-ins it configures). Copy keys stay under
  // COPY.settings.* (aliased as S below) — moving ~70 keys was churn
  // without behavior. ═════════════════════════════════════════════════

  // ── agent model/effort config ───────────────────────────────────────────
  // Moved from memory.js's renderAgentControl (Slice 2, 2026-07-09) -- the
  // SELECT-driven half. The read-only status-display half (current
  // model/effort as text, start/stop/restart, mute-revert) now lives in the
  // nav.js shell; this page only writes config. Disable-lock is scoped to
  // just the two selects below (the shell's own start/stop/restart/
  // mute-revert controls lock independently in nav.js -- see there for why
  // this split doesn't recreate the original single 5-control lock).

  // Model catalog + provider gate. A model is selectable only if its provider
  // is the onboarded PROVIDER (single-provider today; claude-subscription
  // counts as claude). Claude ids use CLI aliases (version-independent).
  // Catalog reorg (the owner 2026-07-14 09:45, verbatim ask): "프로바이더별로
  // 정리좀 합시다 ... 버전까지 명시해줘". Groups render as <optgroup>; ids are
  // EXPLICIT versioned model ids, replacing the old version-independent CLI
  // aliases ('opus'/'sonnet'). Existing installs with an alias still stored
  // surface it via the pinned "(current)" passthrough below -- honest, and it
  // heals on the next swap.
  //
  // Receipts for the Claude ids (all ran live in the the reference fleet):
  // claude-fable-5 + claude-opus-4-8 (ps-verified boots, 07-14),
  // claude-opus-4-6 (fleet default lane), claude-sonnet-5 (conf swap
  // 57e4744, ran 07-05). GPT: gpt-5.6-terra ran live (a separate lane, 07-10);
  // sol/luna are the owner-named siblings -- live-verify on first swap, the
  // mute-strike ledger is the backstop either way.
  // The real model rows live in the SHARED static catalog
  // (js/model-catalog.cjs, loaded before this file) since the chat composer
  // grew its own quick-switch dropdown (0.2.6, the owner 08-20 19:09) — one list,
  // two surfaces. This page adds its two ACTION sentinels on top: they are
  // settings-page interactions (reveal a form section), not models, so the
  // chat dropdown never sees them. Row provenance/verification history moved
  // to model-catalog.cjs.
  // Sentinel model-select value for the Custom catalog entry (custom-
  // provider addition, 2026-07-25) -- never sent to the server as a real
  // model id (see the onchange handler's early-return branch for it).
  const CUSTOM_MODEL_SENTINEL = '__custom__'
  // Ollama by-URL picker sentinel (2026-08-04) -- same action-not-state
  // contract as CUSTOM_MODEL_SENTINEL; never sent to the server.
  const OLLAMA_URL_SENTINEL = '__ollama_url__'
  const CLAUDE_PROVIDERS = ['claude', 'claude-cli', 'claude-subscription'] // for dynamic-merge rows below; static rows carry their own copy
  const MODEL_CATALOG = window.SCHZ_MODEL_CATALOG.map((row) => ({ ...row }))
  // By-URL action row sits at the END of the Ollama group (after the last
  // Ollama model, before the DSH rows), exactly where the inline literal
  // kept it. Gated on the ollama provider being authed (unlike Custom,
  // which opts out of gating entirely).
  const lastOllamaIdx = MODEL_CATALOG.reduce((acc, row, i) => (row.group === 'Ollama' ? i : acc), -1)
  MODEL_CATALOG.splice(lastOllamaIdx + 1, 0,
    { id: OLLAMA_URL_SENTINEL, label: S.ollamaUrlCatalogLabel, group: 'Ollama', providers: ['ollama'] })
  // Custom: ACTION entry, not a switchable state -- points at the custom
  // proxy section below. `custom: true` opts it out of the provider gate.
  MODEL_CATALOG.push(
    { id: CUSTOM_MODEL_SENTINEL, label: S.customCatalogLabel, group: 'Custom', custom: true, providers: [] })

  // Effort selector (the owner 07-13 click-test item 2: sonnet-5 felt slow -- the
  // old hardwired max bought thinking budget casual chat doesn't need).
  // 'high' is run.sh's own `${EFFORT_LEVEL:-high}` default; labels say so
  // rather than pre-selecting silently.
  const EFFORT_LEVELS = window.SCHZ_EFFORT_LEVELS
  const EFFORT_DEFAULT = window.SCHZ_EFFORT_DEFAULT

  let currentProvider = null
  let currentModel = ''
  let currentEffort = EFFORT_DEFAULT
  // Providers with a usable credential/login artifact right now, computed
  // server-side (07-13 multi-provider unlock). The onboarded provider is
  // always treated as available even if the server list momentarily misses
  // it -- the running agent is its own proof.
  let availableProviders = []
  let agentConfigBusy = false

  function setAgentConfigDisabled(disabled) {
    agentConfigBusy = disabled
    $('set-model-select').disabled = disabled
    $('set-effort-select').disabled = disabled
  }

  // Same shape as nav.js's fireControl (POST + disable-lock + error toast) --
  // kept as its own local copy rather than shared, since it locks a disjoint
  // set of controls (see file-header note above). Unlike nav.js, this one
  // re-enables as soon as the request resolves rather than waiting for a
  // polled 'settled' state: this page carries no status poller of its own
  // (pollAgentStatusOnce lives solely in nav.js now), and the real safety net
  // either way is server-side (main.cjs awaits confirmed process death before
  // any respawn) -- the client disable here is UX-only, same as before.
  async function fireControl(action, body) {
    if (agentConfigBusy) return false
    setAgentConfigDisabled(true)
    try {
      await api(`/api/agent/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      return true
    } catch (err) {
      console.error(`agent ${action} failed:`, err)
      showToast(GEN(err.message))
      return false
    } finally {
      setAgentConfigDisabled(false)
    }
  }

  // Dynamic Claude rows (2026-08-13, the owner: "모델 리스트 하드코딩 말고
  // 다이나믹하게"). The server scans the installed CLI binary's own model
  // table; ids the static catalog does not know are spliced into the Claude
  // group, so a model that ships in a CLI update appears here without an app
  // release. Static rows keep their curated labels and order; dynamic rows
  // get a generated label. One fetch per page load; every failure path
  // leaves the static catalog exactly as it was.
  let dynamicClaudeMerged = false
  function claudeLabelOf(id) {
    // claude-opus-4-8 -> "Claude Opus 4.8"; claude-haiku-4-5 -> "Claude Haiku 4.5"
    const parts = id.replace(/^claude-/, '').split('-')
    const words = []
    for (let i = 0; i < parts.length; i++) {
      if (/^\d/.test(parts[i])) { words.push(parts.slice(i).join('.')); break }
      words.push(parts[i].charAt(0).toUpperCase() + parts[i].slice(1))
    }
    return `Claude ${words.join(' ')}`
  }
  async function mergeDynamicClaudeModels() {
    if (dynamicClaudeMerged) return
    dynamicClaudeMerged = true // one attempt per page load, success or not
    try {
      const r = await api('/api/model-catalog/claude')
      const models = Array.isArray(r && r.models) ? r.models : []
      const fresh = models.filter((m) => m && typeof m.id === 'string' && !MODEL_CATALOG.some((row) => row.id === m.id))
      if (fresh.length) {
        // Splice after the last static Claude row so the group stays
        // contiguous for the <optgroup> builder.
        const lastClaudeIdx = MODEL_CATALOG.reduce((acc, row, i) => (row.group === 'Claude' ? i : acc), -1)
        MODEL_CATALOG.splice(lastClaudeIdx + 1, 0,
          ...fresh.map((m) => ({ id: m.id, label: claudeLabelOf(m.id), group: 'Claude', providers: CLAUDE_PROVIDERS })))
      }
    } catch (err) { /* route down = static catalog stands */ }
    // Ollama half (2026-08-13): the live ollama.com catalog rides the same
    // merge -- curated rows keep their labels/order, everything else the
    // catalog carries lands after them (before the by-URL sentinel, which
    // stays the group's last row). Tags ARE the identity for ollama models,
    // so dynamic rows use the raw tag as label.
    try {
      const r = await api('/api/model-catalog/ollama')
      const names = Array.isArray(r && r.models) ? r.models : []
      const fresh = names.filter((n) => typeof n === 'string' && n && !MODEL_CATALOG.some((row) => row.id === n))
      if (fresh.length) {
        const sentinelIdx = MODEL_CATALOG.findIndex((row) => row.id === OLLAMA_URL_SENTINEL)
        const at = sentinelIdx === -1 ? MODEL_CATALOG.length : sentinelIdx
        MODEL_CATALOG.splice(at, 0,
          ...fresh.map((n) => ({ id: n, label: n, group: 'Ollama', providers: ['ollama'] })))
      }
    } catch (err) { /* route down = static catalog stands */ }
  }

  function populateModelSelect(model) {
    const sel = $('set-model-select')
    sel.innerHTML = ''
    // If the live MODEL isn't a catalog id (e.g. an old stored alias like
    // 'opus'/'sonnet' from before the versioned catalog, or a hand-pinned id),
    // surface it as-is so the dropdown reflects reality, not a guess.
    if (model && !MODEL_CATALOG.some((m) => m.id === model)) {
      const opt = document.createElement('option')
      opt.value = model
      opt.textContent = `${model} (current)`
      opt.selected = true
      sel.appendChild(opt)
    }
    // Grouped by provider family (<optgroup>), per the owner 2026-07-14. Group
    // order follows catalog order; entries without a group land at top level.
    const groups = new Map()
    for (const m of MODEL_CATALOG) {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = m.label
      // A model is selectable if ANY of its providers is authenticated --
      // not just the currently-running one (07-13 multi-provider unlock).
      // `m.custom` entries (custom-provider addition) opt OUT of this gate
      // entirely -- they are an action link into the section below, not a
      // switchable state, so availableProviders never applies to them.
      if (!m.custom && !m.providers.some((p) => availableProviders.includes(p))) opt.disabled = true
      // Models withdrawn for observed production failure (see catalog note).
      if (m.disabled) opt.disabled = true
      if (m.id === model) opt.selected = true
      if (m.group) {
        if (!groups.has(m.group)) {
          const og = document.createElement('optgroup')
          og.label = m.group
          groups.set(m.group, og)
          sel.appendChild(og)
        }
        groups.get(m.group).appendChild(opt)
      } else {
        sel.appendChild(opt)
      }
    }
  }

  function populateEffortSelect(effort) {
    const sel = $('set-effort-select')
    sel.innerHTML = ''
    for (const level of EFFORT_LEVELS) {
      const opt = document.createElement('option')
      opt.value = level
      opt.textContent = level === EFFORT_DEFAULT ? `${level} (default)` : level
      if (level === effort) opt.selected = true
      sel.appendChild(opt)
    }
  }

  // ── apply-state line (IA v0.0.9, red-team fold #1) ───────────────────────
  // The selects above are INTENT; the running child is REALITY (recorded at
  // spawn, GET /api/agent/spawn-info). This line explains the gap between
  // them -- most importantly the FAILED state: a spawn refused by the proxy
  // model-receipt gate (07-14 live catch class) lands its reason here, next
  // to the picker that caused it, not only in the app log.
  async function renderApplyState() {
    const el = $('set-apply-state')
    if (!el) return
    el.textContent = S.applyChecking
    let status = null
    let spawn = null
    try {
      status = await api('/api/agent/status')
      spawn = (await api('/api/agent/spawn-info')).spawn
    } catch (err) {
      console.error('apply-state probe failed:', err)
      el.textContent = ''
      return
    }
    if (status.state === 'failed') {
      el.textContent = S.applyFailed(status.detail || status.code || 'unknown')
      return
    }
    if (status.state === 'stopped' || status.state === 'idle') {
      el.textContent = S.applyStopped
      return
    }
    if (status.state === 'connecting') {
      el.textContent = S.applyPending(spawn && spawn.model ? spawn.model : '?')
      return
    }
    // live: compare reality against the current selects' intent.
    const intentModel = $('set-model-select').value
    const intentEffort = $('set-effort-select').value
    if (spawn && spawn.model === intentModel && (spawn.effort || EFFORT_DEFAULT) === intentEffort) {
      el.textContent = S.applyApplied(spawn.model, spawn.effort || EFFORT_DEFAULT)
    } else {
      el.textContent = S.applyMismatch(spawn && spawn.model ? spawn.model : '?')
    }
  }

  // After a model/effort change fires a restart, follow the settle rather
  // than leaving a stale line: poll status until it leaves 'connecting'
  // (bounded), then render the final verdict. This page deliberately has no
  // standing poller (nav.js owns the 2s one); this loop exists only while a
  // change is in flight.
  async function settleApplyState() {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const status = await api('/api/agent/status')
        if (status.state !== 'connecting') break
        $('set-apply-state').textContent = S.applyPending($('set-model-select').value)
      } catch { break }
    }
    renderApplyState()
  }

  // The provider a model switch must run under: keep the current provider
  // when it can serve the model, otherwise the first authenticated provider
  // that can. Returns null when none can (shouldn't happen for an enabled
  // option, but fail closed).
  function providerForModel(modelId) {
    const entry = MODEL_CATALOG.find((m) => m.id === modelId)
    if (!entry) return currentProvider // pinned non-catalog id: stay put
    if (entry.providers.includes(currentProvider)) return currentProvider
    return entry.providers.find((p) => availableProviders.includes(p)) || null
  }

  async function renderAgentConfig(cfgIn) {
    $('set-agent-config-label').textContent = S.agentConfigLabel
    $('set-model-label').textContent = S.modelLabel
    $('set-effort-label').textContent = S.effortLabel

    let cfg = cfgIn || {}
    if (!cfgIn) {
      try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    }
    currentProvider = cfg.PROVIDER || null
    currentModel = cfg.MODEL || ''
    currentEffort = EFFORT_LEVELS.includes(cfg.EFFORT_LEVEL) ? cfg.EFFORT_LEVEL : EFFORT_DEFAULT
    availableProviders = Array.isArray(cfg.availableProviders) ? cfg.availableProviders.slice() : []
    if (currentProvider && !availableProviders.includes(currentProvider)) availableProviders.push(currentProvider)
    await mergeDynamicClaudeModels() // no-op after the first call; static catalog stands on any failure
    populateModelSelect(currentModel)
    populateEffortSelect(currentEffort)

    $('set-model-select').onchange = async (e) => {
      const model = e.target.value
      // Custom (custom-provider addition, 2026-07-25): an action, not a
      // state -- reset the dropdown back to what is actually running and
      // point the user at the always-visible section below instead of
      // firing a model-swap POST with a sentinel that is not a real id.
      if (model === CUSTOM_MODEL_SENTINEL) {
        e.target.value = currentModel
        const section = $('set-custom')
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      // Ollama by-URL picker (the owner 19:17): action row, same contract as
      // Custom above -- reset the select, reveal the paste field.
      if (model === OLLAMA_URL_SENTINEL) {
        e.target.value = currentModel
        const field = $('set-ollama-url-field')
        if (field) { field.classList.remove('hidden'); $('set-ollama-url-input').focus() }
        return
      }
      if (model === currentModel) return
      const provider = providerForModel(model)
      if (!provider) { e.target.value = currentModel; return } // fail closed: no authed provider serves it
      const ok = await window.confirmDialog(S.switchConfirm(model), S.switchOk, S.cancel)
      if (!ok) { e.target.value = currentModel; return }
      const prevModel = currentModel
      const prevProvider = currentProvider
      currentModel = model
      currentProvider = provider
      const accepted = await fireControl('model', provider !== prevProvider ? { model, provider } : { model })
      if (!accepted) {
        currentModel = prevModel
        currentProvider = prevProvider
        e.target.value = prevModel
        return
      }
      settleApplyState()
    }

    // ── ollama by-URL apply (the owner 19:17: "URL 입력받아서 ...
    // /library/{model_name} 파싱해서 드랍다운리스트에 없어도 모델 셀렉
    // 가능") ────────────────────────────────────────────────────────────
    $('set-ollama-url-hint').textContent = S.ollamaUrlHint
    $('set-ollama-url-input').placeholder = S.ollamaUrlPlaceholder
    $('set-ollama-url-apply').textContent = S.ollamaUrlApply
    $('set-ollama-url-apply').onclick = async () => {
      const raw = $('set-ollama-url-input').value.trim()
      const statusLine = $('set-ollama-url-status')
      const applyBtn = $('set-ollama-url-apply')
      if (!raw) return
      // Accept the library URL (https://ollama.com/library/kimi-k3, with or
      // without scheme/query/fragment) OR a bare model id (name / name:tag).
      // The URL form never carries a tag; a pasted bare id may.
      let parsed = null
      const urlMatch = raw.match(/ollama\.com\/library\/([A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?)/)
      if (urlMatch) parsed = urlMatch[1]
      else if (/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(raw)) parsed = raw
      if (!parsed) {
        statusLine.className = 'status-line failure'
        statusLine.textContent = S.ollamaUrlParseFailed
        return
      }
      if (!availableProviders.includes('ollama')) {
        statusLine.className = 'status-line failure'
        statusLine.textContent = S.ollamaUrlNoKey
        return
      }
      applyBtn.disabled = true
      statusLine.className = 'status-line pending'
      statusLine.textContent = S.ollamaUrlChecking(parsed)
      // Pre-flight against ollama.com with the STORED key (keyless validate
      // falls back to it server-side) -- today's field day was one wrong
      // model name after another, so the catalog check runs before the
      // restart, not after. Warn-don't-block on model absence: the catalog
      // fetch is best-effort and a brand-new model may lag it.
      let warnLine = ''
      try {
        const v = await api('/api/byok/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'ollama', model: parsed }),
        })
        if (v.ok === false) {
          statusLine.className = 'status-line failure'
          statusLine.textContent = GEN(v.reason || 'validation failed')
          applyBtn.disabled = false
          return
        }
        if (v.modelPresent === false) warnLine = S.ollamaUrlModelWarn(parsed)
      } catch (err) { /* validate blip: proceed, the turn-error banner backstops */ }
      const ok = await window.confirmDialog(
        (warnLine ? warnLine + ' ' : '') + S.switchConfirm(parsed), S.switchOk, S.cancel)
      if (!ok) { applyBtn.disabled = false; statusLine.textContent = ''; return }
      const prevModel = currentModel
      const prevProvider = currentProvider
      currentModel = parsed
      currentProvider = 'ollama'
      const accepted = await fireControl('model', prevProvider !== 'ollama' ? { model: parsed, provider: 'ollama' } : { model: parsed })
      applyBtn.disabled = false
      if (!accepted) {
        currentModel = prevModel
        currentProvider = prevProvider
        statusLine.className = 'status-line failure'
        statusLine.textContent = S.ollamaUrlApplyFailed
        return
      }
      statusLine.className = 'status-line success'
      statusLine.textContent = S.ollamaUrlApplied(parsed)
      populateModelSelect(parsed)
      settleApplyState()
    }

    $('set-effort-select').onchange = async (e) => {
      const effort = e.target.value
      if (effort === currentEffort) return
      const ok = await window.confirmDialog(S.effortConfirm(effort), S.switchOk, S.cancel)
      if (!ok) { e.target.value = currentEffort; return }
      const prevEffort = currentEffort
      currentEffort = effort
      const accepted = await fireControl('effort', { effort })
      if (!accepted) {
        currentEffort = prevEffort
        e.target.value = prevEffort
        return
      }
      settleApplyState()
    }

    renderApplyState()
  }

  // ── custom provider (generic OpenAI-compatible proxy) ───────────────────
  // Settings-page-only addition (2026-07-25) -- like claude-subscription/
  // chatgpt/ollama before it (see http-server.cjs's ROUTER_WIRED comment),
  // there is no onboarding-wizard tab: reachable only from here, via its
  // own dedicated POST /api/agent/custom-provider (base URL + optional API
  // key + model id together -- no existing single-purpose endpoint accepted
  // all three). Always visible, same convention as Autonomy/Topology/Sudo
  // above: every category on this page is shown regardless of the current
  // provider, not gated on it -- switching TO custom and editing an
  // already-custom install's fields are the same form.
  // Comparison for the save-time credential warning below. ORIGIN, not host:
  // an earlier version dropped the scheme, so moving a saved credential from
  // https://api.vendor.com to http://api.vendor.com read as "same host" and
  // said nothing -- a silent TLS downgrade that puts the key on the wire in
  // cleartext. Same host, different port is also a different service and
  // counts. A path change does not. Anything unparseable is treated as
  // DIFFERENT (warn rather than stay quiet); the server validates the URL for
  // real, this only decides whether to say something.
  const originOf = (u) => { try { return new URL(u).origin } catch { return '' } }
  const sameOrigin = (a, b) => { const x = originOf(a); return Boolean(x) && x === originOf(b) }

  // Decides whether saving is about to send an API key somewhere it was not
  // paired with. Pulled out as a PURE function on purpose: this predicate got
  // it wrong twice (once warning on the wrong comparison, once phrasing the
  // wrong key), and both times nothing could catch it because browser JS has
  // no test harness here. tests/test-custom-key-host.mjs extracts this
  // function by name from this file's source and executes it -- so renaming it
  // breaks that test loudly, which is the intended trade.
  //
  // Returns { warn, stored, priorUrl }. `stored` selects the copy: a stored
  // key and a pasted key are different objects and the dialog must not call
  // one the other.
  function credentialCrossesHosts({ nextUrl, typedKey, keyFromPaste, pastedKeyBaseUrl, storedUrl, hasStoredKey }) {
    const typed = String(typedKey || '').trim()
    const reusingStoredKey = !typed && Boolean(hasStoredKey)
    const carryingPastedKey = Boolean(typed) && Boolean(keyFromPaste)
    if (!reusingStoredKey && !carryingPastedKey) return { warn: false, stored: false, priorUrl: '' }
    // A pasted key's reference host is the URL that arrived WITH it; a stored
    // key's is the URL it was stored under. One comparison cannot serve both.
    const priorUrl = carryingPastedKey ? String(pastedKeyBaseUrl || '') : String(storedUrl || '')
    // No reference recorded is UNKNOWN, not safe -- a key stored through
    // /api/byok/validate leaves no CUSTOM_BASE_URL behind, and a stored key
    // with no known host would otherwise travel anywhere in silence. A pasted
    // key with no baseUrl cannot happen (the paste is refused without one),
    // so that branch stays quiet rather than crying wolf.
    const warn = priorUrl ? !sameOrigin(priorUrl, nextUrl) : reusingStoredKey
    return { warn, stored: reusingStoredKey, priorUrl }
  }

  // A preset pre-fills the Base URL, and (for the cloud providers) a starter
  // Model ID; the fields stay editable afterward. `detect` is an optional
  // predicate on a pasted API key that auto-selects the preset when the key's
  // shape is UNAMBIGUOUS -- only a few are (sk-ant-api03 = a real Anthropic
  // key, sk-or- = OpenRouter, the id.secret pair = z.ai/Zhipu). Kimi and
  // DeepSeek both issue plain `sk-` keys indistinguishable from each other and
  // from OpenAI, so they carry NO detector and rely on the user's pick -- a
  // wrong guess that routes a key to the wrong vendor is worse than no guess.
  const CUSTOM_PRESETS = [
    { label: S.customPresetClinePass, url: 'http://localhost:18084' },
    { label: S.customPresetGrok, url: 'http://localhost:8766' },
    { label: S.customPresetOllamaCloud, url: 'http://localhost:11434' },
    { label: S.customPresetCodexApi, url: 'http://localhost:18080' },
    // OpenAI-compatible cloud providers. Model IDs are editable starters --
    // vendors rotate defaults (verified current 2026-08-31, but check the
    // vendor's console if a call 404s on the model).
    { label: S.customPresetKimi, url: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6' },
    { label: S.customPresetDeepSeek, url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { label: S.customPresetZai, url: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6',
      // z.ai / Zhipu keys are the legacy `{32-hex-id}.{16-alnum-secret}` pair,
      // structurally distinct from every plain `sk-` key here.
      detect: (k) => /^[a-f0-9]{32}\.[A-Za-z0-9]{16,}$/.test(k) },
  ]

  async function renderCustomProvider(cfgIn) {
    $('set-custom-label').textContent = S.customLabel
    $('set-custom-note').textContent = S.customNote
    $('set-custom-preset-label').textContent = S.customPresetLabel
    $('set-custom-url-label').textContent = S.customUrlLabel
    $('set-custom-key-label').textContent = S.customKeyLabel
    $('set-custom-model-label').textContent = S.customModelLabel
    $('set-custom-model-input').placeholder = S.customModelPlaceholder
    $('set-custom-save').textContent = S.customSave

    const presetSel = $('set-custom-preset-select')
    presetSel.innerHTML = ''
    const blankOpt = document.createElement('option')
    blankOpt.value = ''
    blankOpt.textContent = S.customPresetPlaceholder
    presetSel.appendChild(blankOpt)
    for (const preset of CUSTOM_PRESETS) {
      const opt = document.createElement('option')
      opt.value = preset.url
      opt.textContent = preset.label
      presetSel.appendChild(opt)
    }
    // Populate the URL field on pick, and the Model ID field too when the
    // preset carries a starter model. Both stay plain text inputs the user can
    // still edit afterward -- the preset only pre-fills them. The option value
    // is the base URL; the matching preset row carries the model.
    presetSel.onchange = () => {
      if (!presetSel.value) return
      $('set-custom-url-input').value = presetSel.value
      const picked = CUSTOM_PRESETS.find((p) => p.url === presetSel.value)
      if (picked && picked.model && !$('set-custom-model-input').value.trim()) {
        $('set-custom-model-input').value = picked.model
      }
    }

    let cfg = cfgIn || {}
    if (!cfgIn) {
      try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    }
    $('set-custom-url-input').value = cfg.CUSTOM_BASE_URL || ''
    // Model id only pre-fills from the live config when custom is ALREADY
    // the running provider -- otherwise cfg.MODEL belongs to whatever
    // provider IS running, and showing it here would silently imply it is
    // this proxy's model.
    $('set-custom-model-input').value = cfg.PROVIDER === 'custom' ? (cfg.MODEL || '') : ''
    // Write-only, same convention as the sudo password field: never
    // reflects the stored value, only whether one exists (hasCustomApiKey,
    // GET /api/config). Cleared on every render, including right after a
    // successful save below.
    $('set-custom-key-input').value = ''
    $('set-custom-key-input').placeholder = cfg.hasCustomApiKey ? S.customKeyStoredPlaceholder : S.customKeyEmptyPlaceholder
    // Whether the value sitting in the key field came from a PASTE rather than
    // from the user's own typing -- the save-time host warning below turns on
    // it. Declared per render, so it resets with the form; cleared as soon as
    // the user edits the field, because from that point the value is theirs
    // and they chose it against the URL they can see.
    let keyFromPaste = false
    // The baseUrl that arrived in the SAME paste as the key. This is the host
    // the pasted key was paired with, and the only correct thing to compare a
    // later URL change against.
    let pastedKeyBaseUrl = ''
    $('set-custom-key-input').oninput = () => {
      keyFromPaste = false; pastedKeyBaseUrl = ''
      // Unambiguous-key auto-detect: if the user has NOT already picked a
      // preset or typed a Base URL, and the key they just entered matches a
      // preset's `detect`, select that preset for them (fills URL + model).
      // Only the structurally-unique key shapes carry a detector, so this can
      // never mis-route a plain `sk-` key -- see CUSTOM_PRESETS.
      if (presetSel.value || $('set-custom-url-input').value.trim()) return
      const k = $('set-custom-key-input').value.trim()
      if (!k) return
      const hit = CUSTOM_PRESETS.find((p) => typeof p.detect === 'function' && p.detect(k))
      if (hit) { presetSel.value = hit.url; presetSel.onchange() }
    }

    // Pasted definition (2026-07-29). Resolves server-side and fills the three
    // fields above; it never saves. The status line stays visible after a
    // successful fill (unlike the save path's transient toast) because the
    // user's next action is to look UP at fields that just changed under them.
    $('set-custom-json-status').classList.add('hidden') // stale "filled in" must not survive a re-render (this runs again after every save)
    $('set-custom-json-summary').textContent = S.customJsonSummary
    $('set-custom-json-note').textContent = S.customJsonNote
    $('set-custom-json-input').placeholder = S.customJsonPlaceholder
    $('set-custom-json-load').textContent = S.customJsonLoad
    $('set-custom-json-load').onclick = async () => {
      const statusEl = $('set-custom-json-status')
      statusEl.classList.add('hidden')
      const json = $('set-custom-json-input').value
      if (!json.trim()) {
        statusEl.textContent = S.customJsonEmpty
        statusEl.classList.remove('hidden')
        return
      }
      const btn = $('set-custom-json-load')
      btn.disabled = true
      try {
        const parsed = await api('/api/agent/custom-provider/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ json }),
        })
        $('set-custom-url-input').value = parsed.baseUrl
        $('set-custom-model-input').value = parsed.model
        // ALWAYS assign, never `if (parsed.apiKey)`. A conditional here leaks
        // across fills: paste A carries a key, paste B (a different endpoint)
        // does not, and the key field -- type="password", so the user cannot
        // see it -- still holds A's key, which then gets saved and sent to B's
        // host. Every fill leaves the field showing exactly what the CURRENT
        // paste says. (Red-team catch, 2026-07-29.)
        $('set-custom-key-input').value = parsed.apiKey || ''
        keyFromPaste = Boolean(parsed.apiKey)
        pastedKeyBaseUrl = parsed.apiKey ? parsed.baseUrl : ''
        // Blank field means "keep the stored key" at the save route, so when
        // the paste has no key AND one is on file, say so -- otherwise the
        // user switches endpoint believing no key is involved while the
        // previous provider's key keeps being sent.
        statusEl.textContent = parsed.apiKey
          ? S.customJsonLoadedWithKey
          : (cfg.hasCustomApiKey ? S.customJsonLoadedKeptKey : S.customJsonLoaded)
        statusEl.classList.remove('hidden')
      } catch (err) {
        // The server's refusals are the useful message here (">1 provider",
        // unsupported api dialect, bad base URL) -- show them verbatim rather
        // than flattening every failure into one generic line.
        statusEl.textContent = GEN(err.message)
        statusEl.classList.remove('hidden')
      } finally {
        btn.disabled = false
      }
    }

    $('set-custom-save').onclick = async () => {
      const statusEl = $('set-custom-status')
      statusEl.classList.add('hidden')
      const baseUrl = $('set-custom-url-input').value.trim()
      const model = $('set-custom-model-input').value.trim()
      const apiKey = $('set-custom-key-input').value
      if (!baseUrl || !model) {
        statusEl.textContent = S.customMissingFields
        statusEl.classList.remove('hidden')
        return
      }
      // A key is about to be sent to a host it was not entered for.
      //
      // Two ways to get here, and the confirm dialog is the only place that
      // catches BOTH, which is why the check lives at save rather than at the
      // point any single field changes:
      //   1. A pasted definition filled the key field for endpoint A, then the
      //      preset dropdown or the URL box changed the host to B. Nothing
      //      clears the key on those paths (see presetSel.onchange above), and
      //      the field is type="password" so a populated one is invisible.
      //   2. The field is BLANK and a key is on file. Blank means "keep the
      //      stored key" at the save route -- the documented convention -- so
      //      changing only the URL silently re-points the stored credential at
      //      a new host. That path predates the paste box entirely.
      // Both end with a credential at a host the user never paired it with.
      // We do not block it (pointing one key at two proxies is legitimate);
      // we refuse to let it happen without saying the host out loud.
      // NOT warned about: a key the user typed into the field during this
      // visit. They entered it while looking at the URL box, so it is the
      // host they meant. Warning there would fire on the single most common
      // flow -- "switching proxies, here is its key" -- and a warning that
      // cries wolf on the normal case gets clicked through on the abnormal
      // one, which costs more than it saves. Hence keyFromPaste, cleared the
      // moment the user touches the field themselves.
      // TWO cases, TWO reference hosts. Collapsing them onto one comparison
      // (the stored CUSTOM_BASE_URL) was wrong in both directions:
      //   - it MISSED the leak it was written for. Saved localhost:8766, paste
      //     vendor-A's url+key, then pick the Grok preset -> url returns to
      //     localhost:8766, stored-vs-final says "same host", no warning, and
      //     vendor A's key is saved against localhost:8766.
      //   - it FIRED on the normal case. Paste a definition whose baseUrl and
      //     apiKey travel together, change nothing, and it warned -- about a
      //     key that was paired with that exact host inside the same blob.
      // A pasted key's reference is the URL that arrived WITH it; a stored
      // key's reference is the URL it was stored under.
      const verdict = credentialCrossesHosts({
        nextUrl: baseUrl,
        typedKey: apiKey,
        keyFromPaste,
        pastedKeyBaseUrl,
        storedUrl: cfg.CUSTOM_BASE_URL || '',
        hasStoredKey: Boolean(cfg.hasCustomApiKey),
      })
      // Three outcomes, three strings -- see copy.js. `priorOrigin` is empty
      // when the reference URL is missing OR unparseable, and both mean the
      // same thing to the user: we cannot name the host it came from, so we
      // must not print one.
      const nextOrigin = originOf(baseUrl) || baseUrl
      const priorOrigin = originOf(verdict.priorUrl)
      let confirmText
      if (!verdict.warn) confirmText = S.customSwitchConfirm(model)
      else if (!verdict.stored) confirmText = S.customSwitchConfirmPastedKeyToNewHost(model, nextOrigin, priorOrigin || verdict.priorUrl)
      else if (priorOrigin) confirmText = S.customSwitchConfirmKeyToNewHost(model, nextOrigin, priorOrigin)
      else confirmText = S.customSwitchConfirmKeyNoPriorHost(model, nextOrigin)
      const ok = await window.confirmDialog(confirmText, S.switchOk, S.cancel)
      if (!ok) return
      const btn = $('set-custom-save')
      btn.disabled = true
      try {
        await api('/api/agent/custom-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl, apiKey, model }),
        })
        showToast(S.customSaved)
        // Re-read from the server, never trust the form (same principle
        // saveAutonomy() follows above) -- this also refreshes the model
        // select so the new custom model shows as "(current)" and
        // availableProviders now includes 'custom'.
        await renderCustomProvider()
        await renderAgentConfig()
        settleApplyState()
      } catch (err) {
        statusEl.textContent = GEN(err.message)
        statusEl.classList.remove('hidden')
      } finally {
        btn.disabled = false
      }
    }
  }

  // ── attach topology (0.1.0 prep, design-0016) ────────────────────────────
  // Select = intent (written to config, effective at next start/restart);
  // the state line + bootstrap card = reality from /api/topology. The app
  // NEVER runs the bootstrap -- it hands out the exact terminal line, because
  // TCC attribution must descend from the user's terminal, not from this
  // per-release binary (the entire point of the topology).
  async function renderTopology() {
    $('set-topology-label').textContent = S.topologyLabel
    $('set-topology-note').textContent = S.topologyNote
    $('set-topology-select-label').textContent = S.topologySelectLabel
    $('set-topology-save').textContent = S.topologySave
    $('set-topology-bootstrap-why').textContent = S.topologyBootstrapWhy
    $('set-topology-bootstrap-copy').textContent = S.topologyBootstrapCopy

    const sel = $('set-topology-select')
    sel.innerHTML = ''
    for (const [value, label] of [['spawn', S.topologySpawnOption], ['attach', S.topologyAttachOption]]) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      sel.appendChild(opt)
    }

    let topo = null
    try {
      topo = await api('/api/topology')
    } catch (err) {
      $('set-topology-state').textContent = GEN(err.message)
      return
    }
    sel.value = topo.topology
    renderTopologyState(topo)

    $('set-topology-bootstrap-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('set-topology-bootstrap-cmd').value)
        showToast(S.topologyBootstrapCopied)
      } catch (err) {
        console.error('clipboard write failed:', err)
      }
    }

    $('set-topology-save').onclick = async () => {
      const statusEl = $('set-topology-status')
      try {
        await api('/api/topology', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topology: sel.value }),
        })
        showToast(S.topologySaved)
        statusEl.classList.add('hidden')
        const fresh = await api('/api/topology')
        renderTopologyState(fresh)
      } catch (err) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = GEN(err.message)
      }
    }
  }

  function renderTopologyState(topo) {
    const stateEl = $('set-topology-state')
    const card = $('set-topology-bootstrap-card')
    if (topo.topology !== 'attach') {
      stateEl.textContent = S.topologyStateSpawn
      card.classList.add('hidden')
      return
    }
    if (!topo.tmuxPresent) {
      stateEl.textContent = S.topologyStateNoTmux
      card.classList.add('hidden')
      return
    }
    if (topo.sessionPresent) {
      stateEl.textContent = topo.paneDead ? S.topologyStatePaneDead : S.topologyStateAttached(topo.attachCmd)
      card.classList.add('hidden')
      return
    }
    stateEl.textContent = S.topologyStateBootstrapNeeded
    $('set-topology-bootstrap-cmd').value = topo.bootstrapCmd
    card.classList.remove('hidden')
  }

  // ── prerequisite doctor (2026-08-06, 0.67 clean-mac feedback: agent
  // silently dead with nothing installed and nothing saying why). Rows are
  // server truth from GET /api/doctor -- the claude-cli row runs the SAME
  // resolver the spawn gate uses, so this card and the spawn verdict can
  // never disagree. The install field surfaces the official installer
  // command (npm needs Node 22+ -- exactly the dependency class a clean
  // machine doesn't have; see main.cjs CLAUDE_INSTALL_COMMAND). ──────────
  async function renderDoctor() {
    $('conn-doctor-label').textContent = C.doctorLabel
    $('conn-doctor-note').textContent = C.doctorNote
    const recheck = $('conn-doctor-recheck')
    recheck.textContent = C.doctorRecheck
    recheck.onclick = () => {
      recheck.disabled = true
      renderDoctor().finally(() => { recheck.disabled = false })
    }
    let doc
    try {
      doc = await api('/api/doctor')
    } catch (err) {
      $('conn-doctor-note').textContent = GEN(err.message)
      return
    }
    const rowsEl = $('conn-doctor-rows')
    rowsEl.textContent = ''
    const installField = $('conn-doctor-install-field')
    installField.classList.add('hidden')
    for (const row of doc.rows) {
      const wrap = document.createElement('div')
      wrap.className = 'entry-row'
      const main = document.createElement('div')
      main.className = 'entry-main'
      const name = document.createElement('div')
      name.className = 'entry-value'
      name.textContent = row.id === 'claude-cli' ? C.doctorRowClaudeCli : C.doctorRowCredential(row.provider)
      const meta = document.createElement('div')
      meta.className = 'entry-meta'
      // present shows the receipt (the resolved bin path), never a bare
      // synthesized "OK" -- same honesty rule as the provider Test button.
      setChip(meta, row.present ? 'ok' : 'err', row.present ? (row.detail || C.doctorPresent) : C.doctorMissing)
      main.appendChild(name)
      main.appendChild(meta)
      if (row.id === 'provider-credential' && !row.present) {
        const hint = document.createElement('div')
        hint.className = 'entry-meta'
        hint.textContent = C.doctorCredentialFix
        main.appendChild(hint)
      }
      wrap.appendChild(main)
      rowsEl.appendChild(wrap)
      if (row.id === 'claude-cli' && !row.present && row.installCommand) {
        installField.classList.remove('hidden')
        $('conn-doctor-install-hint').textContent = C.doctorInstallHint
        const cmd = $('conn-doctor-install-cmd')
        cmd.value = row.installCommand
        const copyBtn = $('conn-doctor-install-copy')
        copyBtn.textContent = C.doctorInstallCopy
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(cmd.value)
            showToast(C.doctorInstallCopied)
          } catch (err) {
            console.error('clipboard write failed:', err)
            cmd.select()
          }
        }
        const docsBtn = $('conn-doctor-docs')
        docsBtn.classList.toggle('hidden', !row.docsUrl)
        docsBtn.textContent = C.doctorDocs
        docsBtn.onclick = () => window.open(row.docsUrl, '_blank', 'noopener')
      }
    }
  }

  async function init() {
    $('conn-title').textContent = C.title

    // One /api/config for the whole load (2026-08-07 consolidation — this
    // used to be 4 identical GETs: here + the three renders below). Renders
    // triggered later by events still fetch their own fresh copy.
    let cfg = null
    try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    initClaudeSubRow(cfg && Array.isArray(cfg.availableProviders) ? cfg.availableProviders : null)
    renderChatgptReceipt()
    renderMcpConnectors()

    await renderProviderAuth(cfg)
    renderUsage()

    // Engine cards (tab merge 2026-08-06). Topology is a macOS-only
    // surface, hidden rather than rendered empty on Windows -- same rule
    // its settings.js home applied (the owner, first win install 2026-08-03).
    renderAgentConfig(cfg)
    renderCustomProvider(cfg).catch((err) => console.error(err))
    renderDoctor().catch((err) => console.error(err))
    // design-0023 P4: attachTopology is the server's capability, and it is a
    // PROBE (mac AND a tmux this machine can actually run) rather than the
    // page's own `IS_MAC` guess. The card's entire content is a tmux attach
    // command; offering it where no tmux exists is the same class of lie as
    // the x-apple deep links on Windows.
    if (window.can('attachTopology')) {
      renderTopology().catch((err) => console.error(err))
    } else {
      const el = document.getElementById('set-topology')
      if (el) el.classList.add('hidden')
    }
  }

  init()
})()
