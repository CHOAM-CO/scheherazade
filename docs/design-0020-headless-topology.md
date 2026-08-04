# design-0020 — headless topology: `claude -p` stream-json replaces the PTY

Status: DRAFT on branch `headless-topology` (Mino GO 2026-08-04 12:45 "일단
세헤라자드 -p방식으로 바꾸자 그냥 / expect 우회방식 낡았어 이제").
Gate before build: adversarial red-team pass (tech + UX), then QA request to
Mino — no build without it (Mino 12:52).

## Why

The spawn topology today is an interactive TUI driven blind: run.sh renders
an expect script that answers claude's own dialogs (trust prompt, theme
picker, dev-channels warning), the agent lives in a PTY, and everything we
know about it comes from scraping ANSI output. Three shipped incident
classes trace straight to this:

1. **The invisible picker** (Mino live repro 2026-08-04): AskUserQuestion
   drew a numbered menu in the PTY and blocked on an Enter that never came.
   Not a turn end, so stop-reply-guard never fired. Silence until manual
   restart. (Interim mitigation: pre-ask-user-question-redirect.mjs, master
   `03c851f` — a hook that exists only because the terminal is invisible.)
2. **Freeze-class expect bugs**: the 2026-07-05 BYOK trust-dialog freeze —
   every new claude dialog is a new way for expect to hang, discovered only
   in production.
3. **The dev-channels dependency**: inbound messages ride
   `--dangerously-load-development-channels`, an experimental flag whose own
   banner warns against it, and which prints a confirmation picker that
   expect must answer (incident class 2 again).

## Probe receipts (2026-08-04, claude-code 2.1.221, this machine)

All five probes run against `claude -p --input-format stream-json
--output-format stream-json --verbose`:

| # | Question | Result |
|---|---|---|
| 1 | round trip works? | YES — structured events, `session_id` in init, MCP servers connect, runs on subscription auth |
| 2 | AskUserQuestion in -p? | **tool does not exist** — absent from init `tools`, model told "no such tool". The picker class dies at the root |
| 3 | hooks fire in -p? | YES — PreToolUse and Stop both fired (marker-file test) |
| 4 | multi-turn + resume? | YES — multiple user messages over one stdin keep context; `--resume <session_id>` in a NEW process recalls the old conversation |
| 5 | dev-channels notification injection in -p? | **NO** — fake MCP server sent `notifications/claude/channel` (server log confirms), no user message was injected, no turn started |

Probe 5 sets the surgery size: outbound tooling survives unchanged, inbound
needs a new lane.

## Target shape

```
main.cjs ──spawns──> claude -p --input-format stream-json
   │                   --output-format stream-json
   │                   --model … --append-system-prompt-file …
   │                   --strict-mcp-config --mcp-config …
   │                   --dangerously-skip-permissions
   │                   [--resume <session_id> on respawn]
   │        stdin:  user messages as stream-json events
   │        stdout: structured events (liveness, tool use, results)
   │
   ├──ingest endpoint (loopback HTTP, token file in DATA_HOME)──┐
   │                                                            │
   └──spawned by claude as MCP stdio child────── channel backend┘
        (tools: reply / react / routine / … — UNCHANGED)
```

- **Outbound (agent → user)**: untouched. The channel backend stays the MCP
  server; reply/react/send_file/routine tools, hooks on them, allowlist —
  all identical. Probe 3 says the hook pack keeps working.
- **Inbound (user → agent)**: the backend stops calling
  `mcp.notification('notifications/claude/channel')` and instead POSTs the
  same `{content, meta}` payload to a supervisor ingest endpoint (loopback +
  per-launch token file in DATA_HOME, the `.spawn-info-endpoint.json`
  pattern). The supervisor formats the exact same `<channel …>` tagged line
  the dev-channels lane used to render and writes it to claude's stdin as a
  stream-json user event. **The tag format is load-bearing**: stop-reply-guard
  and the reply tools parse it; keeping it byte-compatible keeps every guard
  inert to this migration.
- **Liveness**: stdout events replace PTY scraping. `system/init` = booted
  (capture `session_id`), `result` = turn ended, assistant/tool events =
  activity. The activity feed can later ride these instead of the PreToolUse
  hook, but that is NOT part of this migration (one topology change at a
  time).
- **Restart/resume**: supervisor stores the last `session_id` in DATA_HOME;
  respawn appends `--resume <id>`. Probe 4 proves continuity. Session rotation
  policy stays whatever run.sh's SESSION_TIMEOUT does today — but as plain
  process management, no expect, no PTY group games.
- **Gone**: expect entirely; the dev-channels flag and its warning picker;
  the trust-prompt / theme-picker answering machinery (probe 1 hit neither);
  ANSI parsing of any kind.
- **Unchanged**: attach topology (external tmux IS a terminal — stays
  interactive, documented as such); onboarding; memory; settings migrations;
  the hook pack.

## Open questions (to resolve during implementation)

1. ~~Interrupts: user message arriving mid-turn~~ RESOLVED — probe 6
   (2026-08-04, `tmp_scratch/headless-spike/probe6-queued.mjs`, receipt
   `/tmp/sch-probe6.log`): user events written mid-turn **merge into the
   live turn** — 3 messages queued during a `sleep 8` tool call produced
   ONE result (`num_turns=2`), one reply. Same semantics as the old
   dev-channels live-turn injection, so no UX regression; the lane's
   pending-payoff rule is "a result pays everything written before it",
   pinned in test-headless-lane §6. control_request interrupt: still
   later-if-ever.
2. run.sh's other duties (env resolution, MEM/DATA_HOME, backoff loop,
   heartbeat markers) — port as a thin sh (no expect) or fold into main.cjs.
   Leaning: keep run.sh as the env/backoff layer, replace only the expect
   spawn with a direct exec of claude -p; supervisor talks to it via
   stdin/stdout passthrough.
3. Providers: ollama/proxy lanes set env + base URL — verify -p respects the
   same provider-env.cjs plumbing (no reason it wouldn't; it's env-level).
4. Windows: no expect on Windows was already a porting pain; -p removes it.
   Verify the win spawn path separately before any build.
5. AskUserQuestion redirect hook: keep even after -p (harmless — the tool no
   longer exists to be called; the hook is then dead weight we can retire in
   a later diet) or remove in this branch. Leaning: keep until the topology
   has soaked.

### Resolved with receipts

- **Fresh-dir trust/theme gates (red-team tech #3): ABSENT in -p.** The
  2026-08-04 subscription-policy probe doubled as the receipt: brand-new
  `CLAUDE_CONFIG_DIR` (never trusted, never themed) + `ANTHROPIC_API_KEY`
  set + mock `ANTHROPIC_BASE_URL` (`tmp_scratch/headless-spike/
  mock-anthropic.mjs`, server-side request log) → `claude -p` on CLI
  2.1.221 completed end-to-end, exit 0, no dialog of any class. First-boot
  onboarding installs therefore do not need a pre-trust step for -p.
- **BYOK first-key approval (UX red-team F2): NO GATE in -p.** Same probe,
  same receipt file (`/tmp/sch-mock-anthropic.log`): the key was
  `sk-ant-dummy-key-for-probe`, never approved by any interactive session
  (fresh config dir ⇒ empty `customApiKeyResponses`), and the mock server
  logged `POST /v1/messages auth=sk-ant-dummy-key-for-probe` — the CLI sent
  the unapproved env key straight to the API. The "Do you want to use this
  API key?" consent is an interactive-TUI-lane behavior; `-p` skips it. The
  2026-07-05 expect freeze class is therefore dead at the root, not merely
  routed around.

### Red-team fixes (2026-08-04, tech + UX passes)

- **Poisoned resume id** (UX F1 / tech #2): 2 consecutive no-init exits
  under the same resume id → session file abandoned, fresh boot.
  (`.headless-resume-strikes.json`, lane `recordExitForResume`.)
- **Conversation rotation** (UX F3): `bornTs` in the session file tracks
  conversation birth across resumes; past 24h (env
  `SCHEHERAZADE_MAX_CONVO_HOURS`) the lane rotates fresh — checkpoint files
  are the bridge, same as the old 12h-recycle contract. **Ceiling default
  is a product decision — flag at QA.**
- **Mid-turn recycle strands a message** (UX F4): `.headless-pending.json`
  FIFO of stdin-written user events not yet paid by a `result`; leftovers
  redelivered ONCE at next boot with a no-double-reply note.
- **Stale endpoint file after SIGKILL** (UX F5 / tech stale-file): endpoint
  file carries the lane pid; notifier probes it (`kill(pid,0)`) and treats
  dead-pid as no-endpoint → MCP fallback. Live-pid + failed POST still
  throws (no black hole).
- **Lost inbound receipts** (tech #1 / UX F7): Discord clears 🤔 + reacts
  ⚠️ + replies a re-send ask on notify failure; Slack posts the same
  receipt (it acks before delivery, Slack never redelivers); the notifier
  comment no longer claims a universal retry path that only telegram has.
- **Ingest hygiene** (tech #4/#5): real 413 before destroy; Host-header
  check mirroring channel-local.
- Deferred, recorded: boot-announcer wording under resume (UX F8, minor —
  "재기동 #N" still reads as amnesiac restart; revisit after soak), drain-
  on-TERM (subsumed by F4 redelivery), orphaned-leaf pre-.mcp.json reap
  (tech #6, moot for product topology).

## Rollout

1. Implement behind the branch; all 55 suite files must stay green.
2. New tests: ingest endpoint auth (token, loopback-only), tag formatting
   byte-compat fixture, resume-on-respawn, backend inbound POST fallback
   behavior when supervisor is down (queue? drop with receipt? — decide,
   test it).
3. Adversarial red-team, two passes: tech (spawn/restart/resume/injection
   races, ingest auth, torn writes) and UX (what does the user see during
   restart, mid-turn messages, agent silence windows).
4. QA request to Mino with receipts. No build before his go.
