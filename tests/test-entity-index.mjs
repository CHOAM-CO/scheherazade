#!/usr/bin/env node
// test-entity-index.mjs -- the zero-model-call entity index
// (memory/entity-index.mjs), against a REAL memory server module and a REAL
// temp sqlite db.
//
// Zero-Mem-inspired (arXiv:2607.29377): the whole feature's promise is that
// none of this costs an LLM token. These tests attack that promise as much
// as the extraction heuristics -- graceful degradation when the entity
// tables don't exist yet is asserted as carefully as the happy path.
//
// Run: node tests/test-entity-index.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-entidx-'))
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')

const svc = await import('../memory/service.mjs')
const entityIndex = await import('../memory/entity-index.mjs')
const { extractEntities, rebuildEntityIndex, entityRecall, indexRow } = entityIndex

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// entity_links/entities are deliberately NOT in service.mjs's ALL_TABLES --
// they are this feature's own mechanical layer, not part of the memory_query
// surface -- so tests read them with raw SQL instead of svc.memoryQuery.
function rawQuery(db, table, filter) {
  const keys = Object.keys(filter || {})
  const where = keys.length ? `WHERE ${keys.map((k) => `"${k}" = ?`).join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM "${table}" ${where}`).all(...keys.map((k) => filter[k]))
  return { count: rows.length, rows }
}

console.log('entity index (zero-model-call, Zero-Mem-inspired)\n')

// ── 1. extractEntities: each heuristic class, in isolation ─────────────────
console.log('extraction heuristics:')
{
  const keys = (text, opts) => extractEntities(text, opts).map((e) => e.key)

  // (a) quoted strings
  {
    const es = extractEntities(`he called it "Project Chimera" and also '단독 이벤트' and 「特別編」`)
    check('(a) double-quoted string extracted', keys(`"Project Chimera"`).includes('project chimera') || es.some((e) => e.key === 'project chimera'))
    check('(a) single-quoted string extracted', es.some((e) => e.key === '단독 이벤트'))
    check('(a) 「」-quoted string extracted', es.some((e) => e.key === '特別編'))
    check('(a) quoted entries are tagged type=quoted', es.filter((e) => e.type === 'quoted').length >= 3, JSON.stringify(es))
  }

  // (b) capitalized phrases, sentence-initial stopwords trimmed
  {
    const es = extractEntities('The Melchior project started. This is Claude Code testing something.')
    check('(b) proper-noun phrase kept whole ("Claude Code")', es.some((e) => e.key === 'claude code'), JSON.stringify(es))
    check('(b) sentence-initial "The" stripped off "The Melchior"', es.some((e) => e.key === 'melchior'), JSON.stringify(es))
    check('(b) bare sentence-initial stopword "This" produces no entity on its own', !es.some((e) => e.key === 'this'), JSON.stringify(es))
  }

  // (c) code-shaped tokens: camelCase / snake_case / dotted / @handle / #tag
  {
    const es = extractEntities('touched myVariableName and APIClient, also user_facts_table, config.agent-models.conf, ping @narr about #magi')
    check('(c) camelCase token extracted', es.some((e) => e.key === 'myvariablename'), JSON.stringify(es))
    check('(c) PascalCase-with-internal-cap token extracted', es.some((e) => e.key === 'apiclient'), JSON.stringify(es))
    check('(c) snake_case token extracted', es.some((e) => e.key === 'user_facts_table'), JSON.stringify(es))
    check('(c) dotted.file.name token extracted', es.some((e) => e.key === 'config.agent-models.conf'), JSON.stringify(es))
    check('(c) @handle extracted', es.some((e) => e.key === '@narr'), JSON.stringify(es))
    check('(c) #tag extracted', es.some((e) => e.key === '#magi'), JSON.stringify(es))
    check('(c) plain decimal number NOT treated as a dotted token', !es.some((e) => e.key === '5.6'))
  }

  // (d) Korean, frequency-gated
  {
    const once = extractEntities('오늘 멜키오르 얘기를 잠깐 했다.')
    check('(d) a Korean token seen ONCE in isolation is NOT promoted (no self-repeat, no corpus freq)', !once.some((e) => e.key === '멜키오르'), JSON.stringify(once))

    // v1 keeps particle-stripping out of scope (spec: "strip trailing
    // particles is NOT required, keep v1 simple") -- so the SAME bare token
    // has to repeat verbatim, not just the same root with a different
    // particle attached ("멜키오르" vs "멜키오르는" are different tokens here).
    const twice = extractEntities('오늘 멜키오르 얘기다. 다시 멜키오르 얘기였다.')
    check('(d) a Korean token repeated within the SAME text (self-frequency >=2) IS promoted', twice.some((e) => e.key === '멜키오르'), JSON.stringify(twice))

    const corpusFreq = new Map([['멜키오르', 2]])
    const gated = extractEntities('오늘 멜키오르 얘기를 잠깠다.', { korpusFreq: corpusFreq })
    check('(d) a Korean token seen once locally but >=2 in supplied corpus freq map IS promoted', gated.some((e) => e.key === '멜키오르'), JSON.stringify(gated))

    const notGated = extractEntities('오늘 발타자르 얘기를 잠깐 했다.', { korpusFreq: corpusFreq })
    check('(d) a Korean token absent from the corpus freq map is NOT promoted even if opts.korpusFreq was supplied', !notGated.some((e) => e.key === '발타자르'), JSON.stringify(notGated))
  }

  check('extractEntities returns [] for empty/non-string input', extractEntities('').length === 0 && extractEntities(null).length === 0 && extractEntities(undefined).length === 0)
}

// ── 2. rebuildEntityIndex: seed >=3 tables, incl. Korean+English ───────────
console.log('\nrebuild + idempotence:')
const db = svc.initDb()
{
  svc.memoryWrite(db, { table: 'user_facts', data: { subject: 'user', predicate: 'project', value: 'works on "Scheherazade" with Melchior and 멜키오르 the persona, config.agent-models.conf too', source_session: 's1' } })
  svc.memoryWrite(db, { table: 'user_facts', data: { subject: 'user', predicate: 'handle', value: 'goes by @narr on #magi channels', source_session: 's1' } })
  svc.memoryWrite(db, { table: 'open_threads', data: { summary: 'finish the Melchior entity index feature, "trend steals" branch', opened_session: 's1' } })
  svc.memoryWrite(db, { table: 'corrections', data: { what_was_wrong: 'called it 멜키오르 once, then 발타자르 by mistake', correct_behavior: 'always 멜키오르 for that persona, 멜키오르 again to be sure', corrected_session: 's1' } })
  svc.memoryWrite(db, { table: 'preferences', data: { key: 'entity_note', value: 'prefers CamelCaseNotation and snake_case_notation both mentioned', source_session: 's1' } })
  svc.journalWriteImpl(db, { date: '2026-08-10', body: '오늘 Melchior 그리고 멜키오르 얘기를 했다. gpt-5.6-sol 모델도 손봤고 channel.mjs 파일도 고쳤다.' })

  const stats1 = rebuildEntityIndex(db)
  check('rebuild returns stats with rows/links/entities/ms', stats1.rows > 0 && stats1.links > 0 && stats1.entities > 0 && typeof stats1.ms === 'number', JSON.stringify(stats1))

  const linksAfter1 = rawQuery(db, 'entity_links')
  const entitiesAfter1 = rawQuery(db, 'entities')
  check('entity_links table populated', linksAfter1.count === stats1.links, `${linksAfter1.count} vs ${stats1.links}`)
  check('entities summary table populated', entitiesAfter1.count === stats1.entities, `${entitiesAfter1.count} vs ${stats1.entities}`)
  check('an entity from user_facts is present ("Melchior")', entitiesAfter1.rows.some((r) => r.entity_key === 'melchior'), JSON.stringify(entitiesAfter1.rows.map((r) => r.entity_key)))
  check('a Korean entity repeated across rows is present (멜키오르)', entitiesAfter1.rows.some((r) => r.entity_key === '멜키오르'))
  check('a link records its source table + snippet', linksAfter1.rows.every((r) => r.source_table && typeof r.snippet === 'string'))

  const stats2 = rebuildEntityIndex(db)
  check('rebuild idempotence: same row/link/entity counts on a second run', stats2.rows === stats1.rows && stats2.links === stats1.links && stats2.entities === stats1.entities, `${JSON.stringify(stats1)} vs ${JSON.stringify(stats2)}`)

  const linksAfter2 = rawQuery(db, 'entity_links')
  check('rebuild idempotence: entity_links row COUNT unchanged (full delete+reinsert, not append)', linksAfter2.count === linksAfter1.count)
}

// ── 2b. indexRow: the incremental single-row variant, direct unit test ─────
// Not the shipped journal-write trigger (see §5 -- full rebuild won that
// call on measured timing), but it is shipped code (the documented fallback
// if a future corpus makes full rebuild too slow) and gets its own coverage.
console.log('\nindexRow (incremental variant, direct):')
{
  const r = indexRow(db, 'preferences', 999999, 'a standalone incremental row about Caspar and 카스파르 다시 카스파르', new Date().toISOString())
  check('indexRow reports how many entities it linked', r.links > 0, JSON.stringify(r))
  const links = rawQuery(db, 'entity_links', { source_table: 'preferences' }).rows.filter((l) => l.source_id === '999999')
  check('indexRow inserted links scoped to exactly that source row', links.length === r.links, `${links.length} vs ${r.links}`)
  check('indexRow entity is reachable via entityRecall', entityRecall(db, 'Caspar').entities.some((e) => e.display === 'Caspar'))

  // re-index the SAME row with different text -- old links for that row must
  // be replaced, not accumulated.
  indexRow(db, 'preferences', 999999, 'now only about Caspar, nothing else', new Date().toISOString())
  const links2 = rawQuery(db, 'entity_links', { source_table: 'preferences' }).rows.filter((l) => l.source_id === '999999')
  check('re-indexing the same row REPLACES its links rather than accumulating duplicates', links2.length === 1, JSON.stringify(links2))
}

// ── 3. entityRecall: linked sources come back ───────────────────────────────
console.log('\nentityRecall:')
{
  const { entities } = entityRecall(db, 'tell me about Melchior and 멜키오르 please')
  check('entityRecall finds the "Melchior" entity from query text', entities.some((e) => e.display.toLowerCase() === 'melchior'), JSON.stringify(entities))
  const melchior = entities.find((e) => e.display.toLowerCase() === 'melchior')
  check('...with mention_count and last_seen populated', melchior && melchior.mention_count > 0 && !!melchior.last_seen, JSON.stringify(melchior))
  check('...with linked sources (<=5) pointing at real rows', melchior && melchior.sources.length > 0 && melchior.sources.length <= 5 && melchior.sources.every((s) => s.table && s.id), JSON.stringify(melchior && melchior.sources))

  const none = entityRecall(db, 'completely unrelated query about nothing indexed whatsoever xyz123nonexistent')
  check('entityRecall returns {entities:[]} when nothing in the query matches the index', Array.isArray(none.entities) && none.entities.length === 0, JSON.stringify(none))

  const empty = entityRecall(db, '')
  check('entityRecall on empty query text returns {entities:[]}', Array.isArray(empty.entities) && empty.entities.length === 0)
}

// ── 4. memory_recall_material wiring: topic -> "Related entities" section ──
console.log('\nmemory_recall_material wiring:')
{
  const withTopic = svc.memoryRecallMaterial(db, { session: 's1', topic: 'what do we know about Melchior?' })
  check('recall material includes related_entities when topic given and matches', Array.isArray(withTopic.related_entities) && withTopic.related_entities.length > 0, JSON.stringify(withTopic.related_entities))
  check('recall material includes a "## Related entities" markdown section', typeof withTopic.related_entities_md === 'string' && withTopic.related_entities_md.startsWith('## Related entities'), withTopic.related_entities_md)
  check('the md section literally contains the string "Related entities"', withTopic.related_entities_md.includes('Related entities'))

  const withoutTopic = svc.memoryRecallMaterial(db, { session: 's1' })
  check('no topic given -> no related_entities fields at all (not even empty ones)', withoutTopic.related_entities === undefined && withoutTopic.related_entities_md === undefined, JSON.stringify(Object.keys(withoutTopic)))

  const noMatchTopic = svc.memoryRecallMaterial(db, { session: 's1', topic: 'xyz123nonexistent unrelated' })
  check('topic given but nothing matches -> section omitted, not an empty one', noMatchTopic.related_entities === undefined && noMatchTopic.related_entities_md === undefined, JSON.stringify(Object.keys(noMatchTopic)))

  check('ordinary recall material fields are untouched by the wiring', Array.isArray(withTopic.open_threads) && Array.isArray(withTopic.user_facts) && Array.isArray(withTopic.corrections) && typeof withTopic.counts === 'object')
}

// ── 5. journal_write trigger: entity index refreshes after a journal append ─
console.log('\njournal-write trigger:')
{
  const before = rawQuery(db, 'entities', { entity_key: '발타자르' })
  check('sanity: "발타자르" not yet indexed', before.count === 0)

  svc.journalWriteImpl(db, { date: '2026-08-11', body: '오늘은 발타자르 얘기만 했다. 발타자르는 계속 그 얘기를 반복했다.' })

  const after = rawQuery(db, 'entities', { entity_key: '발타자르' })
  check('a NEW entity introduced by a journal_write is indexed WITHOUT any explicit rebuild call (the journal-write trigger fired)', after.count === 1, JSON.stringify(after.rows))
}

// ── 6. graceful no-table degradation ────────────────────────────────────────
// A genuinely SEPARATE db handle, built directly from svc.DDL rather than
// svc.initDb() -- DB_PATH is a module-level constant read once at import
// (see service.mjs's own comment), so a second initDb() call mid-test would
// just reopen the SAME file this test already ran rebuildEntityIndex
// against, defeating the point of this section.
console.log('\ngraceful degradation (entity tables absent):')
{
  const freshPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-entidx-fresh-')), 'memory.db')
  const freshDb = new DatabaseSync(freshPath)
  freshDb.exec(svc.DDL) // the ordinary memory DDL only -- entity_links/entities are NEVER created (no rebuild, no indexRow, no journal_write ran here)

  const tables = freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entity_links','entities')").all()
  check('sanity: a fresh db really has no entity_links/entities tables yet', tables.length === 0)

  let threw = false
  try { entityRecall(freshDb, 'Melchior') } catch { threw = true }
  check('entityRecall itself throws on a missing table (not silently wrong data)', threw)

  let recallThrew = false
  let material = null
  try { material = svc.memoryRecallMaterial(freshDb, { session: 's1', topic: 'Melchior' }) } catch { recallThrew = true }
  check('memory_recall_material does NOT throw even though the entity tables are missing', !recallThrew)
  check('...and simply omits the related_entities section', material && material.related_entities === undefined && material.related_entities_md === undefined, JSON.stringify(material && Object.keys(material)))
  check('...while still returning the ordinary recall fields', material && Array.isArray(material.open_threads) && Array.isArray(material.user_facts))

  freshDb.close()
}

// ── 7. output char cap respected ────────────────────────────────────────────
console.log('\noutput char cap:')
{
  // Build a corpus of many distinct, high-mention-count English entities so a
  // broad query pulls in a lot of candidates, then confirm entityRecall caps
  // total output size rather than growing unbounded. Its own isolated db,
  // same reasoning as §6 -- svc.initDb() would just reopen the shared path.
  const capPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-entidx-cap-')), 'memory.db')
  const capDb = new DatabaseSync(capPath)
  capDb.exec(svc.DDL)
  const words = []
  for (let i = 0; i < 40; i++) {
    const w = `EntityWordNumber${i}`
    words.push(w)
    svc.memoryWrite(capDb, {
      table: 'open_threads',
      data: { summary: `long thread about ${w} with lots of padding text ${'x'.repeat(80)} repeated to make a long snippet`, opened_session: 's1' },
    })
  }
  rebuildEntityIndex(capDb)

  const bigQuery = words.join(' and also ')
  const capped = entityRecall(capDb, bigQuery, { maxChars: 2000 })
  const size = JSON.stringify(capped.entities).length
  check(`entityRecall output stays within the ~2000 char cap (got ${size} chars for ${capped.entities.length}/${words.length} candidate entities)`, size <= 2200, `size=${size}`)
  check('the cap actually engaged (fewer entities returned than were extractable)', capped.entities.length < words.length, `${capped.entities.length} of ${words.length}`)

  capDb.close()
}

db.close()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
