// test-autonomy-night.mjs -- run a whole night.
// Run: node scripts/test-autonomy-night.mjs
//
// Everything else about this feature has been tested in pieces: the decision
// logic with a mocked meter, the meter with a mocked clock, the HTTP surface
// with neither. None of that is the same as watching a night actually happen.
//
// Twice tonight I shipped something that was only ever reasoned about: a
// calendar design that turned out to take 50 seconds, and a code comment
// asserting that consent withdrawal took effect within the minute (it did not).
// Both survived every check I ran, because I never ran the thing itself.
//
// So this drives the REAL decision function against a REAL state file on disk
// and a REAL token meter reading a REAL transcript, minute by minute across a
// simulated night, with a fake clock as the only mock. The agent's spending is
// simulated by appending usage rows to the transcript, the way the CLI does.
//
// What it can catch that the unit tests cannot: state round-tripping through
// JSON, the day-key surviving midnight, the meter and the decision disagreeing,
// the brief never arriving, the cycle firing twice.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-night-'))
const PROJECTS = path.join(scratch, 'projects')
const DATA_HOME = path.join(scratch, 'Scheherazade')
fs.mkdirSync(PROJECTS, { recursive: true })
fs.mkdirSync(DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_PROJECTS_ROOT = PROJECTS

const budget = require(path.join(HERE, '..', 'autonomy', 'budget.cjs'))
const cycle = require(path.join(HERE, '..', 'autonomy', 'cycle.cjs'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── the world ───────────────────────────────────────────────────────────────
const STATE_PATH = path.join(DATA_HOME, '.autonomy-state.json')
const TRANSCRIPT = path.join(PROJECTS, budget.slugForCwd(DATA_HOME), 'session.jsonl')
fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true })
fs.writeFileSync(TRANSCRIPT, '')

// The agent spends tokens. This is what that looks like on disk.
function agentSpends(at, tokens) {
  const row = JSON.stringify({
    type: 'assistant',
    cwd: DATA_HOME,
    timestamp: at.toISOString(),
    message: { usage: { input_tokens: 0, output_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  })
  fs.appendFileSync(TRANSCRIPT, row + '\n')
  fs.utimesSync(TRANSCRIPT, at, at)
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch { return null }
}
function writeState(s) {
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, STATE_PATH)
}

// One turn of the watcher, exactly as channel.mjs runs it -- including the
// persist-order rule (START writes before it "sends", STOP/BRIEF after).
const CONFIG = { AUTONOMY: 'yes', AUTONOMY_WINDOW_START: '23:00', AUTONOMY_WINDOW_END: '05:00', AUTONOMY_TOKEN_CAP: '1000' }
const delivered = []

function tick(now, config = CONFIG) {
  budget.resetCache() // a fresh poll may be a fresh process; never rely on warm cache for correctness
  const cap = Number(config.AUTONOMY_TOKEN_CAP)
  const decision = cycle.decideAutonomy({
    now,
    config,
    state: readState(),
    readBudget: (sinceMs) => budget.budgetState(DATA_HOME, cap, now, sinceMs),
  })
  if (decision.action === 'none') {
    if (decision.nextState) writeState(decision.nextState)
    return decision
  }
  const text = cycle.injectFor(decision)
  const persistFirst = decision.action === 'start'
  if (persistFirst) writeState(decision.nextState)
  delivered.push({ at: now.toISOString(), action: decision.action, text })
  if (!persistFirst) writeState(decision.nextState)
  return decision
}

const T = (d, h, m) => new Date(2026, 6, d, h, m, 0)

// ── the night ───────────────────────────────────────────────────────────────
console.log('\n-- 22:30, before the window: nothing happens')
{
  const d = tick(T(13, 22, 30))
  ok('no cycle before the window opens', d.action === 'none', d.reason)
  ok('nothing was delivered', delivered.length === 0)
}

console.log('\n-- 23:00, the window opens')
{
  const d = tick(T(13, 23, 0))
  ok('the cycle starts', d.action === 'start', d.reason)
  ok('the agent is shown the gauge', /1,000/.test(delivered[0].text))
  ok('and told it may stop early', /멈춰도 된다/.test(delivered[0].text))
  ok('the night was recorded BEFORE the message went out', readState().cycleDay === '2026-07-13')
}

console.log('\n-- 23:01-23:59, the agent works. It must not be started twice.')
{
  agentSpends(T(13, 23, 20), 300)
  const a = tick(T(13, 23, 30))
  ok('a second poll does not start a second cycle', a.action === 'none', a.reason)
  ok('the meter sees the spend', a.budget && a.budget.used === 300, JSON.stringify(a.budget))
  ok('and it may keep going', a.budget.mayRun === true)
}

console.log('\n-- 00:30, PAST MIDNIGHT. The calendar day changed. The night did not.')
{
  agentSpends(T(14, 0, 10), 300)
  const d = tick(T(14, 0, 30))
  ok('still inside the same night', d.action === 'none', d.reason)
  // THE bug that shipped in the first version: a calendar-day meter would have
  // reset here and handed the agent a second full budget.
  ok('the night REMEMBERS what it spent before midnight (600, not 300)',
    d.budget.used === 600, JSON.stringify(d.budget))
  ok('remaining is measured against the night, not the day', d.budget.remaining === 400)
  ok('one cycle, still', readState().cycleDay === '2026-07-13')
}

console.log('\n-- 01:00, the agent crosses the cap')
{
  agentSpends(T(14, 0, 50), 500) // 1100 total, cap is 1000
  const d = tick(T(14, 1, 0))
  ok('it is told to STOP', d.action === 'stop', d.reason)
  ok('the stop notice carries the real numbers', /1,100/.test(delivered.at(-1).text), delivered.at(-1).text.slice(0, 80))
  ok('the stop is silent to Discord (nobody is woken at 01:00)', /답장하지 마/.test(delivered.at(-1).text))
  ok('and it is told this is a ceiling, not a failure', /네 실패가 아니라/.test(delivered.at(-1).text))

  const again = tick(T(14, 1, 30))
  ok('it is only told once', again.action === 'none', again.reason)
}

console.log('\n-- 05:00, the window closes. The debt comes due.')
{
  const d = tick(T(14, 5, 0))
  ok('the brief is delivered', d.action === 'brief', d.reason)
  const brief = delivered.at(-1).text
  ok('the brief carries the token count -- the cost cannot be quietly omitted', /1,100/.test(brief))
  ok('the brief is NOT silent (stop-reply-guard will force it to land)', !/답장하지 마/.test(brief))
  ok('it is asked what it chose NOT to do, not just what it did', /안 했고 왜/.test(brief))

  const again = tick(T(14, 7, 0))
  ok('the brief is delivered once, not every poll', again.action === 'none', again.reason)
}

console.log('\n-- the next night is a NEW night')
{
  const d = tick(T(14, 23, 0))
  ok('a fresh cycle starts', d.action === 'start', d.reason)
  ok('with a fresh budget -- last night is not on tonight\'s bill', d.budget.used === 0, JSON.stringify(d.budget))
  ok('and a new day key', readState().cycleDay === '2026-07-14')
}

console.log('\n-- consent withdrawn mid-night: it must SPEAK, not fall silent')
{
  agentSpends(T(14, 23, 30), 200)
  const off = { ...CONFIG, AUTONOMY: 'no' }
  const d = tick(T(14, 23, 40), off)
  ok('the running agent is told to stop', d.action === 'stop', d.reason)
  ok('...on the grounds of the withdrawal itself', /consent withdrawn/.test(d.reason))

  const b = tick(T(14, 23, 45), off)
  ok('the night that already spent money still owes its accounting', b.action === 'brief', b.reason)
  ok('and the brief reports what that night cost', /200/.test(delivered.at(-1).text))

  const q = tick(T(14, 23, 50), off)
  ok('once stopped and briefed, it finally goes quiet', q.action === 'none', q.reason)
}

console.log('\n-- the app was CLOSED at dawn. The brief never went out.')
{
  // The ordinary case, not an exotic one: the user quits before morning. The
  // watcher is not running at 05:00, so no brief is delivered -- and the debt is
  // keyed by cycleDay, which the next window opening used to overwrite. The night
  // was then buried: the user never learned what it cost.
  writeState({ cycleDay: '2026-07-15', cycleStartedAt: T(15, 23, 0).toISOString(), stoppedDay: null, briefDay: null, lastSkip: null })
  agentSpends(T(16, 1, 0), 400) // it worked through the night unwatched

  const d = tick(T(16, 23, 5)) // next evening, window open again
  ok('the buried night is paid before tonight starts', d.action === 'brief', d.reason)
  ok('...and it is billed to the night that spent it (400)', d.budget.used === 400, JSON.stringify(d.budget))
  ok('tonight has not been started yet', readState().cycleDay === '2026-07-15')

  const n = tick(T(16, 23, 6)) // one minute later
  ok('now tonight begins', n.action === 'start', n.reason)
  ok('with its own budget, not the buried night\'s', n.budget.used === 0, JSON.stringify(n.budget))
}

console.log('\n-- the whole night, as delivered')
for (const d of delivered) console.log(`     ${d.at.slice(5, 16)}  ${d.action}`)

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
