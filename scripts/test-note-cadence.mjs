#!/usr/bin/env node
// test-note-cadence.mjs -- exercises cadence/note-tick.cjs (the pure rule
// behind the session-note cadence watcher). Run directly: node scripts/test-note-cadence.mjs
//
// IDLE-ONLY since the 2026-07-28 boot-context diet: an active session skips
// entirely (the conversation is the cadence); the watcher is the floor
// under idle stretches only. The active-lane tests that used to live here
// were removed WITH the lane -- keeping them green against a shim would
// have tested a copy of a rule that no longer exists.

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { planNoteTick, DEFAULT_IDLE_MIN, ACTIVITY_WINDOW_MS } = require(
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
const IDLE = { lastActivityMs: T0 - 2 * 60 * MIN } // 2h since activity -> idle

// -- disabled knob --------------------------------------------------------
{
  const r = planNoteTick({ now: T0, config: { NOTE_CADENCE: 'off' }, noteMtimeMs: null, lastActivityMs: T0 })
  check('NOTE_CADENCE=off disables entirely (even with a missing note)', r.skip === true && r.reason === 'disabled')
}

// -- active session: NEVER nags, no matter how stale ----------------------
{
  const stale = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 400 * MIN, lastActivityMs: T0 - 5 * MIN })
  check('active + note 400min old -> skip (conversation is the cadence)', stale.skip === true && stale.reason === 'active session')
  const missing = planNoteTick({ now: T0, config: {}, noteMtimeMs: null, lastActivityMs: T0 - 5 * MIN })
  check('active + missing note -> still skip', missing.skip === true && missing.reason === 'active session')
}

// -- idle session, fresh note ---------------------------------------------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 45 * MIN, ...IDLE })
  check('idle + note 45min old (< 180min) -> skip', r.skip === true && r.reason === 'note fresh')
}

// -- idle session, stale beyond idle cadence ------------------------------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 200 * MIN, ...IDLE, noteDate: '2026-07-16' })
  check('idle + note 200min old -> remind (idle mode)', !r.skip && r.mode === 'idle')
  check('reminder names the exact file', !r.skip && r.content.includes('session_notes/2026-07-16.md'))
  check('reminder is file-work-only (답장하지 마 rail)', !r.skip && r.content.includes('답장하지 마'))
  check('nextLastRemindMs advances to now', r.nextLastRemindMs === T0)
}

// -- activity window boundary ----------------------------------------------
{
  const justActive = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 200 * MIN, lastActivityMs: T0 - ACTIVITY_WINDOW_MS })
  const justIdle = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 200 * MIN, lastActivityMs: T0 - ACTIVITY_WINDOW_MS - 1 })
  check('activity exactly at window edge counts as active (200min note -> skip)', justActive.skip === true && justActive.reason === 'active session')
  check('activity 1ms past window counts as idle (200min note -> remind)', !justIdle.skip)
}

// -- missing note (midnight rollover), idle --------------------------------
{
  const r = planNoteTick({ now: T0, config: {}, noteMtimeMs: null, ...IDLE, noteDate: '2026-07-17' })
  check('idle + missing note -> remind regardless of age math', !r.skip)
  check('missing-note reminder says to create it', !r.skip && r.content.includes('아직 없다'))
}

// -- throttle ---------------------------------------------------------------
{
  const first = planNoteTick({ now: T0, config: {}, noteMtimeMs: T0 - 200 * MIN, ...IDLE })
  const second = planNoteTick({ now: T0 + 5 * MIN, config: {}, noteMtimeMs: T0 - 205 * MIN, lastActivityMs: T0 - 2 * 60 * MIN, lastRemindMs: first.nextLastRemindMs })
  const third = planNoteTick({ now: T0 + 181 * MIN, config: {}, noteMtimeMs: T0 - 381 * MIN, lastActivityMs: T0 - 2 * 60 * MIN, lastRemindMs: first.nextLastRemindMs })
  check('second poll 5min after a reminder -> throttled', second.skip === true && second.reason === 'reminded recently')
  check('poll after a full cadence window -> reminds again', !third.skip)
}

// -- knob overrides ---------------------------------------------------------
{
  const idle = planNoteTick({ now: T0, config: { NOTE_CADENCE_IDLE_MIN: '60' }, noteMtimeMs: T0 - 90 * MIN, ...IDLE })
  check('NOTE_CADENCE_IDLE_MIN=60 tightens the idle cadence', !idle.skip && idle.mode === 'idle')
  const bad = planNoteTick({ now: T0, config: { NOTE_CADENCE_IDLE_MIN: 'garbage' }, noteMtimeMs: T0 - 90 * MIN, ...IDLE })
  check('garbage knob falls back to default (90min note -> skip)', bad.skip === true)
  // The dead active-lane knob: a config still carrying it is ignored, never
  // an error, and never tightens anything.
  const dead = planNoteTick({ now: T0, config: { NOTE_CADENCE_ACTIVE_MIN: '10' }, noteMtimeMs: T0 - 90 * MIN, ...IDLE })
  check('stale NOTE_CADENCE_ACTIVE_MIN in config is ignored (90min note -> skip)', dead.skip === true && dead.reason === 'note fresh')
}

// -- defaults sanity ---------------------------------------------------------
check(`idle default is ${DEFAULT_IDLE_MIN} min (180 per Mino 07-16 "세시간에 한 번")`, DEFAULT_IDLE_MIN === 180)

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall checks passed')
