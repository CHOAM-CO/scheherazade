#!/usr/bin/env node
/**
 * Scheherazade Memory MCP Server
 *
 * Standalone MCP stdio server exposing a SQLite-backed structured memory DB
 * (ontology-style: category tables + an append-only audit-events table).
 *
 * Spec: ~/Documents/MAGI_Memory/projects/scheherazade_memory_schema_v0_melchior_2026-07-03.md
 * Pattern source (ported, not reinvented): ~/Desktop/MAGI/ontology/server.mjs
 *   — handleUpdate's read-back-verify (UPDATE...RETURNING + valuesEquivalent +
 *     numericCoerce + null-mirror). Same shape applied here to insert/upsert
 *     too, since memory_write covers both.
 *
 * Tools: memory_write, memory_query, memory_confirm, memory_delete,
 *        memory_recall_material
 *
 * v1 fix pass (model-divergent/GPT review, confirmed by direct code read,
 * 2026-07-03): every mutation+audit pair now runs inside one BEGIN
 * IMMEDIATE/COMMIT transaction with ROLLBACK on any error (see
 * withTransaction); memory_write throws on unknown/typo'd columns instead
 * of silently dropping them (see rejectUnknownColumns); DB opens with
 * PRAGMA secure_delete=ON + busy_timeout=5000, and memory_delete runs a
 * post-commit wal_checkpoint(TRUNCATE) so no plaintext residue survives on
 * disk; the upsert insert-vs-update audit mode is now derived from which
 * write statement actually executed (try INSERT, fall back to UPDATE on a
 * caught UNIQUE conflict) instead of a racy pre-check SELECT; the 4
 * category tables' id PK is now AUTOINCREMENT so deleted rowids are never
 * reused (memory_events excluded, see its own comment); memory_confirm/
 * memory_delete take an optional `session` arg for audit attribution.
 * Deferred to v1.1 (not implemented here, see inline TODOs): the
 * AFTER-trigger RETURNING-observability gap (dormant — v1 defines no
 * triggers) and enforcing that the `session` field can't be used to smuggle
 * real content past a later delete (ships with the self_catches work).
 *
 * sqlite lib: node:sqlite (DatabaseSync) — node 24 built-in, supports
 * RETURNING (incl. INSERT...ON CONFLICT DO UPDATE...RETURNING), no native
 * module to rebuild for Electron/ASAR. Confirmed working via probe before
 * this file was written (see build report). Currently gated behind an
 * "experimental" stderr warning from Node itself — harmless, does not
 * touch stdout (MCP stdio purity preserved, see stdout hygiene below).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── stdout hygiene ─────────────────────────────────────────────────────────
// MCP stdio transport reserves stdout exclusively for JSON-RPC. Any stray
// console output there corrupts the stream (ported from channel.mjs), so
// every console method is rerouted to stderr before anything else runs.
function safeJson(v) { try { return JSON.stringify(v) } catch { return String(v) } }
for (const [method, prefix] of [['log', ''], ['info', ''], ['debug', ''], ['warn', '[WARN] '], ['error', '[ERR] ']]) {
  console[method] = (...args) => {
    process.stderr.write(`${prefix}${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}\n`)
  }
}

// ── Config ──────────────────────────────────────────────────────────────
const AGENT_NAME = process.env.AGENT_NAME || 'scheherazade'
const DB_PATH = process.env.SCHEHERAZADE_MEMORY_DB || path.join(os.homedir(), 'Documents', AGENT_NAME, 'memory.db')

const log = (msg) => process.stderr.write(`[memory] ${msg}\n`)
const nowISO = () => new Date().toISOString()

// ── DDL (spec §DDL — CREATE TABLE IF NOT EXISTS, idempotent on startup) ──
// v1 fix (rowid stability): id PK uses AUTOINCREMENT on the 4 category
// tables below (NOT on memory_events — see its own comment). Plain
// `INTEGER PRIMARY KEY` lets SQLite reuse a deleted row's rowid for the
// next insert; AUTOINCREMENT (backed by sqlite_sequence) guarantees a
// monotonically increasing id that is NEVER reused, so a delete's
// memory_events.row_id can never later silently point at a different,
// newer row. CREATE TABLE IF NOT EXISTS does not retroactively change an
// existing table's PK definition, so this only takes effect for freshly
// created tables/dbs. v1 has no live users yet, so the correct migration
// is simply a fresh db (delete the old memory.db, or point
// SCHEHERAZADE_MEMORY_DB at a new path) — if that stops being true later,
// a real migration would need to rebuild each table (create
// new-with-AUTOINCREMENT, copy rows, swap) rather than relying on
// IF NOT EXISTS to upgrade it in place.
const DDL = `
-- one current value per (subject,predicate); re-learning bumps last_confirmed
CREATE TABLE IF NOT EXISTS user_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,             -- "user", "user.job", "user.env"
  predicate TEXT NOT NULL,           -- "name","works_at","timezone"
  value TEXT NOT NULL,
  source_session TEXT NOT NULL,
  source_msg TEXT,
  created_at TEXT NOT NULL,          -- ISO, first learned
  last_confirmed_at TEXT NOT NULL,   -- ISO, last reaffirmed (recency trust)
  confidence REAL DEFAULT 1.0,       -- soft-canon vs confirmed
  UNIQUE(subject, predicate)
);

-- THE fuel for session-2 transformed recall + proactive messages
CREATE TABLE IF NOT EXISTS open_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,             -- "X 마저 정리하기로 함"
  status TEXT NOT NULL DEFAULT 'open', -- open | done | stale
  opened_session TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_touched_at TEXT NOT NULL,     -- recency for recall ranking
  salience REAL DEFAULT 1.0          -- decays; recall pulls highest
);

-- distrust productized: hooks READ active rows as gating constraints ("훅이 제일 킥임")
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  what_was_wrong TEXT NOT NULL,      -- "존댓말 썼는데 반말 요청"
  correct_behavior TEXT NOT NULL,    -- "always 반말"
  corrected_session TEXT NOT NULL,
  corrected_at TEXT NOT NULL,
  still_active INTEGER DEFAULT 1
);

-- onboarding 3-Q = first rows
CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,          -- "reply_length","format","contact_window","register"
  value TEXT NOT NULL,
  source_session TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- audit trail of memory ACTIONS, never deleted content (see principle 3).
-- No AUTOINCREMENT here on purpose (per v1 fix spec) — this table is
-- append-only and its own rows are never deleted, so rowid reuse cannot
-- happen; keeping it plain INTEGER PRIMARY KEY avoids the (tiny) extra
-- sqlite_sequence bookkeeping where it buys nothing.
CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,               -- insert | update | delete | confirm
  table_name TEXT NOT NULL,
  row_id INTEGER,                    -- may dangle after hard delete (intentional)
  session TEXT,                      -- v1.1 TODO: enforce this looks like a session id, not
                                      -- arbitrary content — a caller can currently stuff real
                                      -- memory content into this field, which would survive a
                                      -- memory_delete of the row it describes (deferred to
                                      -- v1.1 with the self_catches work; not implemented here).
  at TEXT NOT NULL
);
`

// Tables writable via memory_write/memory_confirm/memory_delete.
// memory_events is deliberately excluded — it's an append-only audit log,
// written only internally by logEvent(); it is readable via memory_query.
const WRITABLE_TABLES = new Set(['user_facts', 'open_threads', 'corrections', 'preferences'])
const ALL_TABLES = new Set([...WRITABLE_TABLES, 'memory_events'])

// Per-table upsert/recency shape. conflictCols = natural key for
// INSERT...ON CONFLICT...DO UPDATE upsert (null = always a fresh INSERT,
// e.g. open_threads/corrections are append-only-by-nature — each row a
// distinct thread/correction, no natural single-row identity to collapse
// onto). immutable = columns preserved across a conflict-update (never
// touched by DO UPDATE SET, mirrors "created_at never changes" ontology
// rule). timestampDefaults = columns auto-filled with now() if the caller
// didn't supply one. recencyCol = the column memory_confirm bumps.
const TABLE_CONFIG = {
  user_facts: {
    conflictCols: ['subject', 'predicate'],
    immutable: ['created_at'],
    timestampDefaults: ['created_at', 'last_confirmed_at'],
    recencyCol: 'last_confirmed_at',
    sessionField: 'source_session',
  },
  open_threads: {
    conflictCols: null,
    immutable: [],
    timestampDefaults: ['opened_at', 'last_touched_at'],
    recencyCol: 'last_touched_at',
    sessionField: 'opened_session',
  },
  corrections: {
    conflictCols: null,
    immutable: [],
    timestampDefaults: ['corrected_at'],
    recencyCol: null, // no last_confirmed_at/last_touched_at column on this table by spec DDL
    sessionField: 'corrected_session',
  },
  preferences: {
    conflictCols: ['key'],
    immutable: [],
    timestampDefaults: ['updated_at'],
    recencyCol: 'updated_at',
    sessionField: 'source_session',
  },
}

function validateTable(table, allowed = ALL_TABLES) {
  if (!allowed.has(table)) {
    throw new Error(`Unknown or non-writable table "${table}". Valid: ${[...allowed].sort().join(', ')}`)
  }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name))
}

// ── Read-back-verify helpers ─────────────────────────────────────────────
// v1.1 TODO (deferred, not implemented here — dormant risk only): RETURNING
// reflects the row as of the write statement itself, BEFORE any AFTER
// trigger on the table runs. If a future AFTER trigger mutates the row
// post-write, read-back-verify would report success on a value the row no
// longer actually holds (demonstrated in smoke.mjs's "gap demo"). v1 defines
// no triggers anywhere, so this is currently dormant; closing it needs
// either a follow-up SELECT after RETURNING (reintroduces a race window) or
// a documented "v1 has no triggers" invariant enforced at DDL-review time.
// Ported verbatim (semantics) from ~/Desktop/MAGI/ontology/server.mjs
// handleUpdate — conservative equivalence between an intended value and the
// value actually persisted, read back via ...RETURNING in the SAME atomic
// statement (no follow-up SELECT, no race window). Must NEVER flag a
// genuine sqlite representation/type-affinity difference as a drop.
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/
function numericCoerce(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null
  if (typeof x === 'bigint') return Number(x)
  if (typeof x === 'string' && NUMERIC_STRING_RE.test(x.trim())) return Number(x.trim())
  return null
}
function valuesEquivalent(intended, actual) {
  // node:sqlite binds JS `undefined`/`null` as SQL NULL — match that.
  const a = intended === undefined ? null : intended
  const b = actual === undefined ? null : actual
  if (a === null || b === null) return a === b
  if (a === b) return true
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b)
  // Booleans persist as 0/1 in sqlite (still_active, etc.)
  if (typeof a === 'boolean') return valuesEquivalent(a ? 1 : 0, b)
  if (typeof b === 'boolean') return valuesEquivalent(a, b ? 1 : 0)
  const na = numericCoerce(a)
  const nb = numericCoerce(b)
  if (na !== null && nb !== null) return na === nb
  return false
}

// ── Atomicity (v1 fix) ────────────────────────────────────────────────────
// Every mutation (write/confirm/delete) + its memory_events audit row must
// commit together or not at all — a memory mutation must NEVER persist
// without its audit row (or vice-versa). Before this fix, node:sqlite ran in
// implicit per-statement autocommit, so an UPDATE could commit and THEN the
// read-back-verify or logEvent() throw, leaving a persisted mutation with no
// audit trail. BEGIN IMMEDIATE takes the write lock up front (cooperates
// with PRAGMA busy_timeout below instead of racing other writers for it);
// any throw inside `fn` — from a verify-guard, a constraint error, or
// logEvent's own verify — unwinds via ROLLBACK before the error is
// re-thrown, so the caller still sees the exact same failure message as
// before, but the db is left exactly as it was pre-call.
function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackErr) {
      throw new Error(
        `Transaction FAILED (${err.message}) and ROLLBACK itself failed (${rollbackErr.message}) — db may be in an inconsistent state.`,
      )
    }
    throw err
  }
}

// ── Reject-unknown-column guard (v1 fix, fail loud) ───────────────────────
// memory_write used to silently filter `data` down to known columns, so a
// typo'd field (e.g. "last_tuoched_at") was dropped with no error and the
// write still reported success — defeating the whole read-back-verify
// promise for that field. Any caller-supplied key that isn't a real column
// on the table now throws immediately. Columns the server manages itself
// (created_at/opened_at immutability, recencyCol auto-refresh) are real
// columns, so they're unaffected by this check — they're still accepted,
// just intentionally overridden/ignored later by design, which is
// documented behavior distinct from this typo guard.
function rejectUnknownColumns(table, data, cols) {
  const unknown = Object.keys(data).filter((c) => !cols.has(c))
  if (unknown.length > 0) {
    throw new Error(
      `memory_write: unknown column(s) for table "${table}": ${unknown.join(', ')}. ` +
      `Valid columns: ${[...cols].sort().join(', ')}`,
    )
  }
}

// ── Audit log (internal only — never exposed as a direct write tool) ─────
function logEvent(db, event, table, rowId, session) {
  const at = nowISO()
  const stmt = db.prepare(
    `INSERT INTO memory_events (event, table_name, row_id, session, at) VALUES (?, ?, ?, ?, ?) RETURNING id, event, table_name, row_id, session, at`,
  )
  const row = stmt.get(event, table, rowId ?? null, session ?? null, at)
  // Read-back-verify extends to the audit log itself — a silently dropped
  // event row would mean the delete-audit promise (spec principle #3) is
  // unenforceable, so this must fail loud too, same as any other write.
  if (!row || row.event !== event || row.table_name !== table || !valuesEquivalent(rowId ?? null, row.row_id)) {
    throw new Error(
      `memory_events log FAILED to verify: event=${event} table=${table} row_id=${rowId} — audit row did not persist as intended.`,
    )
  }
  return row
}

// ── memory_write: insert/upsert with read-back-verify ────────────────────
function memoryWrite(db, args) {
  const { table, data } = args || {}
  validateTable(table, WRITABLE_TABLES)
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('memory_write: "data" must be an object of column-value pairs.')
  }

  const cols = tableColumns(db, table)
  const cleanData = { ...data }
  const hasId = cleanData.id != null
  const id = cleanData.id
  delete cleanData.id

  if (hasId) return memoryWriteUpdateById(db, table, id, cleanData, cols)
  return memoryWriteInsertOrUpsert(db, table, cleanData, cols)
}

function memoryWriteUpdateById(db, table, id, cleanData, cols) {
  const cfg = TABLE_CONFIG[table]
  rejectUnknownColumns(table, cleanData, cols)   // v1 fix: typo'd field = throw, not silent drop
  delete cleanData.created_at   // never allow changing "first learned" ts
  delete cleanData.opened_at    // ditto for open_threads

  const recencyCol = cfg.recencyCol
  if (recencyCol && cols.has(recencyCol)) {
    cleanData[recencyCol] = nowISO() // always server-refreshed, like ontology's updated_at
  }

  const setCols = Object.keys(cleanData).filter((c) => cols.has(c))
  if (setCols.length === 0) throw new Error(`memory_write: no valid columns to update on "${table}".`)

  const setClause = setCols.map((c) => `"${c}" = ?`).join(', ')
  const values = setCols.map((c) => cleanData[c])
  const returningClause = setCols.map((c) => `"${c}"`).join(', ')

  // v1 fix (atomicity): write + read-back-verify + audit log all happen
  // inside ONE transaction now — if the verify guard or logEvent's own
  // verify throws below, withTransaction rolls the UPDATE back too, so a
  // mutation can never persist without its memory_events row.
  return withTransaction(db, () => {
    const stmt = db.prepare(`UPDATE "${table}" SET ${setClause} WHERE id = ? RETURNING ${returningClause}`)
    const row = stmt.get(...values, id)

    if (!row) {
      throw new Error(`memory_write matched 0 rows: id=${id} not found in "${table}". Update did NOT apply.`)
    }

    // Verify every caller-intended column except the server-bumped recencyCol
    // (no caller intent to compare it against — same exclusion ontology
    // applies to its own auto-injected updated_at).
    const verifyCols = setCols.filter((c) => c !== recencyCol)
    for (const col of verifyCols) {
      if (!valuesEquivalent(cleanData[col], row[col])) {
        throw new Error(
          `memory_write SILENT FIELD-DROP: table="${table}" id=${id} column="${col}" — ` +
          `intended=${JSON.stringify(cleanData[col])} but persisted=${JSON.stringify(row[col])}.`,
        )
      }
    }

    const sessionField = cfg.sessionField
    logEvent(db, 'update', table, id, cleanData[sessionField] ?? null)
    return { id, changes: 1, mode: 'update', row: { id, ...row } }
  })
}

function memoryWriteInsertOrUpsert(db, table, cleanData, cols) {
  const cfg = TABLE_CONFIG[table]
  rejectUnknownColumns(table, cleanData, cols)   // v1 fix: typo'd field = throw, not silent drop
  const now = nowISO()

  for (const col of cfg.timestampDefaults) {
    if (cleanData[col] == null && cols.has(col)) cleanData[col] = now
  }

  const boundCols = Object.keys(cleanData).filter((c) => cols.has(c))
  if (boundCols.length === 0) throw new Error(`memory_write: no valid columns for table "${table}".`)
  const values = boundCols.map((c) => cleanData[c])
  const returningClause = [...boundCols.map((c) => `"${c}"`), '"id"'].join(', ')

  // v1 fix (atomicity): entire insert-or-update + verify + audit log runs
  // inside ONE transaction (see memoryWriteUpdateById above for why).
  return withTransaction(db, () => {
    let mode, row
    if (cfg.conflictCols) {
      const conflictVals = cfg.conflictCols.map((c) => cleanData[c])
      if (conflictVals.some((v) => v == null)) {
        throw new Error(`memory_write: table "${table}" requires ${cfg.conflictCols.join(', ')} (upsert key).`)
      }

      const immutable = new Set([...cfg.conflictCols, ...cfg.immutable])
      const updateCols = boundCols.filter((c) => !immutable.has(c))

      // v1 fix (mode-attribution race): the old code pre-checked existence
      // with a SELECT, then did INSERT...ON CONFLICT...DO UPDATE — a second
      // writer could commit between that SELECT and this transaction's write,
      // making the pre-check's insert/update guess wrong for what actually
      // happened. Fix: attempt the real INSERT first, inside this txn's write
      // lock; SQLite throws a UNIQUE-constraint error iff a conflicting row
      // genuinely exists AT THE MOMENT OF THE WRITE, so the mode is derived
      // from which statement actually succeeded, not a stale guess. (Probed
      // and confirmed: node:sqlite does NOT set last_insert_rowid() on the
      // ON-CONFLICT-DO-UPDATE branch of an upsert, so that signal is
      // unreliable here — this try/insert-first/catch/update-fallback is the
      // correct equivalent. A caught UNIQUE-violation does not abort the
      // surrounding transaction in SQLite, so the UPDATE fallback below runs
      // in the same still-open txn — also probe-confirmed.)
      // NOTE: this assumes the table's only UNIQUE constraint is the one
      // backing cfg.conflictCols (true today for both upsert tables —
      // user_facts UNIQUE(subject,predicate), preferences.key UNIQUE). If a
      // table ever gains an independent UNIQUE constraint, a violation on
      // THAT constraint would also land here; the UPDATE fallback would then
      // look up rows by conflictCols, most likely match 0 rows, and throw
      // the explicit error below — still fail-loud, just not maximally
      // precise about which constraint actually fired.
      try {
        const insertSql =
          `INSERT INTO "${table}" (${boundCols.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${boundCols.map(() => '?').join(', ')}) RETURNING ${returningClause}`
        row = db.prepare(insertSql).get(...values)
        mode = 'insert'
      } catch (err) {
        if (err.code !== 'ERR_SQLITE_ERROR' || !/UNIQUE constraint failed/i.test(err.message)) throw err
        const setClause = updateCols.map((c) => `"${c}" = ?`).join(', ')
        const updateValues = updateCols.map((c) => cleanData[c])
        const updateSql =
          `UPDATE "${table}" SET ${setClause} ` +
          `WHERE ${cfg.conflictCols.map((c) => `"${c}" = ?`).join(' AND ')} ` +
          `RETURNING ${returningClause}`
        row = db.prepare(updateSql).get(...updateValues, ...conflictVals)
        if (!row) {
          throw new Error(
            `memory_write: upsert on "${table}" hit a UNIQUE conflict on insert but the UPDATE fallback ` +
            `matched 0 rows (concurrent delete of the conflicting row?) conflictCols=${JSON.stringify(conflictVals)}`,
          )
        }
        mode = 'update'
      }

      // Verify: on a fresh insert every bound value is genuinely intended and
      // checkable. On a conflict-update, immutable cols (conflict key +
      // created_at/opened_at) were never part of the UPDATE SET clause by
      // design, so the returned value is deliberately the OLD row's value,
      // not what we bound — verifying those would be a guaranteed false
      // positive.
      const verifyCols = mode === 'insert' ? boundCols : updateCols
      for (const col of verifyCols) {
        if (!valuesEquivalent(cleanData[col], row[col])) {
          throw new Error(
            `memory_write SILENT FIELD-DROP: table="${table}" id=${row.id} column="${col}" mode=${mode} — ` +
            `intended=${JSON.stringify(cleanData[col])} but persisted=${JSON.stringify(row[col])}.`,
          )
        }
      }
    } else {
      mode = 'insert'
      const sql =
        `INSERT INTO "${table}" (${boundCols.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${boundCols.map(() => '?').join(', ')}) RETURNING ${returningClause}`
      row = db.prepare(sql).get(...values)
      for (const col of boundCols) {
        if (!valuesEquivalent(cleanData[col], row[col])) {
          throw new Error(
            `memory_write SILENT FIELD-DROP: table="${table}" id=${row.id} column="${col}" mode=insert — ` +
            `intended=${JSON.stringify(cleanData[col])} but persisted=${JSON.stringify(row[col])}.`,
          )
        }
      }
    }

    const sessionField = cfg.sessionField
    logEvent(db, mode, table, row.id, cleanData[sessionField] ?? null)
    return { id: row.id, changes: 1, mode, row }
  })
}

// ── memory_query: read rows (feeds recall + the pane) ─────────────────────
function memoryQuery(db, args) {
  const { table, filter } = args || {}
  validateTable(table, ALL_TABLES)
  const cols = tableColumns(db, table)
  const f = filter && typeof filter === 'object' ? filter : {}

  const keys = Object.keys(f)
  for (const k of keys) {
    if (!cols.has(k)) {
      throw new Error(`memory_query: "${k}" is not a column of "${table}". Valid: ${[...cols].join(', ')}`)
    }
  }

  const where = keys.length ? `WHERE ${keys.map((k) => `"${k}" = ?`).join(' AND ')}` : ''
  const values = keys.map((k) => f[k])
  const rows = db.prepare(`SELECT * FROM "${table}" ${where} ORDER BY id DESC`).all(...values)
  return { table, count: rows.length, rows }
}

// ── memory_confirm: bump last_confirmed_at / last_touched_at ─────────────
function memoryConfirm(db, args) {
  const { table, id, session } = args || {}
  validateTable(table, WRITABLE_TABLES)
  if (id == null) throw new Error('memory_confirm: "id" is required.')

  const cols = tableColumns(db, table)
  const touchCols = ['last_confirmed_at', 'last_touched_at'].filter((c) => cols.has(c))
  if (touchCols.length === 0) {
    throw new Error(`memory_confirm: table "${table}" has no last_confirmed_at/last_touched_at column to bump.`)
  }

  const now = nowISO()
  const setClause = touchCols.map((c) => `"${c}" = ?`).join(', ')
  const values = touchCols.map(() => now)
  const returningClause = touchCols.map((c) => `"${c}"`).join(', ')

  // v1 fix (atomicity): write + verify + audit log in one transaction.
  return withTransaction(db, () => {
    const stmt = db.prepare(`UPDATE "${table}" SET ${setClause} WHERE id = ? RETURNING ${returningClause}`)
    const row = stmt.get(...values, id)

    if (!row) throw new Error(`memory_confirm matched 0 rows: id=${id} not found in "${table}".`)
    for (const col of touchCols) {
      if (!valuesEquivalent(now, row[col])) {
        throw new Error(
          `memory_confirm SILENT FIELD-DROP: table="${table}" id=${id} column="${col}" — ` +
          `intended=${JSON.stringify(now)} but persisted=${JSON.stringify(row[col])}.`,
        )
      }
    }

    // v1 fix (session attribution): optional caller-supplied session id now
    // flows into the audit row (was hardcoded null) — the pane's "이번
    // 세션에 삭제한 것" needs it. Backward-compatible: omitting it still
    // logs null exactly as before.
    logEvent(db, 'confirm', table, id, session ?? null)
    return { id, table, confirmed_at: now, columns: touchCols, session: session ?? null }
  })
}

// ── memory_delete: HARD delete + delete-event WITHOUT the deleted content ─
function memoryDelete(db, args) {
  const { table, id, session } = args || {}
  validateTable(table, WRITABLE_TABLES)
  if (id == null) throw new Error('memory_delete: "id" is required.')

  // v1 fix (atomicity): delete + audit log in one transaction.
  const result = withTransaction(db, () => {
    // RETURNING id only — deleted content is never pulled back into JS memory,
    // let alone logged (spec principle #3: content gone, action auditable).
    const row = db.prepare(`DELETE FROM "${table}" WHERE id = ? RETURNING id`).get(id)
    if (!row) throw new Error(`memory_delete matched 0 rows: id=${id} not found in "${table}". Nothing deleted.`)

    // v1 fix (session attribution): see memory_confirm above — same
    // backward-compatible optional session id.
    logEvent(db, 'delete', table, id, session ?? null)
    return { deleted: true, id, table, session: session ?? null }
  })

  // v1 fix (secure delete): PRAGMA secure_delete=ON (set at DB open) zeroes
  // freed pages in the MAIN db file, but WAL-mode writes land in the -wal
  // file first — a deleted row's old bytes can still be sitting in
  // already-committed -wal frames even after the DELETE above commits. A
  // TRUNCATE checkpoint folds all committed WAL frames back into the main
  // file (where secure_delete's zeroing applies) and truncates -wal to
  // empty, so no plaintext residue survives on disk in either file. This
  // MUST run after the deleting transaction commits (checkpointing mid-txn
  // doesn't fold that txn's own uncommitted frames) — best-effort disk
  // hygiene, so on failure we fail loud rather than silently claim a clean
  // secure delete, but we do NOT roll back the already-committed logical
  // delete, which succeeded correctly.
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  if (!checkpoint || checkpoint.busy !== 0) {
    throw new Error(
      `memory_delete: id=${id} table="${table}" deleted successfully, but the post-delete WAL ` +
      `checkpoint(TRUNCATE) did not fully complete (${JSON.stringify(checkpoint)}) — deleted ` +
      `content may still be recoverable from the -wal file on disk.`,
    )
  }

  return result
}

// ── memory_recall_material: session-start helper, raw structured data ────
function memoryRecallMaterial(db, args) {
  const { session } = args || {}
  const open_threads = db
    .prepare(`SELECT * FROM open_threads WHERE status = 'open' ORDER BY salience DESC, last_touched_at DESC LIMIT 5`)
    .all()
  const user_facts = db
    .prepare(`SELECT * FROM user_facts ORDER BY last_confirmed_at DESC LIMIT 20`)
    .all()
  const corrections = db
    .prepare(`SELECT * FROM corrections WHERE still_active = 1 ORDER BY corrected_at DESC`)
    .all()

  return { session: session ?? null, generated_at: nowISO(), open_threads, user_facts, corrections }
}

// ── DB init ────────────────────────────────────────────────────────────
function initDb() {
  const dbDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // v1 fix (concurrency): wait up to 5s on a writer-lock conflict (e.g. this
  // process's own BEGIN IMMEDIATE racing another connection, or the
  // wal_checkpoint below) instead of failing immediately with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000')
  // v1 fix (secure delete): zero freed pages in the main db file on delete,
  // instead of leaving old bytes sitting in unallocated space. Paired with
  // the post-delete wal_checkpoint(TRUNCATE) in memoryDelete (this pragma
  // alone does not clean the -wal file).
  db.exec('PRAGMA secure_delete = ON')
  db.exec(DDL)
  log(`DB ready at ${DB_PATH}`)
  return db
}

// ── MCP tool schema ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'memory_write',
    description:
      'Insert or upsert a row into a memory table (user_facts, open_threads, corrections, preferences). ' +
      'Pass data.id to update an existing row by id; omit it to insert (or upsert, for tables with a natural key: ' +
      'user_facts on subject+predicate, preferences on key). Read-back-verified — throws on silent field-drop. ' +
      'Also throws if data contains any key that is not a real column on the table (fail loud on typos, e.g. ' +
      '"last_tuoched_at"), instead of silently dropping it. The write and its memory_events audit row commit or ' +
      'roll back together as one transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'user_facts | open_threads | corrections | preferences' },
        data: { type: 'object', description: 'Column-value pairs. Include "id" to update by id.', additionalProperties: true },
      },
      required: ['table', 'data'],
    },
  },
  {
    name: 'memory_query',
    description: 'Read rows from a memory table (any of the 5 tables, including memory_events) with an optional equality filter.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'user_facts | open_threads | corrections | preferences | memory_events' },
        filter: { type: 'object', description: 'Column-value equality pairs (optional, AND-combined)', additionalProperties: true },
      },
      required: ['table'],
    },
  },
  {
    name: 'memory_confirm',
    description: 'Bump last_confirmed_at (user_facts) or last_touched_at (open_threads) for a row by id, without creating a new row. Logs a memory_events row (optionally session-attributed), committed atomically with the bump.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'user_facts | open_threads' },
        id: { type: 'number', description: 'Row id to confirm' },
        session: { type: 'string', description: 'Optional current session id, attributed onto the memory_events audit row.' },
      },
      required: ['table', 'id'],
    },
  },
  {
    name: 'memory_delete',
    description: 'HARD delete a row by id. User-initiated only. Logs a memory_events delete row WITHOUT the deleted content (optionally session-attributed), committed atomically with the delete, then secure-erases residue (secure_delete + WAL truncate checkpoint).',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'user_facts | open_threads | corrections | preferences' },
        id: { type: 'number', description: 'Row id to delete' },
        session: { type: 'string', description: 'Optional current session id, attributed onto the memory_events audit row.' },
      },
      required: ['table', 'id'],
    },
  },
  {
    name: 'memory_recall_material',
    description: 'Session-start helper. Returns top open threads (status=open, ordered by salience+recency) + recent user_facts + active corrections, as raw structured data (not phrased).',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Current session identifier (for the returned payload; not used to filter)' },
      },
      required: [],
    },
  },
]

// ── MCP server setup ──────────────────────────────────────────────────────
async function main() {
  const db = initDb()

  const server = new Server(
    { name: `${AGENT_NAME}-memory`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      let result
      switch (name) {
        case 'memory_write':
          result = memoryWrite(db, args)
          break
        case 'memory_query':
          result = memoryQuery(db, args)
          break
        case 'memory_confirm':
          result = memoryConfirm(db, args)
          break
        case 'memory_delete':
          result = memoryDelete(db, args)
          break
        case 'memory_recall_material':
          result = memoryRecallMaterial(db, args)
          break
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      // FAIL LOUD: the full error message is surfaced to the caller, not
      // swallowed. This is the entire point of read-back-verify — a mismatch
      // MUST be visible, not caught-and-ignored.
      log(`Error in ${name}: ${err.message}`)
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
  log(`MCP server up (${AGENT_NAME}-memory), db=${DB_PATH}`)
}

// Only boot the MCP stdio server when run directly (`node server.mjs`), not
// when imported by the smoke test — importing must not open a stdio
// transport or it hangs waiting for a JSON-RPC client.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  main().catch((err) => {
    log(`Fatal: ${err.message}`)
    process.exit(1)
  })
}

export { DDL, valuesEquivalent, numericCoerce, memoryWrite, memoryQuery, memoryConfirm, memoryDelete, memoryRecallMaterial, initDb, DB_PATH }
