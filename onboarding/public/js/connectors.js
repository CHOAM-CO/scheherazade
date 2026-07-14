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

  async function init() {
    $('conn-title').textContent = C.title
    $('conn-back-link').textContent = C.backToMemory
    $('conn-slack-label').textContent = C.slackLabel
    $('conn-slack-note').textContent = C.slackNote

    await renderProviderAuth()
  }

  init()
})()
