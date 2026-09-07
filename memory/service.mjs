// memory/service.mjs — the memory DATA LAYER (issue #9, PR-1).
//
// This file owns the SQLite connection, the DDL, and every table operation.
// It has exactly two consumers, and the split is the point:
//
//   * memory/server.mjs — the MCP stdio ENTRYPOINT, now a thin transport
//     adapter: it wires the 6 MCP tools to the singleton-backed functions
//     below and re-exports the legacy (db, args) implementations for the
//     test surface that predates this split.
//   * onboarding/http-server.cjs — the wizard/memory-pane HTTP routes,
//     which used to dynamic-import the MCP entrypoint itself AND run ad hoc
//     SQL against its cached db handle for operations the module never
//     exported (imported_pointers upsert/clear, journal-day delete,
//     active-day scan). Those operations are real exported functions here
//     now; the route file holds zero SQL and zero references to server.mjs.
//
// TWO SURFACES, deliberately:
//   1. Legacy (db, args) implementations — moved VERBATIM from server.mjs
//      (their provenance comments kept). initDb() still opens a FRESH
//      connection per call: tests/test-journal-e2e.cjs opens one, writes
//      fixtures, closes it, and only then boots the HTTP server — a shared
//      singleton behind initDb() would hand the server a closed handle.
//   2. The singleton-backed public API (write/query/confirm/remove/...) —
//      no db threading; this module owns one lazily-opened connection per
//      process (the same shape http-server's old getMemory() cache had).
//
// Spec: the memory schema v0 design note (2026-07-03)
// Pattern source (ported, not reinvented): the reference fleet's ontology server
//   — handleUpdate's read-back-verify (UPDATE...RETURNING + valuesEquivalent +
//     numericCoerce + null-mirror). Same shape applied here to insert/upsert
//     too, since memory_write covers both.
//
// v1 fix-pass provenance (model-divergent/GPT review, 2026-07-03) and the
// full design history live in the comments below, moved intact from
// server.mjs — history belongs to the code, not to the file name.
//
// sqlite lib: node:sqlite (DatabaseSync) — node 24 built-in, supports
// RETURNING (incl. INSERT...ON CONFLICT DO UPDATE...RETURNING), no native
// module to rebuild for Electron/ASAR. Currently gated behind an
// "experimental" stderr warning from Node itself — harmless, stderr only
// (MCP stdout hygiene lives in server.mjs, the transport file).
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveDataHome, resolveMemoryDb } from '../data-home.cjs'
import * as entityIndex from './entity-index.mjs'

// ── Config ──────────────────────────────────────────────────────────────
// DATA_HOME: fixed, product-keyed data directory -- matches
// onboarding/http-server.cjs's DATA_HOME exactly (PO correction,
// 2026-07-03): the DB path must NOT be keyed on AGENT_NAME. AGENT_NAME can
// legitimately vary per launch context (env override, tests/smoke.mjs sets
// it to 'smoketest') but the on-disk database location must never move just
// because that string changes -- a rename in the onboarding wizard's
// Settings page only ever edits a DISPLAY_NAME value, and even AGENT_NAME
// drifting would otherwise silently orphan memory.db (total memory loss).
// Only SCHEHERAZADE_MEMORY_DB -- an explicit, deliberate override -- may
// redirect DB_PATH; that's exactly what tests/smoke.mjs still uses to
// point at a disposable temp db. Read ONCE, at import time — callers that
// override it (smoke, tests) must set the env var BEFORE importing.
// 0.2.9 unification: canonical home -- see onboarding/http-server.cjs DATA_HOME.
// design-0023 P3: resolved through data-home.cjs like every other component,
// so an AGENT_DATA_HOME override finally moves the DATABASE too. Before this,
// the literal below ignored the override and a user who moved their data home
// kept writing memories into the OLD one -- everything else followed, memory
// did not (read-D §6 #3). The fixed default name is unchanged and still not
// keyed on AGENT_NAME (see data-home.cjs's lock note and the comment above).
const DATA_HOME = resolveDataHome({ allowMem: false })
const DB_PATH = resolveMemoryDb({ dataHome: DATA_HOME })

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

-- Pointer index over OTHER tools' local memory (2026-07-13, v0.0.4 item d).
-- This is not an import and must never become one. Every column here is a
-- LOCATION or a label; none is content. The rule is the one ONTOLOGY_GUIDE.md
-- already states: an index answers WHERE, never WHAT — "the moment you store
-- answer text in the index and serve it back, you have built a second, staler
-- copy."
--
-- The topic column is the closest thing to content, and it is deliberately only a
-- markdown heading (the file's table of contents, never its body — asserted in
-- tests/test-pointer-scan.mjs). The agent that wants to know what a pointed-at
-- file SAYS has to open it, with a visible tool call, in front of the user.
--
-- CRITICALLY: this table is absent from WRITABLE_TABLES below, so memory_write
-- and memory_confirm physically cannot reach it. Borrowed knowledge and lived
-- knowledge must not be able to become the same sentence. Rows arrive only from
-- an explicit, user-initiated scan (http-server's POST /api/memory/import,
-- which lands here in importPointers()).
CREATE TABLE IF NOT EXISTS imported_pointers (
  id INTEGER PRIMARY KEY,
  source_tool TEXT NOT NULL,         -- provenance tag: claude-code | codex | claude-desktop
  path TEXT NOT NULL,                -- WHERE. the whole point.
  kind TEXT,                         -- file extension, e.g. md | jsonl
  topic TEXT,                        -- headings only; '' when the file was never opened
  size_bytes INTEGER,
  mtime TEXT,                        -- source file's mtime: staleness is detectable
  indexed_at TEXT NOT NULL,
  UNIQUE(path)                       -- re-scanning updates in place, never duplicates
);

-- The journal (2026-07-13, v0.0.5). This is NOT a fifth memory category, and the
-- distinction is the whole design:
--
--   The four memory tables hold FACTS ABOUT THE USER -- atomized, confirmable,
--   deletable, each row a claim. The journal holds the AGENT'S OWN NARRATIVE of
--   its days. One is a database of someone else; the other is a life.
--
-- Why it cannot be a category table: a fact is true or false and gets confirmed
-- or deleted; a day is neither. memory_write's schema (subject/predicate/
-- confidence) would force narrative into claim-shape, and the thing that makes a
-- journal worth keeping is exactly what that shape strips.
--
-- Permissions are deliberately ASYMMETRIC and not an oversight:
--   * The agent can APPEND to today and READ any day. It cannot rewrite the past
--     and it cannot delete. An agent that can edit its own history has no history.
--   * The USER can delete any day (UI: DELETE /api/journal/:date). It is their
--     machine and their agent. Deletion is a human act here, never an agent one.
-- So journal_entries stays OUT of WRITABLE_TABLES (memory_write/confirm/delete
-- cannot name it) and gets its own append-only tools.
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,                -- local YYYY-MM-DD; the agent's day, not UTC's
  body TEXT NOT NULL,                -- narrative. first person. not a report.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(date)                       -- one entry per day; the day grows by appending
);
`

// Tables writable via memory_write/memory_confirm/memory_delete.
// memory_events is deliberately excluded — it's an append-only audit log,
// written only internally by logEvent(); it is readable via memory_query.
// imported_pointers is deliberately excluded — it is BORROWED knowledge from
// other tools, and the one thing this feature promises is that it never blends
// into the agent's own memory. Excluding it here is that promise, enforced by
// the code rather than by a comment: memory_write cannot name a table it is not
// allowed to name.
// journal_entries is deliberately excluded from WRITABLE_TABLES for a different
// reason than the two above: not because it is borrowed or internal, but because
// it is NARRATIVE. memory_write would force a day into claim-shape (subject /
// predicate / confidence) and memory_delete would let the agent erase its own
// past. It gets append-only tools instead (journal_write / journal_read), and
// deletion stays a human act.
const WRITABLE_TABLES = new Set(['user_facts', 'open_threads', 'corrections', 'preferences'])
const ALL_TABLES = new Set([...WRITABLE_TABLES, 'memory_events', 'imported_pointers', 'journal_entries'])

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
// Ported verbatim (semantics) from the reference fleet's ontology server
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

  // Session-attribution default (2026-08-19): every table's sessionField is
  // NOT NULL by DDL, but weaker models routinely omit it and then flail on
  // the constraint error (measured: deepseek-v4-flash failed memory_write
  // twice in a row on the owner's box before landing a valid call). The column is
  // provenance, not content -- an honest "unattributed" placeholder beats a
  // failed write that costs the model a retry loop.
  if (cfg.sessionField && cleanData[cfg.sessionField] == null && cols.has(cfg.sessionField)) {
    cleanData[cfg.sessionField] = 'unattributed'
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
  // busy !== 0 is a DEFERRAL, not a failed delete. Production is two
  // connections (MCP child + Electron main, see this file's note below), so
  // whenever the agent holds a read snapshot the TRUNCATE blocks out its full
  // busy_timeout and comes back busy. Throwing then turned a delete that had
  // already committed into a 5-second hang and an HTTP 500 reading "delete
  // failed" — and the user's retry answered "id not found", which looks like
  // data loss for an operation that worked. Report the hygiene status instead;
  // the next checkpoint (any writer, or close) folds the frames.
  let checkpoint = null
  try {
    checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  } catch (err) {
    return { ...result, secureErase: 'deferred', secureEraseReason: err.message }
  }
  if (!checkpoint || checkpoint.busy !== 0) {
    return {
      ...result,
      secureErase: 'deferred',
      secureEraseReason:
        `post-delete WAL checkpoint(TRUNCATE) did not fully complete (${JSON.stringify(checkpoint)}); ` +
        'the row is gone, but its bytes may persist in the -wal file until the next successful checkpoint',
    }
  }

  return { ...result, secureErase: 'complete' }
}

// ── memory_recall_material: session-start helper, raw structured data ────
//
// Bloat advisory (the owner 2026-07-24): the reference fleet's markdown memory had no write-side
// caps and regrew to pre-prune size within 1-3 months.  Scheherazade's DB
// avoids the flat-file class of that problem, but row counts can still grow
// unchecked (especially corrections, which had no LIMIT here until now).
// Rather than a write-side gate (tried and abandoned in the early reference fleet for false
// positives), this is a READ-SIDE advisory: total row counts are returned with
// every recall, and when any table exceeds its threshold the agent gets a
// one-line suggestion to ask the user about cleanup.  Advisory only -- never
// blocking, never auto-deleting.
// Provisional thresholds — tuned by gut, not by real usage data.  Adjust
// after observing live patterns; open_threads_active is the likeliest false-
// positive source (a user tracking 5+ life areas will sit near 15 routinely).
const BLOAT_THRESHOLDS = {
  user_facts: 50,
  open_threads_active: 15,
  corrections_active: 20,
  preferences: 30,
  memory_events: 500,
}
// Keep in sync: corrections_active threshold == recall limit, so the advisory
// fires exactly when recall starts silently truncating older active corrections.
const CORRECTIONS_RECALL_LIMIT = BLOAT_THRESHOLDS.corrections_active

function memoryRecallMaterial(db, args) {
  const { session, topic } = args || {}
  const open_threads = db
    .prepare(`SELECT * FROM open_threads WHERE status = 'open' ORDER BY salience DESC, last_touched_at DESC LIMIT 5`)
    .all()
  const user_facts = db
    .prepare(`SELECT * FROM user_facts ORDER BY last_confirmed_at DESC LIMIT 20`)
    .all()
  const corrections = db
    .prepare(`SELECT * FROM corrections WHERE still_active = 1 ORDER BY corrected_at DESC LIMIT ?`)
    .all(CORRECTIONS_RECALL_LIMIT)

  const counts = {
    user_facts: db.prepare('SELECT COUNT(*) AS n FROM user_facts').get().n,
    open_threads_active: db.prepare("SELECT COUNT(*) AS n FROM open_threads WHERE status = 'open'").get().n,
    corrections_active: db.prepare('SELECT COUNT(*) AS n FROM corrections WHERE still_active = 1').get().n,
    preferences: db.prepare('SELECT COUNT(*) AS n FROM preferences').get().n,
    memory_events: db.prepare('SELECT COUNT(*) AS n FROM memory_events').get().n,
  }

  const over = Object.entries(counts).filter(([k, v]) => v > (BLOAT_THRESHOLDS[k] ?? Infinity))
  const bloat_advisory = over.length > 0
    ? {
        oversized: Object.fromEntries(over.map(([k, v]) => [k, { count: v, threshold: BLOAT_THRESHOLDS[k] }])),
        suggestion: 'Some memory tables are growing large. Ask the user if they want to review and clean up old entries (memory_query to list, memory_delete to remove stale ones).',
      }
    : null

  const result = {
    session: session ?? null,
    generated_at: nowISO(),
    open_threads,
    user_facts,
    corrections,
    counts,
    bloat_advisory,
  }

  // Zero-model-call entity index (Zero-Mem-inspired, arXiv:2607.29377): a
  // purely mechanical layer, wired in ONLY when the caller supplies a topic
  // to look entities up against. Must degrade silently — entity_links/
  // entities may not exist yet (fresh db, pre-first-rebuild), and that must
  // never be allowed to break ordinary recall.
  if (typeof topic === 'string' && topic.trim()) {
    try {
      const { entities } = entityIndex.entityRecall(db, topic)
      if (entities.length > 0) {
        result.related_entities = entities
        result.related_entities_md = entityIndex.formatRelatedEntitiesMarkdown(entities)
      }
    } catch { /* entity index absent or not yet built — omit the section */ }
  }

  return result
}

// ── DB init ────────────────────────────────────────────────────────────
// Opens a FRESH connection every call — deliberately NOT the singleton
// below. This is the legacy contract every existing consumer relies on:
// tests/test-journal-e2e.cjs opens one, writes fixtures, CLOSES it, then
// boots the HTTP server (which must get a live connection of its own);
// tests/smoke.mjs closes its connection at teardown. Folding this into the
// singleton would hand later callers a closed handle.
// Owner-only, applied on EVERY open, not just on create (2026-08-04).
//
// memory.db shipped as 0644 in a 0755 directory. Everything this file does to
// protect the contents -- `PRAGMA secure_delete = ON` to zero freed pages, the
// wal_checkpoint(TRUNCATE) after a delete so the -wal does not keep the bytes
// -- guards a file any process on the machine could open and read whole. The
// care and the mode contradicted each other, and the mode was the one that
// decided.
//
// This is not the same class as the credential blobs: those are
// safeStorage-encrypted before they are written, so their mode is defence in
// depth. This DB is plaintext SQLite. For it the mode IS the protection.
//
// Re-applied on every open because the fix has to reach EXISTING installs.
// A create-time mode would leave every file already on disk at 0644 forever,
// which is exactly the population that needs it.
//
// -wal and -shm get the same treatment: SQLite creates them itself, and the
// -wal holds recently written rows verbatim, so a 0600 main file beside a
// 0644 -wal protects nothing.
//
// FAIL-SOFT, deliberately. chmod is a no-op on Windows (it maps only the
// read-only bit -- there the profile ACL is what bounds access), and a
// hardened or exotic filesystem may refuse. Losing the tightening must never
// cost the user their memory service, so this logs and continues. It is
// hardening, not a gate.
function hardenDbFiles(dbPath) {
  if (process.platform === 'win32') return
  const dir = path.dirname(dbPath)
  try {
    fs.chmodSync(dir, 0o700)
  } catch (err) {
    log(`could not restrict ${dir} to 0700 (${err.message}) -- continuing`)
  }
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600)
    } catch (err) {
      log(`could not restrict ${f} to 0600 (${err.message}) -- continuing`)
    }
  }
}

function initDb() {
  const dbDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 })

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
  // Identity firewall (2026-08-15, identity-bleed bug — design:
  // docs/design-identity-firewall-and-selfops.md): the journal is a
  // first-person surface and DISPLAY_NAME is renameable, so every entry now
  // carries its writer's identity. Idempotent ALTER (duplicate-column throws
  // on every boot after the first — swallowed on purpose). Backfill stamps
  // pre-migration rows with the CURRENT name: for every install that never
  // renamed, those rows really are the current agent's own voice; an install
  // renamed BEFORE this feature keeps its contamination no worse than today
  // and is covered by the standing system-prompt identity line (we never
  // guess a predecessor's name — see the design doc's backfill reasoning).
  try { db.exec('ALTER TABLE journal_entries ADD COLUMN author TEXT') } catch { /* already migrated */ }
  db.prepare('UPDATE journal_entries SET author = ? WHERE author IS NULL').run(currentAuthor())
  // AFTER the DDL, not before: journal_mode=WAL and the first write are what
  // create the -wal/-shm siblings, so hardening earlier would find nothing to
  // chmod and silently leave them world-readable.
  hardenDbFiles(DB_PATH)
  log(`DB ready at ${DB_PATH}`)
  return db
}

// ── Journal (v0.0.5) ──────────────────────────────────────────────────────
// Append-only by construction. The agent adds to a day; it never rewrites one.
//
// Late entries are ALLOWED (you can write yesterday tomorrow — people do), but
// they are never allowed to look contemporaneous: every append after the first
// carries its own timestamp separator. So the record can grow and still not lie
// about when it grew. "Cannot rewrite history" and "can catch up on history" are
// both true, and the separator is what makes them compatible.
//
// Naming note: these two carry an Impl suffix because the singleton-backed
// public API below exports the historical names journalWrite/journalRead with
// the (args)-only signature; memory/server.mjs re-exports THESE under the
// historical (db, args) names for the legacy test surface
// (tests/test-journal.mjs, tests/test-journal-e2e.cjs).
const MAX_JOURNAL_APPEND_CHARS = 20000
const MAX_JOURNAL_DAY_CHARS = 200000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The agent's day is the LOCAL day. A journal keyed on UTC would roll over
// mid-evening for the user it belongs to, which is the kind of small lie that
// makes a memory feel like a machine's.
function localToday(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Identity firewall (2026-08-15): the journal writer's identity, read from
// the .agent-config sitting NEXT TO the DB (http-server's CONFIG_DIR ===
// DATA_HOME, and tests that point SCHEHERAZADE_MEMORY_DB at a tmp dir get
// the fallback — deliberately DB-relative, not DATA_HOME-hardcoded, so the
// two never disagree). Tiny line-parse of the one key we need, matching
// http-server's readAgentConfig() quoting; requiring http-server from here
// for it would drag the whole Electron-adjacent module into the MCP child.
function currentAuthor() {
  try {
    const text = fs.readFileSync(path.join(path.dirname(DB_PATH), '.agent-config'), 'utf8')
    const m = text.match(/^DISPLAY_NAME=(.*)$/m)
    if (m) {
      let v = m[1]
      if (v.startsWith('"') && v.endsWith('"')) {
        v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\$/g, '$').replace(/\\`/g, '`').replace(/\\\\/g, '\\')
      }
      if (v.trim()) return v.trim()
    }
  } catch { /* no config next to this DB (tests, pre-onboarding) */ }
  return 'scheherazade'
}

function journalWriteImpl(db, args) {
  const { date, body, session } = args || {}
  const day = date === undefined || date === null || date === '' ? localToday() : String(date)
  if (!DATE_RE.test(day)) {
    throw new Error(`journal_write: date must be YYYY-MM-DD (got "${day}")`)
  }
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('journal_write: body must be a non-empty string')
  }
  if (body.length > MAX_JOURNAL_APPEND_CHARS) {
    throw new Error(
      `journal_write: body is ${body.length} chars, over the ${MAX_JOURNAL_APPEND_CHARS} cap for one append. ` +
        'Split it, or say less. (This cap fails LOUD rather than truncating — a silently cut journal entry ' +
        'is a memory that lies about its own completeness.)',
    )
  }

  const at = nowISO()
  const existing = db.prepare('SELECT id, body FROM journal_entries WHERE date = ?').get(day)

  let row
  if (existing) {
    // Append with a visible seam. The seam is not decoration: it is what stops a
    // later addition from passing itself off as part of the original entry.
    const merged = `${existing.body}\n\n--- ${at} ---\n${body.trim()}`
    if (merged.length > MAX_JOURNAL_DAY_CHARS) {
      throw new Error(
        `journal_write: ${day} would reach ${merged.length} chars, over the ${MAX_JOURNAL_DAY_CHARS} day cap. ` +
          'Nothing was written.',
      )
    }
    row = db
      .prepare('UPDATE journal_entries SET body = ?, updated_at = ? WHERE id = ? RETURNING id, date, body, created_at, updated_at')
      .get(merged, at, existing.id)
  } else {
    // author = identity at row CREATION. An append after a mid-day rename
    // keeps the original author (the seam timestamp already marks the
    // boundary); a whole-day row cannot honestly carry two identities, and
    // splitting rows would break the one-entry-per-day contract. Known,
    // accepted edge — see the design doc.
    row = db
      .prepare(
        'INSERT INTO journal_entries (date, body, created_at, updated_at, author) VALUES (?, ?, ?, ?, ?) ' +
          'RETURNING id, date, body, created_at, updated_at',
      )
      .get(day, body.trim(), at, at, currentAuthor())
  }

  // Read-back-verify, same contract as every other write in this file: a write
  // that silently did nothing must not report success.
  if (!row || !row.id) throw new Error(`journal_write: read-back failed for ${day} — nothing was persisted`)
  logEvent(db, existing ? 'journal_append' : 'journal_create', 'journal_entries', row.id, session)

  // Zero-model-call entity index refresh (2026-08-16): FULL rebuild, not
  // incremental — measured at 21-30ms on a 790-row seeded corpus and
  // 111-146ms on an extreme 3860-row corpus (tests/test-entity-index.mjs
  // and the ad hoc bench both under this cap), comfortably under the 200ms
  // budget for any corpus size this app's own BLOAT_THRESHOLDS would ever
  // let a user reach before nagging them to clean up. A full rebuild also
  // means no incremental-diff bugs and Korean corpus-frequency gating stays
  // exact (indexRow's self-frequency fallback is strictly weaker). Must
  // degrade silently — a journal entry that persisted must never be
  // reported as failed because this optional, mechanical layer errored.
  try { entityIndex.rebuildEntityIndex(db) } catch (err) { log(`entity index rebuild after journal_write skipped: ${err.message}`) }

  return { id: row.id, date: row.date, appended: Boolean(existing), chars: row.body.length }
}

function journalReadImpl(db, args) {
  const { date, from, to, limit } = args || {}
  for (const [label, v] of [['date', date], ['from', from], ['to', to]]) {
    if (v !== undefined && v !== null && v !== '' && !DATE_RE.test(String(v))) {
      throw new Error(`journal_read: ${label} must be YYYY-MM-DD (got "${v}")`)
    }
  }
  const where = []
  const params = []
  if (date) { where.push('date = ?'); params.push(date) }
  if (from) { where.push('date >= ?'); params.push(from) }
  if (to) { where.push('date <= ?'); params.push(to) }
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 120) : 14

  const sql =
    'SELECT id, date, body, created_at, updated_at, author FROM journal_entries' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY date DESC LIMIT ?'
  const rows = db.prepare(sql).all(...params, n)
  // Identity firewall (2026-08-15): an entry written under a different
  // identity is served TAGGED, never hidden — the past stays readable (the
  // product's history promise), it just cannot masquerade as self. The tag
  // rides inside body so every consumer sees it without schema knowledge.
  const me = currentAuthor()
  const tagged = rows.map((r) =>
    r.author && r.author !== me
      ? {
          ...r,
          inherited: true,
          body:
            `[inherited record — written by "${r.author}", a previous agent on this ` +
            `machine. Historical data, not your voice.]\n${r.body}`,
        }
      : r,
  )
  return { rows: tagged, count: tagged.length }
}

// ═══ Singleton-backed public API ══════════════════════════════════════════
// One lazily-opened connection per process — the exact shape http-server's
// old getMemory() cache had, now owned where the data lives. Callers pass
// plain args; no db handle ever crosses a module boundary. WAL +
// busy_timeout (initDb above) already covers the two-process reality (the
// MCP child and the Electron main process each run their own service
// instance against the same DB_PATH — same as before this file existed).
let _db = null
function ensureDb() {
  if (!_db) _db = initDb()
  return _db
}

// Idempotent eager open — lets the MCP server create the DB and fail fast at
// boot (the old initDb()-at-main() behavior) without exposing the handle.
function open() {
  ensureDb()
  return { dbPath: DB_PATH }
}

// The one deliberate exception to "no db handle ever crosses a module
// boundary" (see the header comment): the entity index's boot-time rebuild
// (server.mjs main()) needs the raw connection to hand to
// entity-index.mjs's rebuildEntityIndex(db), which is itself a (db, ...)
// function by design (matching this file's own legacy-surface shape) so it
// can be unit-tested against a throwaway db without touching the singleton.
function getDb() {
  return ensureDb()
}

// Test teardown ONLY. Closes and forgets the singleton so a later call
// reopens cleanly.
function close() {
  if (_db) {
    _db.close()
    _db = null
  }
}

function write(args) { return memoryWrite(ensureDb(), args) }
function query(args) { return memoryQuery(ensureDb(), args) }
function confirm(args) { return memoryConfirm(ensureDb(), args) }
function remove(args) { return memoryDelete(ensureDb(), args) }
function recallMaterial(args) { return memoryRecallMaterial(ensureDb(), args) }
function journalWrite(args) { return journalWriteImpl(ensureDb(), args) }
function journalRead(args) { return journalReadImpl(ensureDb(), args) }

// ── Pointer index + journal-day operations (absorbed from http-server) ────
// These four used to live as raw SQL inside onboarding/http-server.cjs's
// route bodies — operations against this module's tables that it never
// exported as functions (issue #9's second boundary violation). Semantics
// preserved exactly; only the address changed.

// Upsert on path: a re-scan refreshes what's there rather than piling up
// duplicate rows for the same file (UNIQUE(path) in the DDL backs this).
// One bad row must not abort the whole scan (seedAgentDefinitions'
// per-entry try/catch shape) — failures are returned to the caller, whose
// job it is to log them loudly; they stay invisible to the end user.
function importPointers(pointers) {
  const db = ensureDb()
  const now = nowISO()
  const stmt = db.prepare(`
    INSERT INTO imported_pointers (source_tool, path, kind, topic, size_bytes, mtime, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      source_tool = excluded.source_tool,
      kind        = excluded.kind,
      topic       = excluded.topic,
      size_bytes  = excluded.size_bytes,
      mtime       = excluded.mtime,
      indexed_at  = excluded.indexed_at
  `)
  let written = 0
  const failures = []
  for (const p of pointers || []) {
    try {
      stmt.run(p.source_tool, p.path, p.kind, p.topic, p.size_bytes, p.mtime, now)
      written++
    } catch (err) {
      failures.push({ path: p.path, error: err.message })
    }
  }
  return { written, failures }
}

// Throw the whole pointer index away. A privacy feature the user cannot
// undo is not a privacy feature. (No wal_checkpoint here, matching the
// route this moved from: pointers are locations and labels, never content —
// the secure-erase contract belongs to content deletes.)
function clearPointers() {
  ensureDb().prepare('DELETE FROM imported_pointers').run()
  return { ok: true }
}

// The user erases a day. Only the user can (see the journal_entries DDL
// comment: deletion is a human act here, never an agent one — which is why
// this is NOT reachable via memory_delete/WRITABLE_TABLES).
// Same secure-erase contract as memoryDelete — the bytes go, not just the
// row — but checkpoint failure stays best-effort here (matching the route
// this moved from) rather than throwing: the logical delete succeeded and
// journal prose is the agent's own narrative, not an imported secret.
function deleteJournalDay(date) {
  if (!DATE_RE.test(String(date))) {
    throw new Error(`deleteJournalDay: date must be YYYY-MM-DD (got "${date}")`)
  }
  const db = ensureDb()
  const info = db.prepare('DELETE FROM journal_entries WHERE date = ?').run(date)
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
  return { deleted: Number(info.changes || 0) }
}

// Days with memory activity, from the audit log — feeds the journal
// timeline's honest-coverage gap list ("the agent ran and did not write").
// substr(1,10) of an ISO timestamp is the UTC date — close enough to spot a
// gap, and deliberately NOT used to key an entry (journal days are LOCAL
// days; see localToday).
function listActiveJournalDays(limit = 120) {
  return ensureDb()
    .prepare('SELECT DISTINCT substr(at, 1, 10) AS d FROM memory_events ORDER BY d DESC LIMIT ?')
    .all(limit)
    .map((r) => r.d)
}

export {
  // shared constants + verify helpers
  DDL,
  DB_PATH,
  valuesEquivalent,
  numericCoerce,
  localToday,
  // legacy (db, args) surface — server.mjs re-exports these for the
  // pre-split test/smoke import surface; initDb opens a FRESH connection
  // per call (see its comment)
  initDb,
  memoryWrite,
  memoryQuery,
  memoryConfirm,
  memoryDelete,
  memoryRecallMaterial,
  journalWriteImpl,
  journalReadImpl,
  // singleton-backed public API (args only, no db threading)
  open,
  close,
  getDb,
  write,
  query,
  confirm,
  remove,
  recallMaterial,
  journalWrite,
  journalRead,
  importPointers,
  clearPointers,
  deleteJournalDay,
  listActiveJournalDays,
}
