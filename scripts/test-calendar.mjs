// test-calendar.mjs -- attacks on the calendar reader.
// Run: node scripts/test-calendar.mjs
//
// The property under attack is not "does it list events". It is:
//   CAN THIS THING EVER SAY "you have nothing scheduled" WHEN IT SIMPLY
//   COULD NOT LOOK?
//
// That is not hypothetical. On this machine, EventKit returns count=0 with NO
// ERROR when the process has write-only calendar access, while a second API
// simultaneously finds 3 events in the same window. The zero is a lie the
// framework hands you for free.

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const cal = require(path.join(HERE, '..', 'calendar', 'read.cjs'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

console.log('\n-- the authorization guard: only ONE status may report events')
{
  // 3 (fullAccess) is the only status with no denial mapping. Every other status
  // must produce a refusal, including the two that are easy to mistake for
  // success.
  for (const [status, expected] of [[0, 'not_determined'], [1, 'restricted'], [2, 'denied'], [4, 'write_only']]) {
    const d = cal.EK_STATUS[status]
    ok(`status ${status} is a REFUSAL (${expected})`, d && d.code === expected, JSON.stringify(d))
  }
  ok('status 3 (fullAccess) is the only one allowed to answer', cal.EK_STATUS[3] === null)
  ok('the write-only refusal explicitly says a 0 does not mean "nothing scheduled"',
    /일정이 없다는 뜻이 아니라/.test(cal.EK_STATUS[4].reason))
}

console.log('\n-- the script itself checks the status BEFORE reading')
{
  // If the status check came after the read, a write-only process would build an
  // empty list and then have to be talked out of returning it. Check the order in
  // the source: the guard must be upstream of the query.
  const src = cal.SCRIPT
  const guardAt = src.indexOf('authorizationStatusForEntityType')
  const queryAt = src.indexOf('eventsMatchingPredicate')
  ok('the permission check precedes the query', guardAt > -1 && queryAt > -1 && guardAt < queryAt,
    `guard@${guardAt} query@${queryAt}`)
  ok('and it returns early rather than falling through', /if \(status !== 3\)[\s\S]{0,80}return/.test(src))
}

console.log('\n-- ranges')
{
  const bad = await cal.readEvents({ from: 'not-a-date', to: new Date() })
  ok('an unusable range is refused, not silently widened', bad.ok === false && bad.code === 'bad_range')
  const inverted = await cal.readEvents({ from: new Date(2026, 6, 14), to: new Date(2026, 6, 13) })
  ok('a backwards range is refused', inverted.ok === false && inverted.code === 'bad_range')
}

console.log('\n-- failure classification')
{
  const t = cal.classify({ killed: true, message: 'timeout' }, '')
  ok('a hang is reported as a TIMEOUT, not as an empty calendar', t.code === 'timeout')
  ok('...and the reason names the headless-prompt cause we actually hit', /권한 팝업/.test(t.reason))
  const u = cal.classify(new Error('boom'), 'some stderr')
  ok('an unknown failure keeps the raw text rather than inventing a category',
    u.code === 'unknown' && /some stderr/.test(u.reason))
}

console.log('\n-- LIVE, against the real Calendar on this machine')
{
  const t0 = Date.now()
  const r = await cal.readEvents(cal.dayRange(new Date(), 14))
  const ms = Date.now() - t0
  ok(`the call returns fast (${ms}ms; the Apple Events design it replaced took 50,003ms)`, ms < 5000, `${ms}ms`)

  // THE assertion. Whatever this machine's permission state is, the one thing
  // that must never happen is a confident empty list from a process that cannot
  // see the calendar.
  const lied = r.ok === true && r.authStatus !== 3
  ok('it never reports events without full read access', lied === false, JSON.stringify(r).slice(0, 160))

  if (r.ok) {
    ok('with access, events come back as a list', Array.isArray(r.events))
    console.log(`      (live: ${r.events.length} events in the next 14 days)`)
  } else {
    ok('without access, it refuses with a named, actionable reason',
      typeof r.code === 'string' && typeof r.reason === 'string' && r.reason.length > 10)
    console.log(`      (live: refused with code="${r.code}", authStatus=${r.authStatus})`)
    console.log('      NOTE: the positive path (fullAccess -> real events) is NOT proven by this run.')
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
