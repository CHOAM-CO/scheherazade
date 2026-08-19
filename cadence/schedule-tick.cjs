'use strict'
// cadence/schedule-tick.cjs -- pure decision for generic Schedules: user- or
// agent-authored recurring/one-off prompts, read from DATA_HOME/schedules.json.
//
// Same split as autonomy/tick.cjs and cadence/note-tick.cjs, for the same
// reason: a copy of a rule is not the rule. channel.mjs owns the IO (read
// .agent-config fresh, read+parse schedules.json, call this function, inject
// the due prompts on the SAME rail the autonomy cycle uses, write back
// lastRunISO). This file owns the rule: what is due, what is not, and why --
// and scripts/test-schedule-tick.mjs calls THIS function, not a copy of it.
//
// Before this feature, every background behavior (autonomy cycle, note
// cadence, routines) was its own hardcoded setInterval with its own bespoke
// schedule. Schedules is the generic one: an entry in schedules.json IS a
// background behavior, authored by the user, the system (shipped defaults),
// or the agent itself (writing DATA_HOME/schedules.json directly -- no new
// MCP tool, its CLAUDE.md already gives it DATA_HOME write freedom).
//
// No clock, no fs, no Date.now() anywhere below this line. `now` is a Date,
// injected -- same contract as autonomy/cycle.cjs (it needs getHours() /
// getMinutes() for window math, not just an epoch number like note-tick.cjs
// gets away with).

// Recurring schedules faster than this are refused, not merely slow -- a
// leaked everyMinutes:1 would poll the model every tick forever. This is a
// business-rule floor on an otherwise well-formed entry (goes to `skipped`
// with a reason), not a malformed entry (which goes to `warnings`).
const MIN_EVERY_MINUTES = 15

// Suppress firing while the user is mid-conversation. Deliberately its own,
// SMALLER number than cadence/note-tick.cjs's ACTIVITY_WINDOW_MS (1h): that
// watcher is choosing not to NAG about note hygiene during a live chat;
// this one is choosing not to inject a THIRD PARTY's scheduled turn into a
// conversation the user is actively having. 10 minutes (Mino's design) is
// long enough to cover normal typing gaps, short enough that a schedule
// does not starve just because the user is chatty that day -- the deferred
// entry is due again the very next quiet tick, never lost, never
// back-filled (see recurringDue / onceDue below).
const ACTIVITY_SUPPRESS_MS = 10 * 60 * 1000

function isConsented(config) {
  return String((config && config.AUTONOMY) || '').toLowerCase() === 'yes'
}

function schedulesOff(config) {
  return String((config && config.SCHEDULES) || '').toLowerCase() === 'off'
}

// "HH:MM" -> minutes since local midnight, or null if it is not one.
// Copy of autonomy/cycle.cjs's parseHM, not a require of it: this module is
// dependency-free by design (no other cadence/autonomy module, no IO), so a
// test that imports schedule-tick.cjs alone gets the whole rule.
function parseHM(s) {
  if (typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

// "HH:MM-HH:MM" -> { start, end } in minutes, or null if malformed.
// undefined/null window means "no window restriction" and is valid.
function parseWindow(w) {
  if (w == null) return { start: null, end: null }
  if (typeof w !== 'string') return null
  const parts = w.split('-')
  if (parts.length !== 2) return null
  const start = parseHM(parts[0])
  const end = parseHM(parts[1])
  if (start === null || end === null || start === end) return null
  return { start, end }
}

// May wrap midnight (23:00-02:00 is an ordinary window), same rule as
// autonomy/cycle.cjs's windowState.
function inWindow(now, start, end) {
  if (start === null) return true
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return start > end ? (nowMin >= start || nowMin < end) : (nowMin >= start && nowMin < end)
}

// Structural validation only -- is this entry SHAPED like a schedule.
// Business rules (floor, window/interval math, consent) are checked later,
// against an entry we already trust to have the right types. Returns
// { ok: true, entry } or { ok: false, warning }.
function validateEntry(raw, idx) {
  const label = raw && typeof raw.id === 'string' && raw.id.trim() ? raw.id : `schedules[${idx}]`
  if (!raw || typeof raw !== 'object') return { ok: false, warning: `${label}: not an object` }
  if (typeof raw.id !== 'string' || !raw.id.trim()) return { ok: false, warning: `${label}: missing/invalid id` }
  if (raw.kind !== 'recurring' && raw.kind !== 'once') {
    return { ok: false, warning: `${label}: kind must be "recurring" or "once", got ${JSON.stringify(raw.kind)}` }
  }
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
    return { ok: false, warning: `${label}: missing/invalid prompt` }
  }
  if (raw.createdBy !== 'system' && raw.createdBy !== 'user' && raw.createdBy !== 'agent') {
    return { ok: false, warning: `${label}: createdBy must be "system", "user", or "agent", got ${JSON.stringify(raw.createdBy)}` }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return { ok: false, warning: `${label}: enabled must be a boolean` }
  }
  if (raw.lastRunISO != null && (typeof raw.lastRunISO !== 'string' || !Number.isFinite(Date.parse(raw.lastRunISO)))) {
    return { ok: false, warning: `${label}: lastRunISO must be null or a parseable ISO string` }
  }
  if (raw.kind === 'recurring') {
    if (!Number.isFinite(raw.everyMinutes)) return { ok: false, warning: `${label}: everyMinutes must be a number` }
    if (raw.window !== undefined && parseWindow(raw.window) === null) {
      return { ok: false, warning: `${label}: window must be "HH:MM-HH:MM"` }
    }
  } else {
    // once
    if (typeof raw.atISO !== 'string' || !Number.isFinite(Date.parse(raw.atISO))) {
      return { ok: false, warning: `${label}: atISO must be a parseable ISO string` }
    }
  }
  return {
    ok: true,
    entry: {
      id: raw.id,
      kind: raw.kind,
      enabled: raw.enabled !== false, // absent -> true; only explicit false disables
      prompt: raw.prompt,
      createdBy: raw.createdBy,
      lastRunISO: raw.lastRunISO || null,
      everyMinutes: raw.kind === 'recurring' ? raw.everyMinutes : undefined,
      window: raw.kind === 'recurring' ? (raw.window || null) : undefined,
      atISO: raw.kind === 'once' ? raw.atISO : undefined,
    },
  }
}

// Business rule: is a structurally-valid recurring entry due RIGHT NOW.
// Returns { due: true } or { due: false, reason }.
function recurringDue(now, entry) {
  if (entry.everyMinutes < MIN_EVERY_MINUTES) {
    return { due: false, reason: `everyMinutes below floor (${MIN_EVERY_MINUTES})` }
  }
  const w = parseWindow(entry.window) // re-validated shape already guaranteed by validateEntry
  if (!inWindow(now, w.start, w.end)) return { due: false, reason: 'outside window' }
  if (entry.lastRunISO) {
    const lastMs = Date.parse(entry.lastRunISO)
    // A missed window (app closed through it) does NOT back-fire: it is not
    // "overdue", it just waits for the NEXT window open. That fall-through is
    // free here -- inWindow() above already said no once "now" has moved past
    // the window close, so there is no separate catch-up branch to write.
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < entry.everyMinutes * 60 * 1000) {
      return { due: false, reason: 'interval not elapsed' }
    }
  }
  return { due: true }
}

// Business rule for "once": fires exactly once, the first tick where
// now >= atISO, and never again -- lastRunISO being non-null IS "already
// fired", there is no separate flag.
function onceDue(now, entry) {
  if (entry.lastRunISO) return { due: false, reason: 'already fired' }
  const atMs = Date.parse(entry.atISO)
  if (now.getTime() < atMs) return { due: false, reason: 'not yet time' }
  return { due: true }
}

// planScheduleTick({ now, config, store, agentActiveMs }) ->
//   { due: [entry...], warnings: [string...], skipped: [{id, reason}...] }
//
// now             Date, local time (window/day math needs getHours(), not
//                 just an epoch number)
// config          parsed .agent-config object, read fresh by the caller every
//                 poll -- same contract as autonomy/tick.cjs and note-tick.cjs
// store           parsed schedules.json ({ version, schedules: [...] }), or
//                 null/anything-not-that if the caller's JSON.parse failed --
//                 a malformed FILE is reported as one warning and nothing is
//                 due, same "skip, never throw" contract as a malformed entry
// agentActiveMs   ms since the last chat activity (the same activity signal
//                 note-tick.cjs uses -- lastActivityMs -- but the CALLER
//                 subtracts, because this module never reads a clock to
//                 derive "since" from "at")
function planScheduleTick({ now, config, store, agentActiveMs }) {
  // Global kill switch. "Nothing due" -- deliberately not enumerated per
  // entry into `skipped`: with the whole feature off, a full skip list every
  // 60s is noise, not a receipt anyone needs to read.
  if (schedulesOff(config)) {
    return { due: [], warnings: [], skipped: [] }
  }

  const warnings = []
  const skipped = []
  const due = []

  // store == null means the file does not exist -- nothing registered yet.
  // That is the NORMAL state of a fresh install, not a fault: warn-on-null
  // spammed the app log every 60s on every fresh 0.2.x DATA_HOME (measured
  // on Mino's box, 2026-08-19) until this was split. A store that EXISTS
  // but has the wrong shape is still a fault and still warns below.
  if (store == null) {
    return { due, warnings, skipped }
  }
  if (!Array.isArray(store.schedules)) {
    warnings.push('schedules.json malformed (expected { schedules: [...] })')
    return { due, warnings, skipped }
  }

  const suppressed = Number.isFinite(agentActiveMs) && agentActiveMs < ACTIVITY_SUPPRESS_MS

  store.schedules.forEach((raw, idx) => {
    const v = validateEntry(raw, idx)
    if (!v.ok) {
      warnings.push(v.warning)
      return
    }
    const entry = v.entry

    if (!entry.enabled) {
      skipped.push({ id: entry.id, reason: 'disabled' })
      return
    }

    // Consent gate: agent-authored proactivity rides the SAME explicit,
    // separate consent as the autonomy cycle (autonomy/tick.cjs's
    // isConsented) -- never inherited, never laundered from a narrower flag.
    // user/system entries are exempt; the human (or the app's own shipped
    // defaults) already said yes by creating the entry.
    if (entry.createdBy === 'agent' && !isConsented(config)) {
      skipped.push({ id: entry.id, reason: 'agent-authored requires AUTONOMY=yes' })
      return
    }

    const verdict = entry.kind === 'recurring' ? recurringDue(now, entry) : onceDue(now, entry)
    if (!verdict.due) {
      skipped.push({ id: entry.id, reason: verdict.reason })
      return
    }

    // It IS due -- but not while the user is mid-conversation. Per design:
    // everything defers here, nothing is marked run. The entry is due again,
    // unchanged, on the next tick once the conversation goes quiet -- a
    // recurring entry re-evaluates window/interval then; a "once" entry is
    // still simply "now >= atISO && lastRunISO == null" then, so it is not
    // lost, and it does not back-fire for having waited.
    if (suppressed) {
      skipped.push({ id: entry.id, reason: 'active session (suppressed)' })
      return
    }

    due.push(entry)
  })

  return { due, warnings, skipped }
}

// The one default schedule the app seeds (Dreaming feature, 2026-08-16).
// Single source of truth shared by BOTH seed sites: hooks/session-start.mjs
// (headless lane, Claude Code SessionStart hook) and channel-runtime's
// startScheduleTicker (dsh lane, where Claude Code hooks never run -- without
// the ticker-side seed the Dreaming default silently never existed on 0.2.x,
// found 2026-08-19 on Mino's box). Seeding is absence-only everywhere: once
// the file exists it belongs to the user/agent. createdBy MUST stay "agent"
// -- the consent gate above only lets agent-authored entries fire once
// AUTONOMY=yes; "system" would bypass that gate.
function defaultScheduleStore() {
  return {
    version: 1,
    schedules: [
      {
        id: 'memory-consolidation',
        enabled: true,
        kind: 'recurring',
        everyMinutes: 1440,
        window: '03:00-06:00',
        prompt: 'Read procedures/memory-consolidation.md and follow it.',
        createdBy: 'agent',
        lastRunISO: null,
      },
    ],
  }
}

module.exports = {
  planScheduleTick,
  defaultScheduleStore,
  MIN_EVERY_MINUTES,
  ACTIVITY_SUPPRESS_MS,
  parseHM,
  parseWindow,
  inWindow,
}
