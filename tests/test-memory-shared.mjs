import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import siblings from '../sibling-profiles.cjs'
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
fs.writeFileSync(path.join(sibling, '.agent-config'), 'PROFILE=work\nDISPLAY_NAME=Worker\n')
fs.writeFileSync(path.join(sibling, '.agent.pid'), String(process.pid))
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
read(query); assert.equal(opens, before + 1)
fs.writeFileSync(path.join(own, '.agent-config'), 'SHARED_MEMORY_READ=0\n')
assert.deepEqual(read(query), []); assert.equal(opens, before + 1)
fs.writeFileSync(path.join(own, '.agent-config'), 'SHARED_MEMORY_READ=1\n')
db.exec('BEGIN EXCLUSIVE')
assert.deepEqual(read(query), [])
assert.equal(logs.length, 0)
db.exec('ROLLBACK; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE')
assert.equal(read(query)[0].material.rows.length, 1)
db.exec('ROLLBACK')
const material = { open_threads: [], user_facts: [{ id: 1, subject: 'user', predicate: 'likes', value: 'tea', owner_display_name: 'Worker' }], corrections: [], preferences: [] }
assert.match(prependMemoryContext('tea', {}, { recall: () => material }), /\[told to Worker\] user likes: tea/)
assert.equal(prependMemoryContext('unchanged', {}, { recall: () => ({ open_threads: [], user_facts: [], corrections: [] }), awareness: () => [] }), 'unchanged')
assert.equal(prependMemoryContext('hello', {}, { recall: () => ({ open_threads: [], user_facts: [], corrections: [] }), awareness: () => { throw Error('must not discover per turn') } }), 'hello')
db.close()
fs.unlinkSync(path.join(sibling, '.agent.pid'))
assert.equal(fs.existsSync(path.join(sibling, 'memory.db-wal')), false)
assert.equal(read(query)[0].material.rows.length, 1)
assert.equal(fs.existsSync(path.join(sibling, 'memory.db-wal')), false)
assert.equal(fs.existsSync(path.join(sibling, 'memory.db-shm')), false)
const corrupt = path.join(root, 'Scheherazade-corrupt')
fs.mkdirSync(corrupt)
fs.writeFileSync(path.join(corrupt, '.agent-config'), 'PROFILE=corrupt\n')
fs.writeFileSync(path.join(corrupt, 'memory.db'), 'not sqlite')
const previousLogs = logs.length
read(query); read(query)
assert.equal(logs.length, previousLogs + 1)
const stray = path.join(root, 'Scheherazade-old')
fs.mkdirSync(stray)
fs.writeFileSync(path.join(stray, 'memory.db'), 'stray')
assert.equal(read(query).some(row => row.profile === 'Scheherazade-old'), false)
// Real lone-default discovery, including a backup-shaped stray database.
const loneHome = path.join(root, 'lone-home')
const lone = path.join(loneHome, 'Documents', 'Scheherazade')
const old = path.join(loneHome, 'Documents', 'Scheherazade-old')
fs.mkdirSync(lone, { recursive: true }); fs.mkdirSync(old)
fs.writeFileSync(path.join(lone, '.agent-config'), '')
fs.writeFileSync(path.join(old, 'memory.db'), 'stray backup')
assert.deepEqual(siblings.awareness(lone), [])
assert.deepEqual(createSharedMemory({ dataHome: lone })(query), [])
const env = { ...process.env, HOME: loneHome, AGENT_DATA_HOME: lone, MEM: lone, SCHEHERAZADE_MEMORY_DB: path.join(lone, 'memory.db') }
const hook = new URL('../hooks/session-start.mjs', import.meta.url)
const memoryModule = new URL('../memory/service.mjs', import.meta.url).href
const runQuery = () => execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(memoryModule)}); if (m.siblingMemory().length) throw Error('unexpected siblings'); m.query({table:'user_facts'}); m.close()`], { env, encoding: 'utf8' })
const runHook = () => JSON.parse(execFileSync(process.execPath, [hook.pathname], { env, encoding: 'utf8' })).hookSpecificOutput.additionalContext
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]).sort()
// Existing boot behavior initializes continuity files. Measure steady state separately.
assert(!runHook().includes('다른 세라:')); runQuery()
const baseline = files(loneHome)
assert(!runHook().includes('다른 세라:')); runQuery()
assert.deepEqual(files(loneHome), baseline)
assert.deepEqual(fs.readdirSync(old), ['memory.db'])
fs.rmSync(root, { recursive: true, force: true })
console.log('test-memory-shared: shared-read assertions passed (no siblings, provenance, own tie, cache, toggle spy, locked, WAL writer, prompt)')
