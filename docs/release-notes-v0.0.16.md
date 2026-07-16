# v0.0.16 — liveness bundle (boot ping / work-entry announce / note cadence)

Mino's harness feedback, 2026-07-16 11:48 + 11:58 + 12:25. All three share
one principle: detection and cadence are the HARNESS's job, deterministically;
only the voice on top is the model's. Topology-independent — none of this
touches the attach-refactor lane (that stays gated on the 춘식 attribution
probe, docs/probe-0016-attribution.md).

## (a) Boot ping

- Supervisor (BOTH lanes — run.sh `SPAWN_SEQ` and supervisor.mjs
  `writeBootEvent()`, lane parity) writes `$MEM/.boot-event.json`
  (tmp+rename) immediately before every leaf spawn.
- channel.mjs `announceBoot()` (ClientReady) consumes the marker
  (10-min staleness gate, consume-before-use): posts a deterministic
  `🔁 [system] 에이전트 세션 기동/재기동 #n` line directly to the home
  channel — the file's first and deliberate non-model-mediated send —
  then injects a [SYSTEM] turn asking for a greeting in the agent's own
  voice (no "답장하지 마", so stop-reply-guard enforces delivery).
- Quick-death crash loops never spam: leaves that die before Discord
  login never reach ClientReady; the failure marker + bounce budget
  already own that class.

## (c) Work-entry announce

- Boot greeting inject carries the standing session rule (deterministic,
  reaches existing installs every boot): before a work block, announce
  what + roughly how long, one line, first.
- `onboarding/templates/agent-system-prompt.md` gains a "Liveness"
  section (template is re-rendered at every boot, so this propagates to
  existing installs on update).

## (e) Session-note cadence

- New watcher in channel.mjs (autonomy-watcher shape: 5-min poll,
  in-flight guard, config read fresh every tick, advance-marker-only-on-
  delivered). Rule is pure in `cadence/note-tick.cjs`; tests in
  `scripts/test-note-cadence.mjs` (18 checks).
- Active session (Discord activity within 1h): note older than 30 min →
  [SYSTEM] refresh reminder (file-work only, 답장하지 마 rail).
- Idle: 3h cadence (Mino 12:25 "아이들링 상태면 한 세시간에 한번씩").
- Midnight rollover covered: missing today-file counts as stale and the
  reminder says to create it.
- Knobs in `.agent-config`: `NOTE_CADENCE=off`,
  `NOTE_CADENCE_ACTIVE_MIN` (default 30), `NOTE_CADENCE_IDLE_MIN`
  (default 180).

## Known wrinkles (recorded, not fixed here)

- hooks/session-start.mjs computes the note filename with hardcoded
  Asia/Seoul while channel.mjs's timestamps follow the system timezone
  (07-13 fix). The cadence watcher deliberately MATCHES the hook's
  Asia/Seoul convention so both always point at the same file; if the
  hook moves to system tz, move the watcher in the same commit
  (comment anchors exist on both sides).
- Boot greeting/삽입문 is Korean-fixed; {TONE}/locale templating for the
  injected system turns is future work if a non-Korean user ever exists.

## Verification

- scripts/test-note-cadence.mjs 18/18 (new).
- Neighbor suites after the wiring: test-supervisor 125/0,
  test-liveness-marker 24/0, test-outbound-channel 14/0,
  test-autonomy-cycle 63/0.
- `node --check` channel.mjs / supervisor.mjs / cadence/note-tick.cjs,
  `bash -n` run.sh.
