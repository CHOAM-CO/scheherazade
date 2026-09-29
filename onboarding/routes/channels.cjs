// onboarding/routes/channels.cjs -- channel setup routes: discord / telegram / slack / switch (group 3)
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
    readJsonBody, sendJson, validateDiscordToken, storeDiscordTokenVerified, readDiscordToken,
    enumerateDiscordTargets, writeEnv, writeAgentConfig, readAgentConfig, activeChannelBackend, enabledChannelBackends,
    channelBackendReadiness, readTelegramToken, enumerateTelegramChats, telegramApi,
    storeTelegramTokenVerified, readSlackBotToken, readSlackAppToken, enumerateSlackChannels,
    slackApi, storeSlackBotTokenVerified, storeSlackAppTokenVerified, CHANNEL_BACKENDS,
    ensureMcpJsonAgentName, getElectron,
  } = staticCtx
  return [
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/discord/validate',
      handler: async (req, res, callCtx) => {
        const { onOnboardingComplete } = callCtx // per-call value from createOnboardingServer, never staticCtx
        const { token } = await readJsonBody(req)
        const result = await validateDiscordToken(token)
        if (!result.ok) {
          sendJson(res, 200, result)
          return
        }
        storeDiscordTokenVerified(token) // safeStorage only -- never written to .env in plaintext (security review, 2026-07-03)
        writeEnv({ homeChannelId: result.channelId })
        // HOME_GUILD_ID lives in .agent-config (not .env): it's a UI-only value
        // (building the discord.com/channels/<guild>/<channel> URL) -- the agent
        // child process never needs it, and .agent-config is what /api/config
        // already serves, so persisting here exposes it to the client for free.
        writeAgentConfig({ ONBOARDING_STEP: '4', ONBOARDING_COMPLETE: '1', ONBOARDING_COMPLETED_AT: new Date().toISOString(), HOME_GUILD_ID: result.guildId })
        // BUG 1 fix (agent-lifecycle, 2026-07-03): this is the ONLY place
        // ONBOARDING_COMPLETE flips from unset -> '1' outside of an app
        // restart. Before this fix there was no callback into main.cjs here,
        // so spawnRealAgentChild() (which requires ONBOARDING_COMPLETE==='1'
        // to proceed) only ever ran again on the NEXT app launch -- a
        // fresh-onboarding user's agent silently never started until they
        // quit and reopened the app. Fired synchronously, before the response
        // is sent, so by the time the client's poll for Step 5 liveness
        // begins the spawn attempt has already happened (see
        // GET /api/agent/status below).
        if (typeof onOnboardingComplete === 'function') {
          try {
            onOnboardingComplete()
          } catch (err) {
            // Never let a spawn-side failure break the validate response --
            // the token IS valid and IS stored; the agent-status endpoint
            // (not this response) is the fail-loud surface for spawn
            // problems. Still log loud, never swallow silently.
            console.error('[scheherazade/onboarding] onOnboardingComplete callback threw:', err)
          }
        }
        sendJson(res, 200, result)
        return
      },
    },
    // ── Discord reconnect (IA v0.0.9): 2-step validate/apply ─────────────────
    // Post-onboarding re-wiring: switch token, server, or channel on a live
    // install. Deliberately SEPARATE from /api/discord/validate above -- that
    // route is the onboarding completer (it stamps ONBOARDING_COMPLETE and
    // fires the spawn callback); these routes must never re-stamp onboarding
    // history. ONBOARDING_COMPLETED_AT records when onboarding happened --
    // rewriting it on a reconnect would falsify the record.
    //
    // token is OPTIONAL on both: absent/blank falls back to the STORED token
    // (safeStorage), so switching channels doesn't demand a re-paste of a
    // credential the app already holds.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/discord/reconnect/validate',
      handler: async (req, res, callCtx) => {
        const { token } = await readJsonBody(req)
        const provided = typeof token === 'string' && token.trim() !== ''
        const effective = provided ? token.trim() : readDiscordToken()
        if (!effective) {
          sendJson(res, 200, { ok: false, branch: 'invalid_token', usedStoredToken: !provided })
          return
        }
        const result = await enumerateDiscordTargets(effective)
        sendJson(res, 200, { ...result, usedStoredToken: !provided })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/discord/reconnect/apply',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        const { token, guildId, channelId } = await readJsonBody(req)
        if (!guildId || !channelId) {
          sendJson(res, 400, { error: 'guildId and channelId are required' })
          return
        }
        const provided = typeof token === 'string' && token.trim() !== ''
        const effective = provided ? token.trim() : readDiscordToken()
        if (!effective) {
          sendJson(res, 200, { ok: false, branch: 'invalid_token' })
          return
        }
        // Server-side re-verification at apply time: the picked ids must be
        // reachable by THIS token right now. Client-sent ids are never trusted
        // (the validate response is a UI convenience, not an authorization), and
        // a token/pick mismatch fails loud instead of persisting a channel the
        // bot cannot actually read.
        const enumerated = await enumerateDiscordTargets(effective)
        if (!enumerated.ok) {
          sendJson(res, 200, enumerated)
          return
        }
        const guild = enumerated.guilds.find((g) => g.id === String(guildId))
        const channel = guild && guild.channels.find((c) => c.id === String(channelId))
        if (!guild || !channel) {
          sendJson(res, 400, { error: 'picked guild/channel is not reachable by this token' })
          return
        }
        storeDiscordTokenVerified(effective)
        writeEnv({ homeChannelId: channel.id })
        // HOME_GUILD_ID: same UI-only persistence as the onboarding validate
        // route above. HOME_GUILD_NAME/HOME_CHANNEL_NAME are display-only
        // additions so the connectors page can show WHERE the agent lives
        // without a Discord API call per page view (legacy installs simply
        // don't have them and the UI falls back to ids). NO onboarding stamps.
        writeAgentConfig({ HOME_GUILD_ID: guild.id, HOME_GUILD_NAME: guild.name || '', HOME_CHANNEL_NAME: channel.name || '' })
        // Restart so the child picks up the new token/channel (spawn re-reads
        // both fresh -- main.cjs readHomeChannelId()/readDiscordToken() at spawn
        // time). Fire-and-forget + 202, same contract as the lifecycle routes
        // below: the client polls GET /api/agent/status until it settles. On a
        // STOPPED agent restartAgent starts it -- deliberate: a reconnect is an
        // explicit "point my agent here" act.
        if (agentControls && typeof agentControls.restartAgent === 'function') {
          agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] reconnect restart threw:', err))
        }
        sendJson(res, 202, { ok: true, guildId: guild.id, guildName: guild.name, channelId: channel.id, channelName: channel.name })
        return
      },
    },
    // ── multichannel (v0.0.18): status / telegram / slack connect / switch ──
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/channels/status',
      handler: async (req, res, callCtx) => {
        // 0.3.7: `enabled` = every messenger switched on (primary first);
        // `channels` = live per-channel process state from main.cjs (primary
        // is the agent's own MCP entry; the rest are companion processes).
        const { agentControls } = callCtx
        let channels = {}
        try { channels = (agentControls && agentControls.channelStatus && agentControls.channelStatus()) || {} } catch { channels = {} }
        sendJson(res, 200, { active: activeChannelBackend(), enabled: enabledChannelBackends(), backends: channelBackendReadiness(), channels })
        return
      },
    },
    {
      // Per-messenger on/off (Settings). Enabling needs the messenger's
      // credentials on file; the last enabled messenger cannot be switched off
      // (an agent with no channel is a mute agent -- the in-app chat is the
      // only other surface and it has its own backend value).
      method: 'POST',
      match: (pathname) => pathname === '/api/channels/enabled',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx
        const { backend, enabled } = await readJsonBody(req)
        if (!['discord', 'slack', 'telegram'].includes(backend) || typeof enabled !== 'boolean') {
          sendJson(res, 400, { error: 'backend must be discord|slack|telegram and enabled a boolean' })
          return
        }
        const current = enabledChannelBackends()
        if (enabled && !channelBackendReadiness()[backend].configured) {
          sendJson(res, 200, { ok: false, branch: 'not_configured', backend })
          return
        }
        // 'local' only stands when no messenger is enabled; enabling a messenger replaces it.
        let next = enabled ? [...current.filter((b) => b !== 'local'), backend] : current.filter((b) => b !== backend)
        next = [...new Set(next)]
        if (!next.length) {
          sendJson(res, 200, { ok: false, branch: 'last_channel', backend })
          return
        }
        writeAgentConfig(require('../../channel-backends.cjs').backendConfigFields(next))
        ensureMcpJsonAgentName() // primary may have changed -> agent-channel script path
        if (agentControls && typeof agentControls.restartAgent === 'function') {
          agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] channel toggle restart threw:', err))
        }
        sendJson(res, 202, { ok: true, enabled: next })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/telegram/connect/validate',
      handler: async (req, res, callCtx) => {
        const { token } = await readJsonBody(req)
        const provided = typeof token === 'string' && token.trim() !== ''
        const effective = provided ? token.trim() : readTelegramToken()
        if (!effective) {
          sendJson(res, 200, { ok: false, branch: 'invalid_token' })
          return
        }
        sendJson(res, 200, await enumerateTelegramChats(effective))
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/telegram/connect/apply',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        const { token, chatId, chatLabel } = await readJsonBody(req)
        if (!chatId) {
          sendJson(res, 400, { error: 'chatId is required' })
          return
        }
        const provided = typeof token === 'string' && token.trim() !== ''
        const effective = provided ? token.trim() : readTelegramToken()
        if (!effective) {
          sendJson(res, 200, { ok: false, branch: 'invalid_token' })
          return
        }
        // Apply-time re-verification, discord-apply discipline: the picked chat
        // must be reachable by THIS token right now. sendChatAction is the
        // cheapest probe that proves reachability without posting a visible
        // message ("typing" flashes at most). Client-sent ids are never trusted.
        const me = await telegramApi(effective, 'getMe', {})
        if (me.status === 401 || me.status === 404) {
          sendJson(res, 200, { ok: false, branch: 'invalid_token' })
          return
        }
        if (!me.ok) throw new Error(`Telegram getMe failed: HTTP ${me.status} ${me.description}`)
        const ping = await telegramApi(effective, 'sendChatAction', { chat_id: String(chatId), action: 'typing' })
        if (!ping.ok) {
          sendJson(res, 200, { ok: false, branch: 'chat_unreachable', detail: ping.description })
          return
        }
        storeTelegramTokenVerified(effective)
        writeAgentConfig({
          TELEGRAM_HOME_CHAT_ID: String(chatId),
          TELEGRAM_HOME_CHAT_NAME: typeof chatLabel === 'string' ? chatLabel : '',
          TELEGRAM_BOT_USERNAME: me.result.username || '',
        })
        // Restart ONLY when telegram is the active backend: configuring an
        // inactive backend must not bounce the agent living on another one.
        const isActive = enabledChannelBackends().includes('telegram')
        if (isActive && agentControls && typeof agentControls.restartAgent === 'function') {
          agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] telegram apply restart threw:', err))
        }
        sendJson(res, isActive ? 202 : 200, { ok: true, chatId: String(chatId), botUsername: me.result.username || '', restarted: isActive })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/slack/connect/validate',
      handler: async (req, res, callCtx) => {
        const { botToken, appToken } = await readJsonBody(req)
        const effBot = typeof botToken === 'string' && botToken.trim() !== '' ? botToken.trim() : readSlackBotToken()
        const effApp = typeof appToken === 'string' && appToken.trim() !== '' ? appToken.trim() : readSlackAppToken()
        if (!effBot) {
          sendJson(res, 200, { ok: false, branch: 'invalid_bot_token' })
          return
        }
        if (!effApp) {
          sendJson(res, 200, { ok: false, branch: 'invalid_app_token' })
          return
        }
        sendJson(res, 200, await enumerateSlackChannels(effBot, effApp))
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/slack/connect/apply',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        // channelId is OPTIONAL since DM-default mode (2026-08-04, the owner
        // "홈채널 방식 말고 DM 기본"): tokens alone are a complete config --
        // the conversation is the bot's DM (message.im). A picked channel is
        // the optional extra surface, and keeps its full reachability check.
        const { botToken, appToken, channelId } = await readJsonBody(req)
        const effBot = typeof botToken === 'string' && botToken.trim() !== '' ? botToken.trim() : readSlackBotToken()
        const effApp = typeof appToken === 'string' && appToken.trim() !== '' ? appToken.trim() : readSlackAppToken()
        if (!effBot || !effApp) {
          sendJson(res, 200, { ok: false, branch: !effBot ? 'invalid_bot_token' : 'invalid_app_token' })
          return
        }
        // Apply-time re-verification: both tokens live (+ when a channel was
        // picked: reachable AND bot actually IN it -- posting from outside a
        // channel fails at runtime, catch it here where the user can fix it).
        const auth = await slackApi(effBot, 'auth.test', {})
        if (!auth.ok) {
          sendJson(res, 200, { ok: false, branch: 'invalid_bot_token', detail: auth.error })
          return
        }
        const conn = await slackApi(effApp, 'apps.connections.open', {})
        if (!conn.ok) {
          sendJson(res, 200, { ok: false, branch: 'invalid_app_token', detail: conn.error })
          return
        }
        let channelName = ''
        if (channelId) {
          const info = await slackApi(effBot, 'conversations.info', { channel: String(channelId) })
          if (!info.ok || !info.body.channel) {
            // Slack's own error code rides along VERBATIM: the first live test hit
            // this branch and the swallowed code made the failure undiagnosable
            // from the screen. Never eat the upstream error.
            sendJson(res, 400, { error: `picked channel is not reachable by this token (slack: ${info.error || 'no_channel_in_response'})` })
            return
          }
          if (info.body.channel.is_member !== true) {
            sendJson(res, 200, { ok: false, branch: 'not_in_channel', channelName: info.body.channel.name || '' })
            return
          }
          channelName = info.body.channel.name || ''
        }
        storeSlackBotTokenVerified(effBot)
        storeSlackAppTokenVerified(effApp)
        writeAgentConfig({
          // Written unconditionally ('' in DM mode) so a re-apply WITHOUT a
          // channel clears a previously picked one instead of silently
          // keeping it (writeAgentConfig merges; omitted keys survive).
          SLACK_HOME_CHANNEL_ID: channelId ? String(channelId) : '',
          SLACK_HOME_CHANNEL_NAME: channelName,
          SLACK_TEAM_NAME: auth.body.team || '',
        })
        const isActive = enabledChannelBackends().includes('slack')
        if (isActive && agentControls && typeof agentControls.restartAgent === 'function') {
          agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] slack apply restart threw:', err))
        }
        sendJson(res, isActive ? 202 : 200, { ok: true, channelId: channelId ? String(channelId) : '', channelName, mode: channelId ? 'channel' : 'dm', team: auth.body.team || '', restarted: isActive })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/channels/switch',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        const { backend } = await readJsonBody(req)
        if (!CHANNEL_BACKENDS.includes(backend)) {
          sendJson(res, 400, { error: `backend must be one of: ${CHANNEL_BACKENDS.join(', ')}` })
          return
        }
        const readiness = channelBackendReadiness()
        if (!readiness[backend].configured) {
          sendJson(res, 200, { ok: false, branch: 'not_configured', backend })
          return
        }
        writeAgentConfig(require('../../channel-backends.cjs').backendConfigFields([backend]))
        // Rewrite .mcp.json NOW (not at next boot): the restart below re-spawns
        // the claude CLI, which reads .mcp.json at ITS spawn -- the agent-channel
        // entry must already point at the new backend script by then.
        ensureMcpJsonAgentName()
        if (agentControls && typeof agentControls.restartAgent === 'function') {
          agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] channel switch restart threw:', err))
        }
        sendJson(res, 202, { ok: true, active: backend })
        return
      },
    },
    // ── In-app chat as the onboarding completer (in-app chat slice 5) ────────
    // The third way onboarding can finish, next to /api/discord/validate
    // (same completion contract: stamp + spawn callback) and /api/channels/
    // switch (same backend mechanics: config + .mcp.json + restart). There
    // is nothing to validate -- the "platform" is the app itself -- so the
    // whole route is the stamp and the spawn. This is what makes the wizard's
    // channel step OPTIONAL: before it, "do this later" ended setup with an
    // agent the user could not reach.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/channels/local/complete',
      handler: async (req, res, callCtx) => {
        const { onOnboardingComplete, agentControls } = callCtx // per-call values, never staticCtx
        const already = readAgentConfig().ONBOARDING_COMPLETE === '1'
        const stamp = { ...require('../../channel-backends.cjs').backendConfigFields(['local']), ONBOARDING_STEP: '4' }
        if (!already) {
          // COMPLETED_AT records when onboarding happened; a wizard re-entry
          // (?step=4 resume) landing here must not falsify that record --
          // same rule the discord reconnect routes state above.
          stamp.ONBOARDING_COMPLETE = '1'
          stamp.ONBOARDING_COMPLETED_AT = new Date().toISOString()
        }
        writeAgentConfig(stamp)
        // .mcp.json NOW, not at next boot -- the spawn below reads it at the
        // claude child's spawn (same reason /api/channels/switch does this).
        ensureMcpJsonAgentName()
        if (!already) {
          // Fresh onboarding: fire the spawn callback, same contract and
          // same never-break-the-response guard as /api/discord/validate.
          if (typeof onOnboardingComplete === 'function') {
            try {
              onOnboardingComplete()
            } catch (err) {
              console.error('[scheherazade/onboarding] onOnboardingComplete callback threw:', err)
            }
          }
        } else if (agentControls && typeof agentControls.restartAgent === 'function') {
          // Already-onboarded re-entry: the agent is (or was) running on
          // another backend -- this is a switch, so restart like one.
          agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] local complete restart threw:', err))
        }
        sendJson(res, 202, { ok: true, active: 'local', completedNow: !already })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/discord/open',
      handler: async (req, res, callCtx) => {
        const { guildId, channelId } = await readJsonBody(req)
        if (!guildId || !channelId) {
          sendJson(res, 400, { error: 'guildId and channelId are required' })
          return
        }
        const { shell } = getElectron()
        await shell.openExternal(`https://discord.com/channels/${guildId}/${channelId}`)
        sendJson(res, 200, { ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
