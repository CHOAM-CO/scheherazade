# v0.0.21 — hook lane revived: node shim now reaches the bash lane

> Trigger: Mino's 2026-07-16 18:01 log paste — the /logs viewer's first
> real catch, on its own release day. Symptom: "애가 답을 못하네" (agent
> hears Discord pings, answers in its own terminal, nothing arrives in
> Discord).

## Root cause (from the pasted log, not guessed)
- Every Claude Code hook died with `/bin/sh: node: command not found` —
  SessionStart, PostToolUse, Stop, SessionEnd, all of them, both boots.
- v0.0.15 built `ensureNodeShim` (MEM/bin/node → Electron-as-node) but
  wired it ONLY into supervisor.mjs's spawn path — the node lane.
  Production spawns the BASH lane (`run.sh`, visible in the log's own
  launcher line), so packaged installs never got the shim.
- Consequence chain: **stop-reply-guard was among the dead hooks** — the
  guard that bounces "promised a reply, ended the turn without sending"
  back into an actual send. The log shows exactly that class twice:
  17:58:11 the agent wrote a full Korean status answer into the terminal
  and stopped; 17:58:57 it said "지금 바로 디코로 답 보낼게", read two
  files, got hit by conversation compaction mid-turn, and the post-compact
  continuation never sent. With the guard alive, both turns get bounced.

## Fix
- The shim PATH patch is hoisted to the SHARED env layer in main.cjs
  (`supervisorEnv.PATH`), so BOTH lanes inherit it: bash lane via run.sh →
  expect → claude → hook `/bin/sh`, node lane idempotently (its own call
  now sees the dir already appended).
- Single-sourced: main.cjs dynamically imports `ensureNodeShim` from
  supervisor.mjs (no copy). Failure = loud log + unpatched PATH (pre-fix
  behavior), never a blocked boot.

## Test receipts
- scripts/test-hook-lane-path.mjs — 7/7, including a REAL end-to-end run:
  negative control proves the test PATH has no node, then
  `/bin/sh -c "node hook.mjs"` (the exact hook invocation shape) executes
  through the shim. Plus wiring tripwires so the patch can't silently
  regress back into one lane.
- Regressions: test-supervisor 125/125, test-packaging 36/36 pre+post.

## Seen in the same log, NOT fixed here (named, not hidden)
- `⚠ 1 MCP server needs authentication · run /mcp` at both boots. If the
  reply tool itself was hidden behind that, hooks alone won't fully explain
  the silence — after installing 0.0.21, if the agent still can't send,
  run `/mcp` in the agent terminal or paste the next log; the two failure
  classes are now separable.
- Conversation compaction landing exactly between "보낼게" and the send —
  CLI-side timing, not app-controllable; stop-reply-guard revival is the
  mitigation for its consequence.
- TCC permission regression after the version swap (screencapture rc=1,
  Safari/Mail denied) — known stale-grant class, unchanged; 0.1.0 attach
  territory.
