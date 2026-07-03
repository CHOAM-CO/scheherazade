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
const DDL = `
-- one current value per (subject,predicate); re-learning bumps last_confirmed
CREATE TABLE IF NOT EXISTS user_facts (
  id INTEGER PRIMARY KEY,
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
  id INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,             -- "X 마저 정리하기로 함"
  status TEXT NOT NULL DEFAULT 'open', -- open | done | stale
  opened_session TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_touched_at TEXT NOT NULL,     -- recency for recall ranking
  salience REAL DEFAULT 1.0          -- decays; recall pulls highest
);

-- distrust productized: hooks READ active rows as gating constraints ("훅이 제일 킥임")
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY,
  what_was_wrong TEXT NOT NULL,      -- "존댓말 썼는데 반말 요청"
  correct_behavior TEXT NOT NULL,    -- "always 반말"
  corrected_session TEXT NOT NULL,
  corrected_at TEXT NOT NULL,
  still_active INTEGER DEFAULT 1
);

-- onboarding 3-Q = first rows
CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,          -- "reply_length","format","contact_window","register"
  value TEXT NOT NULL,
  source_session TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- audit trail of memory ACTIONS, never deleted content (see principle 3)
CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,               -- insert | update | delete | confirm
  table_name TEXT NOT NULL,
  row_id INTEGER,                    -- may dangle after hard delete (intentional)
  session TEXT,
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
}

function memoryWriteInsertOrUpsert(db, table, cleanData, cols) {
  const cfg = TABLE_CONFIG[table]
  const now = nowISO()

  for (const col of cfg.timestampDefaults) {
    if (cleanData[col] == null && cols.has(col)) cleanData[col] = now
  }

  const boundCols = Object.keys(cleanData).filter((c) => cols.has(c))
  if (boundCols.length === 0) throw new Error(`memory_write: no valid columns for table "${table}".`)
  const values = boundCols.map((c) => cleanData[c])
  const returningClause = [...boundCols.map((c) => `"${c}"`), '"id"'].join(', ')

  let mode, row
  if (cfg.conflictCols) {
    // Pre-check existence so the audit event honestly reports insert vs
    // update (INSERT...ON CONFLICT...RETURNING alone can't tell us which
    // branch fired).
    const conflictVals = cfg.conflictCols.map((c) => cleanData[c])
    if (conflictVals.some((v) => v == null)) {
      throw new Error(`memory_write: table "${table}" requires ${cfg.conflictCols.join(', ')} (upsert key).`)
    }
    const existing = db
      .prepare(`SELECT id FROM "${table}" WHERE ${cfg.conflictCols.map((c) => `"${c}" = ?`).join(' AND ')}`)
      .get(...conflictVals)
    mode = existing ? 'update' : 'insert'

    const immutable = new Set([...cfg.conflictCols, ...cfg.immutable])
    const updateCols = boundCols.filter((c) => !immutable.has(c))
    const setClause = updateCols.map((c) => `"${c}" = excluded."${c}"`).join(', ')
    const sql =
      `INSERT INTO "${table}" (${boundCols.map((c) => `"${c}"`).join(', ')}) ` +
      `VALUES (${boundCols.map(() => '?').join(', ')}) ` +
      `ON CONFLICT(${cfg.conflictCols.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${setClause} ` +
      `RETURNING ${returningClause}`
    row = db.prepare(sql).get(...values)

    // Verify: on a fresh insert every bound value is genuinely intended and
    // checkable. On a conflict-update, immutable cols (conflict key +
    // created_at/opened_at) are excluded from the SET clause by design, so
    // the returned value is deliberately the OLD row's value, not what we
    // bound — verifying those would be a guaranteed false positive.
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
  const { table, id } = args || {}
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

  logEvent(db, 'confirm', table, id, null)
  return { id, table, confirmed_at: now, columns: touchCols }
}

// ── memory_delete: HARD delete + delete-event WITHOUT the deleted content ─
function memoryDelete(db, args) {
  const { table, id } = args || {}
  validateTable(table, WRITABLE_TABLES)
  if (id == null) throw new Error('memory_delete: "id" is required.')

  // RETURNING id only — deleted content is never pulled back into JS memory,
  // let alone logged (spec principle #3: content gone, action auditable).
  const row = db.prepare(`DELETE FROM "${table}" WHERE id = ? RETURNING id`).get(id)
  if (!row) throw new Error(`memory_delete matched 0 rows: id=${id} not found in "${table}". Nothing deleted.`)

  logEvent(db, 'delete', table, id, null)
  return { deleted: true, id, table }
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
      'user_facts on subject+predicate, preferences on key). Read-back-verified — throws on silent field-drop. Logs a memory_events row.',
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
    description: 'Bump last_confirmed_at (user_facts) or last_touched_at (open_threads) for a row by id, without creating a new row. Logs a memory_events row.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'user_facts | open_threads' },
        id: { type: 'number', description: 'Row id to confirm' },
      },
      required: ['table', 'id'],
    },
  },
  {
    name: 'memory_delete',
    description: 'HARD delete a row by id. User-initiated only. Logs a memory_events delete row WITHOUT the deleted content.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'user_facts | open_threads | corrections | preferences' },
        id: { type: 'number', description: 'Row id to delete' },
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
