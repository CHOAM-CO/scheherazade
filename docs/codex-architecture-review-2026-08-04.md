# What Codex's architecture is worth to us — 2026-08-04

Mino asked (00:04) to read the open-codex project and fix what is worth fixing,
then (00:06) steered it: *"UIUX나 프록시 다중 관리면에서 참고할만한거 있을듯"*, apply
my own judgement, keep it rollback-able.

## Which repo

**`openai/codex`** is the reference. 103.6k★, Apache-2.0, pushed 2026-08-03, now
~96.6% Rust across ~130 crates under `codex-rs/`.

**`ymichael/open-codex`** — the TypeScript fork with the matching name — is
**not** a useful reference and nothing here comes from it. Last push 2025-05-03,
15 months stale, forked from the pre-Rust CLI. Its multi-provider support is a
hardcoded `switch` in `apiKeyForProvider`/`baseURLForProvider` and it picks a
default provider by sniffing which API-key env var happens to be set (two set =
arbitrary winner). `provider-env.cjs`'s `PROVIDER_ROWS` is already better than
that fork in every dimension. Recorded so nobody re-reads it hoping.

**Is Codex a good reference for us?** For provider/proxy/config, yes — it is the
most carefully specified multi-provider config system in this space. For UI/UX,
**only half**. Codex is *attended and session-based*: a human at a terminal
approving things. Scheherazade is *unattended and persistent*: a Discord agent
with nobody at the keyboard. A large part of Codex's UX machinery is load-bearing
only under the attended assumption and is actively wrong for us. Those are in
§"Not worth copying" rather than laundered into lessons.

## Applied already

- **`bootstrap-needed` had no copy row** (`d0e61c6`). `main.cjs` sets it at four
  attach-topology call sites; `copy.js` had no entry, so
  `causes[code] || causes.unknown` told the user to "wait a moment and click
  Check status again" for a condition where nothing is transient. Found by
  reading Codex's error taxonomy and asking which of OUR codes are unhandled.

## Worth doing, ranked by value-to-effort

### 1. Ephemeral port for the chatgpt proxy — SMALL

Codex's `responses-api-proxy` takes `--port` as optional; unset means bind an
ephemeral port and write `{"port","pid"}` to a `--server-info` file the parent
reads. There is no default port, so there is no collision policy to get wrong.

Ours: `provider-env.cjs:68` pins `CHATGPT_PROXY_DEFAULT_PORT = '18080'`, and on
`EADDRINUSE` at that port `main.cjs` **refuses to spawn the agent at all**. That
refusal is correct — routing the conversation stream at an unidentified local
listener is worse. But the whole failure class is self-inflicted: our proxy is
**in-process**, so nothing outside the app needs to know the port in advance.
`main.cjs:189` already uses `listen(0, …)` elsewhere.

Adopting it deletes the block-and-don't-spawn branch and the `lsof` diagnostics
with it. `CHATGPT_PROXY_PORT` stays as the explicit user-opt-in reuse path.
Ollama legitimately keeps a fixed port — the daemon owns 11434 by convention.

**Not done tonight on purpose**: it touches the spawn path hours before Mino
tests a build.

### 2. A real error-code vocabulary — SMALL

Codex's `CodexErrorInfo` is a closed union (`contextWindowExceeded`,
`usageLimitExceeded`, `httpConnectionFailed{httpStatusCode}`, `unauthorized`,
…) delivered with **`willRetry: boolean` on the error itself**, so the client
never has to guess whether to draw a retry button or a spinner.

Ours: `setAgentStatus(state, code, detail)` has no enum and no validation, and
**13 of 21 `failed` call sites in `main.cjs` pass `'unknown'`** — including both
proxy failures, all three token-read failures, spawn error and unexpected exit.
The real reason lives only in the app log, which the user cannot open: the
"openLogs" button is rendered **disabled**, because no log route, no exposed
path and no IPC bridge exists.

Cheapest first: (a) freeze the code vocabulary as an exported const and make
`setAgentStatus` reject unknown codes in dev — `provider-env.cjs:793` already
does exactly this for `PROVIDER_ROWS`, so it is idiomatic here; (b) split
`'unknown'` into the 6–8 codes the call sites already know; (c) add `willRetry`
so `wizard.js` stops drawing a retry button that its own comment admits "does
not itself restart the agent process."

### 3. Model catalog as data, not renderer source — SMALL/MEDIUM

Codex caches its catalog as `{fetched_at, etag, client_version, models[]}` and
invalidates on **either** TTL expiry **or** a `client_version` mismatch, so
upgrading the binary invalidates a stale catalog even inside the TTL.

Ours: `MODEL_CATALOG` is a hardcoded array in `onboarding/public/js/settings.js`,
interleaved with a ~17-line prose obituary for a dropped provider. It has already
drifted — `onboarding/http-server.cjs` carries a context-cap table naming
`claude-opus-4-7` and `claude-sonnet-4-6`, **neither of which exists in the
catalog**. The default model string is hardcoded in four places. Base-URL presets
are hardcoded twice more.

Move it to a bundled JSON file with `contextWindow` as a field — that one
addition folds `contextCapForModel()` back into the same record and kills the
drift structurally. Keep `client_version` from day one even without remote fetch,
so adding refresh later invalidates correctly.

### 4. A status that can say "alive but blocked" — MEDIUM

Codex's `ThreadStatus` is a tagged union whose `active` variant carries
`activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[]`.

Ours is a flat string over `idle|connecting|live|stopped|failed`, and `nav.js`
collapses it further to `running = live || connecting`. **The UI cannot express
"working" versus "alive but stuck waiting"** — which, for an always-on agent
someone checks on from Discord, is the single most useful thing the status pill
could say. Today the only signal is the typing dots, capped at 3 minutes, whose
own comment is an explicit refusal to dress a silent agent as an active one.
Right instinct, wrong lever: the fix is a richer status, not a shorter animation.

We do not want Codex's approval flags. We want ours: `waitingOnRateLimit`,
`waitingOnChannelReconnect`, `compacting`, `idleNoWork`.

### 5. Named profiles, and a precedence ladder that is written down — MEDIUM

Codex documents six layers highest-first, and — the part worth stealing hardest
— **forbids lower-trust layers from setting credential-adjacent keys**
(`base_url`, `model_provider`, `model_providers`, `notify`, `profile`), printing
a startup warning rather than silently ignoring them.

Ours has no layering in the app process at all, and the one merge that exists is
**inverted**: `supervisor.mjs:162` does `{ ...env, ...fileVals }`, so the file
beats the environment and `MODEL=x ./run.sh` silently does nothing. There is also
a third independent re-implementation of the same parser in `channel-runtime.mjs`,
called per poll.

The real prize is **profiles**. `parseCustomProviderJson` refuses multi-provider
pastes because "this app runs one provider at a time" — the right constraint, but
the consequence is that switching lanes destructively rewrites one flat file.
Codex's answer is a named config layer per lane. For us:
`~/Documents/Scheherazade/profiles/<name>.agent-config`. That turns our
one-at-a-time limitation from a wart into a feature and gives the settings page
something coherent to render.

### 6. Provider descriptors: headers, `auth.command`, and a fix-hint — MEDIUM

`ModelProviderInfo` carries `http_headers`, `env_http_headers`, `query_params`,
retry/timeout budgets, and `[model_providers.<id>.auth]` — a **credential helper
command** whose stdout is the bearer token, so Codex never stores the secret. Its
`validate()` encodes mutual exclusion as data and names every conflicting field
at once. `env_key_instructions` rides with the provider and is surfaced *in the
error* when the key is missing.

Our `PROVIDER_ROWS` is already this design and is genuinely good. The gaps are
narrow: no custom headers (so any proxy needing a routing header is unusable via
the `custom` lane), no `auth.command` (rotating-token proxies impossible), and
**`notReady` strings say what is wrong but not how to fix it**. A sibling
`notReadyFix` field is ~10 lines and the highest UX-per-line item in this review.

### 7. Activity items in the transcript — MEDIUM, and smaller than it looks

Codex emits `item/started` / `item/completed` alongside its delta stream.

**Per-token streaming is worth much less to us than to Codex** — our primary
surface is Discord/Slack, which don't stream. Chasing `agentMessage/delta` is a
large refactor for a benefit the main channel cannot render. **The valuable half
is `item/started`.** `channel-local.mjs` already assigns a monotonic `seq` and
`drain(from)` already returns `{items, latest, missed, state}`, so pushing
non-terminal *activity* items ("running `npm test`") into that same queue is
additive and needs no transport change. It is what actually kills the silent
three-minute problem. `MAX_QUEUE = 500` needs a think first — activity items
churn it faster than replies do.

### 8. Named permission ceilings as a product surface — MEDIUM

Codex has `:read-only` / `:workspace` / `:danger-full-access` plus custom
profiles with `extends` (and refuses to let `extends` point at the dangerous
one, refuses undefined parents and cycles).

We pass `--dangerously-skip-permissions` unconditionally and `canUseTool` has
zero hits in the repo. For an unattended agent that is defensible — `run.sh`
documents it as a deliberate reversal — but it is currently all-or-nothing and
**invisible**. A named, user-selectable ceiling the settings page *renders*
("this agent may write only under `~/Documents/Scheherazade`") is what makes an
always-on agent sellable to someone nervous about it. Steal the `:`-prefix
convention so a user profile can never shadow a built-in.

Note our word "permission" currently means macOS TCC/SIP/sudo walls, which is a
different and already-shipped piece of work.

## Not worth copying

- **The approval request/response loop.** It assumes a human present within
  seconds. Our entire premise is that they are not. Codex's own `ReviewDecision`
  had to grow a `"timed_out"` variant; for us *every* prompt would time out, so
  we would build an elaborate mechanism whose only reachable branch is the
  timeout. `--dangerously-skip-permissions` + a declared ceiling + post-hoc
  receipts is the right shape here.
- **The OS sandbox stack** (`linux-sandbox`, `bwrap`, `windows-sandbox-rs`,
  `execpolicy`, a SOCKS5 network proxy with domain allowlists). Many
  engineer-years, and it exists to protect *a repository* from *a coding agent
  writing to it*. Our agent operates on its own `DATA_HOME` under the user's own
  subscription. The threat model does not transfer.
- **Rust and the 130-crate workspace.** An artifact of shipping one static binary
  to 100k+ users on three OSes. `docs/windows-port-scoping.md` records our
  deliberate zero-native-modules stance and node-pty is already one more than we
  wanted. Don't let the crate graph talk us out of that.
- **A wire-protocol translation layer.** Codex **removed** `wire_api = "chat"`
  entirely; `responses` is the only accepted value now. `provider-env.cjs`
  refuses anything but `anthropic-messages` for the same reason. Same posture,
  already correct — Codex is evidence *for* our call, not against it.
- **`codex app-server` as a wholesale refactor.** The protocol vocabulary is
  worth stealing (§4, §7). Splitting into a headless core behind versioned
  JSON-RPC with generated clients pays off with three independent frontends built
  by different teams. We have one renderer.
- **Cloud / multi-agent / memories / OTel / plugin marketplace / enterprise
  `requirements.toml`.** That last one exists so an IT admin can forbid a setting
  fleet-wide. We have no fleet admins.

## Windows

Codex's Windows story changed recently: the in-repo `docs/install.md` still says
"Windows 11 **via WSL2**", but the README now ships a native PowerShell installer
and there is a `windows-sandbox-rs` crate. **Treat the in-repo doc as stale.**

- **Degraded capability is a queryable three-state value, not a boolean.**
  `WindowsSandboxReadiness = "ready" | "notConfigured" | "updateRequired"`. This
  is the direct answer to our biggest Windows liability: `supervisor.mjs`
  **disables the stall watchdog entirely on Windows** because the transcript path
  munge is unverified. To our credit it logs that at every spawn — but into a
  pane the user cannot open. Make it a value the UI renders. `updateRequired` as
  distinct from `notConfigured` is the detail worth copying: "do something" and
  "do something *different from last time*" are different user tasks.
- **The world-writable-directory warning** —
  `{ samplePaths, extraCount, failedScan }`. On Windows, directories are
  routinely world-writable, so any trust boundary that assumed Unix permissions
  is void. Two details to lift exactly: `extraCount` (say "and 47 more", never
  truncate silently) and **`failedScan`** — an honest third state for "we could
  not check", distinct from "we checked and it is clean". Directly relevant: our
  `chmod 0o600` on the credential blobs is a no-op on Windows and what actually
  protects them is the inherited profile ACL.
- **Codex answers our open Phase-3 decision.** `windows-port-scoping.md` records
  "shell tool flips PowerShell↔Git Bash on Git-for-Windows presence — DECISION
  STILL NEEDED." Codex's answer: the terminal is an **explicit user setting**
  (PowerShell / cmd / Git Bash / WSL), applied to new sessions only. Do not
  auto-detect silently. A shell that changes identity because the user installed
  Git last Tuesday is an unreproducible bug report.
- **Honest degradation over a broken feature.** `codex app` opens the workspace
  on macOS and on Windows just **prints the path**. They shipped the lesser
  behaviour with the difference documented. Same lesson we learned the hard way
  when the TCC probe ran on Windows and logged three alarming DENIED lines for a
  permission system that does not exist there.
- **Distribution.** Codex ships via Microsoft Store / `winget`. Our locked call
  is unsigned NSIS with SmartScreen friction accepted, which is fine for v1 —
  but note it is **Store distribution, not code signing alone**, that removes the
  warning. Worth knowing before buying a certificate.

**One thing Codex cannot help with.** Our hardest Windows risk is
`resolveClaudeBin()` looking for **`claude.exe` only**: an npm-installed
`claude.cmd` shim would *detect* successfully and then fail at ConPTY spawn,
because `CreateProcess` does not interpret `.cmd`. Codex sidesteps this by
shipping one static binary. There is no architecture to borrow — it needs one
real run on a Windows box with an npm-installed CLI.

## Incidental

`/Users/narr/Desktop/scheherazade/http-server.cjs` (root, 2445 lines) is a
**stale unreferenced duplicate** of `onboarding/http-server.cjs`. `main.cjs`
requires the `onboarding/` one; nothing requires the root copy. Every repo-wide
grep double-reports, and a fix landed in the root copy would ship nothing. Worth
deleting, but it is a deletion — Mino's call, not taken here.
