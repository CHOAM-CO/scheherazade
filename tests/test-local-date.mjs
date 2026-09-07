// test-local-date.mjs -- local-date.cjs, the one local-day clock (P3 #5).
// Run: node tests/test-local-date.mjs
//
// Two promises: (1) the DEFAULT is unchanged Asia/Seoul, so this refactor is
// invisible to every existing install; (2) AGENT_TZ moves ALL of them at once
// -- the note filename, the journal day, the backoff reset -- because they now
// share one definition. The old bug was that they did not: memory keyed on the
// system zone while six other sites hardcoded KST, so off-KST the journal row
// and the session note of the same evening carried different dates.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_TZ, agentTimeZone, localDate, localDayKey, localTime, localStamp } from '../local-date.cjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// 2026-07-14 20:00 UTC == 2026-07-15 05:00 KST == 2026-07-14 13:00 New York.
// One instant, three calendar days: the whole point of the helper.
const T = Date.UTC(2026, 6, 14, 20, 0, 0)

console.log('\n-- default zone: unchanged Asia/Seoul')
{
  ok('DEFAULT_TZ is Asia/Seoul', DEFAULT_TZ === 'Asia/Seoul')
  ok('no AGENT_TZ -> Asia/Seoul', agentTimeZone({}) === 'Asia/Seoul')
  ok('empty AGENT_TZ -> Asia/Seoul', agentTimeZone({ AGENT_TZ: '   ' }) === 'Asia/Seoul')
  ok('the KST day of 20:00Z is the NEXT day (what every hardcoded site produced)',
    localDate(T, {}) === '2026-07-15', localDate(T, {}))
  ok('shape is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(localDate(Date.now(), {})))
}

console.log('\n-- AGENT_TZ moves the day boundary')
{
  ok('UTC', localDate(T, { AGENT_TZ: 'UTC' }) === '2026-07-14', localDate(T, { AGENT_TZ: 'UTC' }))
  ok('America/New_York', localDate(T, { AGENT_TZ: 'America/New_York' }) === '2026-07-14')
  ok('Pacific/Kiritimati (UTC+14) is already the 15th',
    localDate(T, { AGENT_TZ: 'Pacific/Kiritimati' }) === '2026-07-15')
  ok('agentTimeZone reports the configured zone', agentTimeZone({ AGENT_TZ: 'UTC' }) === 'UTC')
}

console.log('\n-- an unusable AGENT_TZ falls back instead of throwing')
{
  // A date helper must never be the reason a Stop hook exits non-zero.
  let threw = false
  let got = ''
  try { got = localDate(T, { AGENT_TZ: 'Mars/Olympus_Mons' }) } catch { threw = true }
  ok('a bogus zone does not throw', !threw)
  ok('a bogus zone falls back to the default day', got === '2026-07-15', got)
}

console.log('\n-- times and the log stamp')
{
  ok('localTime is 24h HH:MM', localTime(T, { env: { AGENT_TZ: 'UTC' } }) === '20:00', localTime(T, { env: { AGENT_TZ: 'UTC' } }))
  ok('seconds variant is HH:MM:SS',
    localTime(T, { seconds: true, env: { AGENT_TZ: 'UTC' } }) === '20:00:00',
    localTime(T, { seconds: true, env: { AGENT_TZ: 'UTC' } }))
  ok('midnight is 00:xx, never 24:xx (en-GB hour12:false trap)',
    localTime(Date.UTC(2026, 6, 14, 0, 5), { env: { AGENT_TZ: 'UTC' } }) === '00:05',
    localTime(Date.UTC(2026, 6, 14, 0, 5), { env: { AGENT_TZ: 'UTC' } }))
  ok('the stamp NAMES the zone (it used to say "KST" whatever the zone was)',
    localStamp(T, { AGENT_TZ: 'UTC' }) === '2026-07-14 20:00:00 UTC', localStamp(T, { AGENT_TZ: 'UTC' }))
}

console.log('\n-- localDayKey: the storage-side spelling, same boundary')
{
  ok('accepts a Date (memory/service.mjs localToday signature)',
    localDayKey(new Date(T), { AGENT_TZ: 'UTC' }) === '2026-07-14')
  ok('accepts ms', localDayKey(T, { AGENT_TZ: 'UTC' }) === '2026-07-14')
  ok('agrees with localDate for the same instant -- the DB day and the note',
    localDayKey(T, { AGENT_TZ: 'America/New_York' }) === localDate(T, { AGENT_TZ: 'America/New_York' }))
}

console.log('\n-- every former Asia/Seoul site now asks the helper')
{
  const files = [
    'channel.mjs', 'supervisor.mjs', 'memory/service.mjs',
    'hooks/session-start.mjs', 'scripts/journal-compress.mjs', 'scripts/madoromi-solo.mjs',
    'tests/test-hooks-port.mjs',
  ]
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    ok(`${f}: no hardcoded timeZone: 'Asia/Seoul'`, !/timeZone:\s*'Asia\/Seoul'/.test(src))
    ok(`${f}: imports local-date.cjs`, src.includes("local-date.cjs"))
  }
  const memSrc = fs.readFileSync(path.join(ROOT, 'memory', 'service.mjs'), 'utf8')
  ok("memory's local day IS the shared helper (not a second implementation)",
    memSrc.includes('const localToday = localDayKey'))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok('local-date.cjs ships (build.files)', pkg.build.files.includes('local-date.cjs'))
  ok('local-date.cjs is unpacked (hooks/scripts/supervisor run outside the asar)',
    pkg.build.asarUnpack.includes('local-date.cjs'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
