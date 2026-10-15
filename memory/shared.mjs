// Read-only sibling access, deliberately independent of profile process discovery.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import siblings from '../sibling-profiles.cjs'
import { DatabaseSync } from 'node:sqlite'
export function createSharedMemory({ dataHome, open = file => new DatabaseSync(file, { readOnly: true }), log = console.error }) {
  const warned = new Map()
  return function readSiblings(read) {
    try { if (/^SHARED_MEMORY_READ=(?:0|false|off)\s*$/mi.test(fs.readFileSync(path.join(dataHome, '.agent-config'), 'utf8'))) return [] } catch {}
    const results = []
    for (const sibling of siblings.discover(dataHome)) {
      const file = path.join(sibling.dataHome, 'memory.db')
      if (!fs.existsSync(file)) continue
      let db, signature
      try {
        const stat = fs.statSync(file)
        signature = `${stat.ino}:${stat.mtimeMs}:${stat.size}`
        // A live writer needs WAL visibility; a stopped writer must leave no sidecars.
        let alive = false
        try { const pid = Number(fs.readFileSync(path.join(sibling.dataHome, '.agent.pid'), 'utf8')); if (pid > 0) { process.kill(pid, 0); alive = true } } catch (error) { alive = error.code === 'EPERM' }
        const uri = pathToFileURL(file)
        uri.searchParams.set('mode', 'ro')
        if (!alive) uri.searchParams.set('immutable', '1')
        db = open(uri.href)
        db.exec('PRAGMA busy_timeout=0')
        results.push({ name: siblings.displayName(sibling.dataHome), profile: sibling.folder, material: read(db) })
      } catch (error) {
        if (warned.get(file) !== signature) { warned.set(file, signature); log(`[memory] skipped sibling ${sibling.folder}: ${error.message}`) }
      } finally { try { db?.close() } catch {} }
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
