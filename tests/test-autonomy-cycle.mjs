// test-autonomy-cycle.mjs -- attacks on the decision that spends a sleeping
// person's tokens.
// Run: node tests/test-autonomy-cycle.mjs
//
// Written as attacks, not as coverage. The questions being asked are:
//   - can it EVER run without explicit consent?
//   - can it EVER run when the meter is blind?
//   - can it run twice in one night, or twice across a midnight-wrapping night?
//   - can the user be left without a brief for a night that DID spend money?
//   - does a restart mid-night lose the debt?

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const { decideAutonomy, windowState, parseHM, emptyState } = require(path.join(HERE, '..', 'autonomy', 'cycle.cjs'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const at = (h, m = 0, day = 13) => new Date(2026, 6, day, h, m, 0)

const RICH = () => ({ ok: true, mayRun: true, cap: 5000000, used: 100000, remaining: 4900000, usedPct: 2 })
const BROKE = () => ({ ok: true, mayRun: false, cap: 5000000, used: 5000000, remaining: 0, usedPct: 100 })
const BLIND = () => ({ ok: false, mayRun: false, cap: 5000000, reason: 'no transcript directory found' })

const CONSENTED = { AUTONOMY: 'yes', AUTONOMY_WINDOW_START: '02:00', AUTONOMY_WINDOW_END: '06:00' }

console.log('\n-- window math')
eq('parseHM', parseHM('02:00'), 120)
eq('parseHM rejects garbage', parseHM('2am'), null)
eq('parseHM rejects impossible hours', parseHM('25:00'), null)
{
  const w = windowState(at(3), '02:00', '06:00')
  ok('inside a normal window', w.ok && w.inWindow === true)
  eq('dayKey is today', w.dayKey, '2026-07-13')
}
{
  const w = windowState(at(7), '02:00', '06:00')
  ok('outside a normal window', w.ok && w.inWindow === false)
}
{
  // A night that wraps midnight is a normal night, and it is ONE night.
  const before = windowState(at(23, 30), '23:00', '05:00')
  const after = windowState(at(1, 30, 14), '23:00', '05:00')
  ok('23:30 is inside a 23:00-05:00 window', before.inWindow === true)
  ok('01:30 the next morning is still inside it', after.inWindow === true)
  eq('and both belong to the SAME night (dayKey = the day it opened)', after.dayKey, before.dayKey)
  const noon = windowState(at(12), '23:00', '05:00')
  ok('noon is outside it', noon.inWindow === false)
}
{
  const bad = windowState(at(3), 'nonsense', '06:00')
  ok('a malformed window is NOT permission to run whenever', bad.ok === false)
  const zero = windowState(at(3), '02:00', '02:00')
  ok('a zero-length window is rejected, not treated as all-day', zero.ok === false)
}

console.log('\n-- consent: the gate that cannot be inherited')
{
  const d = decideAutonomy({ now: at(3), config: { AUTONOMY_WINDOW_START: '02:00', AUTONOMY_WINDOW_END: '06:00' }, state: null, readBudget: RICH })
  eq('no AUTONOMY flag -> nothing happens', d.action, 'none')
}
{
  const d = decideAutonomy({ now: at(3), config: { ...CONSENTED, AUTONOMY: 'no' }, state: null, readBudget: RICH })
  eq('AUTONOMY=no -> nothing happens', d.action, 'none')
}
{
  // The consent-laundering attack: the user said yes to "may I speak first",
  // and the codebase already stores that as PROACTIVE=yes. That must not buy
  // permission to spend money overnight.
  const d = decideAutonomy({ now: at(3), config: { PROACTIVE: 'yes', PROACTIVE_WINDOW_START: '02:00', PROACTIVE_WINDOW_END: '06:00' }, state: null, readBudget: RICH })
  eq('PROACTIVE=yes does NOT authorize autonomous spending', d.action, 'none')
}
{
  const d = decideAutonomy({ now: at(3), config: { ...CONSENTED, AUTONOMY: 'YES' }, state: null, readBudget: RICH })
  eq('consent is case-insensitive (a yes is a yes)', d.action, 'start')
}

console.log('\n-- budget: the gate that fails closed')
{
  const d = decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: BLIND })
  eq('meter blind -> does NOT start', d.action, 'none')
  ok('and the reason names the blindness', /meter cannot measure/.test(d.reason), d.reason)
  ok('no cycle is recorded, so no brief is owed for a night that never ran',
    d.nextState.cycleDay === null)
  ok('but the skip is remembered (a silent no-op is how a feature becomes a ghost)',
    d.nextState.lastSkip && d.nextState.lastSkip.reason === 'meter-blind')
}
{
  const d = decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: BROKE })
  eq('already over cap at window open -> does NOT start', d.action, 'none')
  ok('skip reason is the cap, not the meter', d.nextState.lastSkip.reason === 'cap')
}
{
  const d = decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: RICH })
  eq('consent + window + budget -> START', d.action, 'start')
  eq('the night is stamped', d.nextState.cycleDay, '2026-07-13')
  ok('the remaining budget is handed to the caller so the AGENT can see the gauge',
    d.budget.remaining === 4900000)
}

console.log('\n-- one cycle per night, even across midnight')
{
  const started = decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: RICH })
  const again = decideAutonomy({ now: at(4), config: CONSENTED, state: started.nextState, readBudget: RICH })
  eq('a second poll in the same night does NOT start a second cycle', again.action, 'none')
}
{
  const cfg = { AUTONOMY: 'yes', AUTONOMY_WINDOW_START: '23:00', AUTONOMY_WINDOW_END: '05:00' }
  const started = decideAutonomy({ now: at(23, 30), config: cfg, state: null, readBudget: RICH })
  eq('wrapping night starts', started.action, 'start')
  const afterMidnight = decideAutonomy({ now: at(1, 0, 14), config: cfg, state: started.nextState, readBudget: RICH })
  eq('crossing midnight does NOT start a second cycle', afterMidnight.action, 'none')
}

console.log('\n-- the cap crossed mid-cycle: stop, do not kill')
{
  const started = decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: RICH })
  const d = decideAutonomy({ now: at(4), config: CONSENTED, state: started.nextState, readBudget: BROKE })
  eq('cap reached mid-cycle -> STOP', d.action, 'stop')
  ok('the stop reason carries the numbers', /5000000/.test(d.reason), d.reason)
  const d2 = decideAutonomy({ now: at(4, 30), config: CONSENTED, state: d.nextState, readBudget: BROKE })
  eq('and it only says stop once', d2.action, 'none')
}
{
  const started = decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: RICH })
  const d = decideAutonomy({ now: at(4), config: CONSENTED, state: started.nextState, readBudget: BLIND })
  eq('meter going blind MID-cycle also stops it', d.action, 'stop')
  ok('and says the meter went blind rather than inventing a number', /blind/.test(d.reason), d.reason)
}

console.log('\n-- the brief: a debt that survives the night and the process')
{
  const started = decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: RICH })
  const d = decideAutonomy({ now: at(7), config: CONSENTED, state: started.nextState, readBudget: RICH })
  eq('after the window, a cycle that ran OWES a brief', d.action, 'brief')
  const d2 = decideAutonomy({ now: at(8), config: CONSENTED, state: d.nextState, readBudget: RICH })
  eq('the brief is delivered once, not every poll', d2.action, 'none')
}
{
  // Restart at 07:00: the process is new, but the state file is not.
  const nightState = { cycleDay: '2026-07-13', cycleStartedAt: '2026-07-13T02:00:00.000Z', stoppedDay: null, briefDay: null }
  const d = decideAutonomy({ now: at(7), config: CONSENTED, state: nightState, readBudget: RICH })
  eq('a restart does not erase the debt', d.action, 'brief')
}
{
  // The night went badly and hit the cap. The user is owed the brief MORE, not less.
  const stopped = { cycleDay: '2026-07-13', cycleStartedAt: 'x', stoppedDay: '2026-07-13', briefDay: null }
  const d = decideAutonomy({ now: at(7), config: CONSENTED, state: stopped, readBudget: BROKE })
  eq('a cycle that hit the cap still owes a brief', d.action, 'brief')
}
{
  // Nothing ran. Nothing is owed. The app must not wake the user at 07:00 to
  // report that it did nothing.
  const skipped = { ...emptyState(), lastSkip: { day: '2026-07-13', at: 'x', reason: 'cap' } }
  const d = decideAutonomy({ now: at(7), config: CONSENTED, state: skipped, readBudget: BROKE })
  eq('a night with no cycle owes no brief', d.action, 'none')
}
console.log('\n-- consent WITHDRAWN mid-night (external red team, 2026-07-13)')
{
  // The hole: this watcher does not PUSH the agent. It told the agent once to
  // go, and the agent is running its own loop. Falling silent when consent is
  // withdrawn does not stop it -- it keeps spending until the window closes.
  // Withdrawal has to SPEAK.
  const running = { cycleDay: '2026-07-13', cycleStartedAt: '2026-07-13T02:00:00.000Z', stoppedDay: null, briefDay: null }
  const d = decideAutonomy({ now: at(3), config: { ...CONSENTED, AUTONOMY: 'no' }, state: running, readBudget: RICH })
  eq('withdrawing consent mid-cycle STOPS the agent (it does not just go quiet)', d.action, 'stop')
  ok('and says so', /consent withdrawn/.test(d.reason), d.reason)

  const after = decideAutonomy({ now: at(3, 5), config: { ...CONSENTED, AUTONOMY: 'no' }, state: d.nextState, readBudget: RICH })
  eq('...then the night that already ran is STILL owed its accounting', after.action, 'brief')

  const settled = decideAutonomy({ now: at(3, 10), config: { ...CONSENTED, AUTONOMY: 'no' }, state: after.nextState, readBudget: RICH })
  eq('...and once stopped and briefed, it finally goes quiet', settled.action, 'none')
}
{
  const never = { ...emptyState() }
  const d = decideAutonomy({ now: at(3), config: { ...CONSENTED, AUTONOMY: 'no' }, state: never, readBudget: RICH })
  eq('consent off with nothing outstanding stays silent', d.action, 'none')
}

console.log('\n-- a corrupt cycle anchor is BLINDNESS, not a free budget')
{
  // If cycleStartedAt is unreadable we cannot know what tonight has cost. The
  // tempting answer (treat it as 0) hands the agent a fresh full cap on top of
  // whatever it already burned.
  const corrupt = { cycleDay: '2026-07-13', cycleStartedAt: 'not-a-timestamp', stoppedDay: null, briefDay: null }
  const d = decideAutonomy({ now: at(3), config: CONSENTED, state: corrupt, readBudget: RICH })
  eq('a cycle with an unparseable start time is STOPPED', d.action, 'stop')
  ok('and the reason is that we cannot measure it, not that it overspent',
    /cannot measure/.test(d.reason), d.reason)
}

console.log('\n-- the cap is anchored to the night, and the anchor is passed through')
{
  let seen = 'never called'
  const spy = (sinceMs) => { seen = sinceMs; return RICH() }
  decideAutonomy({ now: at(3), config: CONSENTED, state: null, readBudget: spy })
  eq('with no cycle running, the meter is asked about NO window (null)', seen, null)

  // The anchor must be in the PAST relative to `now` -- the clock guard rejects a
  // future one, and it caught this fixture when it was written wrong.
  const startedAt = new Date(at(3).getTime() - 60 * 60 * 1000).toISOString() // an hour before now
  const running = { cycleDay: '2026-07-13', cycleStartedAt: startedAt, stoppedDay: null, briefDay: null }
  decideAutonomy({ now: at(3), config: CONSENTED, state: running, readBudget: spy })
  eq('with a cycle running, the meter is anchored to the cycle START', seen, Date.parse(startedAt))
}

console.log('\n-- clock moved BACKWARD (external red team, pass 2)')
{
  // NTP correction / manual change / VM restore: the night now starts in the
  // future. usageSince() would filter out every row the agent writes, spend
  // would read as zero forever, and the cap would be silently disarmed.
  const running = {
    cycleDay: '2026-07-13',
    cycleStartedAt: new Date(2026, 6, 13, 5, 0, 0).toISOString(), // 05:00
    stoppedDay: null, briefDay: null,
  }
  const d = decideAutonomy({ now: at(3), config: CONSENTED, state: running, readBudget: RICH })
  eq('an anchor in the FUTURE stops the cycle', d.action, 'stop')
  ok('and names the clock, rather than inventing a spend number',
    /clock moved backward/.test(d.reason), d.reason)
}
{
  // ...but ordinary NTP jitter (a few seconds) must not kill the night.
  const jitter = {
    cycleDay: '2026-07-13',
    cycleStartedAt: new Date(2026, 6, 13, 3, 0, 10).toISOString(), // 10s ahead of now
    stoppedDay: null, briefDay: null,
  }
  const d = decideAutonomy({ now: at(3), config: CONSENTED, state: jitter, readBudget: RICH })
  eq('a few seconds of skew is tolerated, not treated as a clock jump', d.action, 'none')
}

console.log('\n-- an unreadable schedule is a STOP, not a shrug (external red team, pass 2)')
{
  const running = { cycleDay: '2026-07-13', cycleStartedAt: '2026-07-13T02:00:00.000Z', stoppedDay: null, briefDay: null }
  const cfg = { AUTONOMY: 'yes', AUTONOMY_WINDOW_START: 'garbage', AUTONOMY_WINDOW_END: '06:00' }
  const d = decideAutonomy({ now: at(3), config: cfg, state: running, readBudget: RICH })
  eq('a running cycle under an unreadable window is STOPPED', d.action, 'stop')

  const idle = decideAutonomy({ now: at(3), config: cfg, state: null, readBudget: RICH })
  eq('...while with no cycle running it simply does not start', idle.action, 'none')
}

console.log('\n-- the injected turns: a contract with stop-reply-guard, not decoration')
{
  const { startInject, stopInject, briefInject, injectFor } = require(path.join(HERE, '..', 'autonomy', 'cycle.cjs'))

  // Read the guard's ACTUAL skip patterns out of the hook source rather than
  // restating them here. A copy of a rule is not the rule: if someone edits the
  // hook, this test must break, and a duplicated regex would keep passing while
  // the agent starts waking the user at 03:00.
  const hookSrc = fs.readFileSync(path.join(HERE, '..', 'hooks', 'stop-reply-guard.mjs'), 'utf8')
  const block = hookSrc.match(/const SKIP_PATTERNS = \[([\s\S]*?)\]/)
  ok('the guard\'s SKIP_PATTERNS block was found in the hook source', Boolean(block))
  // eslint-disable-next-line no-eval
  const SKIP = block ? eval(`[${block[1]}]`) : []
  ok('and it parsed into real regexes', SKIP.length > 0 && SKIP.every((r) => r instanceof RegExp), String(SKIP.length))
  const skipped = (text) => SKIP.some((r) => r.test(text))

  const B = RICH()
  ok('START is SILENT to the guard (nobody is woken at 03:00)', skipped(startInject(B)))
  ok('STOP is SILENT to the guard', skipped(stopInject(B, 'cap')))
  ok('BRIEF is NOT silent -- the guard is what makes the morning report land',
    skipped(briefInject(B)) === false, briefInject(B).slice(0, 60))

  ok('START shows the agent the gauge (a number it can choose against)',
    startInject(B).includes('4,900,000'))
  ok('START says stopping early is allowed -- a gauge with no permission to stop is just a warning',
    /멈춰도 된다/.test(startInject(B)))
  ok('BRIEF carries the token number, so the cost cannot be quietly omitted',
    briefInject(B).includes('100,000'))

  const BL = BLIND()
  ok('a blind meter never renders as a number in the brief -- it says it cannot measure',
    /지어내지 마/.test(briefInject(BL)) && !/NaN|undefined/.test(briefInject(BL)))
  ok('a blind meter never renders as a number in the stop notice',
    !/NaN|undefined/.test(stopInject(BL, 'no transcript directory found')))

  eq('injectFor(none) is null (the wiring cannot pick text for a non-action)',
    injectFor({ action: 'none' }), null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
