// read.cjs -- read the owner's macOS calendar without ever lying about it.
//
// THE RULE (same one as the token meter and the pointer index):
// silence falls toward "I don't know", never toward "nothing".
//
//   { ok: true, events: [] }   "I read your calendar. You have nothing scheduled."
//   { ok: false, code, reason} "I could not read your calendar."
//
// Different sentences. Only one is a relief. An empty list returned on a
// permission failure lets the agent tell someone their day is clear on the
// morning they have a funeral.
//
// ── two APIs, and why this one ──────────────────────────────────────────────
// The original design scripted Calendar.app over Apple Events (JXA
// `Application('Calendar')`). It was never executed until 2026-07-13, and the
// moment it was, it disqualified itself:
//
//   Apple Events (Calendar.app scripting) : 50,003 ms for a 14-day read
//                                           (12 calendars, 981 events)
//   EventKit (native framework)           :        76 ms, same machine
//
// 650x. A tool call that takes fifty seconds is not a tool. EventKit also asks
// for the RIGHT permission: "Calendars", rather than "Automation" -- Automation
// is permission to drive the whole application, which is far more than reading
// a schedule, and the narrower ask is the honest one.
//
// ── the trap that made this file paranoid ───────────────────────────────────
// EventKit's read returned `count: 0` with NO ERROR while the Apple Events path
// simultaneously found 3 events in the same window. The difference was
// authorizationStatus = 4 (writeOnly): the process could ADD events but not SEE
// them, and the framework expressed that as an empty result rather than a
// refusal.
//
// So this file NEVER reports events without first checking the authorization
// status, and treats anything short of full access as a refusal to answer. The
// zero was the lie; the guard is the fix.
// ── UNVERIFIED, and named here rather than assumed ──────────────────────────
// This reader shells out to /usr/bin/osascript. In the shipped app the process
// tree is:  Scheherazade.app -> claude CLI -> calendar/server.mjs -> osascript
//
// macOS attributes a TCC request to the "responsible process", which for a
// spawned child is normally the parent app bundle -- that is why the Automation
// prompt names the app rather than naming osascript. If that attribution holds,
// NSCalendarsFullAccessUsageDescription (declared in package.json) supplies the
// sentence, the user clicks once on first use, and this works.
//
// I HAVE NOT PROVEN THAT. It needs a packaged build on a machine that has never
// granted the permission, and it is exactly the kind of claim that sounds true
// and ships broken -- the same shape as the 50-second design that "worked" in
// theory until it was executed.
//
// If attribution instead lands on osascript, the fallback is to stop shelling
// out: do the EventKit call in-process from the Electron main (a native addon,
// or a small signed helper inside the bundle) so the request unambiguously comes
// from the app. That is a bigger change and it is not worth making until the
// cheap path is observed to fail.
'use strict'

const { execFile } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 15000

// EKAuthorizationStatus. Verified against live behavior on this machine rather
// than trusted from memory: status 4 returned zero events while another API saw
// three, which is writeOnly's signature exactly.
const EK_STATUS = {
  0: { code: 'not_determined', reason: '캘린더 접근 권한을 아직 물어보지 않았습니다.' },
  1: { code: 'restricted', reason: '이 기기의 정책이 캘린더 접근을 제한하고 있습니다.' },
  2: { code: 'denied', reason: '캘린더 접근이 거부되어 있습니다. 시스템 설정 > 개인정보 보호 및 보안 > 캘린더에서 허용해주세요.' },
  3: null, // fullAccess -- the only status that may report events
  4: {
    code: 'write_only',
    reason:
      '캘린더에 쓰기 권한만 있고 읽기 권한이 없습니다. 이 상태에서는 일정이 0건으로 보이는데, ' +
      '그건 일정이 없다는 뜻이 아니라 볼 수 없다는 뜻입니다. ' +
      '시스템 설정 > 개인정보 보호 및 보안 > 캘린더에서 전체 접근을 허용해주세요.',
  },
}

const SCRIPT = `
ObjC.import('EventKit')
ObjC.import('Foundation')

function run(argv) {
  const fromSec = parseFloat(argv[0])
  const toSec = parseFloat(argv[1])

  // 0 = EKEntityTypeEvent. Checked BEFORE reading anything: a write-only grant
  // returns an empty list instead of an error, and an empty list is a sentence
  // we are not allowed to say unless it is true.
  const status = parseInt($.EKEventStore.authorizationStatusForEntityType(0), 10)
  if (status !== 3) {
    return JSON.stringify({ authStatus: status })
  }

  const store = $.EKEventStore.alloc.init
  const from = $.NSDate.dateWithTimeIntervalSince1970(fromSec)
  const to = $.NSDate.dateWithTimeIntervalSince1970(toSec)
  const pred = store.predicateForEventsWithStartDateEndDateCalendars(from, to, $())
  const evs = store.eventsMatchingPredicate(pred)

  const fmt = $.NSISO8601DateFormatter.alloc.init
  const out = []
  const n = parseInt(evs.count, 10)
  for (let i = 0; i < n; i++) {
    const e = evs.objectAtIndex(i)
    try {
      out.push({
        calendar: ObjC.unwrap(e.calendar.title),
        title: ObjC.unwrap(e.title) || '',
        start: ObjC.unwrap(fmt.stringFromDate(e.startDate)),
        end: ObjC.unwrap(fmt.stringFromDate(e.endDate)),
        allDay: Boolean(e.isAllDay),
        location: ObjC.unwrap(e.location) || null,
      })
    } catch (err) { /* one unreadable event must not sink the whole read */ }
  }
  return JSON.stringify({ authStatus: status, events: out })
}
`

function classify(err, stderr) {
  const text = `${stderr || ''} ${err ? err.message : ''}`
  if (err && err.killed) {
    return {
      code: 'timeout',
      reason:
        '캘린더가 제한 시간 안에 응답하지 않았습니다. 권한 팝업이 뜰 곳이 없거나 (창 없는 실행), ' +
        '캘린더가 멈춰 있을 수 있습니다.',
    }
  }
  if (/-1743|not authori[sz]ed/i.test(text)) {
    return { code: 'not_authorized', reason: '캘린더 접근 권한이 없습니다.' }
  }
  return { code: 'unknown', reason: (stderr || (err && err.message) || 'osascript 실패').trim() }
}

// readEvents({ from, to, timeoutMs }) -> Promise<
//   { ok: true, events, authStatus, from, to } |
//   { ok: false, code, reason, authStatus? }
// >
// Never throws. Never returns [] to mean "I couldn't look".
function readEvents({ from, to, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const f = from instanceof Date ? from : new Date(from)
  const t = to instanceof Date ? to : new Date(to)
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
    return Promise.resolve({ ok: false, code: 'bad_range', reason: `unusable date range (${from} .. ${to})` })
  }
  if (t.getTime() <= f.getTime()) {
    return Promise.resolve({ ok: false, code: 'bad_range', reason: 'the range ends before it starts' })
  }

  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', SCRIPT, String(f.getTime() / 1000), String(t.getTime() / 1000)],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, ...classify(err, stderr) })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(String(stdout).trim() || 'null')
        } catch (e) {
          resolve({ ok: false, code: 'bad_output', reason: `캘린더가 읽을 수 없는 값을 반환했습니다: ${String(stdout).slice(0, 120)}` })
          return
        }
        if (!parsed || typeof parsed.authStatus !== 'number') {
          resolve({ ok: false, code: 'bad_output', reason: '캘린더 응답에 권한 상태가 없습니다.' })
          return
        }

        // The guard. Anything short of full access is a refusal to answer, not
        // an empty calendar.
        const denial = EK_STATUS[parsed.authStatus]
        if (denial) {
          resolve({ ok: false, ...denial, authStatus: parsed.authStatus })
          return
        }
        if (parsed.authStatus !== 3 || !Array.isArray(parsed.events)) {
          resolve({ ok: false, code: 'unknown', reason: `알 수 없는 권한 상태 (${parsed.authStatus})`, authStatus: parsed.authStatus })
          return
        }

        resolve({ ok: true, events: parsed.events, authStatus: 3, from: f.toISOString(), to: t.toISOString() })
      },
    )
  })
}

// The owner's local day, not UTC's.
function dayRange(now = new Date(), days = 1) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000)
  return { from: start, to: end }
}

module.exports = { readEvents, dayRange, classify, DEFAULT_TIMEOUT_MS, EK_STATUS, SCRIPT }
