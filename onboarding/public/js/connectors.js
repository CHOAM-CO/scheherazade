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

  // ── Discord reconnect (IA v0.0.9): enumerate -> pick -> apply ────────────
  // 2-step server contract: POST /api/discord/reconnect/validate enumerates
  // guilds+channels for the token (stored token when the field is blank);
  // POST .../apply re-verifies the pick server-side, persists, and restarts
  // the agent (202 + the shell's own status poll shows the settle).
  // Failure branch copy reuses discordTutorial.failures verbatim -- same
  // three causes, same fixes.
  let enumeratedGuilds = []

  function discordFailureText(branch) {
    return window.COPY.discordTutorial.failures[branch] || GEN(branch || 'unknown')
  }

  function renderDiscordStatus(cfg) {
    $('conn-discord-name').textContent = C.discordName
    const statusEl = $('conn-discord-status')
    if (cfg.homeChannelId) {
      const guildLabel = cfg.HOME_GUILD_NAME || cfg.HOME_GUILD_ID || '?'
      const channelLabel = cfg.HOME_CHANNEL_NAME || cfg.homeChannelId
      statusEl.textContent = C.discordConnected(guildLabel, channelLabel)
    } else {
      statusEl.textContent = C.discordNotConnected
    }
  }

  function populateChannelPicker(guild) {
    const channelSel = $('conn-reconnect-channel')
    channelSel.innerHTML = ''
    if (!guild || guild.channels.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = C.discordNoChannels
      channelSel.appendChild(opt)
      $('conn-reconnect-apply').disabled = true
      return
    }
    for (const ch of guild.channels) {
      const opt = document.createElement('option')
      opt.value = ch.id
      opt.textContent = `#${ch.name}`
      channelSel.appendChild(opt)
    }
    $('conn-reconnect-apply').disabled = false
  }

  function populatePickers(result) {
    enumeratedGuilds = result.guilds
    const guildSel = $('conn-reconnect-guild')
    guildSel.innerHTML = ''
    for (const g of result.guilds) {
      const opt = document.createElement('option')
      opt.value = g.id
      opt.textContent = g.name || g.id
      guildSel.appendChild(opt)
    }
    guildSel.onchange = () => {
      const picked = enumeratedGuilds.find((g) => g.id === guildSel.value)
      populateChannelPicker(picked)
    }
    populateChannelPicker(result.guilds[0])
    const truncEl = $('conn-reconnect-truncated')
    if (result.truncated) {
      truncEl.textContent = C.discordTruncatedNote(result.guilds.length)
      truncEl.classList.remove('hidden')
    } else {
      truncEl.classList.add('hidden')
    }
    $('conn-reconnect-pickers').classList.remove('hidden')
  }

  function initDiscordReconnect() {
    $('conn-discord-label').textContent = C.discordLabel
    $('conn-reconnect-note').textContent = C.discordStoredTokenNote
    $('conn-reconnect-token').placeholder = C.discordTokenPlaceholder
    $('conn-reconnect-enum').textContent = C.discordEnumButton
    $('conn-reconnect-guild-label').textContent = C.discordGuildLabel
    $('conn-reconnect-channel-label').textContent = C.discordChannelLabel
    $('conn-reconnect-apply').textContent = C.discordApplyButton

    const flow = $('conn-reconnect-flow')
    const reconnectBtn = $('conn-discord-reconnect')
    reconnectBtn.textContent = C.discordReconnectButton
    reconnectBtn.onclick = () => {
      const opening = flow.classList.contains('hidden')
      flow.classList.toggle('hidden', !opening)
      reconnectBtn.textContent = opening ? C.discordReconnectClose : C.discordReconnectButton
    }

    $('conn-reconnect-enum').onclick = async () => {
      const btn = $('conn-reconnect-enum')
      const statusEl = $('conn-reconnect-status')
      btn.disabled = true
      statusEl.textContent = C.discordEnumRunning
      $('conn-reconnect-pickers').classList.add('hidden')
      try {
        const token = $('conn-reconnect-token').value.trim()
        const result = await api('/api/discord/reconnect/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(token ? { token } : {}),
        })
        if (!result.ok) {
          statusEl.textContent = discordFailureText(result.branch)
          return
        }
        statusEl.textContent = ''
        populatePickers(result)
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        btn.disabled = false
      }
    }

    $('conn-reconnect-apply').onclick = async () => {
      const guildSel = $('conn-reconnect-guild')
      const channelSel = $('conn-reconnect-channel')
      const guild = enumeratedGuilds.find((g) => g.id === guildSel.value)
      const channel = guild && guild.channels.find((c) => c.id === channelSel.value)
      if (!guild || !channel) return
      const ok = await confirmDialog(C.discordApplyConfirm(guild.name || guild.id, channel.name), C.discordApplyOk, window.COPY.nav.cancel)
      if (!ok) return
      const applyBtn = $('conn-reconnect-apply')
      const statusEl = $('conn-reconnect-status')
      applyBtn.disabled = true
      statusEl.textContent = C.discordApplying
      try {
        const token = $('conn-reconnect-token').value.trim()
        const body = { guildId: guild.id, channelId: channel.id }
        if (token) body.token = token
        const result = await api('/api/discord/reconnect/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!result.ok) {
          statusEl.textContent = result.branch ? discordFailureText(result.branch) : GEN(result.error || 'apply failed')
          return
        }
        statusEl.textContent = ''
        showToast(C.discordApplied(result.guildName || result.guildId, result.channelName))
        $('conn-discord-status').textContent = C.discordConnected(result.guildName || result.guildId, result.channelName)
        $('conn-reconnect-flow').classList.add('hidden')
        $('conn-discord-reconnect').textContent = C.discordReconnectButton
        $('conn-reconnect-token').value = ''
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        applyBtn.disabled = false
      }
    }
  }

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

  async function init() {
    $('conn-title').textContent = C.title
    $('conn-back-link').textContent = C.backToMemory
    $('conn-slack-label').textContent = C.slackLabel
    $('conn-slack-note').textContent = C.slackNote
    $('conn-telegram-label').textContent = C.telegramLabel
    $('conn-telegram-note').textContent = C.telegramNote

    let cfg = {}
    try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    renderDiscordStatus(cfg)
    initDiscordReconnect()
    initClaudeKeyRow(Array.isArray(cfg.availableProviders) ? cfg.availableProviders : [])
    renderChatgptReceipt()

    await renderProviderAuth()
  }

  init()
})()
