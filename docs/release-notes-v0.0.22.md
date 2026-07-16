# v0.0.22 — context diet: occupancy gauge + lazy restore

> Trigger: Mino's 2026-07-16 18:29 log paste (gpt-5.6-luna, "답장 하나
> 받을때 4분씩 걸림"). Root cause of the latency was NOT model speed: the
> session was pinned at its context ceiling, eating a 2-3min autocompact
> pass every turn ("Context limit reached", continuous "Compacting
> conversation…" 18:25→18:27). Two contributing structures, both fixed here.

## 1. Context gauge (18:51 "오 좋은 피쳐" approval)

The agent terminal is a headless PTY — `/context` is a CLI-UI command
nothing can type, so occupancy was invisible from the app ("에이전트
터미널을 내가 못보잖니"). Now:

- `hooks/context-gauge.mjs` (Stop + SessionStart): tail-parses the
  transcript's most recent `usage` block, writes
  `DATA_HOME/context-status.json` atomically. Advisory instrument, exit 0
  on every path, no context feedback into the agent.
- `GET /api/context-status`: attaches the model→cap table
  (`contextCapForModel`) — caps live in the APP, not frozen into snapshots.
  Provenance labeled: `claude-cli-table` (extracted from the claude CLI
  2.1.211 binary's own model table: fable-5 / opus-4-8 / opus-4-6 /
  sonnet-5 = 1M) vs `codex-as-api-table` (proxy 0.6.3: gpt-5.6 sol/terra/
  luna = 372K). Unknown model → cap null, occupancy only, never a guessed
  number. Known honest gap: the CLI doesn't know gpt ids, so its BELIEVED
  window (= the autocompact trigger) may be smaller than the proxy cap;
  occupancy is exact either way.
- Shell status bar (every page, /logs included): `컨텍스트 N% (used/cap)`,
  red at 80%+ (autocompact territory). 10s poll, running-gated — a stopped
  agent shows no gauge ("셸은 현실").
- Existing installs get the hook via the additive settings migration
  (same mechanism as stop-reply-guard's, both event groups checked
  independently).

## 2. Lazy restore (18:52 "lazy loading좀 넣어줘")

The boot restore procedure read EVERYTHING whole — today's note (300 lines
by evening) + checkpoint (340) + 3 days of journal + persona + 5 dreams +
reflux backlog. Compaction re-attaches fully-read files, so on a 372K lane
the boot pile alone kept refilling the window (v0.0.15's oversize guard
named the class; the procedure itself still taught the behavior).

- CLAUDE.md §1 rewritten: **excerpt first, full Read only on a pointer.**
  Notes = head (Felt/Pending/Handoff) + tail via offset/limit; journal =
  yesterday only (contract floor per test-journal.mjs — yesterday covered —
  still satisfied; the pinned default moved in the same diff, as that
  test's comment demands); dreams 5→2; backlog notices = queue pointers,
  newest item only at boot.
- §2: checkpoint is a SNAPSHOT — keep under ~120 lines, compress overgrown
  ones at next overwrite (an overgrown checkpoint silently breaks §1, it's
  the one file restore reads whole).
- session-start.mjs advisory lines aligned to the same numbers.
- CLAUDE.md is a harness file (re-rendered every boot), so existing
  installs pick this up on app update without touching their history files.

## Test receipts

- scripts/test-context-gauge.mjs — 28/28: last-usage-wins extraction,
  occupancy summation, atomic write, 600KB truncated-tail robustness,
  no-clobber on usage-free transcripts, cap table (13 model cases), wiring
  tripwires (template Stop+SessionStart, migration both-groups, route).
- Regressions: test-hooks-port 61/61, test-journal 35/35 (window pin
  updated in-diff), test-supervisor 125/125, test-packaging 36/36,
  test-channel-connect 19/19, test-log-buffer 33/33, test-hook-lane-path
  7/7.

## Known limits (named, not hidden)

- The gauge updates on agent turns (Stop hook) — during one very long turn
  the number is that turn's START occupancy. Good enough for "am I near the
  ceiling", not a per-tool-call live meter.
- pct for gpt-lane models is vs the proxy's cap; if the CLI's believed
  window is smaller, autocompact fires earlier than the gauge's 100%. The
  first live /context-equivalent receipt (transcript usage paste) can
  calibrate this; until then the 80% red threshold is deliberately early.
- Lazy restore changes the INSTRUCTION layer. The agent can still choose a
  full Read; the oversize hook warning (24KB+) remains the mechanical
  backstop.
