// test-budget.mjs -- attacks on the autonomous cycle's token meter.
// Run: node scripts/test-budget.mjs
//
// These are not "does it add up" tests. The meter guards someone's money while
// they sleep, so the tests are written as attacks on the ONE property that
// matters: can this thing ever say "go ahead and spend" when it does not
// actually know what was spent.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-budget-'))
const PROJECTS = path.join(scratch, 'projects')
const DATA_HOME = path.join(scratch, 'Scheherazade')
fs.mkdirSync(PROJECTS, { recursive: true })
fs.mkdirSync(DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_PROJECTS_ROOT = PROJECTS

const budget = require(path.join(HERE, '..', 'autonomy', 'budget.cjs'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${expected}, got ${actual}`)
}

const NOW = new Date(2026, 6, 13, 23, 30, 0) // 2026-07-13 23:30 LOCAL
const YESTERDAY = new Date(2026, 6, 12, 23, 30, 0)

function usageRow(ts, { input = 0, output = 0, cacheCreate = 0, cacheRead = 0 } = {}, cwd = DATA_HOME) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp: ts.toISOString(),
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  })
}

function writeTranscript(dir, name, lines, mtime = NOW) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  fs.utimesSync(file, mtime, mtime)
  return file
}

console.log('\n-- slug transform (checked against a real observed slug)')
eq('slugForCwd matches the CLI\'s own scheme',
  budget.slugForCwd('/Users/narr/Desktop/MAGI'), '-Users-narr-Desktop-MAGI')
eq('slug replaces dots too', budget.slugForCwd('/a/b.c'), '-a-b-c')

console.log('\n-- resolveTranscriptDir: it must never invent a directory')
{
  const r = budget.resolveTranscriptDir(DATA_HOME)
  ok('missing transcript dir FAILS LOUD (does not return an empty dir)', r.ok === false, JSON.stringify(r))
  ok('failure carries a reason a human can act on', typeof r.reason === 'string' && r.reason.length > 20)
}

const slugDir = path.join(PROJECTS, budget.slugForCwd(DATA_HOME))

{
  // A directory that exists but whose rows belong to a DIFFERENT cwd must not
  // be accepted just because the slug matched -- that would meter someone
  // else's session against this user's cap.
  writeTranscript(slugDir, 'wrong-cwd.jsonl', [usageRow(NOW, { output: 999 }, '/some/other/place')])
  const r = budget.resolveTranscriptDir(DATA_HOME)
  ok('slug dir whose rows claim another cwd is REJECTED', r.ok === false || r.via !== 'slug', JSON.stringify(r))
}

{
  writeTranscript(slugDir, 'a.jsonl', [usageRow(NOW, { output: 10 })])
  const r = budget.resolveTranscriptDir(DATA_HOME)
  ok('dir is accepted once a row actually claims our cwd', r.ok === true && r.dir === slugDir, JSON.stringify(r))
}

{
  // If the CLI ever changes its slug scheme, the meter must still find the
  // transcripts by content rather than silently metering zero.
  const oddDir = path.join(PROJECTS, 'some-future-scheme-abc123')
  writeTranscript(oddDir, 'b.jsonl', [usageRow(NOW, { output: 7 }, path.join(scratch, 'Other'))])
  const otherHome = path.join(scratch, 'Other')
  fs.mkdirSync(otherHome, { recursive: true })
  const r = budget.resolveTranscriptDir(otherHome)
  ok('unknown slug scheme is found by SCANNING row cwd', r.ok === true && r.via === 'scan', JSON.stringify(r))
}

console.log('\n-- usageForDay: sums, and what it refuses to count')
{
  writeTranscript(slugDir, 'a.jsonl', [
    usageRow(NOW, { input: 100, output: 50, cacheCreate: 20, cacheRead: 1000 }),
    usageRow(NOW, { input: 5, output: 5 }),
  ])
  const u = budget.usageForDay(DATA_HOME, NOW)
  ok('measures', u.ok === true, JSON.stringify(u))
  eq('input summed', u.input, 105)
  eq('output summed', u.output, 55)
  eq('cache-create summed', u.cacheCreate, 20)
  eq('cache-read summed (counted, not hidden)', u.cacheRead, 1000)
  eq('total is the sum of all four', u.total, 1180)
  eq('row count surfaced', u.rows, 2)
}

{
  // Yesterday's rows in TODAY's file must not count -- an agent that ran all
  // night would otherwise start the new day already over cap.
  writeTranscript(slugDir, 'a.jsonl', [
    usageRow(YESTERDAY, { output: 500000 }),
    usageRow(NOW, { output: 42 }),
  ])
  const u = budget.usageForDay(DATA_HOME, NOW)
  eq('yesterday\'s rows are excluded by local day', u.total, 42)
}

{
  // A 23:30 LOCAL timestamp is still today even though it is tomorrow in UTC.
  const lateLocal = new Date(2026, 6, 13, 23, 59, 30)
  writeTranscript(slugDir, 'a.jsonl', [usageRow(lateLocal, { output: 9 })])
  const u = budget.usageForDay(DATA_HOME, NOW)
  eq('local day, not UTC day', u.total, 9)
}

{
  writeTranscript(slugDir, 'a.jsonl', [
    '{ this is not json',
    usageRow(NOW, { output: 3 }),
    JSON.stringify({ type: 'assistant', cwd: DATA_HOME, timestamp: 'not-a-date', message: { usage: { output_tokens: 999 } } }),
    JSON.stringify({ type: 'user', cwd: DATA_HOME, timestamp: NOW.toISOString(), message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', cwd: DATA_HOME, timestamp: NOW.toISOString(), message: { usage: { output_tokens: -50, input_tokens: NaN } } }),
  ])
  const u = budget.usageForDay(DATA_HOME, NOW)
  ok('corrupt / dateless / usageless / negative rows are skipped, not guessed', u.ok === true && u.total === 3, JSON.stringify(u))
}

{
  // A file untouched since before today is not opened at all.
  writeTranscript(slugDir, 'a.jsonl', [usageRow(NOW, { output: 11 })])
  writeTranscript(slugDir, 'old.jsonl', [usageRow(NOW, { output: 777 })], YESTERDAY)
  const u = budget.usageForDay(DATA_HOME, NOW)
  eq('stale-mtime transcripts are skipped', u.total, 11)
  eq('only one file actually contributed rows', u.filesCounted, 1)
}

console.log('\n-- the cwd filter: a foreign row in our directory is not our spend')
{
  // wrong-cwd.jsonl (999 output tokens, cwd=/some/other/place) has been sitting
  // in slugDir since the resolve tests. It must not be on this user's bill.
  writeTranscript(slugDir, 'a.jsonl', [usageRow(NOW, { output: 11 })])
  const u = budget.usageForDay(DATA_HOME, NOW)
  eq('row claiming a DIFFERENT cwd is excluded', u.total, 11)

  // ...but a row with NO cwd claim is COUNTED. Excluding it could hide real
  // spend; counting it can only overcount, and overcounting spends less.
  writeTranscript(slugDir, 'nocwd.jsonl', [
    JSON.stringify({
      type: 'assistant',
      timestamp: NOW.toISOString(),
      message: { usage: { output_tokens: 4 } },
    }),
  ])
  const u2 = budget.usageForDay(DATA_HOME, NOW)
  eq('row with no cwd claim is counted (doubt spends less)', u2.total, 15)
  fs.rmSync(path.join(slugDir, 'nocwd.jsonl'))
}

console.log('\n-- incremental reader: the meter is polled every minute, forever')
{
  budget.resetCache()
  const f = path.join(slugDir, 'incr.jsonl')
  fs.rmSync(path.join(slugDir, 'a.jsonl'), { force: true })
  fs.rmSync(path.join(slugDir, 'wrong-cwd.jsonl'), { force: true })
  writeTranscript(slugDir, 'incr.jsonl', [usageRow(NOW, { output: 10 })])

  const a = budget.usageForDay(DATA_HOME, NOW)
  eq('first poll counts', a.total, 10)

  const b = budget.usageForDay(DATA_HOME, NOW)
  const c = budget.usageForDay(DATA_HOME, NOW)
  ok('polling again does NOT double-count (offset advanced, not re-summed)',
    b.total === 10 && c.total === 10, `${b.total} / ${c.total}`)

  fs.appendFileSync(f, usageRow(NOW, { output: 5 }) + '\n')
  fs.utimesSync(f, NOW, NOW)
  const d = budget.usageForDay(DATA_HOME, NOW)
  eq('an appended row is picked up', d.total, 15)

  // A row still mid-write (no trailing newline) must be left alone, not
  // half-parsed -- and must be counted once it completes.
  const partial = usageRow(NOW, { output: 100 })
  fs.appendFileSync(f, partial.slice(0, 20))
  fs.utimesSync(f, NOW, NOW)
  const e = budget.usageForDay(DATA_HOME, NOW)
  eq('a half-written row is not counted yet', e.total, 15)
  fs.appendFileSync(f, partial.slice(20) + '\n')
  fs.utimesSync(f, NOW, NOW)
  const g = budget.usageForDay(DATA_HOME, NOW)
  eq('...and is counted exactly once when it lands', g.total, 115)

  // Truncation / rotation: the cached offset now points past the end.
  // Resuming from it would silently skip everything -> fail-open. It must
  // re-read from zero instead.
  writeTranscript(slugDir, 'incr.jsonl', [usageRow(NOW, { output: 7 })])
  const h = budget.usageForDay(DATA_HOME, NOW)
  eq('a truncated/rotated file is re-read from zero, not resumed', h.total, 7)

  // Rewritten in place to the SAME length: size and mtime give nothing away.
  // Only the head probe catches this.
  const row1 = usageRow(NOW, { output: 7 })
  const row2 = usageRow(NOW, { output: 8 })
  ok('the rewrite test is honest (same byte length)', row1.length === row2.length)
  fs.writeFileSync(f, row2 + '\n')
  fs.utimesSync(f, NOW, NOW)
  const i = budget.usageForDay(DATA_HOME, NOW)
  eq('same-size rewrite is detected by the head probe', i.total, 8)

  fs.rmSync(f)
  budget.resetCache()
}

console.log('\n-- tailRows: a partial row is dropped, never half-parsed')
{
  const f = path.join(scratch, 'tail.jsonl')
  const good = JSON.stringify({ a: 1 })
  fs.writeFileSync(f, `${'x'.repeat(50)}\n${good}\n`)
  const rows = budget.tailRows(f, 20) // cut lands mid-first-line
  ok('partial leading row dropped', rows.length <= 1)
  ok('no fabricated row', rows.every((r) => r && typeof r === 'object'))
}

console.log('\n-- budgetState: the fail-CLOSED property (the whole point)')
{
  writeTranscript(slugDir, 'a.jsonl', [usageRow(NOW, { output: 100 })])
  const s = budget.budgetState(DATA_HOME, 1000, NOW)
  ok('under cap -> mayRun', s.ok === true && s.mayRun === true, JSON.stringify(s))
  eq('remaining is honest', s.remaining, 900)
  eq('usedPct surfaced for the agent to SEE', s.usedPct, 10)
}
{
  writeTranscript(slugDir, 'a.jsonl', [usageRow(NOW, { output: 1000 })])
  const s = budget.budgetState(DATA_HOME, 1000, NOW)
  ok('at cap -> may NOT run', s.mayRun === false, JSON.stringify(s))
  eq('remaining floors at 0, never negative', s.remaining, 0)
}
{
  const s = budget.budgetState(DATA_HOME, 0, NOW)
  ok('cap of 0 means OFF, not unlimited', s.mayRun === false && s.ok === false, JSON.stringify(s))
}
{
  const s = budget.budgetState(DATA_HOME, -1, NOW)
  ok('negative cap means OFF, not unlimited', s.mayRun === false, JSON.stringify(s))
}
{
  const s = budget.budgetState(DATA_HOME, 'lots', NOW)
  ok('non-numeric cap means OFF', s.mayRun === false, JSON.stringify(s))
}
{
  // THE test. The meter cannot see the transcripts. It must say no.
  const blindHome = path.join(scratch, 'NoTranscriptsHere')
  fs.mkdirSync(blindHome, { recursive: true })
  const s = budget.budgetState(blindHome, 999999, NOW)
  ok('UNMEASURABLE -> mayRun === false (fail closed, never fail open)',
    s.ok === false && s.mayRun === false, JSON.stringify(s))
  ok('and it says why', typeof s.reason === 'string' && s.reason.length > 0)
}
{
  // Same, but the projects root itself is gone (fresh machine, CLI never ran).
  const saved = process.env.SCHEHERAZADE_PROJECTS_ROOT
  process.env.SCHEHERAZADE_PROJECTS_ROOT = path.join(scratch, 'nonexistent-root')
  const s = budget.budgetState(DATA_HOME, 999999, NOW)
  ok('missing projects root -> mayRun === false', s.mayRun === false, JSON.stringify(s))
  process.env.SCHEHERAZADE_PROJECTS_ROOT = saved
}

fs.rmSync(scratch, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
