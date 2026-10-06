// Pure selection: timestamps are required; unknown age is not fresh evidence.
// Promise markers. Bare "다음" is NOT one ("다음 턴에 들어온다" is a lesson, not a plan).
const INTENT = /다음\s*(?:에|날|주|번|세션|턴부터)|내일|아침에|할게|하기로|할\s*예정|해야\s*(?:한다|함|해|할)|확인\s*필요|결정\s*대기|답\s*(?:기다|대기)|미답|대기\s*중|\b(?:will|tomorrow|next session|NEXT|TODO|due|pending)\b/i
const ECHO = /^(?:Mino\s*:|[>"'“‘「『])/i
// Sections that hold rules, identity or tooling, never open promises.
const SKIP_SECTION = /교훈|lesson|규칙|rule|정체성|identity|persona|페르소나|말투|도구|자산|tool|asset|함정/i
export function pickFollowUp({ sessionNoteTail, checkpoint, openThreads = [], now = Date.now() } = {}) {
  const clock = new Date(now).getTime()
  if (!Number.isFinite(clock)) return null
  const candidates = []
  function add(source, text, timestamp) {
    const age = (clock - new Date(timestamp).getTime()) / 3600000
    if (!Number.isFinite(age) || age < 0 || age > 168) return
    let fenced = false
    let skipSection = false
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (/^\s*```/.test(raw)) { fenced = !fenced; continue }
      if (/^\s*#{1,6}\s/.test(raw)) { skipSection = SKIP_SECTION.test(raw); continue }
      const line = raw.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s*)+/, '').trim()
      if (fenced || skipSection || ECHO.test(line) || !INTENT.test(line)) continue
      // Empty intent labels are not concrete promises.
      if (!line.replace(INTENT, '').replace(/[\s:：\-_*]/g, '')) continue
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
