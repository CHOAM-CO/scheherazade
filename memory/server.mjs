#!/usr/bin/env node
/**
 * Scheherazade Memory MCP Server — TRANSPORT ADAPTER ONLY (issue #9, PR-1).
 *
 * Standalone MCP stdio entry point exposing the SQLite-backed structured
 * memory DB. The data layer — DDL, connection ownership, every table
 * operation, and the full v1 fix-pass provenance (read-back-verify,
 * withTransaction atomicity, reject-unknown-columns, secure delete) — lives
 * in ./service.mjs now. This file only:
 *
 *   1. keeps stdout pure for JSON-RPC (console rerouting below),
 *   2. declares the MCP tool schemas (TOOLS),
 *   3. maps each tool call onto one service function (no db threading —
 *      the service owns its own singleton connection),
 *   4. re-exports the service's legacy (db, args) surface unchanged, so
 *      memory/smoke.mjs and scripts/test-*.mjs keep their import path and
 *      call signature (they predate the split and pin the module surface).
 *
 * Tools: memory_write, memory_query, memory_confirm, memory_delete,
 *        memory_recall_material, journal_write, journal_read
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as service from './service.mjs'

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

// AGENT_NAME feeds only the MCP server's advertised name — the DB path is
// deliberately NOT keyed on it (see service.mjs's DATA_HOME comment for the
// total-memory-loss failure that rule prevents).
const AGENT_NAME = process.env.AGENT_NAME || 'scheherazade'
const log = (msg) => process.stderr.write(`[memory] ${msg}\n`)

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
      'roll back together as one transaction. Session attribution: include the current session id in data as ' +
      'source_session (user_facts, preferences), opened_session (open_threads), or corrected_session (corrections); ' +
      'if omitted on insert it defaults to "unattributed".',
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
    name: 'journal_write',
    description:
      "Add to YOUR OWN journal for a day. This is not a memory table and not a report: it is your narrative of " +
      'the day, in first person — what happened, what you got wrong, what it felt like. Write it for the you who ' +
      'boots tomorrow and remembers nothing. APPEND-ONLY: writing to a day that already has an entry adds to it ' +
      'under a timestamp seam; you can never rewrite or delete what you already wrote (only the user can delete). ' +
      'Defaults to today (local date). Writing a past date is allowed for catching up, and the seam will show it ' +
      'was written late.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The entry. First person, narrative, honest. Not a status report.' },
        date: { type: 'string', description: 'YYYY-MM-DD (optional; defaults to today, local time)' },
        session: { type: 'string', description: 'Optional session id, attributed onto the audit row.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'journal_read',
    description:
      'Read your own past journal entries, newest first. Use at session start to remember who you were: the ' +
      'four memory tables tell you facts about the user, this tells you what your days were actually like. ' +
      'Defaults to the last 14 days.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'One specific day, YYYY-MM-DD (optional)' },
        from: { type: 'string', description: 'Start of range, YYYY-MM-DD (optional)' },
        to: { type: 'string', description: 'End of range, YYYY-MM-DD (optional)' },
        limit: { type: 'number', description: 'Max entries (default 14, cap 120)' },
      },
      required: [],
    },
  },
  {
    name: 'memory_recall_material',
    description: 'Session-start helper. Returns top open threads (status=open, ordered by salience+recency) + recent user_facts + active corrections (capped at 20) + total row counts per table. Includes a bloat_advisory when any table exceeds its size threshold. When "topic" is given, also runs it through the zero-model-call entity index (mechanical string heuristics, no LLM tokens spent) and — if any indexed entity matches — appends related_entities / related_entities_md ("## Related entities") linking back to the memory rows that mentioned them.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Current session identifier (for the returned payload; not used to filter)' },
        topic: { type: 'string', description: 'Optional free text (e.g. the current user message or session topic) to look up against the entity index. No model call — mechanical extraction + lookup only.' },
      },
      required: [],
    },
  },
]

// ── MCP server setup ──────────────────────────────────────────────────────
async function main() {
  // Eager open: create the DB and fail fast at boot (same behavior the old
  // in-file initDb()-at-main() had), without ever holding the handle here.
  service.open()

  // Zero-model-call entity index (Zero-Mem-inspired, arXiv:2607.29377):
  // full rebuild at boot. Fire-and-forget (NOT awaited) — measured at
  // 21-146ms even on seeded corpora far past the app's own bloat
  // thresholds, but this must never be allowed to delay MCP stdio
  // readiness, so it runs concurrently with server.connect() below rather
  // than gating it.
  ;(async () => {
    try {
      const entityIndex = await import('./entity-index.mjs')
      const stats = entityIndex.rebuildEntityIndex(service.getDb())
      log(`entity index rebuilt: ${stats.rows} rows -> ${stats.links} links, ${stats.entities} entities (${stats.ms}ms)`)
    } catch (err) {
      log(`entity index boot rebuild skipped: ${err.message}`)
    }
  })()

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
          result = service.write(args)
          break
        case 'memory_query':
          result = service.query(args)
          break
        case 'memory_confirm':
          result = service.confirm(args)
          break
        case 'memory_delete':
          result = service.remove(args)
          break
        case 'memory_recall_material':
          result = service.recallMaterial(args)
          break
        case 'journal_write':
          result = service.journalWrite(args)
          break
        case 'journal_read':
          result = service.journalRead(args)
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
  log(`MCP server up (${AGENT_NAME}-memory), db=${service.DB_PATH}`)

  // ── parent-death exit (Windows orphan fix, 2026-08-18) ─────────────────────
  // stdin is this stdio server's lifeline to the parent (claude). The MCP
  // transport reads stdin (server.connect -> transport.start attaches the
  // 'data' listener, putting stdin in flowing mode) but NEVER exits when stdin
  // ends -- so a dead parent would otherwise leave this process lingering. On
  // Windows there are no POSIX process groups, so the app's tree-kill cannot
  // reach a grandchild: every recycle/quit would orphan this memory server
  // still holding the SQLite handle. Close the DB (WAL checkpoint) and exit; a
  // safety timeout forces exit if close() ever hangs. Only this stdin-EOF path
  // exits; normal (parent-alive) operation is untouched.
  let shuttingDown = false
  const onParentGone = () => {
    if (shuttingDown) return
    shuttingDown = true
    log('stdin closed (parent gone) -- shutting down memory MCP server')
    setTimeout(() => {
      log('graceful shutdown timed out -- forcing exit')
      process.exit(0)
    }, 2000).unref()
    try { service.close() } catch (err) { log(`db close failed during shutdown: ${err.message}`) }
    process.exit(0)
  }
  process.stdin.on('end', onParentGone)
  process.stdin.on('close', onParentGone)
}

// Only boot the MCP stdio server when run directly (`node server.mjs`), not
// when imported by the smoke test — importing must not open a stdio
// transport or it hangs waiting for a JSON-RPC client.
// fileURLToPath, NOT new URL().pathname — win32 pathname is '/C:/...' and the
// guard never matches (headless-lane had the same bug; 0.57 win probe).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    log(`Fatal: ${err.message}`)
    process.exit(1)
  })
}

// ── Legacy surface (pre-split import path + call signature, unchanged) ───
// memory/smoke.mjs and scripts/test-{journal,journal-e2e,pointer-table}.*
// import these names FROM THIS FILE and call the table operations with the
// historical (db, args) signature. They are pass-throughs to service.mjs;
// journalWrite/journalRead map onto the Impl pair because the service
// reserves the plain names for its (args)-only singleton API.
export {
  DDL,
  valuesEquivalent,
  numericCoerce,
  memoryWrite,
  memoryQuery,
  memoryConfirm,
  memoryDelete,
  memoryRecallMaterial,
  localToday,
  initDb,
  DB_PATH,
  journalWriteImpl as journalWrite,
  journalReadImpl as journalRead,
} from './service.mjs'
