<!--
Phase A scope — 2026-10-06, branch chromux-live-20261006, base main.

Current wiring
- Browser access is a shell-driven skill, not a dedicated MCP browsing tool.
  Both Claude/headless and DSH lanes consume the seeded chromux/websearch skills.
  websearch uses isolated sessions, with no explicit live-profile selection.
- package.json extraResources copies vendor/chromux to Resources/chromux.
  onboarding/harness-render.cjs syncChromuxPortable resolves Resources/chromux
  first, vendor/chromux second; copies to DATA_HOME/bin/chromux-portable;
  writes chromux / chromux.cmd launchers and seeds bundled skills.
- Boot calls syncChromuxPortable in onboarding/http-server.cjs.
  Settings UI: onboarding/public/settings.html and public/js/settings.js;
  routes: onboarding/routes/settings.cjs. Existing settings persist through
  readAgentConfig/writeAgentConfig into DATA_HOME/.agent-config (atomic rename).
- DSH tool-ask-user is explicitly disabled: its web-UI question provider hangs
  in channel-mediated runs. Replies ask questions, but are not an action gate.
  Headless runs skip CLI permissions; these cannot serve as live consent.

Live requirements
- User installs vendor/chromux/extension (synced portable extension directory)
  via chrome://extensions, Developer mode, Load unpacked; no Web Store listing.
  Link vendor install.md, Live mode section, and show the actual folder path.
- Pair button runs chromux pair: starts loopback bridge and waits for extension;
  no token, automatic reconnect after restart. Bound wait/status is necessary.
- Toggle defaults OFF, persisted as an existing .agent-config field.
  Opt-in selects CHROMUX_PROFILE=live only for explicitly requested live work;
  ordinary web research must retain its isolated profile.
- Read allowlist: open <session> --tab active WITHOUT URL; snapshot/read-text
  extraction and screenshot of that attached session. --tab belongs to open,
  not snapshot/screenshot. Do not classify arbitrary JavaScript as a read.
- Write gate: open with URL/navigation, click, fill/type, press (Enter submits),
  submit flows, run/eval/raw CDP, drag/hover/download and unknown operations.
  Confirm each concrete action, bound to channel, exact argv and target tab;
  consume once on explicit yes, clear on no or after two minutes. Reattach or
  changed tab/action needs new consent. No batching writes under one approval.
- Add a channel-runtime confirmation primitive and consume actual inbound user
  messages in each channel adapter; model-provided yes is never user consent.
  A prompt-only wrapper is not enforcement: direct shell chromux invocations
  and raw CDP can bypass it. Gate at the live execution boundary as well.
- Live safety already provided by vendor: attached-tab close detaches; kill live
  leaves Chrome running; debugging banner/green tab group; popup kill switch;
  chrome:// and headless launch unsupported. Bridge trusts local processes and
  rejects requests carrying Origin. None of this supplies per-write consent.
- Fail open for existing isolated browsing; fail CLOSED for live writes if
  confirmation state, channel identity, settings, bridge or target is missing.

Verification planned: classification + unconfirmed/yes/expired gate tests;
full npm test; real Chrome extension/pair/channel confirmation smoke test.
No memory/ changes, dependencies, commits or implementation in Phase A.
-->

## Phase B implementation receipt

Live launcher and consent gate shipped; toggle defaults OFF. Pairing is bounded
at 60 seconds. Pending asks cross the shell/channel process boundary via
DATA_HOME/consent/pending-*.json; channel-runtime owns the pendingConsent map
and only human ingress can issue a single-use exact-channel/argv receipt.
JSON argv is required for --ask to avoid shell parsing/injection ambiguity.
Long-lived lanes cannot inherit a different environment for each shell turn;
SCHZ_CHANNEL_ID is supported, but instructions require explicit --channel from
the current inbound tag rather than guessing a home channel.
Launcher enforcement is NOT an OS sandbox: direct vendor live/raw-CDP calls by
a local process remain possible. Skill and template explicitly forbid bypass.
Chrome extension pairing and messenger end-to-end behavior remain unverified.
