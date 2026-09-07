'use strict'
// cadence/boot-announce.cjs -- pure decision for the boot ping (v0.0.16
// review fix, the reviewer 07-16 13:24 verdict on cf39447: the original
// announceBoot had only {marker exists + 10min staleness} as guards, which
// caps NOTHING in a crash loop that reaches Discord login each time --
// backoff tops out at 120s, so a bad-provider-key loop could ping up to
// ~30x/hour. Discord login in channel.mjs is independent of provider auth,
// so "quick deaths never reach ClientReady" was an unverified assumption.)
//
// The fix is a persistent frequency throttle, SEPARATE from the
// consume-on-read boot-event marker: the marker prevents double-announce
// within one leaf's life; the throttle remembers "I announced recently"
// ACROSS restarts. channel.mjs owns the IO (marker read/unlink, ts file,
// sends); this file owns the rule; tests/test-boot-announce.mjs calls it.

const DEFAULT_MAX_AGE_MIN = 10 // marker older than this = leftover from a dead spawn
const DEFAULT_THROTTLE_MIN = 15 // min gap between announces (review rec 10~15, conservative end)

function intKnob(raw, fallback) {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Inputs (injected, no clock/fs here):
//   now            ms epoch
//   event          parsed .boot-event.json ({ts, iteration, ...}) or null
//   lastAnnounceMs when we last announced, from the persistent ts file (0 = never)
//   config         parsed .agent-config (BOOT_PING=off disables;
//                  BOOT_PING_THROTTLE_MIN overrides the gap)
// Returns { skip: true, reason } or
//         { announce: true, iteration, label, nextLastAnnounceMs }.
function planBootAnnounce({ now, event, lastAnnounceMs = 0, config = {} }) {
  if (String(config.BOOT_PING || '').toLowerCase() === 'off') {
    return { skip: true, reason: 'disabled' }
  }
  if (!event || typeof event.ts !== 'number') {
    return { skip: true, reason: 'no or malformed marker' }
  }
  if (now - event.ts > DEFAULT_MAX_AGE_MIN * 60 * 1000) {
    return { skip: true, reason: 'stale marker' }
  }
  const throttleMs = intKnob(config.BOOT_PING_THROTTLE_MIN, DEFAULT_THROTTLE_MIN) * 60 * 1000
  if (now - lastAnnounceMs < throttleMs) {
    return { skip: true, reason: 'throttled' }
  }
  const iteration = Number.isFinite(event.iteration) ? event.iteration : 1
  return {
    announce: true,
    iteration,
    label: iteration > 1 ? `재기동 #${iteration}` : '기동',
    nextLastAnnounceMs: now,
  }
}

module.exports = { planBootAnnounce, DEFAULT_MAX_AGE_MIN, DEFAULT_THROTTLE_MIN }
