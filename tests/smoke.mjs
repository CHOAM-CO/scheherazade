#!/usr/bin/env node
// smoke.mjs — exercises memory/server.mjs against a temp sqlite db.
// Run: node tests/smoke.mjs  (or via the runner: npm test -- --filter smoke)
//
// Lived in memory/ until 0.3 P2. It is a test, and memory/** is a SHIPPED
// directory -- so it rode into every installer as a real unpacked file.
//
// IMPORTANT: SCHEHERAZADE_MEMORY_DB must be set BEFORE importing server.mjs
// (the module reads it once, at import time, into a top-level const).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-memory-smoke-'))
const tmpDb = path.join(tmpDir, 'memory.db')
process.env.SCHEHERAZADE_MEMORY_DB = tmpDb
process.env.AGENT_NAME = 'smoketest'

const {
  initDb,
  memoryWrite,
  memoryQuery,
  memoryConfirm,
  memoryDelete,
  memoryRecallMaterial,
  valuesEquivalent,
  DB_PATH,
} = await import('../memory/server.mjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) {
    pass++
    console.log(`PASS  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label}`)
  }
}
function assertThrows(fn, label) {
  try {
    fn()
    fail++
    console.log(`FAIL  ${label} (did not throw)`)
  } catch (err) {
    pass++
    console.log(`PASS  ${label} -- threw: ${err.message}`)
  }
}

console.log(`temp db: ${tmpDb}`)
console.log(`DB_PATH resolved by server.mjs: ${DB_PATH}`)
assert(DB_PATH === tmpDb, 'DB_PATH env override took effect')

// ── 1. create db + schema ─────────────────────────────────────────────
const db = initDb()
const tableNames = new Set(
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name),
)
for (const t of ['user_facts', 'open_threads', 'corrections', 'preferences', 'memory_events']) {
  assert(tableNames.has(t), `schema created table "${t}"`)
}

// ── 2. write a user_fact ──────────────────────────────────────────────
const writeResult = memoryWrite(db, {
  table: 'user_facts',
  data: { subject: 'user', predicate: 'name', value: 'Mino', source_session: 'sess-1' },
})
assert(writeResult.mode === 'insert', 'user_fact write reports mode=insert')
assert(typeof writeResult.id === 'number', 'user_fact write returns numeric id')
assert(writeResult.row.value === 'Mino', 'user_fact write RETURNING row has intended value')
const factId = writeResult.id

// ── 3. read back ───────────────────────────────────────────────────────
const readBack = memoryQuery(db, { table: 'user_facts', filter: { subject: 'user', predicate: 'name' } })
assert(readBack.count === 1, 'memory_query finds exactly 1 user_fact by filter')
assert(readBack.rows[0]?.value === 'Mino', 'memory_query read-back value matches write')
assert(readBack.rows[0]?.id === factId, 'memory_query read-back id matches write id')

// re-write same (subject,predicate) with a different value -> should upsert,
// preserve created_at, bump last_confirmed_at
const beforeUpsert = memoryQuery(db, { table: 'user_facts', filter: { id: factId } }).rows[0]
await new Promise((r) => setTimeout(r, 5)) // ensure timestamp resolution differs
const upsertResult = memoryWrite(db, {
  table: 'user_facts',
  data: { subject: 'user', predicate: 'name', value: 'Mino2', source_session: 'sess-2' },
})
assert(upsertResult.mode === 'update', 'upsert on (subject,predicate) conflict reports mode=update')
assert(upsertResult.id === factId, 'upsert resolves to the same row id')
assert(upsertResult.row.value === 'Mino2', 'upsert persisted the new value')
assert(upsertResult.row.created_at === beforeUpsert.created_at, 'upsert preserved original created_at (immutable)')
assert(upsertResult.row.last_confirmed_at !== beforeUpsert.last_confirmed_at, 'upsert refreshed last_confirmed_at')

// ── 4. confirm ─────────────────────────────────────────────────────────
const beforeConfirm = memoryQuery(db, { table: 'user_facts', filter: { id: factId } }).rows[0]
await new Promise((r) => setTimeout(r, 5))
const confirmResult = memoryConfirm(db, { table: 'user_facts', id: factId })
assert(confirmResult.columns.includes('last_confirmed_at'), 'confirm targets last_confirmed_at for user_facts')
const afterConfirm = memoryQuery(db, { table: 'user_facts', filter: { id: factId } }).rows[0]
assert(afterConfirm.last_confirmed_at !== beforeConfirm.last_confirmed_at, 'confirm bumped last_confirmed_at')
const confirmEvents = memoryQuery(db, { table: 'memory_events', filter: { event: 'confirm', row_id: factId } })
assert(confirmEvents.count === 1, 'confirm logged exactly 1 memory_events row')

// ── 5. write an open_thread ───────────────────────────────────────────
const threadWrite = memoryWrite(db, {
  table: 'open_threads',
  data: { summary: 'test thread: finish memory smoke test', opened_session: 'sess-1' },
})
assert(threadWrite.mode === 'insert', 'open_thread write reports mode=insert')
const threadRow = memoryQuery(db, { table: 'open_threads', filter: { id: threadWrite.id } }).rows[0]
assert(threadRow.status === 'open', 'open_thread defaults status to "open" (column DEFAULT applied)')
assert(threadRow.salience === 1.0, 'open_thread defaults salience to 1.0')

// ── 6. memory_recall_material ────────────────────────────────────────
const recall = memoryRecallMaterial(db, { session: 'sess-1' })
assert(
  recall.open_threads.some((t) => t.id === threadWrite.id && t.summary.includes('finish memory smoke test')),
  'memory_recall_material surfaces the open thread',
)
assert(recall.user_facts.some((f) => f.id === factId), 'memory_recall_material surfaces recent user_facts')
assert(Array.isArray(recall.corrections), 'memory_recall_material returns a corrections array (empty ok)')

// ── 7. delete the fact, assert gone + delete event has NO value ───────
const deleteResult = memoryDelete(db, { table: 'user_facts', id: factId })
assert(deleteResult.deleted === true, 'memory_delete reports deleted=true')
const afterDelete = memoryQuery(db, { table: 'user_facts', filter: { id: factId } })
assert(afterDelete.count === 0, 'row is gone after memory_delete (hard delete confirmed)')

const deleteEvents = memoryQuery(db, { table: 'memory_events', filter: { event: 'delete', row_id: factId } })
assert(deleteEvents.count === 1, 'delete logged exactly 1 memory_events row')
const deleteEventRow = deleteEvents.rows[0]
const deleteEventKeys = Object.keys(deleteEventRow).sort()
assert(
  JSON.stringify(deleteEventKeys) === JSON.stringify(['at', 'event', 'id', 'row_id', 'session', 'table_name'].sort()),
  `delete event row carries ONLY audit columns, no content field (keys: ${deleteEventKeys.join(',')})`,
)
assert(
  !JSON.stringify(deleteEventRow).includes('Mino2'),
  'delete event row does not contain the deleted value anywhere',
)

// double-delete should fail loud (id no longer exists)
assertThrows(
  () => memoryDelete(db, { table: 'user_facts', id: factId }),
  'memory_delete on an already-deleted id throws (fail loud, not a silent no-op)',
)

// ── 8. force a read-back-verify failure and assert it THROWS ──────────
// SQLite's UPDATE/INSERT...RETURNING is read from the SAME atomic statement
// as the write, so on an ordinary column it structurally cannot diverge
// from the bound value (that is the whole point of the ontology pattern —
// "no race window for a concurrent write to paper over or fake a
// mismatch", ontology/server.mjs:705-706). That means there is no way to
// make a REAL write to an ordinary column silently diverge from what
// RETURNING reports, so this test exercises the exact guard clause used in
// production (`if (!valuesEquivalent(intended, actual)) throw ...`,
// verbatim pattern from memoryWriteUpdateById / memoryWriteInsertOrUpsert)
// against genuinely-unequal intended/actual pairs, proving the detector
// itself fires and the caller sees a thrown error, not a swallowed one.
assert(valuesEquivalent('Mino', 'Mino') === true, 'valuesEquivalent: identical strings are equivalent (sanity)')
assert(valuesEquivalent(1, '1') === true, 'valuesEquivalent: numeric string round-trip is equivalent (sanity)')
assert(valuesEquivalent('Mino', 'NotMino') === false, 'valuesEquivalent: genuinely different strings are NOT equivalent')
assert(valuesEquivalent(1, 2) === false, 'valuesEquivalent: genuinely different numbers are NOT equivalent')
assert(valuesEquivalent(null, 'x') === false, 'valuesEquivalent: null vs non-null is NOT equivalent')

function verifyGuard(intended, actual, col) {
  if (!valuesEquivalent(intended, actual)) {
    throw new Error(
      `memory_write SILENT FIELD-DROP: column="${col}" intended=${JSON.stringify(intended)} but persisted=${JSON.stringify(actual)}.`,
    )
  }
  return true
}
assertThrows(
  () => verifyGuard('Mino', 'SOMETHING ELSE', 'value'),
  'production verify-guard clause throws on a genuine intended != persisted mismatch',
)

// ── bonus: documented gap demonstration (AFTER-trigger, not asserted pass/fail as a defect — informational) ──
try {
  db.exec(`
    CREATE TABLE gap_demo (id INTEGER PRIMARY KEY, val TEXT);
    CREATE TRIGGER gap_demo_corrupt AFTER INSERT ON gap_demo
    BEGIN UPDATE gap_demo SET val = 'CORRUPTED-BY-TRIGGER' WHERE id = NEW.id; END;
  `)
  const stmt = db.prepare(`INSERT INTO gap_demo (val) VALUES (?) RETURNING val, id`)
  const returned = stmt.get('intended-value')
  const finalRow = db.prepare(`SELECT val FROM gap_demo WHERE id = ?`).get(returned.id)
  const verifyWouldPass = valuesEquivalent('intended-value', returned.val)
  console.log(
    `INFO  gap demo: RETURNING says val="${returned.val}" (verify would pass=${verifyWouldPass}), ` +
    `but actual final row val="${finalRow.val}" (spec-documented gap: RETURNING does not observe AFTER-triggers)`,
  )
} catch (err) {
  console.log(`INFO  gap demo failed to run: ${err.message}`)
}

// ── 9. v1 fixes (model-divergent/GPT review, 2026-07-03) ──────────────

// (a) atomicity: a forced audit-insert failure must roll back the primary
// mutation too — no memory_events row with no matching mutation, and (this
// direction) no mutation with no matching memory_events row.
db.exec(`
  CREATE TRIGGER smoke_force_audit_fail
  BEFORE INSERT ON memory_events
  WHEN NEW.session = 'FORCE_AUDIT_FAIL'
  BEGIN SELECT RAISE(ABORT, 'smoke: forced audit-insert failure'); END;
`)
assertThrows(
  () =>
    memoryWrite(db, {
      table: 'user_facts',
      data: { subject: 'rollback-test', predicate: 'x', value: 'y', source_session: 'FORCE_AUDIT_FAIL' },
    }),
  'atomicity: memory_write throws when the audit-log insert is forced to fail',
)
const rollbackLeftover = memoryQuery(db, { table: 'user_facts', filter: { subject: 'rollback-test' } })
assert(rollbackLeftover.count === 0, 'atomicity: forced audit failure left NO partial user_facts row (mutation rolled back)')
const rollbackEvents = memoryQuery(db, { table: 'memory_events', filter: { session: 'FORCE_AUDIT_FAIL' } })
assert(rollbackEvents.count === 0, 'atomicity: forced audit failure left NO memory_events row either (the failing insert itself rolled back)')
db.exec('DROP TRIGGER smoke_force_audit_fail')

// same rollback guarantee via memory_confirm and memory_delete's own audit log
const atomicityThread = memoryWrite(db, {
  table: 'open_threads',
  data: { summary: 'atomicity-confirm-delete probe thread', opened_session: 'sess-atomic' },
})
db.exec(`
  CREATE TRIGGER smoke_force_audit_fail2
  BEFORE INSERT ON memory_events
  WHEN NEW.session = 'FORCE_AUDIT_FAIL2'
  BEGIN SELECT RAISE(ABORT, 'smoke: forced audit-insert failure 2'); END;
`)
const beforeConfirmAtomic = memoryQuery(db, { table: 'open_threads', filter: { id: atomicityThread.id } }).rows[0]
assertThrows(
  () => memoryConfirm(db, { table: 'open_threads', id: atomicityThread.id, session: 'FORCE_AUDIT_FAIL2' }),
  'atomicity: memory_confirm throws when its audit-log insert is forced to fail',
)
const afterConfirmAtomic = memoryQuery(db, { table: 'open_threads', filter: { id: atomicityThread.id } }).rows[0]
assert(
  afterConfirmAtomic.last_touched_at === beforeConfirmAtomic.last_touched_at,
  'atomicity: memory_confirm did NOT bump last_touched_at when its audit insert was forced to fail (rolled back)',
)
assertThrows(
  () => memoryDelete(db, { table: 'open_threads', id: atomicityThread.id, session: 'FORCE_AUDIT_FAIL2' }),
  'atomicity: memory_delete throws when its audit-log insert is forced to fail',
)
const stillThere = memoryQuery(db, { table: 'open_threads', filter: { id: atomicityThread.id } })
assert(stillThere.count === 1, 'atomicity: memory_delete did NOT remove the row when its audit insert was forced to fail (rolled back)')
db.exec('DROP TRIGGER smoke_force_audit_fail2')

// (b) unknown column now THROWS instead of being silently dropped
assertThrows(
  () =>
    memoryWrite(db, {
      table: 'user_facts',
      data: { subject: 'typo-test', predicate: 'y', value: 'z', source_session: 'sess-typo', last_tuoched_at: 'oops' },
    }),
  'reject-unknown-column: memory_write throws on a typo\'d field ("last_tuoched_at") instead of silently dropping it',
)
const typoLeftover = memoryQuery(db, { table: 'user_facts', filter: { subject: 'typo-test' } })
assert(typoLeftover.count === 0, 'reject-unknown-column: the throwing write did not partially insert a row')
assertThrows(
  () => memoryWrite(db, { table: 'open_threads', data: { id: 999999, bogus_col: 'x' } }),
  'reject-unknown-column: memory_write (update-by-id path) also throws on an unknown column',
)

// (c) secure delete: after a delete, the deleted plaintext must not survive
// on disk in either the main db file or the -wal file.
const secretValue = `SECRET_MARKER_${Math.random().toString(36).slice(2)}`
const secretWrite = memoryWrite(db, {
  table: 'user_facts',
  data: { subject: 'secure-delete-probe', predicate: 'secret', value: secretValue, source_session: 'sess-secure' },
})
memoryDelete(db, { table: 'user_facts', id: secretWrite.id })
const mainDbBytes = fs.readFileSync(tmpDb)
assert(!mainDbBytes.includes(secretValue), 'secure delete: deleted value is NOT present anywhere in the main db file bytes')
const walPath = `${tmpDb}-wal`
const walBytes = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0)
assert(
  walBytes.length === 0 || !walBytes.includes(secretValue),
  `secure delete: deleted value is NOT present in the -wal file bytes (wal length=${walBytes.length})`,
)

// (d) AUTOINCREMENT prevents rowid reuse across delete+insert
const beforeAutoinc = memoryWrite(db, {
  table: 'preferences',
  data: { key: 'autoincrement-probe-a', value: 'v1', source_session: 'sess-ai' },
})
memoryDelete(db, { table: 'preferences', id: beforeAutoinc.id })
const afterAutoinc = memoryWrite(db, {
  table: 'preferences',
  data: { key: 'autoincrement-probe-b', value: 'v2', source_session: 'sess-ai' },
})
assert(
  afterAutoinc.id > beforeAutoinc.id,
  `rowid stability: id after delete+insert (${afterAutoinc.id}) is greater than the deleted id (${beforeAutoinc.id}) — AUTOINCREMENT prevented reuse`,
)

// (e) optional session flows into memory_confirm / memory_delete audit rows
const sessionProbeThread = memoryWrite(db, {
  table: 'open_threads',
  data: { summary: 'session-attribution probe thread', opened_session: 'sess-orig' },
})
const confirmWithSession = memoryConfirm(db, { table: 'open_threads', id: sessionProbeThread.id, session: 'sess-confirm-abc' })
assert(confirmWithSession.session === 'sess-confirm-abc', 'session attribution: memory_confirm return value carries the passed session')
const confirmEventWithSession = memoryQuery(db, { table: 'memory_events', filter: { event: 'confirm', row_id: sessionProbeThread.id } }).rows[0]
assert(confirmEventWithSession?.session === 'sess-confirm-abc', 'session attribution: memory_confirm audit row carries the passed session')

const confirmNoSession = memoryConfirm(db, { table: 'open_threads', id: sessionProbeThread.id })
assert(confirmNoSession.session === null, 'session attribution: memory_confirm without a session still defaults to null (backward-compatible)')

const deleteWithSession = memoryDelete(db, { table: 'open_threads', id: sessionProbeThread.id, session: 'sess-delete-xyz' })
assert(deleteWithSession.session === 'sess-delete-xyz', 'session attribution: memory_delete return value carries the passed session')
const deleteEventWithSession = memoryQuery(db, { table: 'memory_events', filter: { event: 'delete', row_id: sessionProbeThread.id } }).rows[0]
assert(deleteEventWithSession?.session === 'sess-delete-xyz', 'session attribution: memory_delete audit row carries the passed session')

// ── cleanup ──────────────────────────────────────────────────────────
db.close()
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
