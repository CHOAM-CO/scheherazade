#!/usr/bin/env node
// test-daily-clock.mjs -- the once-a-day clock that feeds the "!" (0.3.5).
//
// cadence/daily-clock.cjs gives the reflux pass a daily clock inside the app
// and runs the madoromi turn on it regardless of autonomy mode. Three layers:
//  1. rule -- isDue / hasNew / dreamGate from fixed inputs, frozen clock.
//  2. IO   -- runDailyClock against a throwaway data home: a run with nothing
//     new writes no proposal (and no .review/ at all), the stamp survives a
//     "restart" (a fresh call reading the same file), a real 🔒 line becomes
//     exactly one PENDING block the "!" reader counts, and the dream turn
//     fires once, stands down under autonomy, and is not stamped on failure.
//  3. wiring pins -- it rides the existing Schedules ticker (no timer of its
//     own), both backends that run schedules pass the inject seam, the CLI
//     runs the same pass, and the new files carry no em dash.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(path.join(root, 'package.json')).href)

let passed = 0
let failed = 0
function assert(cond, msg, detail) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}${detail !== undefined ? ` -- ${detail}` : ''}`) }
}

const C = require(path.join(root, 'cadence', 'daily-clock.cjs'))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-daily-clock-'))
const home = (name) => { const d = path.join(tmpRoot, name); fs.mkdirSync(d, { recursive: true }); return d }
const write = (dir, rel, text, mtime) => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  if (mtime) fs.utimesSync(p, mtime, mtime)
}
const pendingCount = (dir) => {
  try {
    return (fs.readFileSync(path.join(dir, '.review', 'reflux-proposals.md'), 'utf8').match(/^\*\*Status\*\*: PENDING$/gm) || []).length
  } catch { return 0 }
}

// Frozen local clocks. 10:00 is outside the dream window, 15:00 inside it.
const MORNING = new Date(2026, 8, 29, 10, 0, 0)
const AFTERNOON = new Date(2026, 8, 29, 15, 0, 0)
const NEXT_AFTERNOON = new Date(2026, 8, 30, 15, 0, 0)
const PAST = new Date(2026, 8, 20, 12, 0, 0) // file mtimes before any run

try {
  console.log('1. due / not due (rule half, frozen clock)')
  assert(C.localDay(MORNING) === '2026-09-29', 'localDay is the local calendar date')
  assert(C.isDue(MORNING, undefined).due === true, 'no stamp -> due (fresh install)')
  assert(C.isDue(MORNING, { day: 'garbage-shape' }).due === true, 'a stamp from another day (or a torn one) -> due')
  assert(C.isDue(AFTERNOON, { day: '2026-09-29' }).due === false, 'stamped today -> not due, whatever the hour')
  assert(C.isDue(NEXT_AFTERNOON, { day: '2026-09-29' }).due === true, 'stamped yesterday -> due again today')
  assert(C.hasNew(0, undefined) === false, 'nothing on disk -> nothing new')
  assert(C.hasNew(1000, 1000) === false && C.hasNew(1001, 1000) === true, 'new only when strictly newer than what the last run saw')

  assert(C.dreamGate({ now: MORNING, config: {}, store: null, agentActiveMs: Infinity }).go === false,
    'dream gate: outside the madoromi window -> not now')
  assert(C.dreamGate({ now: MORNING, config: {}, store: null, agentActiveMs: Infinity }).stamp === false,
    '...and that is "ask again", not "done for today"')
  const active = C.dreamGate({ now: AFTERNOON, config: {}, store: null, agentActiveMs: 60_000 })
  assert(active.go === false && active.stamp === false, 'dream gate: user mid-conversation -> deferred, not lost')
  assert(C.dreamGate({ now: AFTERNOON, config: {}, store: null, agentActiveMs: Infinity }).go === true,
    'dream gate: in window, quiet, autonomy OFF -> go (the point of this feature)')
  const madoromiStore = { schedules: [{ id: 'madoromi', enabled: true }] }
  const owned = C.dreamGate({ now: AFTERNOON, config: { AUTONOMY: 'yes' }, store: madoromiStore, agentActiveMs: Infinity })
  assert(owned.go === false && owned.stamp === true, 'autonomy on + madoromi entry enabled -> the schedule dreams, the clock stands down for the day')
  assert(C.dreamGate({ now: AFTERNOON, config: { AUTONOMY: 'yes' }, store: { schedules: [{ id: 'madoromi', enabled: false }] }, agentActiveMs: Infinity }).go === true,
    'autonomy on but the madoromi entry disabled -> the clock still dreams')
  const content = C.dreamInjectContent()
  assert(content.startsWith('[SCHEDULED TASK]') && !content.includes('user-authored') && !content.includes('[SYSTEM]') && content.includes('madoromi'),
    'the dream turn is a scheduled task, labeled as the app\'s, never as SYSTEM or user-authored', content)

  console.log('\n2. a run with nothing new writes no proposal')
  {
    const dir = home('empty')
    const r = await C.runDailyClock({ dataHome: dir, now: MORNING, config: {}, fire: async () => { throw new Error('must not fire') } })
    assert(r.reflux.ran === false && r.reflux.reason === 'nothing new', 'fresh home: reflux skipped as nothing new', JSON.stringify(r))
    assert(!fs.existsSync(path.join(dir, '.review')), 'fresh home: no .review/ created, no proposals file, no header')
    assert(pendingCount(dir) === 0, 'the "!" reader would count 0 reflux proposals')
    const stamp = JSON.parse(fs.readFileSync(C.stampPath(dir), 'utf8'))
    assert(stamp.reflux && stamp.reflux.day === '2026-09-29', 'the skip is stamped for the day, so later ticks are one small read')
  }
  {
    // Notes exist and changed, but carry no 🔒 line: the pass runs and
    // still writes nothing under .review/.
    const dir = home('no-locks')
    write(dir, 'session_notes/2026-09-28.md', '- ordinary note, no correction here\n', PAST)
    const r = await C.runDailyClock({ dataHome: dir, now: MORNING, config: {} })
    assert(r.reflux.ran === true && r.reflux.added === 0, 'changed notes without a 🔒 line: the pass runs and adds 0', JSON.stringify(r))
    assert(!fs.existsSync(path.join(dir, '.review')), '...and still creates no .review/ (lazy: files only appear with a proposal)')
  }

  console.log('\n3. a real correction, the restart, and the next day')
  {
    const dir = home('locks')
    write(dir, 'session_notes/2026-09-28.md', 'prose that mentions 🔒 in passing\n- 🔒 stop opening with a summary\n', PAST)
    const r1 = await C.runDailyClock({ dataHome: dir, now: MORNING, config: {} })
    assert(r1.reflux.ran === true && r1.reflux.added === 1, 'one line-lead 🔒 -> one proposal (mid-line mention ignored)', JSON.stringify(r1))
    assert(pendingCount(dir) === 1, 'the proposals file holds exactly one PENDING block')

    // "Restart": a fresh call, same data home, same day. Nothing re-runs.
    const r2 = await C.runDailyClock({ dataHome: dir, now: AFTERNOON, config: {}, agentActiveMs: 0 })
    assert(r2.reflux.ran === false && r2.reflux.reason === 'already ran today', 'same day after a restart: the stamp on disk says done', JSON.stringify(r2))

    // Next day, nothing touched: skipped as nothing new, and the file does
    // not grow.
    const r3 = await C.runDailyClock({ dataHome: dir, now: NEXT_AFTERNOON, config: {}, agentActiveMs: 0 })
    assert(r3.reflux.ran === false && r3.reflux.reason === 'nothing new', 'next day with no changed note: skipped', JSON.stringify(r3))
    assert(pendingCount(dir) === 1, '...and the pile is unchanged (no duplicate proposal)')

    // The CLI the agent runs by hand agrees with the clock: same seen file,
    // so it dedupes what the clock already proposed.
    const { spawnSync } = await import('node:child_process')
    const cli = spawnSync(process.execPath, [path.join(root, 'scripts', 'persona-reflux.mjs')], { env: { ...process.env, MEM: dir }, encoding: 'utf8' })
    assert(cli.status === 0 && cli.stderr.includes('0 new correction(s)'), 'the CLI dedupes against the clock\'s run (one rule, one seen file)', cli.stderr)
    assert(pendingCount(dir) === 1, '...and adds no second block')
  }

  console.log('\n4. the dream turn, regardless of autonomy')
  {
    const dir = home('dreams')
    write(dir, 'journals/2026-09-27.md', 'the harbor crane entry\n', PAST)
    const fired = []
    const fire = async (c) => { fired.push(c) }
    const m = await C.runDailyClock({ dataHome: dir, now: MORNING, config: {}, fire })
    assert(fired.length === 0 && m.dreams.reason === 'outside dream window', 'morning: no dream yet', JSON.stringify(m))
    const a = await C.runDailyClock({ dataHome: dir, now: AFTERNOON, config: {}, agentActiveMs: Infinity, fire })
    assert(fired.length === 1 && a.dreams.ran === true, 'afternoon, autonomy off: the madoromi turn fires once', JSON.stringify(a))
    await C.runDailyClock({ dataHome: dir, now: new Date(2026, 8, 29, 16, 0, 0), config: {}, agentActiveMs: Infinity, fire })
    assert(fired.length === 1, 'and not twice the same day')
    const n = await C.runDailyClock({ dataHome: dir, now: NEXT_AFTERNOON, config: {}, agentActiveMs: Infinity, fire })
    assert(fired.length === 1 && n.dreams.reason === 'nothing new', 'next day, no new journal: no model turn spent', JSON.stringify(n))
  }
  {
    const dir = home('dreams-owned')
    write(dir, 'journals/2026-09-27.md', 'entry\n', PAST)
    const fired = []
    const r = await C.runDailyClock({ dataHome: dir, now: AFTERNOON, config: { AUTONOMY: 'yes' }, store: { schedules: [{ id: 'madoromi', enabled: true }] }, fire: async (c) => { fired.push(c) } })
    assert(fired.length === 0 && r.dreams.reason === 'autonomy schedule dreams today', 'autonomy on: the existing schedule dreams, no double dream', JSON.stringify(r))
  }
  {
    const dir = home('dreams-fail')
    write(dir, 'journals/2026-09-27.md', 'entry\n', PAST)
    let attempts = 0
    const fire = async () => { attempts++; if (attempts === 1) throw new Error('lane down') }
    await C.runDailyClock({ dataHome: dir, now: AFTERNOON, config: {}, fire })
    const s = C.readStamp(dir)
    assert(!s.dreams || s.dreams.day !== '2026-09-29', 'an inject that did not land is not stamped', JSON.stringify(s))
    const r = await C.runDailyClock({ dataHome: dir, now: AFTERNOON, config: {}, fire })
    assert(attempts === 2 && r.dreams.ran === true, '...and the next tick retries and lands it')
  }
  {
    const dir = home('off')
    write(dir, 'session_notes/2026-09-28.md', '- 🔒 would be proposed\n', PAST)
    const r = await C.runDailyClock({ dataHome: dir, now: AFTERNOON, config: { SCHEDULES: 'off' }, fire: async () => { throw new Error('must not fire') } })
    assert(r.reflux.ran === false && r.dreams.ran === false && !fs.existsSync(path.join(dir, '.review')) && !fs.existsSync(C.stampPath(dir)),
      'SCHEDULES=off: the clock does nothing at all and writes nothing')
  }

  console.log('\n5. it rides the existing Schedules ticker')
  {
    const { startScheduleTicker } = await import(pathToFileURL(path.join(root, 'channel-runtime.mjs')).href)
    const dir = home('ticker')
    write(dir, 'session_notes/2026-09-28.md', '- 🔒 via the ticker\n', PAST)
    write(dir, 'journals/2026-09-27.md', 'entry\n', PAST)
    const daily = []
    const { timer, tick } = startScheduleTicker({
      dataHome: dir, readConfig: async () => ({}), fire: async () => {}, fireDaily: async (c) => { daily.push(c) },
      activityMsProvider: () => Infinity, log: () => {}, now: () => AFTERNOON,
    })
    clearInterval(timer)
    await tick()
    assert(pendingCount(dir) === 1, 'one Schedules tick ran the reflux pass')
    assert(daily.length === 1 && daily[0].includes('madoromi'), 'and delivered the dream turn through fireDaily with autonomy off', JSON.stringify(daily))
    await tick()
    assert(daily.length === 1 && pendingCount(dir) === 1, 'a second tick the same day does nothing')
  }

  console.log('\n6. wiring pins')
  {
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
    const clockSrc = read('cadence/daily-clock.cjs')
    assert(!/setInterval|setTimeout|node-cron/.test(clockSrc), 'the clock owns no timer primitive (it is called by the Schedules tick)')
    assert(/runDailyClock\(/.test(read('channel-runtime.mjs')), 'startScheduleTicker calls runDailyClock')
    for (const f of ['channel-local.mjs', 'channel.mjs']) {
      assert(/fireDaily:/.test(read(f)), `${f} passes the fireDaily inject seam to the Schedules ticker`)
    }
    assert(/require\('\.\.\/cadence\/reflux-pass\.cjs'\)/.test(read('scripts/persona-reflux.mjs')), 'the CLI runs the same pass module, not a copy')
    for (const f of ['cadence/daily-clock.cjs', 'cadence/reflux-pass.cjs', 'scripts/persona-reflux.mjs', 'tests/test-daily-clock.mjs']) {
      assert(!read(f).includes(String.fromCharCode(0x2014)), `${f} carries no em dash`)
    }
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
