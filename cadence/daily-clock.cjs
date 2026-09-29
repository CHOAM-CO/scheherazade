'use strict'
// cadence/daily-clock.cjs -- the once-a-day clock that feeds the "!" (0.3.5).
//
// WHY. The pending signal (design-0024) counts three piles: corrections,
// reflux proposals, dream fragments. Until this file only the first ever
// grew: the reflux pass had no schedule at all (README documented a crontab
// line for the user to add), and madoromi only fired from its schedules.json
// entry, which is createdBy:'agent' and therefore skipped unless AUTONOMY=yes.
// The owner, 2026-09-29: give reflux a daily clock inside the app (not
// launchd; it must work on every install), and run the dream pass on that
// same clock regardless of autonomy mode, so the "!" reports what actually
// piled up.
//
// NOT A NEW TIMER LOOP. This rides the existing Schedules ticker
// (channel-runtime.mjs startScheduleTicker, 60 s): every tick calls
// runDailyClock once, after the schedules. The first thing it does is compare
// today's local date with the stamp, so on every tick but the first of the
// day it costs one small JSON read and returns.
//
// TWO JOBS, each at most once per local day, each with its own stamp half in
// DATA_HOME/.gates/daily-clock.json (survives restarts, so a relaunch does not
// re-run a job that already ran today):
//
//   reflux  -- cadence/reflux-pass.cjs in-process. No model call. Runs only
//              when a session note or journal changed since the last run;
//              otherwise it is skipped and nothing under .review/ is touched.
//   dreams  -- one injected turn asking the agent for its madoromi cycle (the
//              same prompt the madoromi schedule carries). Costs a model turn,
//              so it is gated harder: only inside the madoromi window, never
//              while the user is mid-conversation (deferred, not lost), and
//              only when a journal changed since the last dream run. When
//              AUTONOMY=yes and the madoromi schedule entry is enabled, that
//              entry already dreams daily, so the clock stands down for the
//              day instead of dreaming twice.
//
// SCHEDULES=off (the Schedules kill switch) turns this clock off too: it is
// background work, and the user who switched background work off meant it.
//
// The rule half (localDay, isDue, dreamGate, hasNew) takes `now` and plain
// objects and touches no clock and no fs; tests/test-daily-clock.mjs calls it
// directly. runDailyClock is the IO half and takes its fs, clock and inject
// from the caller.

const fs = require('node:fs')
const path = require('node:path')
const scheduleTick = require('./schedule-tick.cjs')
const refluxPass = require('./reflux-pass.cjs')

const STAMP_BASENAME = 'daily-clock.json'
// Same afternoon/evening window as the madoromi default entry: the post-dream
// first contact (procedures/madoromi.md ending) should land while the human
// is awake to receive it.
const DREAM_WINDOW = '13:00-21:00'
const DREAM_ID = 'madoromi'

function madoromiDefault() {
  return scheduleTick.defaultScheduleStore().schedules.find((e) => e.id === DREAM_ID)
}

// ── rule half: no clock, no fs ──────────────────────────────────────────────

function localDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// A job is due when it has not been decided yet today (local calendar day).
// "Decided" includes "skipped because nothing was new": the stamp records the
// day either way, which is what keeps the rest of the day's ticks free.
function isDue(now, part) {
  if (!part || typeof part.day !== 'string') return { due: true }
  if (part.day === localDay(now)) return { due: false, reason: 'already ran today' }
  return { due: true }
}

// Anything newer than what the last run saw? A missing or zero newest means
// there is nothing to read at all.
function hasNew(newestMs, seenMs) {
  if (!Number.isFinite(newestMs) || newestMs <= 0) return false
  return newestMs > (Number.isFinite(seenMs) ? seenMs : 0)
}

function autonomyOn(config) {
  return String((config && config.AUTONOMY) || '').toLowerCase() === 'yes'
}

function clockOff(config) {
  return String((config && config.SCHEDULES) || '').toLowerCase() === 'off'
}

// Is the schedules.json madoromi entry going to dream today on its own?
// Only when autonomy lets agent-authored entries fire AND the entry is there
// and enabled. A malformed store owns nothing.
function scheduleOwnsDream(config, store) {
  if (!autonomyOn(config)) return false
  if (!store || !Array.isArray(store.schedules)) return false
  return store.schedules.some((e) => e && e.id === DREAM_ID && e.enabled !== false)
}

// dreamGate -> { go: true } | { go: false, reason, stamp }
// stamp:true means "decided for today" (write the day); stamp:false means
// "not now, ask again next tick" (window closed, user mid-conversation).
function dreamGate({ now, config, store, agentActiveMs }) {
  if (scheduleOwnsDream(config, store)) {
    return { go: false, reason: 'autonomy schedule dreams today', stamp: true }
  }
  const w = scheduleTick.parseWindow(DREAM_WINDOW)
  if (!scheduleTick.inWindow(now, w.start, w.end)) {
    return { go: false, reason: 'outside dream window', stamp: false }
  }
  if (Number.isFinite(agentActiveMs) && agentActiveMs < scheduleTick.ACTIVITY_SUPPRESS_MS) {
    return { go: false, reason: 'active session (deferred)', stamp: false }
  }
  return { go: true }
}

// The turn the agent receives. Not [SYSTEM] (same reasoning as
// scheduleInjectContent: a background prompt must not claim authority), and
// not "(user-authored)" either, because the app wrote it.
function dreamInjectContent() {
  return `[SCHEDULED TASK] (app daily clock) "${DREAM_ID}": ${madoromiDefault().prompt}`
}

// ── IO half ─────────────────────────────────────────────────────────────────

function stampPath(dataHome) {
  return path.join(dataHome, '.gates', STAMP_BASENAME)
}

function readStamp(dataHome, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(stampPath(dataHome), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // Absent or torn: both jobs are due. Worst case is one extra cheap check,
    // never a swallowed day.
    return {}
  }
}

function writeStamp(dataHome, stamp, fsImpl = fs) {
  const p = stampPath(dataHome)
  fsImpl.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  fsImpl.writeFileSync(tmp, JSON.stringify(stamp, null, 2) + '\n')
  fsImpl.renameSync(tmp, p)
}

// Newest mtime among the .md files directly inside the given dirs, 0 if none.
function newestMtimeMs(dirs, fsImpl = fs) {
  let newest = 0
  for (const dir of dirs) {
    let names
    try { names = fsImpl.readdirSync(dir) } catch { continue }
    for (const f of names) {
      if (!f.endsWith('.md')) continue
      try {
        const st = fsImpl.statSync(path.join(dir, f))
        if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs
      } catch { /* vanished between readdir and stat */ }
    }
  }
  return newest
}

// runDailyClock -> { reflux: {...}, dreams: {...} } (a receipt; tests read it)
//
// dataHome        the agent's memory home (same root the reflux CLI calls MEM)
// now             Date
// config          parsed .agent-config, read fresh by the caller
// store           parsed schedules.json or null (only used to see whether the
//                 autonomy madoromi entry owns today's dream)
// agentActiveMs   ms since the last chat activity
// fire(content)   inject one turn into the agent; throws when not delivered
async function runDailyClock({ dataHome, now, config, store = null, agentActiveMs = Infinity, fire, log = () => {}, fsImpl = fs }) {
  const out = { reflux: { ran: false }, dreams: { ran: false } }
  if (clockOff(config)) {
    out.reflux.reason = out.dreams.reason = 'SCHEDULES=off'
    return out
  }

  const stamp = readStamp(dataHome, fsImpl)
  const today = localDay(now)
  const refluxDue = isDue(now, stamp.reflux)
  const dreamsDue = isDue(now, stamp.dreams)
  if (!refluxDue.due && !dreamsDue.due) {
    out.reflux.reason = refluxDue.reason
    out.dreams.reason = dreamsDue.reason
    return out
  }

  let dirty = false

  // reflux: file-only, runs at the first tick of the day.
  if (refluxDue.due) {
    const prev = stamp.reflux || {}
    const newest = newestMtimeMs([path.join(dataHome, 'session_notes'), path.join(dataHome, 'journals')], fsImpl)
    if (!hasNew(newest, prev.seenMs)) {
      out.reflux.reason = 'nothing new'
      stamp.reflux = { ...prev, day: today }
    } else {
      try {
        const r = refluxPass.runRefluxPass({ mem: dataHome, lazy: true })
        out.reflux = { ran: true, added: r.added }
        stamp.reflux = { day: today, seenMs: newest, lastRunISO: now.toISOString(), added: r.added }
        log(`daily clock: reflux pass added ${r.added} proposal(s)`)
      } catch (err) {
        // Not stamped: the next tick tries again. A broken pass must not
        // mark the day done.
        out.reflux.reason = `failed: ${err.message}`
        log(`daily clock: reflux pass failed (will retry next tick): ${err.message}`)
      }
    }
    if (stamp.reflux && stamp.reflux.day === today) dirty = true
  } else {
    out.reflux.reason = refluxDue.reason
  }

  // dreams: one model turn, gated by window / activity / autonomy ownership.
  if (dreamsDue.due) {
    const prev = stamp.dreams || {}
    const gate = dreamGate({ now, config, store, agentActiveMs })
    if (!gate.go) {
      out.dreams.reason = gate.reason
      if (gate.stamp) { stamp.dreams = { ...prev, day: today }; dirty = true }
    } else {
      const newest = newestMtimeMs([path.join(dataHome, 'journals')], fsImpl)
      if (!hasNew(newest, prev.seenMs)) {
        out.dreams.reason = 'nothing new'
        stamp.dreams = { ...prev, day: today }
        dirty = true
      } else if (typeof fire !== 'function') {
        out.dreams.reason = 'no inject seam on this backend'
      } else {
        try {
          await fire(dreamInjectContent())
          out.dreams = { ran: true }
          stamp.dreams = { day: today, seenMs: newest, lastRunISO: now.toISOString() }
          dirty = true
          log('daily clock: madoromi turn injected')
        } catch (err) {
          out.dreams.reason = `inject failed: ${err.message}`
          log(`daily clock: madoromi inject failed (will retry next tick): ${err.message}`)
        }
      }
    }
  } else {
    out.dreams.reason = dreamsDue.reason
  }

  if (dirty) {
    try {
      writeStamp(dataHome, stamp, fsImpl)
    } catch (err) {
      log(`daily clock: stamp write failed (jobs may re-check next tick): ${err.message}`)
    }
  }
  return out
}

module.exports = {
  runDailyClock,
  localDay,
  isDue,
  hasNew,
  dreamGate,
  scheduleOwnsDream,
  dreamInjectContent,
  readStamp,
  stampPath,
  newestMtimeMs,
  DREAM_WINDOW,
  STAMP_BASENAME,
}
