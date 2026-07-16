#!/usr/bin/env node
// test-note-cadence.mjs -- exercises cadence/note-tick.cjs (the pure rule
// behind the session-note cadence watcher). Run directly: node scripts/test-note-cadence.mjs

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { planNoteTick, DEFAULT_ACTIVE_MIN, DEFAULT_IDLE_MIN, ACTIVITY_WINDOW_MS } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cadence', 'note-tick.cjs')
)

let failures = 0
function check(name, cond) {
  if (cond) { console.log(`ok   - ${name}`); return }
  failures += 1
  console.error(`FAIL - ${name}`)
}

const MIN = 60 * 1000
const T0 = 1_800_000_000_000 // fixed epoch base: decisions must not read the wall clock

// -- disabled knob --------------------------------------------------------
{
  const r = planNoteTick({ now: T0, config: { NOTE_CADENCE: 'off' }, noteMtimeMs: null, lastActivityMs: T0 })
  check('NOTE_CADENCE=off disables entirely (even with a missing note)', r.skip === true && r.reason === 'disabled')
}

// -- active session, fresh note -------------------------------------------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 10 * MIN, lastActivityMs: T0 - 5 * MIN })
  check('active + note 10min old (< 30min) -> skip', r.skip === true && r.reason === 'note fresh')
}

// -- active session, stale note -------------------------------------------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 45 * MIN, lastActivityMs: T0 - 5 * MIN, noteDate: '2026-07-16' })
  check('active + note 45min old -> remind', !r.skip && r.mode === 'active')
  check('reminder names the exact file', !r.skip && r.content.includes('session_notes/2026-07-16.md'))
  check('reminder is file-work-only (답장하지 마 rail)', !r.skip && r.content.includes('답장하지 마'))
  check('nextLastRemindMs advances to now', r.nextLastRemindMs === T0)
}

// -- idle session: 45min-stale note must NOT remind (3h cadence) ----------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 45 * MIN, lastActivityMs: T0 - 2 * 60 * MIN })
  check('idle + note 45min old (< 180min) -> skip', r.skip === true && r.reason === 'note fresh')
}

// -- idle session, stale beyond idle cadence ------------------------------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 200 * MIN, lastActivityMs: T0 - 2 * 60 * MIN })
  check('idle + note 200min old -> remind (idle mode)', !r.skip && r.mode === 'idle')
}

// -- activity window boundary ----------------------------------------------
{
  const justActive = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 45 * MIN, lastActivityMs: T0 - ACTIVITY_WINDOW_MS })
  const justIdle = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 45 * MIN, lastActivityMs: T0 - ACTIVITY_WINDOW_MS - 1 })
  check('activity exactly at window edge counts as active (remind at 45min)', !justActive.skip && justActive.mode === 'active')
  check('activity 1ms past window counts as idle (45min note -> skip)', justIdle.skip === true)
}

// -- missing note (midnight rollover) --------------------------------------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: null, lastActivityMs: T0, noteDate: '2026-07-17' })
  check('missing note -> remind regardless of age math', !r.skip)
  check('missing-note reminder says to create it', !r.skip && r.content.includes('아직 없다'))
}

// -- throttle ---------------------------------------------------------------
{
  const first = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 45 * MIN, lastActivityMs: T0 })
  const second = planNoteTick({ now: T0 + 5 * MIN, config: {}, noteMtimeMs: T0 - 50 * MIN, lastActivityMs: T0 + 5 * MIN, lastRemindMs: first.nextLastRemindMs })
  const third = planNoteTick({ now: T0 + 31 * MIN, config: {}, noteMtimeMs: T0 - 76 * MIN, lastActivityMs: T0 + 31 * MIN, lastRemindMs: first.nextLastRemindMs })
  check('second poll 5min after a reminder -> throttled', second.skip === true && second.reason === 'reminded recently')
  check('poll after a full cadence window -> reminds again', !third.skip)
}

// -- knob overrides ---------------------------------------------------------
{
  const r = planNoteTick({ now: T0, config: { NOTE_CADENCE_ACTIVE_MIN: '10' }, noteMtimeMs: T0 - 15 * MIN, lastActivityMs: T0 })
  check('NOTE_CADENCE_ACTIVE_MIN=10 tightens the active cadence', !r.skip)
  const bad = planNoteTick({ now: T0, config: { NOTE_CADENCE_ACTIVE_MIN: 'garbage' }, noteMtimeMs: T0 - 15 * MIN, lastActivityMs: T0 })
  check('garbage knob falls back to default (15min note -> skip)', bad.skip === true)
  const idle = planNoteTick({ now: T0, config: { NOTE_CADENCE_IDLE_MIN: '60' }, noteMtimeMs: T0 - 90 * MIN, lastActivityMs: T0 - 3 * 60 * MIN })
  check('NOTE_CADENCE_IDLE_MIN=60 tightens the idle cadence', !idle.skip && idle.mode === 'idle')
}

// -- defaults sanity ---------------------------------------------------------
check(`defaults are ${DEFAULT_ACTIVE_MIN}/${DEFAULT_IDLE_MIN} min (30/180 per Mino 07-16)`, DEFAULT_ACTIVE_MIN === 30 && DEFAULT_IDLE_MIN === 180)

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall checks passed')
