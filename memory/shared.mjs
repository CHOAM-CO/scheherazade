// Read-only sibling access, deliberately independent of profile process discovery.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
export function createSharedMemory({ dataHome, open = file => new DatabaseSync(file, { readOnly: true }), log = console.error }) {
  const cache = new Map()
  return function readSiblings(read) {
    try { if (/^SHARED_MEMORY_READ=(?:0|false|off)\s*$/mi.test(fs.readFileSync(path.join(dataHome, '.agent-config'), 'utf8'))) return [] } catch {}
    let entries
    try { entries = fs.readdirSync(path.dirname(dataHome)) } catch { return [] }
    const results = []
    for (const folder of entries.sort()) {
      if (!folder.startsWith('Scheherazade')) continue
      const home = path.join(path.dirname(dataHome), folder)
      if (path.resolve(home) === path.resolve(dataHome)) continue
      const file = path.join(home, 'memory.db')
      if (!fs.existsSync(file)) continue
      try {
        const stat = fs.statSync(file)
        const signature = `${stat.ino}:${stat.mtimeMs}`
        let entry = cache.get(file)
        if (entry?.signature !== signature) {
          entry?.db.close(); cache.delete(file)
          const db = open(file)
          db.exec('PRAGMA busy_timeout=0')
          entry = { signature, db }; cache.set(file, entry)
        }
        let name = folder === 'Scheherazade' ? 'default' : folder.slice('Scheherazade'.length).replace(/^-/, '')
        try { name = fs.readFileSync(path.join(home, '.agent-config'), 'utf8').match(/^DISPLAY_NAME=(.*)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2') || name } catch {}
        results.push({ name, profile: folder, material: read(entry.db) })
      } catch (error) {
        try { cache.get(file)?.db.close() } catch {}
        cache.delete(file)
        log(`[memory] skipped sibling ${folder}: ${error.message}`)
      }
    }
    return results
  }
}
export function mergeShared(own, siblings, { topic } = {}) {
  if (!siblings.length) return own
  const result = { ...own }
  const tokens = text => new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
  const topicTokens = tokens(topic)
  const relevance = row => {
    const words = tokens(`${row.subject} ${row.predicate} ${row.value}`)
    return [...topicTokens].filter(t => [...words].some(w => w === t || (/[가-힣]/.test(t) && Math.min(w.length, t.length) >= 2 && (w.startsWith(t) || t.startsWith(w))))).length
  }
  const rank = key => (a, b) => {
    if (['user_facts', 'relevant_facts'].includes(key) && topicTokens.size) return relevance(b) - relevance(a)
    if (key === 'open_threads') return (b.salience || 0) - (a.salience || 0) || String(b.last_touched_at || '').localeCompare(String(a.last_touched_at || ''))
    if (key === 'rows') return (b.id || 0) - (a.id || 0)
    const date = { user_facts: 'last_confirmed_at', corrections: 'corrected_at', preferences: 'updated_at' }[key]
    return date ? String(b[date] || '').localeCompare(String(a[date] || '')) : 0
  }
  for (const key of Object.keys(own)) {
    if (!Array.isArray(own[key])) continue
    result[key] = [...own[key], ...siblings.flatMap(({ name, profile, material }) => (material[key] || []).map(row => ({ ...row, owner_profile: profile, owner_display_name: name, provenance: `told to ${name}` })))]
  }
  // Stable sort preserves local-first order on equal scores, including colliding ids.
  for (const key of ['user_facts', 'relevant_facts', 'open_threads', 'corrections', 'preferences', 'rows']) {
    if (Array.isArray(result[key])) result[key].sort(rank(key))
  }
  const related = siblings.filter(s => s.material.related_entities_md).map(s => `[told to ${s.name}]\n${s.material.related_entities_md}`)
  if (related.length) result.related_entities_md = [own.related_entities_md, ...related].filter(Boolean).join('\n')
  if (Array.isArray(result.rows)) result.count = result.rows.length
  return result
}
