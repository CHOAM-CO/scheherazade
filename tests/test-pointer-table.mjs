#!/usr/bin/env node
// test-pointer-table.mjs -- the imported_pointers table against the REAL memory
// server module and a REAL sqlite db.
//
// The one assertion this file exists for: memory_write CANNOT reach
// imported_pointers. Everything else about the pointer index is a convenience;
// that boundary is the promise. Borrowed knowledge from another tool must not
// be able to become one of the agent's own remembered facts, and the guarantee
// has to be enforced by code (WRITABLE_TABLES), not by a comment asking nicely.
//
// Run: node tests/test-pointer-table.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ptrdb-'))
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')

const mod = await import('../memory/server.mjs')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

console.log('imported_pointers table + write boundary\n')

const db = mod.initDb ? mod.initDb() : null
check('memory server exposes initDb', Boolean(db), 'no initDb export -- adjust this test to the module surface')
if (!db) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

// 1. The table exists after DDL.
{
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='imported_pointers'").all()
  check('DDL creates imported_pointers', rows.length === 1)
}

// 2. THE BOUNDARY: memory_write must refuse this table.
{
  let threw = false
  let msg = ''
  try {
    mod.memoryWrite(db, { table: 'imported_pointers', content: 'a borrowed fact pretending to be mine' })
  } catch (err) { threw = true; msg = err.message }
  check('memory_write REFUSES imported_pointers (the whole promise)', threw, 'a borrowed pointer could be written as agent memory')
  check('the refusal names the table', threw && /imported_pointers|not.*writable|Valid/i.test(msg), msg)
}

// 3. ...but memory_query can READ it. The agent must be able to look up WHERE.
{
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO imported_pointers (source_tool, path, kind, topic, size_bytes, mtime, indexed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('claude-code', '/tmp/fake/CLAUDE.md', 'md', 'Project rules', 42, now, now)
  const { rows } = mod.memoryQuery(db, { table: 'imported_pointers' })
  check('memory_query CAN read imported_pointers', rows.length === 1, JSON.stringify(rows))
  check('the row carries its provenance tag', rows[0].source_tool === 'claude-code', JSON.stringify(rows[0]))
  check('the row carries a location', rows[0].path === '/tmp/fake/CLAUDE.md', JSON.stringify(rows[0]))
}

// 4. Re-scanning the same file updates in place instead of duplicating.
{
  const later = new Date(Date.now() + 1000).toISOString()
  db.prepare(`INSERT INTO imported_pointers (source_tool, path, kind, topic, size_bytes, mtime, indexed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET topic = excluded.topic, indexed_at = excluded.indexed_at`)
    .run('claude-code', '/tmp/fake/CLAUDE.md', 'md', 'Project rules / Deploy', 42, later, later)
  const { rows } = mod.memoryQuery(db, { table: 'imported_pointers' })
  check('re-scan upserts rather than duplicating', rows.length === 1, `${rows.length} rows`)
  check('re-scan refreshes the topic', rows[0].topic === 'Project rules / Deploy', JSON.stringify(rows[0]))
}

// 5. The agent's own memory tables are untouched by any of this.
{
  const { rows } = mod.memoryQuery(db, { table: 'user_facts' })
  check('user_facts stays empty -- nothing bled across', rows.length === 0, JSON.stringify(rows))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
