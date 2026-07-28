'use strict'
// cadence/note-tick.cjs -- pure decision for the session-note cadence
// watcher (v0.0.16, Mino 07-16 12:25: "아이들링 상태면 세시간에 한 번씩
// 세션노트 갱신").
//
// IDLE-ONLY since the 2026-07-28 boot-context diet. The original port also
// nagged every 30 minutes DURING active conversation -- that active lane
// was the MAGI fleet's habit riding along in the port, not part of the
// 07-16 directive, and it competed with the user's actual conversation for
// the agent's attention. An active session skips entirely now: while the
// human is talking, the conversation is the cadence. The CLAUDE.md §2
// discipline (write as the day happens) still governs active sessions; this
// watcher is only the floor under IDLE stretches, where nobody is there to
// notice a session note going stale.
//
// channel.mjs owns the IO (fs.stat, config read, mcp.notification); this
// file owns the rule, and scripts/test-note-cadence.mjs calls THIS function.
// Same split as autonomy/tick.cjs, for the same reason: a copy of a rule
// is not the rule.

const DEFAULT_IDLE_MIN = 180
// Conversation activity (inbound Discord message or outbound reply) within
// this window means the session is "active" -> no nag at all.
const ACTIVITY_WINDOW_MS = 60 * 60 * 1000

function intKnob(raw, fallback) {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Inputs (all injected -- no clock/fs access here):
//   now            ms epoch
//   config         parsed .agent-config object (read fresh by the caller,
//                  never cached -- same contract as the autonomy watcher)
//   noteMtimeMs    mtime of today's session note, or null if the file does
//                  not exist (e.g. the session crossed midnight: the
//                  SessionStart hook only creates the file at boot)
//   lastActivityMs last Discord activity; caller seeds with boot time
//   lastRemindMs   when we last injected this reminder (0 = never)
//   noteDate       YYYY-MM-DD the caller statted, echoed into the content
//                  so the agent and the log agree on WHICH file was stale
// Returns { skip: true, reason } or { content, nextLastRemindMs, mode }.
// (NOTE_CADENCE_ACTIVE_MIN, the dead active-lane knob, is deliberately not
// read -- a config still carrying it is ignored, never an error.)
function planNoteTick({ now, config = {}, noteMtimeMs, lastActivityMs, lastRemindMs = 0, noteDate = '' }) {
  if (String(config.NOTE_CADENCE || '').toLowerCase() === 'off') {
    return { skip: true, reason: 'disabled' }
  }
  if (now - lastActivityMs <= ACTIVITY_WINDOW_MS) {
    return { skip: true, reason: 'active session' }
  }
  const idleMin = intKnob(config.NOTE_CADENCE_IDLE_MIN, DEFAULT_IDLE_MIN)
  const cadenceMs = idleMin * 60 * 1000

  const noteAge = noteMtimeMs == null ? Infinity : now - noteMtimeMs
  if (noteAge <= cadenceMs) return { skip: true, reason: 'note fresh' }
  // Throttle at the same cadence: a stale note must not become a reminder
  // every poll tick. If the agent complied, noteAge resets and the branch
  // above wins; if it ignored us, we repeat once per cadence window, which
  // is nagging exactly as often as the rule itself.
  if (now - lastRemindMs < cadenceMs) return { skip: true, reason: 'reminded recently' }

  const missing = noteMtimeMs == null
  const fileClause = missing
    ? `session_notes/${noteDate}.md가 아직 없다 (자정을 넘겼으면 이게 정상이다) -- 새로 만들고 지금까지의 맥락을 적어라`
    : `session_notes/${noteDate}.md를 지금까지의 작업/대화로 갱신해라`
  const content =
    `[SYSTEM] 세션노트 갱신 시간이다 (아이들 케이던스 ${idleMin}분 초과). ` +
    fileClause +
    '. checkpoint.md도 낡았으면 같이 덮어써. ' +
    '기록이 없으면 다음 부팅의 너는 이 시간을 통째로 잃는다. ' +
    '파일 작업만 해라, 디스코드에 답장하지 마.'

  return { content, nextLastRemindMs: now, mode: 'idle' }
}

module.exports = { planNoteTick, DEFAULT_IDLE_MIN, ACTIVITY_WINDOW_MS }
