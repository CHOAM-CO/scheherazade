#!/usr/bin/env node
// test-session-feed.mjs -- the session feed's net-change collapse, attacked.
//
// Live catch (Mino, 2026-07-14, 춘식3 second-device install): one correction
// row appeared TWICE in "이번 세션에서 기억한 것" -- labeled 추가됨 AND
// 수정됨 with identical preview text. The audit log was honest (insert then
// update really happened); the feed was rendering bookkeeping instead of
// what the session net-remembered.
//
// These tests attack collapseSessionEvents (pure, exported from
// http-server.cjs precisely so this file needs no Electron and no db).
// Wrong-defendant discipline (4 convictions on 07-14 alone): every fixture
// is built inline, newest-first, exactly as getSessionEvents feeds it --
// no reliance on machine state, wall clock, or module side effects.
//
// Run: node tests/test-session-feed.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// http-server.cjs resolves DATA_HOME at module scope -- point it at a tmp
// dir BEFORE the require so this test can never touch a real install.
process.env.AGENT_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-feed-'))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { collapseSessionEvents } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// Event fixture helper. Feed order is newest-first, so fixtures list the
// LATEST event first, same as getSessionEvents' sort hands over.
let nextId = 100
function ev(event, table, rowId, at) {
  return { id: nextId++, event, table_name: table, row_id: rowId, session: null, at }
}

console.log('session feed net-change collapse\n')

// ── 1. THE LIVE SHAPE: insert then update of the same row ──────────────────
{
  const out = collapseSessionEvents([
    ev('update', 'corrections', 7, '2026-07-14T01:26:40Z'),
    ev('insert', 'corrections', 7, '2026-07-14T01:26:05Z'),
  ])
  check('춘식3 shape: ONE line, not two', out.length === 1, `${out.length} lines`)
  check('...and it reads 추가됨 (new this session), not 수정됨', out[0].event === 'insert', out[0].event)
  check('...stamped with the NEWEST activity time', out[0].at === '2026-07-14T01:26:40Z', out[0].at)
}

// ── 2. Rank: update outranks confirm; confirm alone survives ───────────────
{
  const out = collapseSessionEvents([
    ev('confirm', 'user_facts', 3, '2026-07-14T05:00:00Z'),
    ev('update', 'user_facts', 3, '2026-07-14T04:00:00Z'),
  ])
  check('update + later confirm = one 수정됨 (recency bump must not mask a content change)',
    out.length === 1 && out[0].event === 'update', JSON.stringify(out.map((e) => e.event)))
  check('...but shown at the newest event time', out[0].at === '2026-07-14T05:00:00Z', out[0].at)

  const solo = collapseSessionEvents([ev('confirm', 'user_facts', 4, '2026-07-14T05:00:00Z')])
  check('confirm alone stays 확인됨', solo.length === 1 && solo[0].event === 'confirm')
}

// ── 3. Deletes: same-day insert+delete nets to NOTHING; plain delete stays ──
{
  const gone = collapseSessionEvents([
    ev('delete', 'open_threads', 9, '2026-07-14T03:00:00Z'),
    ev('update', 'open_threads', 9, '2026-07-14T02:30:00Z'),
    ev('insert', 'open_threads', 9, '2026-07-14T02:00:00Z'),
  ])
  check('inserted-then-deleted today = net no-op, zero lines', gone.length === 0, JSON.stringify(gone))

  const kept = collapseSessionEvents([ev('delete', 'user_facts', 2, '2026-07-14T03:00:00Z')])
  check('delete of a PRE-EXISTING row still shows (삭제됨 is real news)', kept.length === 1 && kept[0].event === 'delete')
}

// ── 4. No over-collapse ─────────────────────────────────────────────────────
{
  const out = collapseSessionEvents([
    ev('insert', 'corrections', 11, '2026-07-14T02:00:00Z'),
    ev('insert', 'corrections', 12, '2026-07-14T01:00:00Z'),
  ])
  check('two DIFFERENT rows stay two lines (collapse is per-row, not per-table)', out.length === 2)

  const cross = collapseSessionEvents([
    ev('update', 'user_facts', 5, '2026-07-14T02:00:00Z'),
    ev('insert', 'preferences', 5, '2026-07-14T01:00:00Z'),
  ])
  check('same row_id across DIFFERENT tables never merges', cross.length === 2,
    JSON.stringify(cross.map((e) => `${e.table_name}:${e.event}`)))

  const solos = collapseSessionEvents([
    ev('delete', 'user_facts', null, '2026-07-14T02:00:00Z'),
    ev('delete', 'user_facts', null, '2026-07-14T01:00:00Z'),
  ])
  check('row_id-less events never merge with each other', solos.length === 2)
}

// ── 5. Order + purity ───────────────────────────────────────────────────────
{
  const input = [
    ev('update', 'user_facts', 21, '2026-07-14T05:00:00Z'),
    ev('insert', 'corrections', 20, '2026-07-14T04:00:00Z'),
    ev('insert', 'user_facts', 21, '2026-07-14T03:00:00Z'),
  ]
  const snapshot = JSON.stringify(input)
  const out = collapseSessionEvents(input)
  check('newest-activity order preserved (row 21 first, row 20 second)',
    out.length === 2 && out[0].row_id === 21 && out[1].row_id === 20,
    JSON.stringify(out.map((e) => e.row_id)))
  check('input events are not mutated (audit rows are read-only here too)', JSON.stringify(input) === snapshot)
  check('collapsed event keeps table_name/row_id for preview resolution',
    out[0].table_name === 'user_facts' && out[0].row_id === 21)
}

// ── 6. Wiring pin: getSessionEvents actually routes through the collapse ────
{
  const src = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  check('getSessionEvents calls collapseSessionEvents on the day slice',
    /collapseSessionEvents\(sorted\.filter/.test(src))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
