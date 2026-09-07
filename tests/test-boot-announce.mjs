#!/usr/bin/env node
// test-boot-announce.mjs -- exercises cadence/boot-announce.cjs (the pure
// rule behind the boot ping). Run directly: node tests/test-boot-announce.mjs

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { planBootAnnounce, DEFAULT_THROTTLE_MIN } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cadence', 'boot-announce.cjs')
)

let failures = 0
function check(name, cond) {
  if (cond) { console.log(`ok   - ${name}`); return }
  failures += 1
  console.error(`FAIL - ${name}`)
}

const MIN = 60 * 1000
const T0 = 1_800_000_000_000

// -- marker gates (pre-existing behavior, now in the pure rule) -------------
check('no marker -> skip', planBootAnnounce({ now: T0, event: null }).skip === true)
check('malformed marker (no ts) -> skip', planBootAnnounce({ now: T0, event: { iteration: 1 } }).skip === true)
check('stale marker (11min) -> skip', planBootAnnounce({ now: T0, event: { ts: T0 - 11 * MIN, iteration: 1 } }).skip === true)

// -- the review finding: crash-loop frequency cap ---------------------------
{
  const first = planBootAnnounce({ now: T0, event: { ts: T0 - 5_000, iteration: 1 }, lastAnnounceMs: 0 })
  check('fresh marker + never announced -> announce', first.announce === true)
  check('nextLastAnnounceMs advances to now', first.nextLastAnnounceMs === T0)

  // Simulated crash loop reaching Discord login every ~2min (backoff caps at
  // 120s): every restart inside the throttle window must be suppressed.
  let last = first.nextLastAnnounceMs
  let announced = 0
  for (let i = 1; i <= 6; i++) {
    const t = T0 + i * 2 * MIN // 2min apart, 6 restarts = 12min span
    const p = planBootAnnounce({ now: t, event: { ts: t - 1_000, iteration: i + 1 }, lastAnnounceMs: last })
    if (p.announce) { announced += 1; last = p.nextLastAnnounceMs }
  }
  check(`crash loop (6 restarts / 12min) announces 0 extra within the ${DEFAULT_THROTTLE_MIN}min window`, announced === 0)

  const after = planBootAnnounce({ now: T0 + (DEFAULT_THROTTLE_MIN + 1) * MIN, event: { ts: T0 + (DEFAULT_THROTTLE_MIN + 1) * MIN - 1_000, iteration: 9 }, lastAnnounceMs: last })
  check('past the throttle window -> announces again (bounded, not silenced forever)', after.announce === true)
}

// -- labels ------------------------------------------------------------------
check('iteration 1 label = 기동', planBootAnnounce({ now: T0, event: { ts: T0, iteration: 1 } }).label === '기동')
check('iteration 3 label = 재기동 #3', planBootAnnounce({ now: T0, event: { ts: T0, iteration: 3 } }).label === '재기동 #3')
check('missing iteration defaults to 1', planBootAnnounce({ now: T0, event: { ts: T0 } }).iteration === 1)

// -- knobs -------------------------------------------------------------------
check('BOOT_PING=off -> skip even with fresh marker', planBootAnnounce({ now: T0, event: { ts: T0 }, config: { BOOT_PING: 'off' } }).skip === true)
{
  const tight = planBootAnnounce({ now: T0, event: { ts: T0 }, lastAnnounceMs: T0 - 6 * MIN, config: { BOOT_PING_THROTTLE_MIN: '5' } })
  check('BOOT_PING_THROTTLE_MIN=5 loosens the gap (6min since last -> announce)', tight.announce === true)
  const garbage = planBootAnnounce({ now: T0, event: { ts: T0 }, lastAnnounceMs: T0 - 6 * MIN, config: { BOOT_PING_THROTTLE_MIN: 'garbage' } })
  check('garbage knob falls back to default (6min since last -> throttled)', garbage.skip === true && garbage.reason === 'throttled')
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall checks passed')
