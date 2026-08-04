---
name: messenger-connect
description: Help your person connect Slack, Discord, or Telegram to this app. Use whenever they ask for help setting up a messenger, ask why a connect step keeps failing, or ask you to write a Slack app manifest. Contains the EXACT Slack manifest this app needs — never improvise scopes from memory.
---

# Messenger connect

Connecting a messenger is the single biggest setup hurdle. Your job is
to hand your person exact, copy-pasteable artifacts and walk them through
the platform screens. **Do not compose Slack manifests or scope lists
from memory — use the ones below verbatim.** Every scope here maps to an
API call this app actually makes; adding fewer breaks features, and a
missing scope is the #1 cause of "tokens look valid but the channel list
never loads."

All connects happen in the app: Settings → Channels → the messenger's
Connect button. Connecting stores credentials; the app then offers to
SWITCH to that channel — switching is what actually moves you there.

## Slack (the fiddly one)

What the app needs: a **bot token** (`xoxb-…`) with the right scopes,
and an **app-level token** (`xapp-…`) with Socket Mode on.

Steps to give your person:

1. Go to https://api.slack.com/apps → **Create New App** → **From a
   manifest** → pick the workspace → paste EXACTLY this (YAML tab),
   changing only the two name fields:

```yaml
display_information:
  name: Scheherazade
features:
  bot_user:
    display_name: Scheherazade
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:read
      - groups:read
      - channels:history
      - groups:history
      - users:read
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
  interactivity:
    is_enabled: false
  socket_mode_enabled: true
```

2. **Install App** to the workspace → copy the **Bot User OAuth Token**
   (`xoxb-…`).
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**
   → name it anything, add scope `connections:write` → copy the
   `xapp-…` token.
4. In Slack, invite the bot to the channel it should live in:
   `/invite @Scheherazade`.
5. Paste both tokens in Settings → Channels → Slack → Connect, pick the
   channel, apply, and accept the switch prompt.

Why each scope (so you can debug, not so you can re-derive):
`chat:write` send · `channels:read`/`groups:read` list & info (this pair
missing = "channel list never loads") · `channels:history`/
`groups:history` read messages incl. the message events subscription ·
`users:read` sender display names · `files:write` file uploads ·
app token `connections:write` = Socket Mode transport.

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
