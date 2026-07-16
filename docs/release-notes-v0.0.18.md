# v0.0.18 — Multichannel: Discord / Slack / Telegram, swappable

> Commission: Mino 2026-07-16 15:07 ("맨 앞에 채널 섹션 추가하고 Discord/
> Slack/Telegram 연동 갈아끼울 수 있게") + 15:13 scope verdict ("셋 다
> 실작동까지 이번에"). Version stays 0.0.18 — 0.1.0 remains reserved for
> the attach-topology refactor (Mino 15:16, upholding his 11:46 lock).

## What changed

### 채널 tab (new, FIRST in the nav)
- New `/channels` page ahead of 기억/커넥터/설정. One card per messenger:
  live status badge (사용 중 / 연결됨 / 미연결), connect/reconnect flow,
  and a "이 채널로 전환" button on any configured non-active backend.
- Discord reconnect flow MOVED here verbatim from /connectors (that page's
  axis narrowed to LLM-side connections: provider auth, BYOK, claude.ai
  connectors, serving receipt).
- Telegram connect: BotFather token → chat enumeration (getUpdates) →
  pick → apply. Fresh-bot empty list is guided, not an error ("봇에게
  먼저 메시지를 보내세요"). Long-poll conflict with a RUNNING telegram
  agent is its own branch ("에이전트를 정지한 뒤 다시").
- Slack connect: bot token (xoxb) + app token (xapp, Socket Mode) →
  channel enumeration → pick → apply. Bot-not-in-channel is caught at
  apply time with the /invite hint, not at first send.

### Channel backends (2 new MCP server scripts)
- `channel-telegram.mjs` — Bot API long-poll, zero new deps (node:https).
  History = local JSONL ledger (Bot API has no history endpoint; the tool
  description says so honestly).
- `channel-slack.mjs` — Socket Mode via @slack/socket-mode + @slack/web-api
  (the two new deps). Real conversations.history. Liveness heartbeat gated
  on socket state (a disconnected backend stops claiming alive).
- Both mirror channel.mjs exactly: IDENTICAL tool names (`reply`,
  `send_file_to_discord`, `read_channel_history` — allowlist + hooks match
  on these, so they must not change per backend), same liveness/failure
  markers, same boot-announce, same stdout hygiene, same injection meta.

### Switch mechanics
- `CHANNEL_BACKEND` in .agent-config (absent/unknown → discord; degrade,
  never brick). `.mcp.json`'s agent-channel entry is rewritten per-backend
  by ensureMcpJsonAgentName() — on every boot AND at switch time.
- Slack/Telegram tokens ride the existing safeStorage seam (pseudo-
  providers slack-bot / slack-app / telegram-bot): decrypted only at
  spawn, injected into the child env, never on disk in plaintext.
- HOME_CHANNEL_ID stays the ONE generic key every backend script reads;
  main.cjs resolves which stored id it means per backend. Injected env
  beats dotenv, so a stale discord-era .env cannot leak into other lanes.
- Shell "Open Discord" button now renders only when discord is the active
  backend.

### Guards
- test-packaging gate extended: channel scripts are named explicitly in
  both build.files and asarUnpack checks (they are single files, spawned
  outside Electron — the directory scan alone never covered them, and a
  missing backend script only fails at the moment the user switches).
- hooks/stop-reply-guard.mjs: channelId regexes accept negative ids
  (Telegram group chats) — digits-only left the guard silently inert there.
- docs/slack-app-manifest.yaml: added missing `files:write` + `users:read`
  scopes (file upload + sender name resolution would have died at runtime).
- Wizard step-4 copy de-lied: slack/telegram buttons now point to the
  채널 tab post-setup instead of claiming "지원 예정".

## Test receipts
- scripts/test-channel-connect.mjs — 19/19 (enumeration branches, backend
  resolution fallback).
- scripts/test-telegram-channel.mjs — 65/65 (injection filter/format,
  chunking boundaries incl. 4000/4001, ledger round-trip, token-reject
  marker incl. real subprocess exit-1).
- scripts/test-slack-channel.mjs — 74/74 (echo filter, chunking, liveness
  gate, name cache, token-reject marker with bot/app distinction incl.
  live boot against real Slack API).
- Regressions: test-discord-reconnect 24/24, test-outbound-channel 14/14,
  test-liveness-marker 24/24, test-packaging repo-half 36/36.

## Known limits (named, not hidden)
- Slack/Telegram REAL-token end-to-end runs only after Mino issues tokens
  (BotFather + manifest app) — until then backends are verified to unit +
  mock-integration + fake-token boot level.
- Telegram read_channel_history covers only what the ledger heard (bot
  offline gaps are absent, by API limitation — stated in tool description).
- Onboarding wizard still walks Discord-only; other backends connect
  post-setup on the 채널 tab.
- Backends deliberately do NOT carry: autonomy watcher, note-cadence,
  shutdown watcher, thinking-indicator reaction (follow-up lane if wanted).
- Version-swap TCC stale-grant class unchanged (0.1.0 attach territory).
