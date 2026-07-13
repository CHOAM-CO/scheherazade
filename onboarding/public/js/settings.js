// settings.js — settings page: rename agent + post-onboarding provider auth
// (07-13 multi-provider unlock) + Slack placeholder.
;(function () {
  const C = window.COPY.settings
  const GEN = window.COPY.genericError

  // Login-capable providers only -- claude/claude-subscription auth happens
  // in onboarding (key/token paste), not via a shell-out login flow, and the
  // server's /api/onboarding/login allowlist would 400 them anyway.
  const AUTH_PROVIDERS = ['chatgpt', 'ollama']
  const LOGIN_POLL_MS = 2000

  function $(id) { return document.getElementById(id) }

  async function api(path, options) {
    const opts = options ? { ...options } : {}
    // localhost-auth gate (security review, 2026-07-03): every mutating
    // (non-GET) request must carry the per-launch token the server
    // injected into this page's <head> -- see copy.js's getOnboardToken().
    if (opts.method && opts.method !== 'GET') {
      opts.headers = { ...(opts.headers || {}), 'X-Onboard-Token': window.getOnboardToken() || '' }
    }
    const res = await fetch(path, opts)
    let body = {}
    try {
      body = await res.json()
    } catch (err) {
      throw new Error(`non-JSON response from ${path}: ${err.message}`)
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status} from ${path}`)
    return body
  }

  function showToast(text) {
    const el = $('set-toast')
    el.textContent = text
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
  }

  // ── autonomous cycle (v0.0.6) ──────────────────────────────────────────
  // This section shows the user a number that is being spent on their behalf
  // while they sleep, so it is written to be un-flatterable:
  //   - the token count is the SAME number the cap is enforced against
  //   - when the meter cannot measure, it says that instead of showing 0
  //   - "used 0 tokens" and "cannot tell you how many tokens" never render
  //     the same way, because only one of them means nothing was spent
  const fmtTokens = (n) => Number(n || 0).toLocaleString()

  function renderAutonomy(a) {
    $('set-autonomy-enabled').checked = a.enabled === true
    $('set-autonomy-start').value = a.windowStart
    $('set-autonomy-end').value = a.windowEnd
    $('set-autonomy-cap').value = String(a.cap)

    const usageEl = $('set-autonomy-usage')
    if (a.usage && a.usage.ok) {
      usageEl.textContent = `${C.autonomyUsageLabel}: ${fmtTokens(a.usage.used)} / ${fmtTokens(a.usage.cap)} (${a.usage.usedPct}%)`
    } else {
      // Not a blank, not a zero. The one sentence the user must never be
      // shown wrongly is "you spent nothing".
      usageEl.textContent = C.autonomyUsageBlind
    }

    const lastEl = $('set-autonomy-last')
    if (a.lastCycle && a.lastCycle.day) {
      const bits = [a.lastCycle.stopped ? C.autonomyLastCycleStopped : C.autonomyLastCycleRan]
      if (a.lastCycle.briefed) bits.push(C.autonomyLastCycleBriefed)
      lastEl.textContent = `${C.autonomyLastCycle} (${a.lastCycle.day}): ${bits.join(' / ')}`
    } else if (a.lastSkip) {
      lastEl.textContent = a.lastSkip.reason === 'cap' ? C.autonomySkipCap : C.autonomySkipMeter
    } else {
      lastEl.textContent = C.autonomyLastCycleNone
    }
  }

  async function loadAutonomy() {
    renderAutonomy(await api('/api/autonomy'))
  }

  async function saveAutonomy() {
    const statusEl = $('set-autonomy-status')
    statusEl.classList.add('hidden')
    const cap = Number(String($('set-autonomy-cap').value).replace(/[,\s]/g, ''))
    if (!Number.isFinite(cap) || cap < 0) {
      statusEl.textContent = C.autonomyInvalidCap
      statusEl.classList.remove('hidden')
      return
    }
    const btn = $('set-autonomy-save')
    btn.disabled = true
    try {
      await api('/api/autonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: $('set-autonomy-enabled').checked,
          windowStart: $('set-autonomy-start').value.trim(),
          windowEnd: $('set-autonomy-end').value.trim(),
          cap,
        }),
      })
      showToast(C.autonomySaved)
      await loadAutonomy() // re-read from the server, never trust the form
    } catch (err) {
      statusEl.textContent = /HH:MM|window/.test(err.message) ? C.autonomyInvalidWindow : (GEN.body || err.message)
      statusEl.classList.remove('hidden')
    } finally {
      btn.disabled = false
    }
  }

  async function init() {
    $('set-title').textContent = C.title
    $('set-back-link').textContent = C.backToMemory
    $('set-rename-label').textContent = C.renameLabel
    $('set-rename-save').textContent = C.renameButton
    $('set-slack-label').textContent = C.slackLabel
    $('set-slack-note').textContent = C.slackNote

    $('set-autonomy-label').textContent = C.autonomyLabel
    $('set-autonomy-note').textContent = C.autonomyNote
    $('set-autonomy-enabled-label').textContent = C.autonomyEnableLabel
    $('set-autonomy-window-label').textContent = C.autonomyWindowLabel
    $('set-autonomy-window-note').textContent = C.autonomyWindowNote
    $('set-autonomy-cap-label').textContent = C.autonomyCapLabel
    $('set-autonomy-cap-note').textContent = C.autonomyCapNote
    $('set-autonomy-save').textContent = C.autonomySave
    $('set-autonomy-save').addEventListener('click', saveAutonomy)
    loadAutonomy().catch((err) => console.error(err))

    try {
      const cfg = await api('/api/config')
      $('set-rename-input').value = cfg.DISPLAY_NAME || ''
    } catch (err) {
      console.error(err)
    }

    $('set-rename-save').onclick = async () => {
      const name = $('set-rename-input').value.trim()
      const statusEl = $('set-rename-status')
      if (!name) return
      try {
        await api('/api/settings/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: name }),
        })
        showToast(C.renameSaved)
        statusEl.classList.add('hidden')
      } catch (err) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = GEN(err.message)
      }
    }

    renderProviderAuth()
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

  async function renderProviderAuth() {
    $('set-providers-label').textContent = C.providersLabel
    $('set-providers-note').textContent = C.providersNote

    let available = []
    try {
      const cfg = await api('/api/config')
      available = Array.isArray(cfg.availableProviders) ? cfg.availableProviders : []
    } catch (err) {
      console.error(err)
    }

    for (const provider of AUTH_PROVIDERS) {
      $(`set-provider-${provider}-name`).textContent = C.providerNames[provider]
      const connected = available.includes(provider)
      const statusEl = $(`set-provider-${provider}-status`)
      const btn = $(`set-provider-${provider}-btn`)
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

  init()
})()
