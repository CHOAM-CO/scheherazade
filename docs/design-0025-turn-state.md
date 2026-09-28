# design-0025 — turn state in the chat pane (running / stalled / gone)

Drafted 2026-09-28 from the owner's report, after a file-level recon of the
current state machine. Status: **contract frozen, two lanes building against
it.** Nothing here is released yet; it rides the same uncommitted tree as the
avatar, the Engine-page unification and the memory mark.

His words:

> 세라가 방금 턴 너무 길게돌려서 죽어버렸는데 / 얘가 툴콜중인지 세션이
> 끊긴건지 / + Stop으로 아예 멈추기가 잘 안됨 / 이거 인디케이팅좀 예쁘게
> 해줄 수 있어?

## What the recon found (file:line, not impressions)

Three separate defects, only one of which is cosmetic.

1. **The pane has no liveness input.** Every in-flight signal in `chat.js`
   (`typingEl`, `runEl`, `thinkEl`, `draftEl`, `readEl`, `awaitingSince`) is
   fed by the `/api/chat/out` poll and by nothing else. Lane liveness lives in
   `GET /api/agent/status` (`http-server.cjs:336-384`, freshness window
   `150_000` at `:253`), which the chat pane reads only during a model swap
   (`chat.js:1168`) and never for turn state.
2. **A mid-turn death clears nothing.** When the lane dies, `channel-local` is
   its MCP child and goes down with it, so the poll fails and `channelUp`
   flips (`chat.js:778`) — which hides the dots, Stop and Read, and leaves
   `runEl`, `thinkEl` and `draftEl` untouched. After the supervisor respawns
   (`supervisor.mjs:922-933`) the transcript still ends with the unanswered
   user message, so `awaitingSince` recomputes non-null and the page shows an
   open run fold, `Weaving the tale…`, Stop and Read with no work behind them,
   indefinitely. `chat.js:656` cannot rescue this: it needs `!waiting`.
3. **Stop looks like it did not stop.** `POST /interrupt`
   (`channel-local.mjs:804-808`) kills correctly — FIFO cleared first
   (`headless-lane.mjs:820-824`), SIGTERM then SIGKILL (`:859-860`), respawn
   with `--resume` — but it writes no transcript record. Only the lane's own
   turn close calls `enqueueTurnEnd` (`channel-local.mjs:302-304`, `:746-747`),
   and that item is deliberately skipped by `transcriptState()` (`:322`), so
   the derivation re-arms Stop and Read the moment the poll returns.

The supervisor already knows which death it was: its verdict at
`supervisor.mjs:490` is literally `'mid-turn death (tool_result tail)'`. That
string dies in a log today.

## The contract (frozen; both lanes build against this)

**One new transcript item kind, persisted.**

```
{ kind: 'turn-abort', role: 'agent', text: '', ts, seq,
  reason: 'stop' | 'death' | 'stall',
  elapsedMs: number | null,
  at: number }
```

- `role: 'agent'` with a kind that is **not** in the skip list is what clears
  the awaiting state: `transcriptState()` breaks on the first non-user,
  non-noise item (`channel-local.mjs:323`), so `awaitingReplySince` goes null
  and the page settles. Do not add `turn-abort` to the skip list at `:322`.
- It **is persisted** (unlike activity/think/turn-end), because a reload must
  not resurrect the stuck state. That came for free: the durable filter at
  `channel-local.mjs:146` is a **denylist** (it drops activity, think and
  turn-end), not a message allowlist, so a new kind is durable by default.
  Naming `turn-abort` on that line would have excluded it. This note was
  written from an imprecise line in the first draft of this document; the
  behaviour is pinned by a reload test instead.
- `text` stays empty. The sentence is composed client-side in `copy.js`, which
  owns every chat string; the server carries facts, not voice.
- `elapsedMs` is wall time from `awaitingSince` to the abort, or null when not
  known. The UI says "12분" from it.

**Who writes it, and once.**

- `/interrupt` success → `reason:'stop'`.
- At transcript restore, if `DATA_HOME/.last-turn-abort.json` exists, is newer
  than the newest retained queue item, and `transcriptState()` still reports an
  unanswered user message → `reason` from the record, then the record is
  consumed (marked, never deleted blindly) so a second boot cannot duplicate
  the line.
- Producers of the record: the supervisor's kill verdict
  (`supervisor.mjs:485-548`), and the lane's own stall watchdog
  (`headless-lane.mjs:947-960`, `TURN_STALL_MS` 10 min) as `reason:'stall'`.
  Shape: `{at, reason, tail: 'tool_result'|'user'|null, elapsedMs}`.

## What the pane shows

Derived every tick from what already exists plus one extra fetch:

| state | condition | line |
|---|---|---|
| idle | `awaitingReplySince` null | nothing |
| working | waiting and the poll is up | dots + current step label + elapsed |
| stalled | same, past the 3 min cap (`TYPING_SHOW_MAX_MS`) | the dots may go; the **elapsed chip stays** — a silent pane after three minutes is the bug, not the fix |
| linking | waiting, poll failing under ~20 s | one quiet line, "다시 붙는 중" |
| gone | waiting, poll failing past that, or `/api/agent/status` reports the lane down | honest line with reason and elapsed, folds closed, Stop replaced by the restart action |
| stopping | between the press and the abort item | the existing `stopping` string, held until the item lands |

The step label is the last `activity` item's label, which the run fold already
receives. The restart action must use the app's existing lifecycle route; do
not invent a spawn path.

## What this must not do

- No new polling rail: reuse the `/out` poll and the existing
  `/api/agent/status`.
- No new persisted field on the message shape beyond the extras above.
- Nothing here turns autonomy on, schedules anything, or writes memory.
- No emoji in the UI strings. The register is the memory mark's: quiet,
  monochrome, one small glyph at most.

## Tests worth having

- `transcriptState()` returns null after a `turn-abort`, and Stop/Read stop
  being re-derived from the stale user message.
- Interrupt pushes exactly one item; a second boot with an already-consumed
  record pushes none.
- The record is not consulted when the transcript has no unanswered user
  message (no phantom line on a clean start).
- Client derivation: each of the six states from a fixed pair of inputs (poll
  up/down, elapsed, presence of an abort item).
