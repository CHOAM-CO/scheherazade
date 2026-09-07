// local-date.cjs -- ONE local-day clock for the whole agent.
//
// design-0023 P3 deliverable 5. `Asia/Seoul` was hardcoded in seven places
// (channel.mjs's note cadence, hooks/session-start.mjs's note filename,
// scripts/journal-compress.mjs, scripts/madoromi-solo.mjs, supervisor.mjs's
// backoff reset + log stamp, run.sh's three `TZ=Asia/Seoul date` calls,
// tests/test-hooks-port.mjs) while memory/service.mjs keyed its journal days
// on the SYSTEM timezone. For anyone outside KST those two disagreed: the
// note file said one day, the journal row another, and the nightly cadence
// rolled over at neither midnight the user experiences. channel.mjs's own
// comment called it "a known port wrinkle... if that ever moves to system tz,
// move this with it in the same commit" -- this is that commit.
//
// AGENT_TZ picks the zone; the DEFAULT IS `Asia/Seoul`, so nothing about
// today's behavior changes for anyone who does not set it. An unusable
// AGENT_TZ falls back to the default and says so once on stderr rather than
// throwing inside a hook (a date helper must never be the reason a Stop hook
// exits non-zero).
//
// Plain CJS, dual-loadable: required from CJS, imported from ESM.

const DEFAULT_TZ = 'Asia/Seoul'

let cachedZone = null
let cachedFor = null
let warned = false

function agentTimeZone(env = process.env) {
  const raw = (env.AGENT_TZ || '').trim()
  if (!raw) return DEFAULT_TZ
  if (cachedFor === raw) return cachedZone
  cachedFor = raw
  try {
    // Throws RangeError on an unknown zone -- probe before anything depends on it.
    new Intl.DateTimeFormat('en-CA', { timeZone: raw }).format(new Date())
    cachedZone = raw
  } catch {
    if (!warned) {
      warned = true
      try { process.stderr.write(`[local-date] AGENT_TZ=${JSON.stringify(raw)} is not a usable IANA time zone -- falling back to ${DEFAULT_TZ}\n`) } catch {}
    }
    cachedZone = DEFAULT_TZ
  }
  return cachedZone
}

const fmtCache = new Map()
function formatter(kind, zone) {
  const key = `${kind}@${zone}`
  let f = fmtCache.get(key)
  if (f) return f
  if (kind === 'date') f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
  else if (kind === 'time') f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false })
  else f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  fmtCache.set(key, f)
  return f
}

function asDate(when) {
  if (when instanceof Date) return when
  if (typeof when === 'number') return new Date(when)
  return new Date()
}

// YYYY-MM-DD in the agent's zone. en-CA is ISO-shaped by locale, not by
// string surgery.
function localDate(when = Date.now(), env = process.env) {
  return formatter('date', agentTimeZone(env)).format(asDate(when))
}

// The same string, named for what it MEANS at the call sites that key storage
// on it (memory's journal day, the supervisor's backoff-reset day, the note
// filename). Accepts a Date like memory/service.mjs's old localToday did.
function localDayKey(when = new Date(), env = process.env) {
  return localDate(when, env)
}

// HH:MM (default) or HH:MM:SS in the agent's zone.
function localTime(when = Date.now(), { seconds = false, env = process.env } = {}) {
  return formatter(seconds ? 'timeSec' : 'time', agentTimeZone(env)).format(asDate(when))
}

// `YYYY-MM-DD HH:MM:SS <ZONE>` -- the supervisor's log stamp, which used to be
// `... KST` unconditionally (a lie the moment the zone is anything else).
function localStamp(when = Date.now(), env = process.env) {
  const zone = agentTimeZone(env)
  return `${localDate(when, env)} ${localTime(when, { seconds: true, env })} ${zone}`
}

module.exports = { DEFAULT_TZ, agentTimeZone, localDate, localDayKey, localTime, localStamp }
