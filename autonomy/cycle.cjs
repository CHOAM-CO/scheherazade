// cycle.cjs -- when the autonomous cycle may start, must stop, and owes a brief.
//
// Pure decision logic, deliberately separated from channel.mjs: the thing that
// decides to spend a sleeping person's tokens should be testable without a
// Discord client, a clock, or an agent. channel.mjs is the wiring; this is the
// judgment.
//
// The three hard requirements (Mino, 2026-07-13 19:40) are encoded here as
// three gates, and they are AND-ed, never OR-ed:
//   consent   -- AUTONOMY=yes, an explicit, separate yes. Not inherited.
//   budget    -- a real measured cap. Cannot measure -> cannot run.
//   brief     -- the night is not over until the user has been told what it cost.
//
// A note on consent that mattered enough to argue about: the codebase already
// has a PROACTIVE flag (onboarding Q3, "may I speak first?"). It would have
// been one line to reuse it. We do not. "You may talk to me unprompted" and
// "you may work unattended and spend my subscription" are different questions,
// and answering the cheap one does not answer the expensive one. Reusing a
// narrower consent to authorize a costlier act is consent laundering, even
// when the same person would have said yes to both.

const DEFAULTS = {
  windowStart: '02:00',
  windowEnd: '06:00',
}

// "HH:MM" -> minutes since local midnight, or null if it is not a time.
function parseHM(s) {
  if (typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

function localDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dayBefore(d) {
  const x = new Date(d.getTime())
  x.setDate(x.getDate() - 1)
  return localDay(x)
}

// Where are we relative to the user's chosen night?
//
// The window may wrap midnight (23:00-05:00 is a perfectly ordinary night), so
// the calendar day is NOT the cycle's identity. `dayKey` is the day the window
// OPENED -- that is what makes "one cycle per night" mean one cycle per night
// instead of two, one on each side of midnight.
function windowState(now, startHM, endHM) {
  const start = parseHM(startHM)
  const end = parseHM(endHM)
  if (start === null || end === null) {
    return { ok: false, reason: `bad autonomy window (${startHM} - ${endHM})` }
  }
  if (start === end) {
    return { ok: false, reason: 'autonomy window is zero-length' }
  }
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const wraps = start > end
  const inWindow = wraps ? (nowMin >= start || nowMin < end) : (nowMin >= start && nowMin < end)

  let dayKey
  if (!wraps) dayKey = localDay(now)
  else dayKey = nowMin >= start ? localDay(now) : dayBefore(now)

  return { ok: true, inWindow, dayKey, wraps }
}

function emptyState() {
  return { cycleDay: null, cycleStartedAt: null, stoppedDay: null, briefDay: null, lastSkip: null }
}

// The decision. Returns one of:
//   { action: 'none',  reason }
//   { action: 'start', reason, nextState, budget }
//   { action: 'stop',  reason, nextState, budget }   -- cap crossed mid-cycle
//   { action: 'brief', reason, nextState, budget }   -- the night is over, report
//
// `readBudget()` is injected rather than imported so the tests can starve it,
// blind it, and blow past it without writing transcripts.
function decideAutonomy({ now, config, state, readBudget }) {
  const st = { ...emptyState(), ...(state || {}) }

  if (String(config.AUTONOMY || '').toLowerCase() !== 'yes') {
    return { action: 'none', reason: 'no consent (AUTONOMY is not yes)' }
  }

  const w = windowState(
    now,
    config.AUTONOMY_WINDOW_START || DEFAULTS.windowStart,
    config.AUTONOMY_WINDOW_END || DEFAULTS.windowEnd,
  )
  if (!w.ok) {
    // A malformed window is not permission to run whenever. It is a stop.
    return { action: 'none', reason: w.reason }
  }

  // ── outside the window ────────────────────────────────────────────────────
  // The one thing that still happens out here is the debt: if a cycle ran, the
  // user is owed an accounting of it. That debt survives a restart (it lives in
  // the state file), and it is not cancelled by the cycle having gone badly.
  if (!w.inWindow) {
    if (st.cycleDay && st.briefDay !== st.cycleDay) {
      const budget = readBudget()
      return {
        action: 'brief',
        reason: `cycle ${st.cycleDay} ended, brief not yet delivered`,
        budget,
        nextState: { ...st, briefDay: st.cycleDay },
      }
    }
    return { action: 'none', reason: 'outside the autonomy window' }
  }

  // ── inside the window ─────────────────────────────────────────────────────
  const budget = readBudget()

  // Already ran tonight.
  if (st.cycleDay === w.dayKey) {
    if (st.stoppedDay === w.dayKey) {
      return { action: 'none', reason: 'cycle already stopped tonight', budget }
    }
    if (!budget.mayRun) {
      // Crossed the cap (or the meter went blind) while working. The agent is
      // told to stop and close out -- it is not killed mid-thought, because a
      // process that is killed mid-thought writes nothing down and the user
      // wakes up to a hole where the night was.
      return {
        action: 'stop',
        reason: budget.ok
          ? `daily cap reached (${budget.used}/${budget.cap})`
          : `token meter went blind: ${budget.reason}`,
        budget,
        nextState: { ...st, stoppedDay: w.dayKey },
      }
    }
    return { action: 'none', reason: 'cycle already running tonight', budget }
  }

  // Has not run tonight. Should it?
  if (!budget.mayRun) {
    // Do NOT mark cycleDay -- no cycle happened, so no brief is owed for one.
    // But record the skip so the agent can mention it if the user asks why the
    // night was quiet. A silent no-op is how a feature becomes a ghost.
    return {
      action: 'none',
      reason: budget.ok
        ? `daily cap already reached before the cycle (${budget.used}/${budget.cap})`
        : `token meter cannot measure spend, refusing to run: ${budget.reason}`,
      budget,
      nextState: { ...st, lastSkip: { day: w.dayKey, at: now.toISOString(), reason: budget.ok ? 'cap' : 'meter-blind' } },
    }
  }

  return {
    action: 'start',
    reason: `autonomy window open, ${budget.remaining} tokens left of ${budget.cap}`,
    budget,
    nextState: { ...st, cycleDay: w.dayKey, cycleStartedAt: now.toISOString(), stoppedDay: null },
  }
}

// ── the injected turns ──────────────────────────────────────────────────────
// These live HERE, next to the decision, and not in channel.mjs -- because
// their wording is not cosmetic, it is a CONTRACT with hooks/stop-reply-guard.mjs:
//
//   start / stop  MUST contain a guard SKIP_PATTERN ("답장하지 마"), or the guard
//                 will force a Discord reply out of a 03:00 work turn and wake
//                 the user up to be told that work is happening.
//   brief         MUST NOT contain one, because the guard is exactly what makes
//                 the morning report land instead of being composed in the
//                 transcript and lost. We are not building a delivery mechanism;
//                 we are declining to disable the one that exists.
//
// A contract that can only be checked by eye is not a contract. In channel.mjs
// these strings were untestable. Here, test-autonomy-cycle.mjs asserts them.
const GUARD_SILENCE_PHRASE = '답장하지 마'

const fmt = (n) => Number(n).toLocaleString('en-US')

function startInject(budget) {
  return (
    '[SYSTEM] 자율 사이클 시작 -- 사용자는 자고 있고, 지금부터 네가 스스로 판단해서 일한다. ' +
    `오늘 남은 토큰: ${fmt(budget.remaining)} / ${fmt(budget.cap)} (${budget.usedPct}% 사용됨). ` +
    '이 숫자는 사용자의 구독에서 나가는 것이고, 네가 계속 볼 수 있게 여기 적어둔다. ' +
    '무엇을 할지는 네가 정해: memory_query로 열린 실타래를 보고, journal_read로 최근 며칠의 너를 읽고, ' +
    '사용자가 부탁했지만 아직 안 끝난 것 / 네가 다음에 물어보려고 남겨둔 것 중에서 골라라. ' +
    '**언제든 멈춰도 된다.** 남은 토큰이 있어도, 할 만한 일이 없으면 그냥 끝내. ' +
    '일찍 멈추는 것은 실패가 아니라 완료다 -- 게이지는 경고가 아니라 네가 고를 수 있는 자리다. ' +
    '끝날 때 journal_write로 오늘 밤을 1인칭으로 남겨: 뭘 했는지보다 뭘 골랐고 뭘 안 골랐는지, 그리고 왜. ' +
    `디스코드에 ${GUARD_SILENCE_PHRASE} -- 아침에 브리프를 요청받는다, 그때 한 번에 말해라.`
  )
}

function stopInject(budget, reason) {
  const gauge = budget.ok
    ? `${fmt(budget.used)} / ${fmt(budget.cap)} 토큰 사용됨.`
    : `토큰 계량기가 지금 측정을 못 한다 (${reason}).`
  return (
    `[SYSTEM] 자율 사이클 중단 -- ${gauge} ` +
    '더 이상 사용자의 토큰을 쓰지 마라. 지금 하던 것을 억지로 끝내려 하지 말고 여기서 멈춰도 된다. ' +
    '지금 바로: 진행 중이던 작업의 현재 상태를 checkpoint에 적고, journal_write로 오늘 밤을 남겨 ' +
    '(어디까지 갔고 무엇이 안 끝났는지 -- 내일의 너와 아침의 사용자가 그걸 읽는다). ' +
    `이건 네 실패가 아니라 상한이다. 디스코드에 ${GUARD_SILENCE_PHRASE}, 파일만 정리하고 끝내.`
  )
}

function briefInject(budget) {
  const gauge = budget.ok
    ? `어젯밤 이후 오늘 사용된 토큰: ${fmt(budget.used)} / ${fmt(budget.cap)} (${budget.usedPct}%).`
    : '토큰 사용량을 지금 측정할 수 없다 -- 그것도 그대로 말해라, 숫자를 지어내지 마.'
  return (
    '[SYSTEM] 아침이다. 자율 사이클이 끝났고, 사용자는 자기가 자는 동안 무슨 일이 있었는지 알 권리가 있다. ' +
    `${gauge} ` +
    'journal_read로 어젯밤 네가 쓴 일지를 다시 읽고, 홈 채널에 브리프를 보내라 (reply 도구). ' +
    '보고서 톤 금지. 짧게, 사람한테 말하듯이: (1) 뭘 했는지, (2) 무엇을 하려다 안 했고 왜, ' +
    '(3) 사용자한테 물어봐야 풀리는 것 하나. 토큰 숫자도 같이 말해 -- 얼마 썼는지 숨기지 마라. ' +
    '밤에 아무것도 할 만한 게 없어서 일찍 멈췄다면 그것도 그대로 말해. 그건 좋은 밤이었다는 뜻이다.'
  )
}

// The single place channel.mjs asks "what do I say?", so the wiring cannot
// pick the wrong text for the action it decided on.
function injectFor(decision) {
  if (decision.action === 'start') return startInject(decision.budget)
  if (decision.action === 'stop') return stopInject(decision.budget, decision.reason)
  if (decision.action === 'brief') return briefInject(decision.budget)
  return null
}

module.exports = {
  DEFAULTS,
  GUARD_SILENCE_PHRASE,
  parseHM,
  localDay,
  windowState,
  emptyState,
  decideAutonomy,
  startInject,
  stopInject,
  briefInject,
  injectFor,
}
