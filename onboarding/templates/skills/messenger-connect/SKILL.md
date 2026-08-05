---
name: messenger-connect
description: Help your person connect Slack, Discord, or Telegram to this app. Use whenever they ask for help setting up a messenger, ask why a connect step keeps failing, or ask you to write a Slack app manifest. Contains the EXACT Slack manifest this app needs — never improvise scopes from memory.
---

# Messenger connect

Connecting a messenger is the single biggest setup hurdle. Your job is
to hand your person exact, copy-pasteable artifacts and walk them through
the platform screens. **Do not compose Slack manifests or scope lists
from memory — use the ones below verbatim.** The manifest is a
production-proven superset: granting fewer scopes breaks features, and a
missing scope is the #1 cause of "tokens look valid but the channel list
never loads."

All connects happen in the app: Settings → Channels → the messenger's
Connect button. Connecting stores credentials; the app then offers to
SWITCH to that channel — switching is what actually moves you there.

## Slack (the fiddly one)

What the app needs: a **bot token** (`xoxb-…`) with the right scopes,
and an **app-level token** (`xapp-…`) with Socket Mode on.

**The manifest below is served AS-IS.** The ONLY things you may change
are the three display fields (`name:`, `description:`, `display_name:`)
— swap them for the agent's name if your person wants. Never add,
remove, or reorder scopes/events; never retype the block from memory;
hand over the whole thing. This is a production-proven manifest
(replaced a minimal one on 2026-08-05 after that one kept producing
broken connections): it deliberately grants MORE than this app calls
today, because a spare scope costs nothing and a missing one is the #1
cause of "tokens look valid but nothing works."

Steps to give your person:

1. Go to https://api.slack.com/apps → **Create New App** → **From a
   manifest** → pick the workspace → paste EXACTLY this (YAML tab):

```yaml
display_information:
  name: Scheherazade
  description: Personal AI agent
  background_color: "#5b8c30"
features:
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: false
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Scheherazade
    always_online: true
oauth_config:
  scopes:
    user:
      - channels:history
      - im:history
    bot:
      - usergroups:write
      - app_mentions:read
      - assistant:write
      - bookmarks:read
      - bookmarks:write
      - calls:read
      - calls:write
      - canvases:read
      - canvases:write
      - channels:history
      - channels:join
      - channels:read
      - chat:write
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - users:read
      - users:read.email
      - users:write
      - usergroups:read
  pkce_enabled: false
settings:
  event_subscriptions:
    user_events:
      - message.channels
      - message.im
    bot_events:
      - app_mention
      - message.im
      - message.channels
      - message.groups
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
  is_mcp_enabled: false
```

(The install screen will also ask to authorize a *user* token because
of the `user:` scopes — that consent is expected; this app only ever
uses the bot `xoxb` and app-level `xapp` tokens.)

2. **Install App** to the workspace → copy the **Bot User OAuth Token**
   (`xoxb-…`).
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**
   → name it anything, add scope `connections:write` → copy the
   `xapp-…` token.
4. Paste both tokens in Settings → Channels → Slack → **Connect (DM
   mode)**, accept the switch prompt, and just **DM the bot** in Slack —
   that DM is the conversation. No channel setup needed.
5. (Optional) To ALSO use a channel: invite the bot
   (`/invite @Scheherazade`), then use Load channels → pick → connect.

What this app actually exercises (so you can debug, not so you can
trim): `chat:write` send · `channels:read`/`groups:read` list & info
(this pair missing = "channel list never loads") · `channels:history`/
`groups:history` read channel messages · `im:history` + the `message.im`
event = receive DMs (missing = the bot ignores DMs, the default surface)
· `im:read`/`im:write` resolve & open the DM conversation · `users:read`
sender display names · `files:write` file uploads · the
`message.channels`/`message.groups` events = home-channel mode hears
plain messages (without them the channel surface is mention-only) · app
token `connections:write` = Socket Mode transport. The remaining scopes
in the manifest are the production superset — not called by this app
today, kept so a future feature or a hand-rolled extension never hits
`missing_scope`.

If they already made an app by hand and connect fails: the fastest fix
is App Manifest tab → replace with the YAML above → **Reinstall App**
(reinstall REGENERATES the bot token — they must paste the NEW xoxb).

## Discord

1. https://discord.com/developers/applications → New Application → Bot.
2. Turn ON **Message Content Intent** (Privileged Gateway Intents).
3. Copy the **Bot Token**.
4. OAuth2 → URL Generator: scope `bot`, permissions at minimum
   View Channels / Send Messages / Read Message History / Add Reactions /
   Attach Files → open the generated URL → invite to their server.
5. Settings → Channels → Discord → Connect: paste token, pick server and
   channel.

## Telegram

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token.
2. Send any message to the new bot first (bots cannot start a chat).
3. Settings → Channels → Telegram → Connect: paste token, pick the chat.

## When it still fails

Read the error text on the connect screen out loud to them — it now
carries the platform's own error code (e.g. Slack `missing_scope`).
Match it to the scope table above rather than guessing. If the error
names a scope, the manifest-replace + reinstall path above is the fix.
