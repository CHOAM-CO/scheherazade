#!/usr/bin/env node
// test-journal.mjs -- the v0.0.5 journal layer against the REAL memory server
// module and a REAL sqlite db.
//
// The journal's promises, in the order they matter:
//   1. The agent CANNOT rewrite or delete its own past. An agent that can edit
//      its history has no history. (Enforced by absence: journal_entries is not
//      in WRITABLE_TABLES, and journalWrite only ever appends.)
//   2. A late entry can be written, but can never LOOK contemporaneous -- every
//      append after the first carries a visible timestamp seam.
//   3. Caps fail LOUD. A silently truncated journal entry is a memory that lies
//      about its own completeness, which is worse than a rejected write.
//
// These are written as attacks on my own design, not as demonstrations of it.
//
// Run: node scripts/test-journal.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-journal-'))
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')

const mod = await import('../memory/server.mjs')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

console.log('journal layer (v0.0.5)\n')

const db = mod.initDb()

// ── 1. The table exists, and the write boundary holds ──────────────────────
{
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'").all()
  check('DDL creates journal_entries', rows.length === 1)

  let threw = false
  try { mod.memoryWrite(db, { table: 'journal_entries', data: { body: 'smuggled in as a fact' } }) } catch { threw = true }
  check('memory_write CANNOT reach journal_entries (narrative is not a fact)', threw)

  let delThrew = false
  try { mod.memoryDelete(db, { table: 'journal_entries', id: 1 }) } catch { delThrew = true }
  check('memory_delete CANNOT reach journal_entries (the agent cannot erase its own past)', delThrew)
}

// ── 2. Write, read back, and the shape of an entry ─────────────────────────
{
  const r = mod.journalWrite(db, { date: '2026-07-13', body: '  오늘 내가 만들려던 기능을 내가 죽였다  ' })
  check('journal_write returns the row it wrote', r && r.date === '2026-07-13' && r.id > 0, JSON.stringify(r))
  check('first write is not an append', r.appended === false, JSON.stringify(r))

  const { rows } = mod.journalRead(db, { date: '2026-07-13' })
  check('journal_read finds it', rows.length === 1, JSON.stringify(rows))
  check('body is trimmed, not mangled', rows[0].body === '오늘 내가 만들려던 기능을 내가 죽였다', JSON.stringify(rows[0].body))
  check('memory_query CAN read the journal (it is readable, just not writable)',
    mod.memoryQuery(db, { table: 'journal_entries' }).rows.length === 1)
}

// ── 3. THE CORE PROMISE: append never overwrites, and the seam is visible ───
{
  mod.journalWrite(db, { date: '2026-07-13', body: 'and then I was wrong about being wrong' })
  const { rows } = mod.journalRead(db, { date: '2026-07-13' })
  check('still ONE row for the day (append, not a second entry)', rows.length === 1, `${rows.length} rows`)
  check('the ORIGINAL text survives verbatim', rows[0].body.includes('오늘 내가 만들려던 기능을 내가 죽였다'))
  check('the new text is there too', rows[0].body.includes('and then I was wrong about being wrong'))
  check('a visible timestamp SEAM separates them (a late line cannot pass as an early one)',
    /\n\n--- \d{4}-\d{2}-\d{2}T[\d:.]+Z? --- ?\n/.test(rows[0].body) || /--- 20\d\d-/.test(rows[0].body),
    JSON.stringify(rows[0].body))

  const second = mod.journalWrite(db, { date: '2026-07-13', body: 'third thought' })
  check('journal_write reports that it appended', second.appended === true, JSON.stringify(second))
  const after = mod.journalRead(db, { date: '2026-07-13' }).rows[0]
  check('nothing was lost across two appends', after.body.includes('죽였다') && after.body.includes('being wrong') && after.body.includes('third thought'))
}

// ── 4. Audit trail: journal writes are events too ──────────────────────────
{
  const events = mod.memoryQuery(db, { table: 'memory_events', filter: { table_name: 'journal_entries' } }).rows
  check('journal writes log memory_events rows', events.length >= 2, JSON.stringify(events.map((e) => e.event)))
  check('the FIRST write is logged as a create, not an append', events.some((e) => e.event === 'journal_create'))
  check('subsequent writes are logged as appends', events.some((e) => e.event === 'journal_append'))
}

// ── 5. Caps fail LOUD, and a rejected write changes NOTHING ────────────────
{
  const before = mod.journalRead(db, { date: '2026-07-13' }).rows[0].body

  let threw = false
  try { mod.journalWrite(db, { date: '2026-07-13', body: 'x'.repeat(20001) }) } catch { threw = true }
  check('an over-cap append is REFUSED, not truncated', threw)

  const after = mod.journalRead(db, { date: '2026-07-13' }).rows[0].body
  check('the refused write left the day EXACTLY as it was', after === before, 'a rejected write mutated the entry')
}

// ── 6. Garbage in is refused loudly (not written as an empty day) ──────────
{
  const cases = [
    ['empty body', { date: '2026-07-13', body: '' }],
    ['whitespace-only body', { date: '2026-07-13', body: '   \n  ' }],
    ['non-string body', { date: '2026-07-13', body: { rambling: true } }],
    ['malformed date', { date: '13-07-2026', body: 'hi' }],
    ['not-a-date', { date: 'yesterday', body: 'hi' }],
  ]
  for (const [label, args] of cases) {
    let threw = false
    try { mod.journalWrite(db, args) } catch { threw = true }
    check(`REFUSES ${label}`, threw)
  }
  let readThrew = false
  try { mod.journalRead(db, { from: 'last tuesday' }) } catch { readThrew = true }
  check('journal_read REFUSES a malformed range', readThrew)
}

// ── 7. Defaults: the day is the LOCAL day, not UTC's ───────────────────────
//    A journal keyed on UTC rolls over mid-evening for the person it belongs to.
{
  const today = mod.localToday()
  check('localToday is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(today), today)
  const local = mod.localToday(new Date(2026, 6, 13, 23, 30)) // 23:30 local, July 13
  check('23:30 local is still the 13th (would be the 14th in UTC east of GMT)', local === '2026-07-13', local)

  const r = mod.journalWrite(db, { body: 'no date given' })
  check('journal_write defaults to today', r.date === today, `${r.date} vs ${today}`)
}

// ── 8. Reading back a life: newest first, ranged, capped ───────────────────
{
  mod.journalWrite(db, { date: '2026-07-01', body: 'older' })
  mod.journalWrite(db, { date: '2026-07-05', body: 'middle' })

  const all = mod.journalRead(db, {})
  check('newest first', all.rows[0].date >= all.rows[all.rows.length - 1].date, JSON.stringify(all.rows.map((r) => r.date)))

  const ranged = mod.journalRead(db, { from: '2026-07-01', to: '2026-07-05' })
  check('range filter is inclusive on both ends', ranged.rows.length === 2, JSON.stringify(ranged.rows.map((r) => r.date)))

  const limited = mod.journalRead(db, { limit: 1 })
  check('limit is honored', limited.rows.length === 1)
  check('limit is capped, not trusted', mod.journalRead(db, { limit: 99999 }).rows.length <= 120)
}

// ── 9. The letter has a reader ─────────────────────────────────────────────
//    The shutdown inject (channel.mjs) tells the agent: "내일 부팅하는 너는
//    아무것도 기억 못 한 채로 이걸 읽는다." That sentence is only true if the
//    restore procedure (CLAUDE.md §1) actually points the next boot at
//    journal_read. Shipped for a night without it: the write side and the
//    night-cycle reads existed, ordinary boot never read the journal at all.
//    This pins the pair -- whoever removes the reader breaks the writer's
//    promise HERE, not silently in some future install.
{
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const claudeMd = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8')
  const restoreSection = claudeMd.split(/^## 2\./m)[0]
  check('CLAUDE.md restore procedure (§1) points the next boot at journal_read', /journal_read/.test(restoreSection))

  const channel = fs.readFileSync(path.join(repoRoot, 'channel.mjs'), 'utf8')
  check('shutdown inject still asks for journal_write (the writer half of the pair)', /journal_write/.test(channel))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
