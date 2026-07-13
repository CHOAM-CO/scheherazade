// tick.cjs -- one poll of the autonomy watcher, as a pure function.
//
// This exists because the test was cheating and I did not notice for an hour.
//
// scripts/test-autonomy-night.mjs re-implemented channel.mjs's watcher body: the
// cheap-exit gate, the cap parse, the inject selection, the persist ORDER. It
// went green against its own copy. If channel.mjs's glue drifted -- if someone
// flipped the persist order, or dropped the `settled` gate -- the test would have
// stayed green while the product broke, and I would have believed it.
//
// I had already written the rule down tonight, in a checkpoint, about a different
// file: A COPY OF A RULE IS NOT THE RULE. Then I violated it in the test I wrote
// to catch myself violating things. So: the decision, the wording, the gate, and
// the write order all live here, and BOTH the watcher and the test call this.
// The only thing left in channel.mjs is the IO.
'use strict'

const path = require('node:path')

const budgetMod = require(path.join(__dirname, 'budget.cjs'))
const cycleMod = require(path.join(__dirname, 'cycle.cjs'))

// Which consent key, and what it may be worth. Never inherit a narrower consent
// (PROACTIVE = "you may speak first") to authorize a costlier act (spending a
// subscription overnight).
function isConsented(config) {
  return String((config && config.AUTONOMY) || '').toLowerCase() === 'yes'
}

// The cheap exit, and it is narrower than it looks. The obvious version --
// "no consent -> return" -- means that withdrawing consent mid-night makes the
// watcher fall SILENT, and a silent watcher does not stop the agent: the agent
// was told once to work and is running its own loop. Withdrawal has to be able
// to speak. So we skip only when nothing is OUTSTANDING.
function isSettled(state) {
  return !state || !state.cycleDay ||
    (state.stoppedDay === state.cycleDay && state.briefDay === state.cycleDay)
}

function capFor(config) {
  const raw = (config && (config.AUTONOMY_TOKEN_CAP || config.AUTONOMY_DAILY_TOKEN_CAP))
  return Number(raw || budgetMod.DEFAULT_DAILY_CAP)
}

// planTick({ now, config, state, readBudget }) ->
//   { skip: true, reason }                                   nothing to do
//   { skip: false, decision, content, persistFirst, nextState }
//
// `readBudget` is injected so tests can starve/blind it; channel.mjs passes the
// real meter. `content` is null for a 'none' decision that still wants its
// bookkeeping written (why the night was quiet -- a silent no-op is how a
// feature becomes a ghost).
function planTick({ now, config, state, readBudget }) {
  if (!isConsented(config) && isSettled(state)) {
    return { skip: true, reason: 'no consent and nothing outstanding' }
  }

  const decision = cycleMod.decideAutonomy({ now, config, state, readBudget })

  if (decision.action === 'none') {
    // `skip` means "do no IO", never "reveal nothing". The decision (and the
    // budget reading inside it) rides along, because a caller that wants to log
    // or assert on why the night was quiet must be able to SEE why -- and the
    // first version of this dropped it on the floor, which turned a live budget
    // into an undefined the moment the cycle was merely idling.
    if (!decision.nextState) return { skip: true, reason: decision.reason, decision }
    return { skip: false, decision, content: null, persistFirst: true, nextState: decision.nextState }
  }

  // The wording is a CONTRACT with hooks/stop-reply-guard.mjs: start/stop carry
  // a SKIP_PATTERN so nobody is woken at 03:00, and the brief deliberately omits
  // one so the guard forces it to land. cycle.cjs owns the text next to the
  // decision that produced it.
  const content = cycleMod.injectFor(decision)

  // WHEN we persist depends on WHICH LIE IS WORSE, and the two actions have
  // opposite answers. (External red team, 2026-07-13.)
  //
  // START -- persist BEFORE sending. If we sent first and died before writing,
  //   the agent would be awake and spending while the state file said no cycle
  //   exists: the owner could then withdraw consent and this watcher, seeing
  //   nothing outstanding, would say nothing -- and silence stops no one. The
  //   next poll would also start a SECOND cycle. The mirror cost of pre-writing
  //   is a recorded night that never began: one skipped night, one brief showing
  //   ~0 tokens. One error loses work. The other loses control of someone's money
  //   while they sleep. Not a close call.
  //
  // STOP / BRIEF -- persist AFTER sending. Marking first turns one transient
  //   failure into "we recorded that we told them, and we never did". On failure
  //   the debt stands and the next poll retries it.
  const persistFirst = decision.action === 'start'

  return { skip: false, decision, content, persistFirst, nextState: decision.nextState }
}

// The real meter, bound to a data home. channel.mjs and the tests both use this
// so the cap is measured the same way in both.
function realBudgetReader(dataHome, cap, nowFn = () => new Date()) {
  return (sinceMs) => budgetMod.budgetState(dataHome, cap, nowFn(), sinceMs)
}

module.exports = { planTick, isConsented, isSettled, capFor, realBudgetReader }
