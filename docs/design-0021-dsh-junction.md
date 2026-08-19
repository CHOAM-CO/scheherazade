# 0.2.1 — dsh junction design (2026-08-19, idea)

Requirements locked (Mino 16:13-16:15):
- Claude Code's role in schz → dsh (pinned rc-7). Schz UI/UX tone stays
  (frosted/translucent); chat + trajectory structure borrowed from dsh;
  Think = collapsible. FULL PARITY in one track: 같이보기, sudo vault,
  channel bridges included.

## Junction (from rc-7 source map, receipts in session_notes 08-19)

Backend engine: spawn `dsh web --port 0` per app instance (headless is
one-shot; ACP is NOT in the npm artifact — do not plan on it until it
ships). Parse announced URL. Keep `--expose-internals` (electron-node) and
the DSH_HOME seeds (workspace.json v2 WITH updatedAt, settings.yaml).

Renderer ↔ dsh protocol:
- RPC: `POST /api/<method>`, body `{type:'client-request', rpcId, method,
  payload}`. Methods: session.create / session.prompt (mode queue|steer) /
  session.cancel / session.list / session.history (paged) / session.models
  / session.selectModel / workspace.* ; approvals+questions answered via
  `POST /api/respond` with the frame's rpcId.
- Streams: WS `/api/events.mux` (frames: session/event passthrough +
  session/subscribed{lastSeq} + queue/jobs/projection + approval/question
  requested|resolved + stream/error), WS `/api/events.host` (session
  add/remove, running flips). Downlink-only.
- Trajectory rendering vocabulary: turn/start|end, step/start|end,
  tool/call|result (may carry ToolEventView render intent — use it),
  assistant/chunk {text-delta | reasoning-delta | tool-call-delta | usage
  | finish}. reasoning-delta feeds the collapsible Think block.
- No since-resume: on WS reconnect, reopen + refetch session.history.

Trust fence (NOT auth — reachability only): Host must be loopback or
--trusted-host; if Origin present it must EQUAL the Host authority;
`sec-fetch-site: cross-site` refused → 403. Electron renderer loading
file:// or custom scheme sends Origin null/none → **rewrite Origin to the
dsh host authority via webRequest.onBeforeSendHeaders for /api requests
(HTTP + WS upgrade both)**. Privileged methods (settings.*, credentials.*,
host.openPath...) are loopback-pinned — fine, we're loopback.

RC-bump watchpoints: rpc-map.d.ts + events.d.ts diffs (gateway is
mid-migration legacy ApiProxy → Typert; session/workspace still legacy in
rc-7). Session-event vocabulary is version-gated and more stable than the
RPC plane.

## Parity ports (graft, not rewrite)

- 같이보기 / sudo vault / permissions / recent-files: app-level features —
  keep 0.1.x implementation, feed captures to the vision route
  (qwen3.5:cloud) via session.prompt image content.
- Channels (discord/slack/telegram): reuse connectors; NEW junction bridge
  replaces MCP-notify injection → session.prompt into a dedicated dsh
  session + reply out of assistant/message events.
- Persona: workspace seeds done (self_persona/checkpoint in main-v2);
  system-prompt injection via dsh persona row = next (diet the 10.9KB
  template on the way in).
- Journal/memory DB tools: port as MCP rows (dsh-mcp-client is
  config-level, mcp__server__tool naming identical to Claude Code).
