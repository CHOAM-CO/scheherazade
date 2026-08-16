// memory/entity-index.mjs — zero-model-call entity index over the memory DB.
//
// Inspired by Zero-Mem (arXiv:2607.29377): a mechanical entity-context layer
// that improves recall WITHOUT spending a single LLM token, built and
// queried by pure string heuristics against the SQLite tables service.mjs
// already owns.
//
// Three pieces, in the order data flows through them:
//   1. extractEntities(text) — pure. No db, no I/O, no model calls. Four
//      mechanical heuristic classes (quoted strings, capitalized English
//      phrases, code-shaped tokens, frequency-gated Korean tokens).
//   2. rebuildEntityIndex(db) / indexRow(db, ...) — walk the memory tables'
//      text columns and populate two summary tables (entity_links,
//      entities). Full rebuild is a DELETE+reinsert in one transaction
//      (corpus is small); indexRow is the incremental single-row variant
//      used after a journal append (see server.mjs/service.mjs wiring).
//   3. entityRecall(db, queryText) — extract entities FROM the query, look
//      them up, return capped linked context for memoryRecallMaterial to
//      fold in as a "## Related entities" section.
//
// Everything here is additive and mechanical. Nothing in this file calls a
// model, an API, or a network of any kind — the entire point of the
// feature is recall improvement at zero marginal token cost.
//
// Module system: .mjs, matching memory/service.mjs and memory/server.mjs
// (this repo is "type":"module" — memory/pointer-scan.cjs is the outlier,
// not the convention).

const nowISO = () => new Date().toISOString()

// ── extractEntities: pure, mechanical, no model calls ─────────────────────
//
// Four heuristic classes, applied independently (a token can match more
// than one; dedup is by entity_key, first extraction wins the display form):
//   (a) quoted strings: "…" / '…' / 「…」
//   (b) capitalized English phrases, with sentence-initial common words
//       trimmed off the ends of the run (not deleted from the middle — v1
//       stays simple, per spec)
//   (c) code-shaped tokens: CamelCase, snake_case, dotted.file.names,
//       @handles, #tags
//   (d) Korean tokens (2+ hangul syllables), frequency-gated: Korean has no
//       capitalization signal, so a bare hangul run is only promoted to an
//       entity if it recurs — either in the corpus-wide frequency map the
//       caller supplies (opts.korpusFreq, used by rebuildEntityIndex) or,
//       absent that, within the same text (self-frequency — the sane
//       default for a single ad hoc call like entityRecall's query text).
const STOPWORDS_EN = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'i', 'my', 'your',
  'his', 'her', 'their', 'our', 'we', 'you', 'he', 'she', 'they', 'if',
  'when', 'while', 'because', 'so', 'but', 'and', 'or', 'not', 'no', 'yes',
  'what', 'which', 'who', 'where', 'why', 'how', 'there', 'here', 'then',
  'now', 'today', 'yesterday', 'tomorrow', 'also', 'however', 'therefore',
  'thus', 'please', 'ok', 'okay', 'hi', 'hello', 'hey', 'well', 'just',
  'very', 'really', 'actually', 'basically', 'let', 'lets', 'us', 'im',
  'ive', 'dont', 'cant', 'wont', 'its', 'thats', 'theres', 'so,',
])

function entityKey(display) {
  return display.trim().toLowerCase()
}

function extractEntities(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) return []

  const found = new Map() // entity_key -> {display, key, type}
  const add = (rawDisplay, type) => {
    const display = String(rawDisplay).trim()
    if (!display) return
    const key = entityKey(display)
    if (!key || found.has(key)) return
    found.set(key, { display, key, type })
  }

  // (a) quoted strings
  const QUOTE_RES = [/"([^"\n]{2,80})"/g, /'([^'\n]{2,80})'/g, /「([^」\n]{2,80})」/g]
  for (const re of QUOTE_RES) {
    let m
    while ((m = re.exec(text))) add(m[1], 'quoted')
  }

  // (c) code-shaped tokens — checked before the capitalized-phrase scan so
  // e.g. "APIClient" is captured whole as 'camel' rather than only via (b).
  const CAMEL_RE = /\b(?:[a-z0-9]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*)\b/g
  {
    let m
    while ((m = CAMEL_RE.exec(text))) add(m[0], 'camel')
  }
  const SNAKE_RE = /\b[a-zA-Z0-9]+(?:_[a-zA-Z0-9]+)+\b/g
  {
    let m
    while ((m = SNAKE_RE.exec(text))) add(m[0], 'snake')
  }
  // requires at least one letter per dot-segment, so plain decimals ("3.14")
  // and version numbers ("5.6") never qualify on their own.
  const DOTTED_RE = /\b[a-zA-Z0-9_-]*[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]*[a-zA-Z][a-zA-Z0-9_-]*)+\b/g
  {
    let m
    while ((m = DOTTED_RE.exec(text))) add(m[0], 'dotted')
  }
  const HANDLE_RE = /(?<![\w@])@[a-zA-Z0-9_]{2,}/g
  {
    let m
    while ((m = HANDLE_RE.exec(text))) add(m[0], 'handle')
  }
  const TAG_RE = /(?<![\w#])#[a-zA-Z0-9_]{2,}/g
  {
    let m
    while ((m = TAG_RE.exec(text))) add(m[0], 'tag')
  }

  // (b) capitalized English phrases — consecutive capitalized-word runs,
  // with stopwords trimmed off the START and END of the run only (v1 stays
  // simple; a stopword stranded in the MIDDLE of a real proper-noun phrase
  // is not handled, e.g. "Bank of America" would need a smarter grammar).
  const CAP_RUN_RE = /\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*\b/g
  {
    let m
    while ((m = CAP_RUN_RE.exec(text))) {
      const words = m[0].split(/\s+/)
      let start = 0
      let end = words.length
      while (start < end && STOPWORDS_EN.has(words[start].toLowerCase())) start++
      while (end > start && STOPWORDS_EN.has(words[end - 1].toLowerCase())) end--
      const kept = words.slice(start, end)
      if (kept.length === 0) continue
      // a single leftover word under 2 chars is noise (stray initials, "I" etc.)
      if (kept.length === 1 && kept[0].length < 2) continue
      add(kept.join(' '), 'capitalized')
    }
  }

  // (d) Korean tokens, frequency-gated
  const KOR_RE = /[가-힣]{2,}/g
  const localCounts = new Map()
  {
    let m
    while ((m = KOR_RE.exec(text))) localCounts.set(m[0], (localCounts.get(m[0]) || 0) + 1)
  }
  for (const [tok, selfCount] of localCounts) {
    const corpusCount = opts.korpusFreq ? (opts.korpusFreq.get(tok) || 0) : selfCount
    if (corpusCount >= 2) add(tok, 'korean')
  }

  return [...found.values()]
}

// ── Table walk config ──────────────────────────────────────────────────────
// Which text columns to index per table, and which timestamp column stamps
// an entity_links row (falls back to a second column, then to nowISO()).
// journal_entries/user_facts/open_threads/corrections/preferences only — the
// spec's exact list. memory_events and imported_pointers are deliberately
// excluded (audit log content and borrowed-tool pointers respectively; see
// service.mjs's own comments on why those two stay out of similar walks).
const SOURCE_TABLES = [
  { table: 'user_facts', textCols: ['subject', 'predicate', 'value'], tsCol: 'last_confirmed_at', tsFallback: 'created_at' },
  { table: 'open_threads', textCols: ['summary'], tsCol: 'last_touched_at', tsFallback: 'opened_at' },
  { table: 'corrections', textCols: ['what_was_wrong', 'correct_behavior'], tsCol: 'corrected_at', tsFallback: null },
  { table: 'preferences', textCols: ['key', 'value'], tsCol: 'updated_at', tsFallback: null },
  { table: 'journal_entries', textCols: ['body'], tsCol: 'updated_at', tsFallback: 'created_at' },
]

const ENTITY_DDL = `
CREATE TABLE IF NOT EXISTS entity_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  snippet TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_links_key ON entity_links(entity_key);
CREATE INDEX IF NOT EXISTS idx_entity_links_source ON entity_links(source_table, source_id);

CREATE TABLE IF NOT EXISTS entities (
  entity_key TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT,
  last_seen TEXT
);
`

function ensureEntityTables(db) {
  db.exec(ENTITY_DDL)
}

function snippetOf(text, max = 140) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function rowTimestamp(row, cfg) {
  return row[cfg.tsCol] || (cfg.tsFallback && row[cfg.tsFallback]) || null
}

function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* best effort */ }
    throw err
  }
}

// ── rebuildEntityIndex: full DELETE+reinsert, one transaction ─────────────
// Corpus is small (a single user's memory DB), so a full rebuild is the
// simplest correct thing: no incremental-diff bugs, trivially idempotent
// (same input rows -> same output tables, every time).
function rebuildEntityIndex(db) {
  ensureEntityTables(db)
  const start = Date.now()

  // Pass 1: read every configured table's text columns, and tally Korean
  // DOCUMENT frequency (rows containing the token at least once) across the
  // whole corpus slice being indexed — deliberately document frequency, not
  // raw occurrence count, so one repetitive row can't manufacture a
  // "frequent" entity on its own.
  const rowsByTable = {}
  const korpusFreq = new Map()
  for (const cfg of SOURCE_TABLES) {
    let rows
    try {
      rows = db.prepare(`SELECT * FROM "${cfg.table}"`).all()
    } catch {
      rows = [] // table absent (e.g. pre-migration db) — degrade silently
    }
    const withText = rows.map((row) => ({
      row,
      combined: cfg.textCols.map((c) => row[c]).filter((v) => typeof v === 'string' && v).join('\n'),
    }))
    rowsByTable[cfg.table] = withText

    for (const { combined } of withText) {
      if (!combined) continue
      const seen = new Set()
      const re = /[가-힣]{2,}/g
      let m
      while ((m = re.exec(combined))) seen.add(m[0])
      for (const tok of seen) korpusFreq.set(tok, (korpusFreq.get(tok) || 0) + 1)
    }
  }

  // Pass 2: extract per row using the corpus-wide Korean frequency map.
  const linkRows = []
  let rowCount = 0
  for (const cfg of SOURCE_TABLES) {
    for (const { row, combined } of rowsByTable[cfg.table]) {
      rowCount++
      if (!combined) continue
      const entities = extractEntities(combined, { korpusFreq })
      if (entities.length === 0) continue
      const ts = rowTimestamp(row, cfg) || nowISO()
      const snip = snippetOf(combined)
      for (const ent of entities) {
        linkRows.push({
          entity: ent.display,
          entity_key: ent.key,
          source_table: cfg.table,
          source_id: String(row.id),
          snippet: snip,
          updated_at: ts,
        })
      }
    }
  }

  withTx(db, () => {
    db.exec('DELETE FROM entity_links')
    db.exec('DELETE FROM entities')

    const insertLink = db.prepare(
      'INSERT INTO entity_links (entity, entity_key, source_table, source_id, snippet, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const l of linkRows) insertLink.run(l.entity, l.entity_key, l.source_table, l.source_id, l.snippet, l.updated_at)

    const summary = new Map() // entity_key -> {display, count, first, last}
    for (const l of linkRows) {
      const s = summary.get(l.entity_key) || { display: l.entity, count: 0, first: l.updated_at, last: l.updated_at }
      s.count++
      if (l.updated_at < s.first) s.first = l.updated_at
      if (l.updated_at > s.last) s.last = l.updated_at
      summary.set(l.entity_key, s)
    }
    const insertEntity = db.prepare(
      'INSERT INTO entities (entity_key, display, mention_count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)',
    )
    for (const [key, s] of summary) insertEntity.run(key, s.display, s.count, s.first, s.last)
  })

  return {
    ms: Date.now() - start,
    rows: rowCount,
    links: linkRows.length,
    entities: new Set(linkRows.map((l) => l.entity_key)).size,
  }
}

// ── indexRow: incremental, single-row, append-only-cheap variant ──────────
// Used after a journal append if a full rebuild proves too slow to run on
// every write (see server.mjs/service.mjs wiring for which is actually
// shipped, decided from real timing). Replaces just this row's own links
// and refreshes the entities summary rows it touches — everything else in
// the index is left untouched. Korean gating here is necessarily
// self-frequency only (this row's text in isolation), a known, accepted
// weaker signal than the full rebuild's corpus-wide document frequency.
function indexRow(db, table, id, text, updatedAt) {
  ensureEntityTables(db)
  if (typeof text !== 'string' || !text.trim()) return { links: 0 }

  const entities = extractEntities(text)
  const snip = snippetOf(text)
  const ts = updatedAt || nowISO()

  return withTx(db, () => {
    db.prepare('DELETE FROM entity_links WHERE source_table = ? AND source_id = ?').run(table, String(id))

    const insertLink = db.prepare(
      'INSERT INTO entity_links (entity, entity_key, source_table, source_id, snippet, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const ent of entities) insertLink.run(ent.display, ent.key, table, String(id), snip, ts)

    const touched = new Set(entities.map((e) => e.key))
    const upsertEntity = db.prepare(`
      INSERT INTO entities (entity_key, display, mention_count, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_key) DO UPDATE SET
        display = excluded.display,
        mention_count = excluded.mention_count,
        first_seen = excluded.first_seen,
        last_seen = excluded.last_seen
    `)
    for (const key of touched) {
      const agg = db.prepare('SELECT COUNT(*) AS n, MIN(updated_at) AS first, MAX(updated_at) AS last FROM entity_links WHERE entity_key = ?').get(key)
      const disp = db.prepare('SELECT entity FROM entity_links WHERE entity_key = ? ORDER BY id DESC LIMIT 1').get(key)
      upsertEntity.run(key, disp.entity, agg.n, agg.first, agg.last)
    }

    return { links: entities.length }
  })
}

// ── entityRecall: extract entities from a query, return linked context ────
// Degrades by THROWING when entity_links/entities don't exist yet (a fresh
// db before the first rebuild, or a caller that skipped ensureEntityTables)
// — the caller (memoryRecallMaterial) wraps this in try/catch and omits the
// section, per spec ("must degrade silently ... if tables absent"). Kept as
// a throw here, not a swallow, so a real bug in a DIFFERENT caller doesn't
// silently look like "no entities found".
function entityRecall(db, queryText, opts = {}) {
  const maxChars = opts.maxChars || 2000
  const maxSourcesPerEntity = opts.maxSourcesPerEntity || 5

  const extracted = extractEntities(queryText || '')
  if (extracted.length === 0) return { entities: [] }

  const getEntity = db.prepare('SELECT entity_key, display, mention_count, first_seen, last_seen FROM entities WHERE entity_key = ?')
  const getSources = db.prepare(
    'SELECT source_table AS "table", source_id AS id, snippet FROM entity_links WHERE entity_key = ? ORDER BY updated_at DESC LIMIT ?',
  )

  const results = []
  let used = 0
  for (const ent of extracted) {
    const row = getEntity.get(ent.key) // throws if the table doesn't exist — intentional, see above
    if (!row) continue
    const sources = getSources.all(ent.key, maxSourcesPerEntity)
    const item = { display: row.display, mention_count: row.mention_count, last_seen: row.last_seen, sources }
    const itemLen = JSON.stringify(item).length
    if (used + itemLen > maxChars && results.length > 0) break
    results.push(item)
    used += itemLen
    if (used >= maxChars) break
  }

  return { entities: results }
}

// ── formatRelatedEntitiesMarkdown: the "## Related entities" section ──────
function formatRelatedEntitiesMarkdown(entities) {
  if (!entities || entities.length === 0) return ''
  const lines = ['## Related entities']
  for (const e of entities) {
    const srcs = (e.sources || []).map((s) => `[${s.table}#${s.id}] ${s.snippet}`).join('; ')
    lines.push(`- **${e.display}** (n=${e.mention_count}, last ${e.last_seen || '?'})${srcs ? `: ${srcs}` : ''}`)
  }
  return lines.join('\n')
}

export {
  extractEntities,
  ensureEntityTables,
  rebuildEntityIndex,
  indexRow,
  entityRecall,
  formatRelatedEntitiesMarkdown,
  SOURCE_TABLES,
}
