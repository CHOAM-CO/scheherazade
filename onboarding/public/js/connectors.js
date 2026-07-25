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
    }
  }

  function startAuth(provider, statusEl, btn) {
    btn.disabled = true
    statusEl.textContent = C.providerAuthRunning
    api(`/api/onboarding/login/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
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
        btn.classList.add('hidden')
        btn.disabled = false
        showToast(C.providerAuthSuccess)
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

  // ── Claude BYOK key row (status + re-entry; the key itself is never
  // rendered back) ─────────────────────────────────────────────────────────
  function initClaudeKeyRow(available) {
    $('conn-provider-claude-name').textContent = C.claudeKeyName
    const statusEl = $('conn-provider-claude-status')
    statusEl.textContent = available.includes('claude') ? C.claudeKeyStored : C.claudeKeyMissing
    const btn = $('conn-provider-claude-btn')
    btn.textContent = C.claudeKeyButton
    btn.classList.remove('hidden')
    const flow = $('conn-claude-flow')
    $('conn-claude-key').placeholder = C.claudeKeyPlaceholder
    $('conn-claude-save').textContent = C.claudeKeySave
    btn.onclick = () => {
      const opening = flow.classList.contains('hidden')
      flow.classList.toggle('hidden', !opening)
      btn.textContent = opening ? C.claudeKeyClose : C.claudeKeyButton
    }
    $('conn-claude-save').onclick = async () => {
      const key = $('conn-claude-key').value.trim()
      if (!key) return
      const saveBtn = $('conn-claude-save')
      const lineEl = $('conn-claude-status-line')
      saveBtn.disabled = true
      lineEl.textContent = C.claudeKeyValidating
      try {
        const result = await api('/api/byok/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'claude', key }),
        })
        if (!result.ok) {
          lineEl.textContent = GEN(result.reason || 'invalid key')
          return
        }
        lineEl.textContent = ''
        statusEl.textContent = C.claudeKeyStored
        showToast(C.claudeKeySaved)
        flow.classList.add('hidden')
        btn.textContent = C.claudeKeyButton
        $('conn-claude-key').value = ''
      } catch (err) {
        lineEl.textContent = GEN(err.message)
      } finally {
        saveBtn.disabled = false
      }
    }
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
    initClaudeKeyRow(Array.isArray(cfg.availableProviders) ? cfg.availableProviders : [])
    renderChatgptReceipt()
    renderMcpConnectors()

    await renderProviderAuth()
  }

  init()
})()
