// Pure selection: timestamps are required; unknown age is not fresh evidence.
const INTENT = /다음에|다음|내일|아침에|할게|하기로|\b(?:will|tomorrow|next session|NEXT|TODO|due)\b/i
const ECHO = /^(?:Mino\s*:|[>"'“‘「『])/i
export function pickFollowUp({ sessionNoteTail, checkpoint, openThreads = [], now = Date.now() } = {}) {
  const clock = new Date(now).getTime()
  if (!Number.isFinite(clock)) return null
  const candidates = []
  function add(source, text, timestamp) {
    const age = (clock - new Date(timestamp).getTime()) / 3600000
    if (!Number.isFinite(age) || age < 0 || age > 168) return
    let fenced = false
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (/^\s*```/.test(raw)) { fenced = !fenced; continue }
      const line = raw.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s*)+/, '').trim()
      if (fenced || ECHO.test(line) || !INTENT.test(line)) continue
      // Headings and empty intent labels are not concrete promises.
      if (/^#/.test(line) || !line.replace(INTENT, '').replace(/[\s:：\-_*]/g, '')) continue
      candidates.push({ source, text: line, age_hours: age })
    }
  }
  for (const thread of openThreads || []) {
    if (thread.status && thread.status !== 'open') continue
    add('open_thread', thread.summary, thread.last_touched_at || thread.created_at)
  }
  for (const [source, record] of [['checkpoint', checkpoint], ['session_note', sessionNoteTail]]) {
    if (!record) continue
    add(source, record.text, record.timestamp || record.updated_at || record.date)
  }
  // Newest first; within one document its last concrete promise wins.
  return candidates.reverse().sort((a, b) => a.age_hours - b.age_hours)[0] || null
}
