#!/usr/bin/env node
// test-schedule-tick.mjs -- attacks on cadence/schedule-tick.cjs, the pure
// rule behind generic Schedules (recurring/one-off prompts, user- or
// agent-authored). Run: node tests/test-schedule-tick.mjs
//
// Same shape as tests/test-note-cadence.mjs / test-autonomy-cycle.mjs:
// import the pure module directly, assert with plain conditionals, exit 1 on
// any failure. No framework, no mocks beyond the injected clock.

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const { planScheduleTick, MIN_EVERY_MINUTES, ACTIVITY_SUPPRESS_MS } = require(
  path.join(HERE, '..', 'cadence', 'schedule-tick.cjs')
)

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`ok   - ${name}`) }
  else { fail++; console.error(`FAIL - ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const at = (h, m = 0, day = 16) => new Date(2026, 7, day, h, m, 0) // Aug 2026, local time
const ACTIVE = ACTIVITY_SUPPRESS_MS - 1000 // recently active: still inside suppress window
const IDLE = ACTIVITY_SUPPRESS_MS + 1000 // idle: past the suppress window

const system = (over) => ({ id: 's1', kind: 'recurring', enabled: true, everyMinutes: 60, prompt: 'do the thing', createdBy: 'system', lastRunISO: null, ...over })
const once = (over) => ({ id: 'o1', kind: 'once', enabled: true, prompt: 'do it once', createdBy: 'user', atISO: '2026-08-16T02:00:00', lastRunISO: null, ...over })
const storeOf = (...schedules) => ({ version: 1, schedules })

// ── global kill switch ───────────────────────────────────────────────────
{
  const r = planScheduleTick({ now: at(3), config: { SCHEDULES: 'off' }, store: storeOf(system({ window: '02:00-06:00' })), agentActiveMs: IDLE })
  ok('SCHEDULES=off -> nothing due', r.due.length === 0 && r.warnings.length === 0 && r.skipped.length === 0)
}

// ── recurring: window wrap (23:00-02:00) ────────────────────────────────
{
  const entry = system({ window: '23:00-02:00' })
  const inside1 = planScheduleTick({ now: at(23, 30), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('23:30 is inside a 23:00-02:00 window -> due', inside1.due.length === 1 && inside1.due[0].id === 's1')
  const inside2 = planScheduleTick({ now: at(1, 30), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('01:30 is still inside the wrapped window -> due', inside2.due.length === 1)
  const outside = planScheduleTick({ now: at(12), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('noon is outside a 23:00-02:00 window -> skipped, not due', outside.due.length === 0 && outside.skipped.some((s) => s.id === 's1' && s.reason === 'outside window'))
}

// ── recurring: no window means always allowed ────────────────────────────
{
  const r = planScheduleTick({ now: at(12), config: {}, store: storeOf(system({ window: undefined })), agentActiveMs: IDLE })
  ok('no window field -> not restricted by time of day', r.due.length === 1)
}

// ── everyMinutes floor ────────────────────────────────────────────────────
{
  const r = planScheduleTick({ now: at(3), config: {}, store: storeOf(system({ everyMinutes: 5 })), agentActiveMs: IDLE })
  ok('everyMinutes below floor -> skipped with reason (not a warning)', r.due.length === 0 && r.warnings.length === 0)
  ok('floor reason mentions the floor', r.skipped.some((s) => s.id === 's1' && s.reason.includes(String(MIN_EVERY_MINUTES))))
  const edge = planScheduleTick({ now: at(3), config: {}, store: storeOf(system({ everyMinutes: MIN_EVERY_MINUTES })), agentActiveMs: IDLE })
  ok(`exactly ${MIN_EVERY_MINUTES} (the floor itself) is allowed`, edge.due.length === 1)
}

// ── recurring: interval gating off lastRunISO ────────────────────────────
{
  const recentRun = new Date(at(3).getTime() - 10 * 60 * 1000).toISOString() // ran 10min ago, interval is 60min
  const r = planScheduleTick({ now: at(3), config: {}, store: storeOf(system({ lastRunISO: recentRun })), agentActiveMs: IDLE })
  ok('interval not yet elapsed since lastRunISO -> skipped', r.due.length === 0 && r.skipped.some((s) => s.reason === 'interval not elapsed'))
  const oldRun = new Date(at(3).getTime() - 90 * 60 * 1000).toISOString() // ran 90min ago, interval is 60min
  const r2 = planScheduleTick({ now: at(3), config: {}, store: storeOf(system({ lastRunISO: oldRun })), agentActiveMs: IDLE })
  ok('interval elapsed -> due again', r2.due.length === 1)
}

// ── recurring: missed window does NOT back-fire ──────────────────────────
{
  // Window 03:00-06:00, last ran yesterday inside it. App was closed through
  // today's window (now is well past it) -- must NOT fire late; must simply
  // wait for the NEXT window open.
  const yesterday = new Date(at(4, 0, 15).getTime()).toISOString() // ran during yesterday's window
  const entry = system({ everyMinutes: 1440, window: '03:00-06:00', lastRunISO: yesterday })
  const missedToday = planScheduleTick({ now: at(20, 0, 16), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('app missed today\'s window -> not due (outside window), no back-fire', missedToday.due.length === 0 && missedToday.skipped.some((s) => s.reason === 'outside window'))
  const nextWindow = planScheduleTick({ now: at(4, 0, 17), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('next day\'s window open -> due normally, no catch-up penalty', nextWindow.due.length === 1)
}

// ── once: fires once, then never again ───────────────────────────────────
{
  const entry = once({ atISO: '2026-08-16T02:00:00' })
  const before = planScheduleTick({ now: at(1), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('before atISO -> not due', before.due.length === 0 && before.skipped.some((s) => s.reason === 'not yet time'))
  const atTime = planScheduleTick({ now: at(2), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('at/after atISO, lastRunISO null -> due', atTime.due.length === 1 && atTime.due[0].id === 'o1')
  const fired = { ...entry, lastRunISO: at(2).toISOString() }
  const again = planScheduleTick({ now: at(5), config: {}, store: storeOf(fired), agentActiveMs: IDLE })
  ok('once lastRunISO is set -> never fires again', again.due.length === 0 && again.skipped.some((s) => s.reason === 'already fired'))
}

// ── agent-authored: blocked without AUTONOMY=yes ─────────────────────────
{
  const entry = system({ id: 'a1', createdBy: 'agent' })
  const noConsent = planScheduleTick({ now: at(3), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('agent-authored, AUTONOMY not set -> blocked', noConsent.due.length === 0 && noConsent.skipped.some((s) => s.id === 'a1' && s.reason === 'agent-authored requires AUTONOMY=yes'))
  const declined = planScheduleTick({ now: at(3), config: { AUTONOMY: 'no' }, store: storeOf(entry), agentActiveMs: IDLE })
  ok('agent-authored, AUTONOMY=no -> blocked', declined.due.length === 0)
  const consented = planScheduleTick({ now: at(3), config: { AUTONOMY: 'yes' }, store: storeOf(entry), agentActiveMs: IDLE })
  ok('agent-authored, AUTONOMY=yes -> allowed through the consent gate', consented.due.length === 1)
}

// ── user/system authored: exempt from the consent gate ───────────────────
{
  const u = system({ id: 'u1', createdBy: 'user' })
  const s = system({ id: 'sys1', createdBy: 'system' })
  const r = planScheduleTick({ now: at(3), config: {}, store: storeOf(u, s), agentActiveMs: IDLE })
  ok('user- and system-authored fire without AUTONOMY at all', r.due.length === 2)
}

// ── activity suppression: defers, does not lose the entry ────────────────
{
  const entry = system()
  const busy = planScheduleTick({ now: at(3), config: {}, store: storeOf(entry), agentActiveMs: ACTIVE })
  ok('recently active (< suppress window) -> deferred, not due', busy.due.length === 0 && busy.skipped.some((s) => s.reason === 'active session (suppressed)'))
  const quiet = planScheduleTick({ now: at(3), config: {}, store: storeOf(entry), agentActiveMs: IDLE })
  ok('idle (> suppress window), same unfired entry -> due', quiet.due.length === 1)
}
{
  // "once" schedules also defer during activity -- per design, everything
  // defers, nothing is marked run, regardless of kind or how overdue.
  const entry = once({ atISO: '2020-01-01T00:00:00' }) // ludicrously overdue
  const busy = planScheduleTick({ now: at(3), config: {}, store: storeOf(entry), agentActiveMs: ACTIVE })
  ok('overdue "once" during active session -> still deferred, not lost', busy.due.length === 0 && busy.skipped.some((s) => s.reason === 'active session (suppressed)'))
}

// ── disabled entries never fire ───────────────────────────────────────────
{
  const r = planScheduleTick({ now: at(3), config: {}, store: storeOf(system({ enabled: false })), agentActiveMs: IDLE })
  ok('enabled:false -> skipped, never due', r.due.length === 0 && r.skipped.some((s) => s.reason === 'disabled'))
}

// ── malformed entries: skipped via warnings, never throw ─────────────────
{
  const cases = [
    ['not an object', 42],
    ['missing id', { kind: 'recurring', everyMinutes: 60, prompt: 'x', createdBy: 'system' }],
    ['bad kind', { id: 'x', kind: 'weekly', everyMinutes: 60, prompt: 'x', createdBy: 'system' }],
    ['missing prompt', { id: 'x', kind: 'recurring', everyMinutes: 60, createdBy: 'system' }],
    ['bad createdBy', { id: 'x', kind: 'recurring', everyMinutes: 60, prompt: 'x', createdBy: 'ghost' }],
    ['non-numeric everyMinutes', { id: 'x', kind: 'recurring', everyMinutes: 'often', prompt: 'x', createdBy: 'system' }],
    ['bad window shape', { id: 'x', kind: 'recurring', everyMinutes: 60, window: 'evening', prompt: 'x', createdBy: 'system' }],
    ['once missing atISO', { id: 'x', kind: 'once', prompt: 'x', createdBy: 'user' }],
    ['once garbage atISO', { id: 'x', kind: 'once', atISO: 'not-a-date', prompt: 'x', createdBy: 'user' }],
  ]
  for (const [label, bad] of cases) {
    const r = planScheduleTick({ now: at(3), config: {}, store: storeOf(bad), agentActiveMs: IDLE })
    ok(`malformed entry (${label}) -> skipped via warnings, never throws`, r.due.length === 0 && r.warnings.length === 1 && r.skipped.length === 0)
  }
}
{
  // One malformed entry must not take a valid sibling down with it.
  const good = system({ id: 'good' })
  const bad = { id: 'bad', kind: 'recurring', prompt: 'x', createdBy: 'system' } // missing everyMinutes
  const r = planScheduleTick({ now: at(3), config: {}, store: storeOf(good, bad), agentActiveMs: IDLE })
  ok('malformed sibling does not block a valid entry', r.due.length === 1 && r.due[0].id === 'good' && r.warnings.length === 1)
}

// ── malformed file (not JSON.parse-able / wrong shape) ────────────────────
{
  // null = file missing = normal fresh-install state. Warning here spammed
  // the app log every 60s on every fresh DATA_HOME (2026-08-19, Mino's box).
  const r1 = planScheduleTick({ now: at(3), config: {}, store: null, agentActiveMs: IDLE })
  ok('store null (file missing -- nothing registered) -> SILENT, never throws', r1.due.length === 0 && r1.warnings.length === 0)
  const r2 = planScheduleTick({ now: at(3), config: {}, store: { schedules: 'not-an-array' }, agentActiveMs: IDLE })
  ok('schedules not an array -> warning, never throws', r2.due.length === 0 && r2.warnings.length === 1)
  const r3 = planScheduleTick({ now: at(3), config: {}, store: { schedules: 'unparseable' }, agentActiveMs: IDLE })
  ok('corrupt-file sentinel from channel-runtime -> warning', r3.due.length === 0 && r3.warnings.length === 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
