// connectors.js — connectors page: provider auth (ChatGPT/Ollama) + Slack
// placeholder. Extracted verbatim from settings.js's post-onboarding
// provider-auth block (07-13 multi-provider unlock) per
// docs/ia-subpage-plan.md's /connectors split. Uses window.api() /
// window.showToast() from nav.js -- no local copies.
;(function () {
  const C = window.COPY.connectors
  const GEN = window.COPY.genericError

  // Login-capable providers only -- claude/claude-subscription auth happens
  // in onboarding (key/token paste), not via a shell-out login flow, and the
  // server's /api/onboarding/login allowlist would 400 them anyway.
  const AUTH_PROVIDERS = ['chatgpt', 'ollama']
  const LOGIN_POLL_MS = 2000

  function $(id) { return document.getElementById(id) }

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

  async function renderProviderAuth() {
    $('conn-providers-label').textContent = C.providersLabel
    $('conn-providers-note').textContent = C.providersNote

    let available = []
    try {
      const cfg = await api('/api/config')
      available = Array.isArray(cfg.availableProviders) ? cfg.availableProviders : []
    } catch (err) {
      console.error(err)
    }

    for (const provider of AUTH_PROVIDERS) {
      $(`conn-provider-${provider}-name`).textContent = C.providerNames[provider]
      const connected = available.includes(provider)
      const statusEl = $(`conn-provider-${provider}-status`)
      const btn = $(`conn-provider-${provider}-btn`)
      statusEl.textContent = connected ? C.providerConnected : C.providerNotConnected
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
        // key-mode (2026-08-04, Mino "ollama -> API키"): there is no login
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
  async function renderUsage() {
    const label = $('conn-usage-label')
    const line = $('conn-usage-line')
    const btn = $('conn-usage-refresh')
    if (!label || !line || !btn) return
    label.textContent = C.usageLabel
    btn.textContent = C.usageRefresh
    btn.onclick = () => renderUsage()
    line.textContent = C.usageLoading
    let u
    try {
      u = await api('/api/usage/claude')
    } catch (err) {
      line.textContent = GEN(err.message)
      return
    }
    if (!u.ok) {
      line.textContent = u.branch === 'no_token' ? C.usageNoToken : (u.detail || C.usageError)
      return
    }
    const pct = (v) => (v == null ? C.usageUnreadable : `${v}%`)
    const at = (iso, dateToo) => {
      if (!iso) return ''
      try {
        const d = new Date(iso)
        const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        return dateToo ? ` (resets ${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${t})` : ` (resets ${t})`
      } catch { return '' }
    }
    // stale reading: still show the numbers (last good), annotated with
    // when they were true -- a 429 should never blank a gauge (2026-08-04).
    const staleNote = u.stale && u.asOf
      ? (() => { try { const d = new Date(u.asOf); return ` · ${C.usageStaleNote(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` } catch { return '' } })()
      : ''
    line.textContent = `5h: ${pct(u.fiveHourPct)}${at(u.fiveHourResetsAt, false)} · weekly: ${pct(u.weeklyPct)}${at(u.weeklyResetsAt, true)}${staleNote}`
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

  // ── Claude subscription re-login row (2026-08-04, Mino "connectors에서
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
    const connected = available.includes('claude-subscription')
    statusEl.textContent = connected ? C.providerConnected : C.providerNotConnected
    const btn = $('conn-provider-claude-btn')
    const cancelBtn = $('conn-claude-cancel')
    const flow = $('conn-claude-flow')
    const lineEl = $('conn-claude-status-line')
    const codeField = $('conn-claude-code-field')
    const codeInput = $('conn-claude-code')
    const codeBtn = $('conn-claude-code-btn')
    btn.textContent = connected ? C.claudeSubRelogin : C.claudeSubLogin
    cancelBtn.textContent = C.claudeSubCancel
    $('conn-claude-code-hint').textContent = C.claudeSubCodePrompt
    codeBtn.textContent = C.claudeSubCodeButton

    function applyStatus(s) {
      const st = s && s.state
      if (st === 'running' || st === 'awaiting_code') {
        flow.classList.remove('hidden')
        lineEl.className = 'status-line pending'
        lineEl.textContent = C.claudeSubWaiting
        btn.disabled = true
        cancelBtn.classList.remove('hidden')
        // awaiting_code = the paste fallback is AVAILABLE, not required --
        // on most machines the localhost redirect wins and this stays hidden.
        if (st === 'awaiting_code') codeField.classList.remove('hidden')
      } else if (st === 'validating') {
        lineEl.className = 'status-line pending'
        lineEl.textContent = C.claudeSubValidating
        btn.disabled = true
      } else if (st === 'connected') {
        stopSetupPoll()
        lineEl.textContent = ''
        flow.classList.add('hidden')
        codeField.classList.add('hidden')
        cancelBtn.classList.add('hidden')
        btn.disabled = false
        btn.textContent = C.claudeSubRelogin
        statusEl.textContent = C.providerConnected
        showToast(C.claudeSubSuccess)
      } else if (st === 'failed' || st === 'cancelled') {
        stopSetupPoll()
        lineEl.className = 'status-line failure'
        lineEl.textContent = C.claudeSubFailure(s.reason)
        codeField.classList.add('hidden')
        cancelBtn.classList.add('hidden')
        btn.disabled = false
      }
    }

    function startSetupPoll() {
      stopSetupPoll()
      setupPollTimer = setInterval(async () => {
        try { applyStatus(await api('/api/setup-token/status')) } catch (err) { /* transient: keep polling */ }
      }, SETUP_POLL_MS)
    }

    btn.onclick = async () => {
      btn.disabled = true
      flow.classList.remove('hidden')
      lineEl.className = 'status-line pending'
      lineEl.textContent = C.claudeSubStarting
      try {
        applyStatus(await api('/api/setup-token/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }))
      } catch (err) {
        lineEl.className = 'status-line failure'
        lineEl.textContent = GEN(err.message)
        btn.disabled = false
        return
      }
      startSetupPoll()
    }

    cancelBtn.onclick = async () => {
      try {
        applyStatus(await api('/api/setup-token/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }))
      } catch (err) { stopSetupPoll() }
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
          lineEl.className = 'status-line failure'
          lineEl.textContent = C.claudeSubCodeInvalid
        } else {
          codeInput.value = ''
          applyStatus(s)
        }
      } catch (err) {
        lineEl.className = 'status-line failure'
        lineEl.textContent = GEN(err.message)
      } finally {
        codeBtn.disabled = false
      }
    }

    // Resume: a login left running by the wizard (or a reload of this page)
    // must restart its poll -- the server session outlives the page, the
    // interval does not. Same rule the wizard pins in test-setup-token-copy.
    api('/api/setup-token/status').then((s) => {
      if (!s || s.state === 'idle') return
      applyStatus(s)
      if (s.state === 'running' || s.state === 'awaiting_code' || s.state === 'validating') startSetupPoll()
    }).catch(() => {})
  }

  // ── claude.ai connector intercept (IA v0.0.9, 춘식3 design) ───────────────
  // List connectors, authorize via the in-app URL-capture flow. The lane
  // warning renders FIRST when the running lane can't use connectors even
  // after authorizing -- honesty over a dead button.
  const MCP_POLL_MS = 2000

  async function renderMcpConnectors() {
    $('conn-mcp-label').textContent = C.mcpLabel
    $('conn-mcp-note').textContent = C.mcpNote
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

  async function init() {
    $('conn-title').textContent = C.title

    let cfg = {}
    try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    initClaudeSubRow(Array.isArray(cfg.availableProviders) ? cfg.availableProviders : [])
    renderChatgptReceipt()
    renderMcpConnectors()

    await renderProviderAuth()
    renderUsage()
  }

  init()
})()
