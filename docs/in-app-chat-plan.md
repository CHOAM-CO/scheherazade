# In-app chat — plan

> **STATUS: ALL FIVE SLICES SHIPPED 2026-07-30** — 1: `ea320fa` (channel) ·
> 2: `ea320fa` (registration) · 3: `1cca773` (proxy) · 4: `f8a0f57` (page;
> plus the orphan guard — stdin EOF exits and unlinks the port file, found
> live) · 5: `a690386` (wizard completer + readiness entry + boot announce).
> Browser-verified end to end via scripts/dev-chat-driver.mjs + dev-serve-ui.
> Version bumped to 0.0.31 for the constraint-4 rebuild.

**Why**: the app has 7 pages (Setup, Channels, Connectors, Logs, Memory,
Settings, Waiting) and none of them is a place to talk to the agent. Every
conversation goes through Discord/Slack/Telegram, so a new user must create a
bot application, get a token, clear 2FA, flip a privileged intent and invite
the bot to a server **before exchanging one message**. The wizard's "do this
later" escape ends setup with an agent the user cannot reach.

Mino go-ahead 2026-07-30 00:28.

## The architecture already supports this

Discovered by reading, not assumed (`channel.mjs:5`, `http-server.cjs:572-597`):

```
inbound:   platform message -> mcp.notification('notifications/claude/channel') -> Claude Code
outbound:  agent calls the `reply` tool -> platform API
selection: .agent-config CHANNEL_BACKEND -> CHANNEL_SCRIPT_PATHS -> .mcp.json agent-channel
```

So an in-app chat is **a fourth channel backend whose "platform" is a local
HTTP endpoint**, not a parallel path. Everything else (supervisor, hooks,
liveness markers, note cadence, memory) keeps working untouched.

## Hard constraints (from the source, do not rediscover)

1. **Tool names are frozen**: `reply`, `send_file_to_discord`,
   `read_channel_history`. The allowlist in
   `onboarding/templates/claude-settings.local.json` and every PreToolUse hook
   match those exact strings. `send_file_to_discord` keeps its Discord-flavored
   name on a local channel too. Renaming = silently unapproved tool + dead
   hooks (`http-server.cjs:576-581`).
2. **Unknown CHANNEL_BACKEND must degrade to discord**, never throw — a
   hand-edited `.agent-config` must not brick the boot path that would let the
   user fix it (`http-server.cjs:590-593`).
3. Channel scripts are **asarUnpacked** — a new one must be added to
   `build.files` AND stay reachable via `toUnpackedPath`.
4. `test-packaging` cannot see a stale build. **Bump the version** after this
   merges or the shipped dmg silently lacks it (learned 07-29, `f2e6395`).

## Slices, riskiest first

1. **`channel-local.mjs`** — MCP stdio server, identical tool surface, plus a
   127.0.0.1 HTTP listener. Inbound POST -> notification. `reply` -> queue for
   the browser. Port written to `DATA_HOME/local-channel.json` (the app spawns
   claude which spawns this, so a fixed env port is not guaranteed).
   *Risk lives here: the notification/reply round trip is the whole feature.*
2. **Register it**: `CHANNEL_SCRIPT_PATHS.local`, `build.files`, packaging test.
3. **Proxy** `/api/chat/*` on the onboarding server to that port, so the browser
   keeps one origin and the existing Host/Origin/token gate keeps applying.
4. **`chat.html` + `chat.js`** — a message list and one input. No history
   persistence, no uploads, no multi-conversation; those are the Discord
   channel's extras and are not what makes the app usable.
5. **Wizard**: make the channel step optional and land setup on the chat page,
   so onboarding ends at the agent's first message instead of "Connecting".

## Deliberately out of scope

Image attachments, file upload, conversation history across restarts, multiple
threads. Each is a real feature; none of them is why the app is hard to start
using.
