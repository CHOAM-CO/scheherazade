// channels.js — channels page (multichannel v0.0.18, the owner 07-16: "맨 앞에
// 채널 섹션 추가하고 Discord/Slack/Telegram 연동 갈아끼울 수 있게").
// One card per messenger backend: live status from GET /api/channels/status
// (never cached config), a connect/reconnect flow per backend, and a switch
// button on any CONFIGURED non-active backend. Switching restarts the agent
// (202 + the shell's own status poll shows the settle -- same contract as
// the discord reconnect apply this page inherited).
//
// The Discord reconnect flow moved here VERBATIM from connectors.js
// (2026-07-16 split) -- ids conn-* -> ch-*, copy source connectors.* ->
// channels.*; logic unchanged. Uses window.api() / window.showToast() /
// window.confirmDialog() from nav.js.
;(function () {
  const C = window.COPY.channels
  const GEN = window.COPY.genericError

  function $(id) { return document.getElementById(id) }
  const api = (...args) => window.api(...args)
  const showToast = (...args) => window.showToast(...args)
  const confirmDialog = (...args) => window.confirmDialog(...args)

  // ── status render ─────────────────────────────────────────────────────────
  // active/configured come from the server's live computation (credential
  // store + config), never from what this page last did -- after a switch we
  // re-fetch rather than hand-writing the badge (셸은 현실).
  let lastStatus = null

  // Button label derives from LIVE state, not the backend's history: a
  // never-connected Discord said "Reconnect" and a connected Slack said
  // "Connect" (the owner, clean-mac 2026-08-04 13:55). Discord's ids keep the
  // legacy reconnect-flow names; the label logic is shared.
  function connectBtnFor(key) {
    return $(key === 'discord' ? 'ch-discord-reconnect' : `ch-${key}-connect`)
  }
  function flowFor(key) {
    return $(key === 'discord' ? 'ch-reconnect-flow' : `ch-${key}-flow`)
  }
  function baseLabel(key) {
    const info = lastStatus && lastStatus.backends && lastStatus.backends[key]
    return info && info.configured ? C.reconnectButton : C.connectButton
  }

  function renderBackendRow(key, status) {
    const info = status.backends[key]
    const isActive = status.active === key
    $(`ch-${key}-name`).textContent = C.names[key]
    // On/off light (2026-08-05, the owner "초록불/회색불로 on off 인디케이팅"):
    // green = live. The in-app surface is hosted by EVERY backend now, so
    // its light is always green; for messengers, green = the one the agent
    // is actually on. The status TEXT keeps the configured/not distinction.
    const dot = $(`ch-${key}-dot`)
    if (dot) dot.classList.toggle('ok', isActive || key === 'local')
    const parts = []
    if (key === 'local') parts.push(C.localAlwaysOn)
    else parts.push(isActive ? C.activeBadge : info.configured ? C.configuredBadge : C.notConfiguredBadge)
    if (info.configured && info.home) parts.push(C.homeLine(info.detail ? `${info.detail} / ${info.home}` : info.home))
    $(`ch-${key}-status`).textContent = parts.join(' · ')
    const connectBtn = connectBtnFor(key)
    if (connectBtn) {
      const flowEl = flowFor(key)
      const flowOpen = flowEl && !flowEl.classList.contains('hidden')
      if (!flowOpen) connectBtn.textContent = baseLabel(key)
    }
    const switchBtn = $(`ch-${key}-switch`)
    switchBtn.textContent = C.switchButton
    switchBtn.classList.toggle('hidden', isActive || !info.configured)
    switchBtn.onclick = async () => {
      const ok = await confirmDialog(C.switchConfirm(C.names[key]), C.switchOk, window.COPY.nav.cancel)
      if (!ok) return
      switchBtn.disabled = true
      try {
        await switchTo(key)
      } finally {
        switchBtn.disabled = false
      }
    }
  }

  async function switchTo(key) {
    try {
      const result = await api('/api/channels/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: key }),
      })
      if (!result.ok) {
        showToast(result.branch === 'not_configured' ? C.notConfiguredYet : GEN(result.error || result.branch || 'switch failed'))
        return
      }
      showToast(C.switched(C.names[key]))
      await refreshStatus()
    } catch (err) {
      showToast(GEN(err.message))
    }
  }

  // connect != switch bit a real user within the hour (the owner, clean-mac
  // 13:58: Slack "Connected" but the agent still listened on in-app chat).
  // After a successful connect/apply on a non-active backend, offer the
  // switch right there instead of relying on the separate button being
  // noticed. Declining keeps the old behavior exactly.
  async function offerSwitchAfterConnect(key) {
    await refreshStatus()
    if (!lastStatus || lastStatus.active === key) return
    const ok = await confirmDialog(C.switchAfterConnect(C.names[key]), C.switchOk, window.COPY.nav.cancel)
    if (ok) await switchTo(key)
  }

  async function refreshStatus() {
    lastStatus = await api('/api/channels/status')
    // local first, matching the page's card order. Missing from the server's
    // backends map (an older server) renders nothing rather than crashing.
    for (const key of ['local', 'discord', 'telegram', 'slack']) {
      if (lastStatus.backends[key]) renderBackendRow(key, lastStatus)
    }
  }

  // ── Discord reconnect (moved verbatim from connectors.js) ────────────────
  let enumeratedGuilds = []

  function discordFailureText(branch) {
    return window.COPY.discordTutorial.failures[branch] || GEN(branch || 'unknown')
  }

  function populateChannelPicker(guild) {
    const channelSel = $('ch-reconnect-channel')
    channelSel.innerHTML = ''
    if (!guild || guild.channels.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = C.discordNoChannels
      channelSel.appendChild(opt)
      $('ch-reconnect-apply').disabled = true
      return
    }
    for (const ch of guild.channels) {
      const opt = document.createElement('option')
      opt.value = ch.id
      opt.textContent = `#${ch.name}`
      channelSel.appendChild(opt)
    }
    $('ch-reconnect-apply').disabled = false
  }

  function populatePickers(result) {
    enumeratedGuilds = result.guilds
    const guildSel = $('ch-reconnect-guild')
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
    const truncEl = $('ch-reconnect-truncated')
    if (result.truncated) {
      truncEl.textContent = C.discordTruncatedNote(result.guilds.length)
      truncEl.classList.remove('hidden')
    } else {
      truncEl.classList.add('hidden')
    }
    $('ch-reconnect-pickers').classList.remove('hidden')
  }

  function initDiscordReconnect() {
    $('ch-reconnect-note').textContent = C.discordStoredTokenNote
    $('ch-reconnect-token').placeholder = C.discordTokenPlaceholder
    $('ch-reconnect-enum').textContent = C.discordEnumButton
    $('ch-reconnect-guild-label').textContent = C.discordGuildLabel
    $('ch-reconnect-channel-label').textContent = C.discordChannelLabel
    $('ch-reconnect-apply').textContent = C.discordApplyButton

    const flow = $('ch-reconnect-flow')
    const reconnectBtn = $('ch-discord-reconnect')
    reconnectBtn.textContent = baseLabel('discord')
    reconnectBtn.onclick = () => {
      const opening = flow.classList.contains('hidden')
      flow.classList.toggle('hidden', !opening)
      reconnectBtn.textContent = opening ? C.closeButton : baseLabel('discord')
    }

    $('ch-reconnect-enum').onclick = async () => {
      const btn = $('ch-reconnect-enum')
      const statusEl = $('ch-reconnect-status')
      btn.disabled = true
      statusEl.textContent = C.discordEnumRunning
      $('ch-reconnect-pickers').classList.add('hidden')
      try {
        const token = $('ch-reconnect-token').value.trim()
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

    $('ch-reconnect-apply').onclick = async () => {
      const guildSel = $('ch-reconnect-guild')
      const channelSel = $('ch-reconnect-channel')
      const guild = enumeratedGuilds.find((g) => g.id === guildSel.value)
      const channel = guild && guild.channels.find((c) => c.id === channelSel.value)
      if (!guild || !channel) return
      const ok = await confirmDialog(C.discordApplyConfirm(guild.name || guild.id, channel.name), C.discordApplyOk, window.COPY.nav.cancel)
      if (!ok) return
      const applyBtn = $('ch-reconnect-apply')
      const statusEl = $('ch-reconnect-status')
      applyBtn.disabled = true
      statusEl.textContent = C.discordApplying
      try {
        const token = $('ch-reconnect-token').value.trim()
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
        $('ch-reconnect-flow').classList.add('hidden')
        $('ch-discord-reconnect').textContent = baseLabel('discord')
        $('ch-reconnect-token').value = ''
        await offerSwitchAfterConnect('discord')
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        applyBtn.disabled = false
      }
    }
  }

  // ── Telegram connect: token -> enumerate chats -> pick -> apply ──────────
  let telegramChats = []

  function initTelegramConnect() {
    $('ch-telegram-guide').textContent = C.telegramGuide
    $('ch-telegram-token-note').textContent = C.telegramStoredTokenNote
    $('ch-telegram-token').placeholder = C.telegramTokenPlaceholder
    $('ch-telegram-enum').textContent = C.telegramEnumButton
    $('ch-telegram-chat-label').textContent = C.telegramChatLabel
    $('ch-telegram-apply').textContent = C.telegramApplyButton
    const botfatherBtn = $('ch-telegram-botfather')
    botfatherBtn.textContent = C.telegramOpenBotFather
    botfatherBtn.onclick = () => window.open(C.links.telegram, '_blank', 'noopener')

    const flow = $('ch-telegram-flow')
    const connectBtn = $('ch-telegram-connect')
    connectBtn.textContent = baseLabel('telegram')
    connectBtn.onclick = () => {
      const opening = flow.classList.contains('hidden')
      flow.classList.toggle('hidden', !opening)
      connectBtn.textContent = opening ? C.closeButton : baseLabel('telegram')
    }

    $('ch-telegram-enum').onclick = async () => {
      const btn = $('ch-telegram-enum')
      const statusEl = $('ch-telegram-flow-status')
      btn.disabled = true
      statusEl.textContent = C.telegramEnumRunning
      $('ch-telegram-pickers').classList.add('hidden')
      try {
        const token = $('ch-telegram-token').value.trim()
        const result = await api('/api/telegram/connect/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(token ? { token } : {}),
        })
        if (!result.ok) {
          statusEl.textContent =
            result.branch === 'conflict_running' ? C.telegramConflictRunning : C.invalidToken
          return
        }
        if (!result.chats || result.chats.length === 0) {
          statusEl.textContent = C.telegramNoChats
          return
        }
        statusEl.textContent = ''
        telegramChats = result.chats
        const sel = $('ch-telegram-chat')
        sel.innerHTML = ''
        for (const chat of result.chats) {
          const opt = document.createElement('option')
          opt.value = chat.id
          opt.textContent = `${chat.label} (${chat.type})`
          sel.appendChild(opt)
        }
        $('ch-telegram-pickers').classList.remove('hidden')
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        btn.disabled = false
      }
    }

    $('ch-telegram-apply').onclick = async () => {
      const sel = $('ch-telegram-chat')
      const chat = telegramChats.find((c) => c.id === sel.value)
      if (!chat) return
      const applyBtn = $('ch-telegram-apply')
      const statusEl = $('ch-telegram-flow-status')
      applyBtn.disabled = true
      try {
        const token = $('ch-telegram-token').value.trim()
        const body = { chatId: chat.id, chatLabel: chat.label }
        if (token) body.token = token
        const result = await api('/api/telegram/connect/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!result.ok) {
          statusEl.textContent =
            result.branch === 'chat_unreachable' ? C.telegramChatUnreachable : C.invalidToken
          return
        }
        statusEl.textContent = ''
        showToast(C.telegramApplied(chat.label))
        flowClose('telegram')
        await offerSwitchAfterConnect('telegram')
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        applyBtn.disabled = false
      }
    }
  }

  // ── Slack connect: 2 tokens -> enumerate channels -> pick -> apply ───────
  let slackChannels = []

  function slackBranchText(result) {
    // Raw upstream detail rides along when the server carried one (0.0.19
    // observability fix) -- a branch label tells the user WHAT to fix, the
    // slack error code tells us WHY when the label turns out wrong.
    const detail = result.detail ? ` (${result.detail})` : ''
    if (result.branch === 'invalid_bot_token') return C.slackInvalidBotToken + detail
    if (result.branch === 'invalid_app_token') return C.slackInvalidAppToken + detail
    if (result.branch === 'list_failed') return C.slackListFailed + detail
    if (result.branch === 'not_in_channel') return C.slackNotInChannel(result.channelName || '?')
    return GEN(result.error || result.branch || 'unknown')
  }

  function initSlackConnect() {
    $('ch-slack-guide').textContent = C.slackGuide
    $('ch-slack-token-note').textContent = C.slackStoredTokenNote
    $('ch-slack-bot-token').placeholder = C.slackBotTokenPlaceholder
    $('ch-slack-app-token').placeholder = C.slackAppTokenPlaceholder
    $('ch-slack-enum').textContent = C.slackEnumButton
    $('ch-slack-channel-label').textContent = C.slackChannelLabel
    $('ch-slack-apply').textContent = C.slackApplyButton
    $('ch-slack-dm-note').textContent = C.slackDmNote
    $('ch-slack-dm-apply').textContent = C.slackDmApplyButton
    const consoleBtn = $('ch-slack-console')
    consoleBtn.textContent = C.slackOpenConsole
    consoleBtn.onclick = () => window.open(C.links.slack, '_blank', 'noopener')

    const flow = $('ch-slack-flow')
    const connectBtn = $('ch-slack-connect')
    connectBtn.textContent = baseLabel('slack')
    connectBtn.onclick = () => {
      const opening = flow.classList.contains('hidden')
      flow.classList.toggle('hidden', !opening)
      connectBtn.textContent = opening ? C.closeButton : baseLabel('slack')
    }

    $('ch-slack-enum').onclick = async () => {
      const btn = $('ch-slack-enum')
      const statusEl = $('ch-slack-flow-status')
      btn.disabled = true
      statusEl.textContent = C.slackEnumRunning
      $('ch-slack-pickers').classList.add('hidden')
      try {
        const botToken = $('ch-slack-bot-token').value.trim()
        const appToken = $('ch-slack-app-token').value.trim()
        const body = {}
        if (botToken) body.botToken = botToken
        if (appToken) body.appToken = appToken
        const result = await api('/api/slack/connect/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!result.ok) {
          statusEl.textContent = slackBranchText(result)
          return
        }
        if (!result.channels || result.channels.length === 0) {
          statusEl.textContent = C.slackNoChannels
          return
        }
        statusEl.textContent = ''
        slackChannels = result.channels
        const sel = $('ch-slack-channel')
        sel.innerHTML = ''
        for (const chan of result.channels) {
          const opt = document.createElement('option')
          opt.value = chan.id
          opt.textContent = `#${chan.name}${chan.isMember ? '' : C.slackNotMemberSuffix}`
          sel.appendChild(opt)
        }
        $('ch-slack-pickers').classList.remove('hidden')
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        btn.disabled = false
      }
    }

    // DM-default connect (2026-08-04, the owner "홈채널 방식 말고 DM 기본"):
    // tokens-only apply -- no channel pick, no enumerate. The server clears
    // any previously picked channel ('' write) and the conversation becomes
    // the bot's DM (message.im).
    $('ch-slack-dm-apply').onclick = async () => {
      const applyBtn = $('ch-slack-dm-apply')
      const statusEl = $('ch-slack-flow-status')
      applyBtn.disabled = true
      try {
        const botToken = $('ch-slack-bot-token').value.trim()
        const appToken = $('ch-slack-app-token').value.trim()
        const body = {}
        if (botToken) body.botToken = botToken
        if (appToken) body.appToken = appToken
        const result = await api('/api/slack/connect/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!result.ok) {
          statusEl.textContent = slackBranchText(result)
          return
        }
        statusEl.textContent = ''
        showToast(C.slackAppliedDm)
        flowClose('slack')
        await offerSwitchAfterConnect('slack')
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        applyBtn.disabled = false
      }
    }

    $('ch-slack-apply').onclick = async () => {
      const sel = $('ch-slack-channel')
      const chan = slackChannels.find((c) => c.id === sel.value)
      if (!chan) return
      const applyBtn = $('ch-slack-apply')
      const statusEl = $('ch-slack-flow-status')
      applyBtn.disabled = true
      try {
        const botToken = $('ch-slack-bot-token').value.trim()
        const appToken = $('ch-slack-app-token').value.trim()
        const body = { channelId: chan.id }
        if (botToken) body.botToken = botToken
        if (appToken) body.appToken = appToken
        const result = await api('/api/slack/connect/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!result.ok) {
          statusEl.textContent = slackBranchText(result)
          return
        }
        statusEl.textContent = ''
        showToast(C.slackApplied(result.channelName || chan.name))
        flowClose('slack')
        await offerSwitchAfterConnect('slack')
      } catch (err) {
        statusEl.textContent = GEN(err.message)
      } finally {
        applyBtn.disabled = false
      }
    }
  }

  function flowClose(key) {
    $(`ch-${key}-flow`).classList.add('hidden')
    const btn = connectBtnFor(key)
    if (btn) btn.textContent = baseLabel(key)
  }

  // ── init ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    $('ch-title').textContent = C.title
    $('ch-subtitle').textContent = C.subtitle
    initDiscordReconnect()
    initTelegramConnect()
    initSlackConnect()
    try {
      await refreshStatus()
    } catch (err) {
      console.error('channels status fetch failed:', err)
      showToast(GEN(err.message))
    }
  })
})()
