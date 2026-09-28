// turn-state.cjs -- ONE derived state for the chat pane's live turn
// (docs/design-0025-turn-state.md, the owner 2026-09-28: "얘가 툴콜중인지
// 세션이 끊긴건지 ... 인디케이팅좀 예쁘게 해줄 수 있어?").
//
// Dual-environment on purpose, the same contract model-catalog.cjs and
// appearance-model.cjs have held since 0.2.6: the browser loads it as a plain
// classic <script> (it publishes window.SCHZ_TURN_STATE, which chat.js reads)
// and node require()s the SAME BYTES for the derivation tests. The extension
// is .cjs because package.json declares "type":"module", so a .js here would
// be ESM to node and unrequirable; http-server.cjs's MIME table already serves
// .cjs as text/javascript for exactly this pattern.
//
// WHY A DERIVATION AND NOT A FLAG. The six states were scattered booleans in
// chat.js -- `waiting`, the dots' own 3-minute cap check, the run fold's
// staleness guard, `channelUp`, the Stop button's `hidden` rule -- and each one
// re-derived "is a turn running" from a different slice of the same facts, so
// they could disagree. When the lane died mid-turn they all did at once: the
// poll failed, so the dots, Stop and Read retired, while the run fold, the
// Think fold and the draft bubble stayed up over a turn that no longer
// existed, indefinitely. One function, one plain input object, one answer,
// read by every render site -- and testable with no DOM at all.
//
// WHAT IT DOES NOT DO: never fetches, never touches the DOM, never guesses a
// fact it was not handed. Lane liveness it cannot see arrives as `lane` (GET
// /api/agent/status); "this turn is settled" arrives as `abortAt`, the `at` of
// the newest turn-abort transcript item -- the same item that clears the
// server's awaitingReplySince.
//
// The thresholds are the design's own numbers: 3 minutes is the typing cap
// that already existed (TYPING_SHOW_MAX_MS in chat.js), ~20s is the reconnecting
// grace the design's state table names.

;(function (root) {
  'use strict'

  const TYPING_SHOW_MAX_MS = 3 * 60 * 1000 // stalled boundary: past this, the dots may go
  const LINKING_GRACE_MS = 20 * 1000 // poll failing under this reads as "reconnecting"
  // A Stop press holds its own state until the turn-abort item lands. The item
  // needs a whole lane respawn to come back, so the hold is generous -- but it
  // is BOUNDED, because an abort that never lands (an older server, a death
  // the lane could not record) must not pin the pane on "Stopping…" forever.
  const STOP_GRACE_MS = 20 * 1000
  // An asked-for restart reads as reconnecting for this long. Past it, the
  // derivation falls back to the honest reading of the same facts (nothing
  // running = gone) instead of pretending a respawn is still on its way.
  const RESTART_GRACE_MS = 90 * 1000

  const STATES = ['idle', 'working', 'stalled', 'linking', 'gone', 'stopping']
  const REASONS = ['stop', 'death', 'stall']
  const TAILS = ['tool_result', 'user']

  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }

  // ── deriveTurnState(input) -> the pane's one answer ──────────────────────
  //
  // input (every field optional; a missing field is "unknown", never a guess):
  //   now           ms epoch. Injected so a test can freeze the clock.
  //   awaitingSince ms epoch of the server's state.awaitingReplySince, or null
  //                 when nothing is owed (that null IS the idle signal).
  //   pollUp        did the last GET /api/chat/out succeed (chat.js's channelUp).
  //   abortAt       `at` of the newest turn-abort item this turn, or null.
  //   abortReason   its `reason` ('stop'|'death'|'stall'), or null.
  //   stoppingAt    ms epoch the Stop press landed, or null.
  //   restartingAt  ms epoch the restart action was fired, or null.
  //   died          the pane already watched this turn die (poll failing past
  //                 the grace, or the lane reported down). Sticky on purpose:
  //                 a poll that comes back does NOT un-die a turn, so the pane
  //                 cannot drift back to "working" over a corpse.
  //   lane          {state} from GET /api/agent/status, or null. 'stopped' and
  //                 'failed' are the lane-down verdicts; 'connecting' is a
  //                 respawn in flight, which is not a death.
  //   tail          'tool_result'|'user'|null -- where the death landed, from the
  //                 pane's own transcript knowledge (work seen since the
  //                 unanswered message = it died waiting on a tool).
  //
  // output: { state, inFlight, elapsedMs, reason, tail, agentOff }
  function deriveTurnState(input) {
    const i = input || {}
    const now = num(i.now) === null ? Date.now() : i.now
    const awaitingSince = num(i.awaitingSince)
    const elapsedMs = awaitingSince === null ? null : Math.max(0, now - awaitingSince)
    const abortAt = num(i.abortAt)
    const abortReason = REASONS.includes(i.abortReason) ? i.abortReason : null
    const stoppingAt = num(i.stoppingAt)
    const restartingAt = num(i.restartingAt)
    const laneState = i.lane && typeof i.lane.state === 'string' ? i.lane.state : null
    const tail = TAILS.includes(i.tail) ? i.tail : null
    const agentOff = laneState === 'stopped'
    const laneDown = laneState === 'stopped' || laneState === 'failed'

    const shape = (state, extra) => ({
      state,
      inFlight: state !== 'idle',
      elapsedMs,
      reason: null,
      tail: null,
      agentOff,
      ...extra,
    })

    // The abort item IS the settle (the server's transcriptState breaks on it
    // and awaitingReplySince goes null in the same payload). Read here too, so
    // the tick that renders the item already reads as settled instead of
    // waiting one poll for the server's half of the same fact.
    if (abortAt !== null && (awaitingSince === null || abortAt >= awaitingSince)) {
      return shape('idle', { reason: abortReason })
    }
    if (awaitingSince === null) return shape('idle')

    // Between the Stop press and the abort item landing. Held, and only held:
    // a turn that is being killed is not "working" and not yet "gone", and
    // swapping the button back to Stop mid-kill is the re-arm the owner hit.
    if (stoppingAt !== null && now - stoppingAt < STOP_GRACE_MS) {
      return shape('stopping', { reason: 'stop' })
    }
    // The restart action was fired: the lane is coming back, and the turn-abort
    // item rides the same return. Same quiet line as a poll blip (it is the
    // same wait for the same thing), bounded by RESTART_GRACE_MS.
    if (restartingAt !== null && now - restartingAt < RESTART_GRACE_MS) {
      return shape('linking')
    }
    // The lane's own verdict beats the poll's: a stopped/failed lane is a dead
    // turn even on a tick where the channel still answers.
    if (laneDown) return shape('gone', { reason: 'death', tail })
    if (i.died === true) return shape('gone', { reason: 'death', tail })
    if (i.pollUp !== true) {
      if (elapsedMs >= LINKING_GRACE_MS) return shape('gone', { reason: 'death', tail })
      return shape('linking')
    }
    if (elapsedMs >= TYPING_SHOW_MAX_MS) return shape('stalled')
    return shape('working')
  }

  const api = {
    STATES,
    REASONS,
    TAILS,
    TYPING_SHOW_MAX_MS,
    LINKING_GRACE_MS,
    STOP_GRACE_MS,
    RESTART_GRACE_MS,
    deriveTurnState,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  root.SCHZ_TURN_STATE = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
