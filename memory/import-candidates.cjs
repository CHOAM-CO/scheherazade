// Pure export parser. Imported prose is data, never instructions.
'use strict'
const { looksSecretContent, MAX_FILE_BYTES } = require('./migrate-import.cjs')
function normalize(text) {
  return String(text).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
function parseCandidates(content, { filename = 'memory.txt', source = 'other', existing = [], stats = {} } = {}) {
  if (!/\.(txt|md|json)$/i.test(filename)) throw new Error('Choose a .txt, .md or .json file')
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Invalid or oversized memory file')
  if (!['chatgpt', 'claude', 'other'].includes(source)) throw new Error('Unknown import origin')
  let lines = []
  if (/\.json$/i.test(filename)) {
    const root = JSON.parse(content)
    // Only named memory containers: never turn a conversation export into facts.
    function collect(value) {
      if (typeof value === 'string') lines.push(...value.split(/\r?\n/))
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') {
        for (const key of ['memories', 'memory', 'saved_memories', 'what_i_know_about_you', 'facts']) {
          if (Object.hasOwn(value, key)) collect(value[key])
        }
        if (typeof value.text === 'string') collect(value.text)
        else if (typeof value.content === 'string') collect(value.content)
      }
    }
    collect(root)
  } else lines = content.split(/\r?\n/)
  const seen = new Set(existing.map(row => normalize(typeof row === 'string' ? row : row.value ?? row.text ?? '')))
  const out = []
  for (let text of lines) {
    text = text.trim()
    if (!text || /^#{1,6}\s|^```|^[-*_]{3,}$/.test(text)) continue
    text = text.replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, '').trim()
    if (/^(?:what I know about you|saved memories|memories|memory|about you|기억)\s*:?$/i.test(text)) continue
    const key = normalize(text)
    if (!key || looksSecretContent(text)) continue
    if (seen.has(key)) { stats.skipped_duplicates = (stats.skipped_duplicates || 0) + 1; continue }
    seen.add(key)
    out.push({ text, source })
    if (out.length === 200) break
  }
  return out
}
module.exports = { normalize, parseCandidates }
