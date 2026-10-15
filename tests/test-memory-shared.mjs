import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSharedMemory, mergeShared } from '../memory/shared.mjs'
import { prependMemoryContext } from '../memory/turn-context.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-'))
const own = path.join(root, 'Scheherazade')
fs.mkdirSync(own)
let opens = 0
const logs = []
const read = createSharedMemory({ dataHome: own, open: file => { opens++; return new DatabaseSync(file, { readOnly: true }) }, log: line => logs.push(line) })
const query = db => ({ rows: db.prepare('SELECT * FROM facts').all(), count: 1 })
const original = { rows: [{ id: 1, value: 'own' }], count: 1 }
assert.equal(mergeShared(original, read(query)), original)
assert.equal(opens, 0)
const sibling = path.join(root, 'Scheherazade-work')
fs.mkdirSync(sibling)
fs.writeFileSync(path.join(sibling, '.agent-config'), 'DISPLAY_NAME=Worker\n')
const db = new DatabaseSync(path.join(sibling, 'memory.db'))
db.exec("CREATE TABLE facts(id INTEGER, value TEXT); INSERT INTO facts VALUES(1, 'sibling')")
let merged = mergeShared(original, read(query))
assert.equal(merged.rows[0].value, 'own')
assert.equal(merged.rows[1].owner_display_name, 'Worker')
assert.equal(merged.rows[1].provenance, 'told to Worker')
assert.deepEqual(read(db => db.exec("INSERT INTO facts VALUES(2, 'forbidden')")), [])
assert.match(logs.at(-1), /readonly/i)
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 1)
logs.length = 0
read(query)
const ranked = mergeShared({ user_facts: [{ id: 1, value: 'tea', subject: 'user', predicate: 'likes' }] }, [{ name: 'Worker', profile: 'work', material: { user_facts: [{ id: 1, value: 'tea garden', subject: 'user', predicate: 'likes' }] } }], { topic: 'tea garden' })
assert.equal(ranked.user_facts[0].owner_display_name, 'Worker')
const tied = mergeShared({ user_facts: [{ id: 1, value: 'tea' }] }, [{ name: 'Worker', profile: 'work', material: { user_facts: [{ id: 1, value: 'tea' }] } }], { topic: 'tea' })
assert.equal(tied.user_facts[0].owner_display_name, undefined)
const before = opens
read(query); assert.equal(opens, before)
fs.writeFileSync(path.join(own, '.agent-config'), 'SHARED_MEMORY_READ=0\n')
assert.deepEqual(read(query), []); assert.equal(opens, before)
fs.writeFileSync(path.join(own, '.agent-config'), 'SHARED_MEMORY_READ=1\n')
db.exec('BEGIN EXCLUSIVE')
assert.deepEqual(read(query), [])
assert.equal(logs.length, 1)
db.exec('ROLLBACK; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE')
assert.equal(read(query)[0].material.rows.length, 1)
db.exec('ROLLBACK')
const material = { open_threads: [], user_facts: [{ id: 1, subject: 'user', predicate: 'likes', value: 'tea', owner_display_name: 'Worker' }], corrections: [], preferences: [] }
assert.match(prependMemoryContext('tea', {}, { recall: () => material }), /\[told to Worker\] user likes: tea/)
db.close()
fs.rmSync(root, { recursive: true, force: true })
console.log('test-memory-shared: shared-read assertions passed (no siblings, provenance, own tie, cache, toggle spy, locked, WAL writer, prompt)')
