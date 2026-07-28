# Scheherazade — Incident & Decision History

(moved out of source per issue #4; dates/reviewers/test tallies preserved here)

This file exists so production source comments can carry the load-bearing
*invariant* ("why the code must stay this way") without also carrying the
*narrative* of how each invariant was discovered (dates, reviewer names, exact
tallies). Every subsection below corresponds to a `(history: docs/HISTORY.md)`
pointer left at the original comment site — see that file/function for the
current, load-bearing version of the comment.

## channel.mjs

### DATA_HOME resolution — two sub-bugs in the first fix draft (agent-lifecycle fix, 2026-07-03, hardening item E1; code-review pass, 2026-07-03)

The first version of this fix used a fixed `~/Documents/Scheherazade`
fallback when `AGENT_DATA_HOME` was unset. An independent review caught two
real bugs in that version before it shipped:

1. `npm start` (`package.json`'s `"start": "node channel.mjs"`) runs this
   file directly with no `AGENT_DATA_HOME` set. A fixed fallback meant local
   dev would read/write the SAME marker files (`DATA_HOME/.agent-live`,
   `.agent-failed.json`) the real packaged, onboarded app uses at
   `~/Documents/Scheherazade` — corrupting production liveness/failure state
   from a dev run. (Confirmed this exact failure mode once already during
   this fix's own verification pass, on `scripts/test-liveness-marker.mjs` —
   see that file's own comment — and initially only guarded there, not
   here.) Fixed by falling back to `~/Documents/agent` (`AGENT_NAME`'s own
   default) instead — nowhere near the real app's fixed path, so a
   `npm start` dev run can no longer collide with it.
2. This fallback used to disagree with run.sh's OWN fallback for the exact
   same no-`AGENT_DATA_HOME` case (a standalone/non-Electron CLI
   deployment) — run.sh writes its own `write_failure()`/`clear_failure()`
   markers to `$HOME/Documents/$AGENT_NAME`, channel.mjs was writing its
   markers to a DIFFERENT fixed directory. Fixed to be identical.

Before this pass, `LIVENESS_MARKER_PATH` was `path.join(process.cwd(),
'.agent-live')`, which only worked because `.mcp.json`'s agent-channel entry
happens to set `cwd: DATA_HOME` (see `onboarding/http-server.cjs`'s
`ensureMcpJsonAgentName()`) — a coincidence, not a guarantee.

### v0.0.16 incident — cadence/ missing from packaged app (07-16 14:05)

`cadence/` was missing from the packaged app, the `require()` for the note
cadence watcher threw synchronously inside the Discord `ClientReady`
once-handler, and the WHOLE BRIDGE died — app stuck on "starting".
Packaging was fixed (`build.files` + `asarUnpack` + a `test-packaging`
assertion added to catch this class going forward), and the v0.0.17
hardening pass wrapped `startNoteCadenceWatcher()` in a try/catch so a
broken optional feature degrades to a loud log instead of taking the bridge
down again.

## main.cjs

### (c) real agent child spawn — origin + agent-lifecycle fix changelog (2026-07-03)

This spawn path replaced the old `demoChildProcessSupervision()` one-shot
spike (proved "can Electron main spawn+capture+reap a child" — retired once
its job was done).

**Bundling** (RESOLVED 2026-07-03, bundle-claude-cli task — closed the
BLOCKER from the packaging-bugfix task): `@anthropic-ai/claude-code` became
a real `dependencies` entry in `package.json` (Mino pre-approved:
redistribution terms waived, arm64-only, "max UX so the user never installs
anything separately"). Its postinstall (`node_modules/@anthropic-ai/claude-code/install.cjs`)
detects the platform and hardlinks/copies the matching platform package's
(`@anthropic-ai/claude-code-darwin-arm64`) native Mach-O binary over the
`bin/claude.exe` placeholder — after `npm install`, that file IS the real
standalone arm64 executable (confirmed: `file` reports Mach-O 64-bit arm64,
runs `--version` with no system node on PATH). electron-builder's
`build.extraResources` copies that one file to
`Contents/Resources/claude-cli/claude` at build time (`build.files` excludes
`node_modules/@anthropic-ai/claude-code*/**` from the asar so the ~220MB
binary isn't duplicated into app.asar on top of the extraResources copy).

**AGENT-LIFECYCLE FIX** (2026-07-03, model-divergent/GPT review — four
verified bugs, closed in one revision):
- **BUG 1 (trigger)**: `spawnRealAgentChild()` used to run ONCE at
  `app.whenReady`, before `ONBOARDING_COMPLETE` could possibly be `'1'` on a
  fresh install — it skipped, and nothing ever called it again until the
  next full app restart. Fixed by having `createOnboardingServer()` take an
  `onOnboardingComplete` callback fired synchronously from the
  `/api/discord/validate` success path, the exact moment
  `ONBOARDING_COMPLETE` flips.
- **BUG 2 (persistent run)**: this used to spawn `claude` directly with
  stdio `['ignore','pipe','pipe']` — no TTY, so Claude Code runs in
  `--print` mode, which exits immediately without a prompt/stdin. Fixed by
  reviving run.sh as an INTERNAL bundled launcher instead of spawning the
  claude binary directly: run.sh's `__loop` mode runs it under
  `/usr/bin/expect` (a real PTY) with the proven exponential-backoff restart
  ladder and trust-prompt handling already battle-tested elsewhere in this
  fork's lineage. (An earlier pass had left a comment calling run.sh "DEAD
  (Mino directive)" on a mis-read of that directive; reviving it as an
  internal launcher — the user never touches a CLI, they double-click the
  .app; run.sh is an implementation detail, not a CLI surface — was
  confirmed intended and approved.)
- **BUG 3 (token forward)**: empirically confirmed NOT a bug — see the
  BOT-TOKEN SEAM entry below for the test and result.
- **REQUIREMENT 4 (liveness gate)**: see `onboarding/agent-status.cjs`
  (process side) + `http-server.cjs`'s `GET /api/agent/status` (combines
  that with `channel.mjs`'s `DATA_HOME/.agent-live` Discord-heartbeat
  marker).

### Provider proxy port owner — the 07-06 run-agent incident

The comment on the in-process HTTP server (Express, listening only after
confirming the npm package exports `createApp()`) used to note that the
dual-supervisor mutual-kill class from "the 07-06 run-agent incident" was
structurally impossible for this server specifically, because it's
in-process (no external process to signal by mistake, no orphan on crash,
no binary resolution/spawn surface). The 07-06 run-agent incident itself was
a dual-supervisor mutual-kill: two supervisors alive at once fighting over
the same Discord token via `pkill`, each replying on Discord. That incident
is what Fix C (below) closes for the bash-launcher path.

### Model passthrough — caught live on Mino's second-device test (2026-07-14)

Caught live on Mino's second-device test, the same morning the versioned GPT
catalog shipped: codex-as-api's anthropic route sends its MODULE-LEVEL
default model and only ECHOES `body.model` back (`dist/index.js:
requestModel = MODEL; clientModel = body.model`) — so the dropdown's
`gpt-5.6-*` pick never reached the engine, and three catalog entries were
one actual model (the proxy default, gpt-5.5 at 0.5.2). Fixed by reading
`CODEX_AS_API_MODEL` once at load (env set BEFORE `require`, require-cache
evicted per (re)build so a model swap reloads the constant), with the
proxy's own `/health` `model` field as the RECEIPT gate after listen — if
the engine-side model doesn't match the user's pick, the proxy dies loudly
rather than serving a silently different model.

### BOT-TOKEN SEAM — empirical forwarding test (security review 2026-07-03; agent-lifecycle fix PART 3)

Forwarding EMPIRICALLY CONFIRMED, 2026-07-03: confirmed by direct test
(bundled `claude.exe` + a scratch `.mcp.json` whose env block deliberately
carried NO token, matching production's `ensureMcpJsonAgentName()` shape, +
a throwaway MCP child that echoed its own `process.env` back to a receipt
file). Result: the `claude` CLI forwards its FULL parent env (151 inherited
keys, +1 = 152 when `DISCORD_BOT_TOKEN` was set; 0 when it wasn't —
positive/negative control, repeated) to every MCP server child it spawns,
merged with (not replaced by) that server's own declared `env` block in
`.mcp.json`. This is why BUG 3 above was confirmed NOT a bug.

Separately: this comment previously and incorrectly claimed
`--dangerously-skip-permissions` was deliberately unused system-wide. That
was true of run.sh's OLD behavior only — per Mino's 2026-07-04 directive,
run.sh now passes `--dangerously-skip-permissions` on its own claude
invocation (see run.sh's own comment). The comment never described this
`spawn()` call (which targets `BASH_BIN`, not `claude`, and the flag only
means anything on the `claude` command line) either way; both the old and
corrected text agree this spawn() call does not set the flag.

### node shim PATH patch — live receipt, Mino's 07-16 18:01 log paste

Production spawns the BASH lane (run.sh) exclusively, so packaged installs
never got the node shim `ensureNodeShim` applies inside `supervisor.mjs`'s
own (NODE-lane-only) spawn path, and every Claude Code hook died with
`/bin/sh: node: command not found`. Live receipt: Mino's 07-16 18:01 log
paste — the `/logs` viewer's first real catch — showed `stop-reply-guard`
among the dead, which is exactly why the agent's promised Discord reply was
never bounced back into an actual send. Patched by applying the same shim
to the bash-lane child's env directly.

### Two-layer kill — ps-pgid empirical verification (2026-07-03)

Layer 2 (`bash run.sh stop`) was EMPIRICALLY CONFIRMED NECESSARY in a
2026-07-03 verification pass: when GNU coreutils' `timeout`(1) IS present
(common via Homebrew — `run_expect()` prefers it), it puts ITS monitored
command (expect, and everything expect spawns, including claude) into a
**new, separate process group** so it can kill that subtree on its own 12h
ceiling — confirmed via `ps -o pgid=`, expect/claude's pgid was NOT run.sh's
pgid in that mode. Sending `kill(-run.sh_pid)` in that mode signals ONLY
run.sh's own group (bash itself, and NOTHING else), and bash won't even run
its own TERM trap until its foreground `wait` on that (differently-grouped,
still-alive) `timeout` child returns, which can be up to 12h. This was
verified to leave the ENTIRE tree alive indefinitely with layer 1 alone —
hence layer 2, which reaches the claude process by COMMAND-LINE PATTERN
MATCH via run.sh's own `stop_agent()`, unaffected by process-group
placement.

### Graceful shutdown — design weld / deepseek swap anecdote

The comment on the hung-agent-must-never-hold-quit-hostage rule used to
credit it as "my design weld, posted to home 19:4x," and noted that a
deepseek model swap earlier that day live-proved why the rule matters:
continuity survived the swap precisely because the agent wrote checkpoint
right before it.

### P1 wiring points (entire original block, ~93 lines, removed with no replacement)

This block used to sit at the bottom of main.cjs, cataloguing four
originally-open wiring points and their status as of the agent-lifecycle
fix revision. Preserved here verbatim since each item's substance now lives
at its own call site (resolveClaudeBin, spawnRealAgentChildLocked, the
BOT-TOKEN SEAM comment, ensureMcpJsonAgentName, DATA_HOME, and
createOnboardingServer's token/Host/Origin checks):

> **1. Real `claude` CLI agent child** — DONE this revision, including the
> bundling blocker from the prior packaging-bugfix task AND the
> agent-lifecycle fix (2026-07-03, model-divergent/GPT review):
> - run.sh is REVIVED as an internal bundled launcher (this revision
>   corrects a prior comment here that called it "DEAD" on a mis-read
>   directive — reviving it as an internal launcher, never exposed as a CLI
>   surface to the user, is intended and approved). `run_loop()`'s proven
>   exponential-backoff restart ladder (KST-aware reset, 5/10/20/40/120s) +
>   `/usr/bin/expect` PTY + trust-prompt handling is what actually keeps the
>   agent alive now — `spawnRealAgentChild()` spawns `bash run.sh __loop`
>   (RUN_SH_PATH), not `claude` directly.
> - BOT-TOKEN SEAM (security review, 2026-07-03) — WIRED, and env
>   forwarding through claude -> its MCP children EMPIRICALLY CONFIRMED
>   (2026-07-03): `readDiscordToken()` is decrypted at the moment of spawn
>   and injected directly into the child's own `env: {...}`, alongside
>   `readHomeChannelId()`. Never written back to any on-disk config.
> - RESOLVED (bundle-claude-cli task, 2026-07-03): `@anthropic-ai/claude-code`
>   is now a package.json dependency; its postinstall places the real
>   standalone arm64 Mach-O binary at
>   `node_modules/@anthropic-ai/claude-code/bin/claude.exe`, and
>   electron-builder's `build.extraResources` copies that file to
>   `Contents/Resources/claude-cli/claude` — exactly the path
>   `resolveClaudeBin()` looks for in a packaged app. Verified: DMG builds,
>   binary is present+executable inside the built .app, and runs
>   `--version` from that bundled path with no system claude/node needed.
> - Liveness gate (REQUIREMENT 4) — WIRED: `onboarding/agent-status.cjs`
>   tracks this child's spawn/error/exit; `http-server.cjs`'s
>   `GET /api/agent/status` combines that with `channel.mjs`'s
>   `DATA_HOME/.agent-live` Discord-heartbeat marker for the Step 5 UI to
>   poll. NOT yet wired at that time: killing this child on app quit
>   (window-all-closed intentionally left it running, matching the
>   daemon-survives pattern — but a full Cmd+Q quit then left it orphaned
>   rather than gracefully stopped; noted as an open follow-up, outside that
>   revision's four-bug scope).
>
> **2. Provider proxy child**: at that point, no such process existed yet
> anywhere in this fork. Noted that it would need spawning the same way as
> (1) — same supervision primitives (spawn/stdout-capture/exit-handling)
> apply directly, just against a different binary/script — and that port
> allocation for the proxy would need the same ephemeral-port pattern
> `startOnboardingServer()` uses (`server.listen(0, ...)` then read
> `server.address().port`) so it doesn't collide with the onboarding server
> or a second app instance.
>
> **3. Real onboarding wizard** — DONE (that revision):
> - Static files under `onboarding/public/` served via `node:http` + a tiny
>   static-file router (`onboarding/http-server.cjs`), option (a) from the
>   original note here. No preload/contextBridge needed after all — "call
>   back into main" turned out to fit entirely inside the localhost server's
>   own JSON API (`fetch()` from the sandboxed renderer), so the
>   BrowserWindow stays contextIsolation/no-Node/sandboxed exactly as the P0
>   spike had it.
> - BYOK key storage uses Electron safeStorage (Keychain-backed), not a
>   write-to-.env pattern — deliberately, to keep provider keys off disk in
>   plaintext.
> - Config write DOES extend setup.sh's `.agent-config` format (now
>   multi-key + quoted) rather than duplicate setup.sh's full bootstrap
>   (CLAUDE.md/settings.local.json rendering, self_persona.md, checkpoint.md
>   creation) — that fuller bootstrap was still setup.sh's job and outside
>   that revision's scope. Discord token + home channel still land in
>   `.env`, matching setup.sh's existing field names exactly so a later
>   setup.sh run or run.sh launch reads them unchanged.
> - Fixed a latent config-drift bug while wiring this up: the checked-in
>   `.mcp.json` had `AGENT_NAME=companion` (leftover from the agent-portable
>   fork) for both its "agent-channel" and "memory" MCP server entries.
>   Since `memory/server.mjs` resolves its DB path from `AGENT_NAME` at
>   import time, that mismatch would have made the wizard's memory writes
>   and the live agent's future memory MCP server point at two different
>   databases. `onboarding/http-server.cjs` corrects this at server boot
>   (see `ensureMcpJsonAgentName()`).
>
> **4. Packaging + localhost-auth hardening** (security review, 2026-07-03):
> - `.agent-config`/`.env`/`.mcp.json` moved from REPO_ROOT (read-only once
>   packaged inside app.asar — writing there was boot-fatal) to DATA_HOME, a
>   FIXED directory (`~/Documents/Scheherazade`, pinned to the literal
>   product name, not to AGENT_NAME or the user-renameable DISPLAY_NAME)
>   that memory.db already lived in. A rename from the Settings page edits
>   only a DISPLAY_NAME value inside `.agent-config` — it never moves
>   DATA_HOME.
> - The onboarding server now requires a per-launch secret token
>   (`X-Onboard-Token` header) on every mutating request, rejects requests
>   whose Host header isn't this server's own
>   `127.0.0.1:<port>`/`localhost:<port>` (DNS-rebinding), and rejects
>   mutating requests carrying a cross-origin Origin header. See
>   `onboarding/http-server.cjs`'s `createOnboardingServer()`.

## supervisor.mjs

### Auto-answer no-CR fact — oracle verdict, 2026-07-05

The bare "1" (no trailing `\r`) answer to the API-key confirm prompt was
settled empirically (`run.sh:331-337`, oracle 2026-07-05, deterministic
re-runs): "1" is a hotkey that fires the confirm handler; a trailing `\r`
INDEPENDENTLY selects the default focus (No), so "1\r" writes the key into
approved AND rejected at once (corrupt state that re-triggers the freeze).
The oracle's deterministic re-runs came back 3/3 (bare "1") vs 2/2 ("1\r")
against the two outcomes, pinning the no-CR requirement.
`test-supervisor.mjs` pins the no-CR fact going forward.

### node shim corpus stats — ~1400 errors across 21 sessions (07-13..07-15 teardown corpus)

Observed live on Mino's install: ~1400 `/bin/sh: node: command not found`
errors across 21 sessions (07-13..07-15 teardown corpus), which silenced
stop-reply-guard, the rumination gate, and every other protection while the
incidents they existed for were happening. The win-port Phase 3 bash->mjs
port made this strictly worse: the bash hooks it replaced ran everywhere.
Third-party plugin `node "${CLAUDE_PLUGIN_ROOT}/..."` hooks failed 121x each
in the same corpus.

### Stall/thrash watchdog — incident timeline (312-min, 429-min, 26x thrash)

Two live incidents this watchdog exists for, both from the 07-13..07-15
teardown corpus on Mino's box: a 312-minute and a 429-minute dead window
where the CLI sat stalled with a user message waiting 7 hours. Terminal
state of an autocompact thrash loop: each compaction re-attached ~12
session-read files, the context refilled to the limit, the CLI emitted its
synthetic "Autocompact is thrashing" error (26x in one session) and then
appended NOTHING more. `stallTimeoutSec`'s default of 15 minutes (900s) is
sized against this incident pair. The transcript-dir munge receipt (cwd
`/Users/cto/Documents/Scheherazade` -> project dir
`-Users-cto-Documents-Scheherazade`) is drawn from the same 24-session
teardown corpus.

### eraStart residual-risk acceptance — Melchior review, 2026-07-15 (review gate G1)

Review gate G1 (Melchior, 2026-07-15): the project dir is SHARED by every
claude session with the same cwd — Melchior's box held 555 jsonl files in
one project dir, and the teardown corpus itself is 24 sequential
generations in one dir. "Newest mtime" alone therefore binds the watchdog
to whichever session wrote last, not to OUR child. Filtering on
`birthtime >= eraStart` restricts the watch to files CREATED in this
child's lifetime, accepting a residual risk: a foreign session freshly
STARTED in the same cwd after our spawn passes the filter — identity beyond
creation-era needs a session-id handshake the CLI does not expose (and
`lsof` is out: 춘식's raw 07-15 note — "열어놓은 jsonl이 lsof에 안 잡힘" — the
corpus shows the CLI append-closes its transcript). This residual's blast
radius is bounded by the bounce budget (`createBounceBudget`): even a
worst-case foreign session parked stalled in our cwd costs at most 3 kills
per 6h before the watchdog degrades to advisory logging. Recorded as
"G1-residual acceptance ground #3" in the 2026-07-15 Melchior review.

Separately, the sep-only munge version was superseded after a Melchior
counter-receipt (07-15 19:40) confirmed on-box raw that EVERY
non-alphanumeric must become `-`, not just `path.sep`:
`~/Documents/MAGI_Memory` -> `-Users-narr-Documents-MAGI-Memory`, and
`session_notes` -> `session-notes` inside deeper project dirs.

The `createBounceBudget` flap-guard comment previously cross-referenced
"the same flap-guard lesson as the Sirin supervisor lane, per Melchior" —
dropped as an undefined cross-project reference with no resolvable context
in this repo.

## onboarding/http-server.cjs

### provider-env.cjs shared-guard consumers — addition-by-addition chronology

This import's header used to narrate each addition as its own dated entry:

- 4-provider-mode wiring (2026-07-04): `PROVIDERS_REQUIRING_STORED_CREDENTIAL`
  established as the single source of truth for "which PROVIDERS values
  need a stored credential before onboarding-complete," shared with
  main.cjs's spawn-time env building.
- `OLLAMA_BASE_URL` added (server-side validate fix, 2026-07-04): reused so
  the local-liveness ping checks the EXACT SAME URL `buildProviderEnv()`
  actually spawns the agent against, rather than a second hardcoded copy.
- `resolveChatgptProxyPort` added (Codex finding #5 fix, 2026-07-04): the
  same digits-only + 1-65535 TCP-range guard `buildProviderEnv()` applies
  at spawn-time (including its `CHATGPT_PROXY_DEFAULT_PORT` fallback),
  shared so this file's liveness ping can never drift out of sync with it
  again — closing a concrete SSRF gap.
- `resolveCustomBaseUrl` added (custom-provider addition, 2026-07-25): same
  shared-guard reasoning as `resolveChatgptProxyPort`, for the 'custom'
  provider's own base-URL field.

### DATA_HOME — PO correction overriding an earlier draft (2026-07-03); AGENT_DATA_HOME override addition (2026-07-13, v0.0.6)

PO correction (2026-07-03), overriding this file's earlier draft: DATA_HOME
must NOT be keyed on AGENT_NAME, and definitely not on DISPLAY_NAME, per the
rename-orphans-memory.db risk documented at the constant's definition.

Separately, the `AGENT_DATA_HOME` env override itself was added 2026-07-13
(v0.0.6): `channel.mjs` (its own DATA_HOME block) and run.sh (`MEM=`) had
always honored this env var; `http-server.cjs` was the one component that
did not, so its DATA_HOME could not be redirected. That gap was harmless
only because no test had ever POSTed to a config-WRITING route — the first
one to do so (the autonomy consent toggle) would have written into the real
user's own `~/Documents/Scheherazade/.agent-config` from a test run.
Production was unaffected either way: main.cjs passes `AGENT_DATA_HOME`
into the env of the children it spawns, never into its own `process.env`,
and http-server runs inside main.

### ensureSettingsLocalAdditions cluster — per-hook dated feature-log framing

Each additive hook installed by this function used to carry its own dated
origin story in the comment above it:

- **stop-reply-guard.mjs**: added after the agent composed replies without
  calling the reply tool and looked dead from Discord — reported as the
  "돌연사" (sudden-death) incident, 2026-07-13 19:10.
- **post-bash-permission-translator.mjs** (v0.0.12): the permission-wall
  translator on Bash results was 춘식3's P1 adoption, 2026-07-15 — a
  silence-during-diagnosis killer; see the hook's own header.
- **context-gauge.mjs** (v0.0.22): the context-gauge tap on Stop +
  SessionStart followed a live test by Mino, 2026-07-16 — a 372K-lane agent
  drowned in autocompact with zero occupancy visibility from the app.

### MUTE_STRIKE_THRESHOLD — the 돌연사 incident's exact shape (2026-07-13 19:10 KST)

The threshold of 2 strikes (= 4 failed attempts to speak, since each strike
already contains one guard-forced retry) was picked to match the original
"돌연사" incident's shape exactly: two consecutive silent turns, observed
19:10 KST on 2026-07-13. Both this constant and the `ensureSettingsLocalAdditions`
stop-reply-guard entry above reference the same incident; this is the
single place it is told in full.

### Discord bot token SEAM — stale "not wired yet" comment (superseded 2026-07-03 -> now)

This comment used to read: "SEAM (documented, not wired to a real child
process yet — see main.cjs's P1 wiring notes, item 1: nothing in this repo
spawns the `claude` CLI/channel.mjs child yet, that's still open work).
Whatever eventually does spawn it must call `readDiscordToken()` at the
moment of spawn..." That was accurate when written, but main.cjs's P1 item
1 (real `claude` CLI agent child) was completed in the agent-lifecycle fix
(2026-07-03, see main.cjs's own history above) — main.cjs's
`spawnRealAgentChild()` has called `readDiscordToken()` at spawn time ever
since. The comment was stale until this issue's cleanup pass corrected it
to state the current fact directly rather than point at a "still open"
item that has been closed for some time.

### chatgpt proxy live receipt — duplicate of main.cjs's model-passthrough catch (2026-07-14)

This endpoint's comment used to re-tell the same 07-14 live catch documented
under main.cjs's "Model passthrough" entry above (dropdown gpt-5.6-sol pick
vs engine actually running gpt-5.5, visible only by log-digging) as its own
motivating incident. It is the same incident; main.cjs's `ensureCodexProxy`
is the canonical telling.

### mute-status probe rejection — "7 of 7" live-condition finding

The comment explaining why mute-status is a post-swap convicter rather than
a pre-swap probe used to cite a specific empirical tally: a probe passed
the known-mute model in 7 of 7 live conditions tried, so it could only ever
have manufactured false acquittals. The conclusion (a pre-swap probe cannot
be trusted here) is what remains in source; the 7/7 count is the receipt
for why.

### cap table provenance — upgrade checklist

The model -> context-cap table (`contextCapForModel`) pins two provenance
tiers as of writing: the `claude-cli-table` tier was extracted from the
claude CLI 2.1.211 binary's own model table
(`"<id>",context:{window:...}` entries); the `codex-as-api-table` tier was
extracted from the proxy's model table (`openai/codex models.json@6ad0e943`,
codex-as-api 0.6.3). Both are point-in-time pins, not live-queried values.
Checklist for re-verifying on a codex-as-api (or bundled claude CLI)
upgrade:

1. Diff the new package's `models.json` (codex-as-api) or the new bundled
   CLI binary's model table (claude-cli) against the ids/windows currently
   hardcoded in `contextCapForModel`.
2. For any changed/added/removed id, update the regex/set and the `cap`
   value together — a stale id silently reports the OLD window on a model
   that now has a different one.
3. Re-run `scripts/test-context-status.mjs` (or the closest current test
   covering this function) against the new pins before shipping.
4. Note the new pin commit/version (mirroring `models.json@6ad0e943` /
   `codex-as-api 0.6.3` above) so the next upgrade has a diffable baseline.
