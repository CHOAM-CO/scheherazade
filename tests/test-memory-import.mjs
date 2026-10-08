import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import parser from '../memory/import-candidates.cjs'
import { DDL, stageImport, listPendingImports, resolveImport } from '../memory/service.mjs'
const { parseCandidates } = parser
assert.deepEqual(parseCandidates('# Memories\n- Cannot eat spicy food\n- Has a cat', { source: 'chatgpt' }).map(x => x.text), ['Cannot eat spicy food', 'Has a cat'])
assert.equal(parseCandidates(JSON.stringify({ memories: ['Likes tea', 'Has a cat'] }), { filename: 'export.json', source: 'chatgpt' }).length, 2)
assert.equal(parseCandidates('# What I know about you\n* Lives in Seoul', { filename: 'claude.md', source: 'claude' })[0].source, 'claude')
assert.equal(parseCandidates(JSON.stringify({ memory: { content: 'Lives in Seoul\nLikes tea' } }), { filename: 'claude.json', source: 'claude' }).length, 2)
assert.equal(parseCandidates('One fact\nAnother fact', { filename: 'list.txt' }).length, 2)
assert.equal(parseCandidates('- Likes tea!\nlikes TEA\nAnother', { existing: [{ value: 'Likes tea' }] }).length, 1)
assert.equal(parseCandidates(Array.from({ length: 250 }, (_, i) => `fact ${i}`).join('\n')).length, 200)
assert.deepEqual(parseCandidates('{"conversations":[{"text":"not a memory"}]}', { filename: 'export.json' }), [])
assert.throws(() => parseCandidates('{bad', { filename: 'memory.json' }))
assert.throws(() => parseCandidates('a', { filename: 'file.exe' }))
const db = new DatabaseSync(':memory:')
db.exec(DDL)
db.prepare('INSERT INTO preferences(key,value,source_session,updated_at) VALUES(?,?,?,?)').run('drink', 'Likes tea', 'test', 'now')
assert.equal(stageImport({ content: 'Likes tea\nHas a cat\nCannot eat spicy food', source: 'chatgpt' }, db).staged, 2)
assert.equal(db.prepare('SELECT count(*) AS n FROM user_facts').get().n, 0)
assert.equal(stageImport({ content: 'HAS A CAT!', source: 'claude' }, db).staged, 0)
const pending = listPendingImports({}, db).rows
assert.equal(pending.length, 2)
assert.equal(resolveImport({ id: pending[0].id, decision: 'accepted' }, db).status, 'accepted')
const fact = db.prepare('SELECT * FROM user_facts').get()
assert.equal(fact.confidence, 0.8)
assert.equal(fact.source_session, 'import:chatgpt')
assert.equal(fact.value, 'Has a cat')
resolveImport({ id: pending[0].id, decision: 'accepted' }, db)
assert.equal(db.prepare('SELECT count(*) AS n FROM user_facts').get().n, 1)
assert.throws(() => resolveImport({ id: pending[0].id, decision: 'rejected' }, db))
resolveImport({ id: pending[1].id, decision: 'rejected' }, db)
assert.equal(listPendingImports({}, db).rows.length, 0)
assert.equal(db.prepare('SELECT count(*) AS n FROM user_facts').get().n, 1)
assert.equal(stageImport({ content: 'Cannot eat spicy food', source: 'other' }, db).staged, 0)
assert.throws(() => resolveImport({ id: 999, decision: 'accepted' }, db))
// Failure during memory_write rolls back both candidate state and fact insertion.
const staged = stageImport({ content: 'Rollback fact', source: 'claude' }, db)
assert.equal(staged.staged, 1)
const id = listPendingImports({}, db).rows[0].id
db.exec("CREATE TRIGGER fail_import BEFORE UPDATE ON import_candidates BEGIN SELECT RAISE(ABORT,'test failure'); END")
assert.throws(() => resolveImport({ id, decision: 'accepted' }, db))
assert.equal(listPendingImports({}, db).rows[0].id, id)
assert.equal(db.prepare("SELECT count(*) AS n FROM user_facts WHERE value='Rollback fact'").get().n, 0)
db.close()
console.log('memory import parsers, dedup, cap, transitions, provenance and atomic rollback passed')
// Exercise the actual exported MCP handler dispatch with an isolated service DB.
const { handleImportTool, TOOLS } = await import('../memory/server.mjs')
const { importMemoryFile } = await import('../memory/service.mjs')
const toolDb = new DatabaseSync(':memory:')
toolDb.exec(DDL)
const api = {
  importMemoryFile: (path, source) => importMemoryFile(path, source, toolDb),
  listPendingImports: args => listPendingImports(args, toolDb),
  resolveImport: args => resolveImport(args, toolDb),
}
for (const name of ['memory_import_file', 'memory_import_pending', 'memory_import_resolve']) assert.ok(TOOLS.find(t => t.name === name))
const receipt = await handleImportTool('memory_import_file', { path: new URL('../CLAUDE.md', import.meta.url).pathname }, api)
assert.ok(receipt.staged > 3)
assert.equal(receipt.skipped_duplicates, 0)
const again = await handleImportTool('memory_import_file', { path: new URL('../CLAUDE.md', import.meta.url).pathname }, api)
assert.equal(again.staged, 0)
assert.ok(again.skipped_duplicates > 0)
const batch = await handleImportTool('memory_import_pending', { limit: 2 }, api)
assert.equal(batch.rows.length, 2)
await handleImportTool('memory_import_resolve', { id: batch.rows[0].id, decision: 'accept' }, api)
await handleImportTool('memory_import_resolve', { id: batch.rows[1].id, decision: 'reject' }, api)
assert.equal(toolDb.prepare('SELECT count(*) AS n FROM user_facts').get().n, 1)
assert.equal(toolDb.prepare('SELECT confidence,source_session FROM user_facts').get().confidence, 0.8)
await assert.rejects(handleImportTool('memory_import_pending', { limit: 4 }, api))
await assert.rejects(handleImportTool('memory_import_resolve', { id: batch.rows[0].id, decision: 'maybe' }, api))
await assert.rejects(handleImportTool('memory_import_file', {}, api))
toolDb.close()
console.log('MCP import file/pending/resolve handlers passed')
// Route bodies can be exercised without bypassing the HTTP token gate.
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const { createRoutes } = require('../onboarding/routes/memory.cjs')
const routeDb = new DatabaseSync(':memory:')
routeDb.exec(DDL)
let response
const routes = createRoutes({
  readJsonBody: async req => req.body,
  sendJson: (_res, status, body) => { response = { status, body } },
  getMemoryService: async () => ({
    stageImport: args => stageImport(args, routeDb),
    listPendingImports: args => listPendingImports(args, routeDb),
    resolveImport: args => resolveImport(args, routeDb),
  }),
})
const route = (method, path) => routes.find(r => r.method === method && r.match(path))
await route('POST', '/api/memory/ai-import').handler({ body: { filename: 'memory.txt', content: 'UI fact\nUI rejected fact', source: 'claude' } }, {})
assert.equal(response.status, 200)
assert.equal(response.body.staged, 2)
await route('GET', '/api/memory/import-candidates').handler({}, {})
const uiRows = response.body.rows
for (const [i, decision] of ['accepted', 'rejected'].entries()) {
  await route('POST', '/api/memory/import-candidates').handler({ body: { id: uiRows[i].id, decision } }, {})
  assert.equal(response.status, 200)
}
assert.equal(routeDb.prepare('SELECT count(*) AS n FROM user_facts').get().n, 1)
assert.equal(routeDb.prepare('SELECT source_session FROM user_facts').get().source_session, 'import:claude')
await route('POST', '/api/memory/ai-import').handler({ body: { filename: 'bad.json', content: '{bad', source: 'other' } }, {})
assert.equal(response.status, 400)
routeDb.close()
console.log('Memory page staging/list/accept/reject route bodies passed')

// Memory page "Import from another AI" markup: themed controls, ids memory.js depends on, copy via copy.js.
{
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../onboarding/public/memory.html', import.meta.url), 'utf8')
  const js = readFileSync(new URL('../onboarding/public/js/memory.js', import.meta.url), 'utf8')
  const copy = readFileSync(new URL('../onboarding/public/js/copy.js', import.meta.url), 'utf8')
  for (const id of ['ai-import-source', 'ai-import-file', 'ai-import-submit', 'ai-import-status', 'ai-import-pending']) assert.ok(html.includes(`id="${id}"`), id)
  assert.match(html, /class="agent-control-row">\s*<label for="ai-import-source"/)
  assert.match(html, /<input id="ai-import-file" type="file"[^>]* hidden>/)
  assert.match(html, /class="field-hint" id="ai-import-file-name"/)
  assert.match(html, /class="step-actions">\s*<button class="secondary" id="ai-import-choose"/)
  assert.ok(!html.includes('Import from another AI') && !html.includes('Choose file'), 'no hardcoded English in memory.html')
  assert.ok(copy.includes('aiImport:') && js.includes("C.aiImport") && js.includes("$('ai-import-file').click()"))
  console.log('Memory page import markup passed')
}
