// onboarding/routes/pending-signal.cjs -- the pending signal ("!", design-0024)
//
// The chat header's mark and the recite it starts. Two routes, and the whole
// feature is that they exist:
//
//   GET  /api/pending-signal         -- is there anything piled up that has
//                                       not been recited to her yet?
//   POST /api/pending-signal/recite  -- the click: one [system] turn into the
//                                       running agent's own notifyInbound.
//
// WHAT "PILED UP" MEANS (option (a) of the design doc, made): the corrections
// table's still-active count, the PENDING blocks in .review/reflux-proposals.md,
// and the dream-fragment files -- "what she wrote that you have not been
// shown". Nothing else is measured, and no model call is made. The recital
// tells her those numbers and then asks HER to name, from what she already
// knows, the things she has never told him -- the one source in the design's
// list that no accumulator in this app tracks (design-0024 §5, option (a)).
//
// THE THREE RULES THIS FILE INHERITS FROM THE DESIGN, in code:
//   * NOTHING IS SCHEDULED. No timer, no cache, no periodic work anywhere in
//     this file -- the pile is computed on the spot, on the request, and only
//     a click starts anything (design §"What this must not do"). A pin in
//     tests/test-pending-signal.mjs exists for exactly that.
//   * A SOURCE THAT CANNOT BE READ CONTRIBUTES ZERO. Missing .review/, missing
//     dreams/, no memory.db, an unreadable memory.db: each is 0 and never an
//     error -- an advisory surface fails toward silence, the
//     session-start-reflux-card.mjs posture. Neither route answers 500.
//   * THE STAMP IS NOT A DISMISSAL LEDGER. DATA_HOME/.gates/pending-signal.json
//     holds, per source, the number that was true when she last recited,
//     written ONLY after a successful inject. It compares numbers and stores no
//     judgment: no per-item record, no "seen" flag, and skipping a suggestion
//     leaves no trace (design §"What this must not do"). A pile that has not
//     grown since the last recital does not light the mark; one that grew
//     re-lights it.
//
// The rest -- the "!" button, the fetch cadence, the CSS -- is the chat page's
// half (onboarding/public/chat.html, js/chat.js, css/app.css, js/copy.js),
// built against the frozen shape these two routes answer with.
//
// The channel's bearer token is used in exactly one place: the Authorization
// header of the loopback fetch below. It never reaches a response, an error or
// a log line (same containment rule as routes/chat.cjs).
'use strict'

// The boot greeting's own seam, not a second one: the channel process injects
// a SYSTEM turn into the model with notifications/claude/channel (see
// channel-runtime.mjs's createBootAnnouncer). A route CANNOT reach the channel
// process's notifyInbound from here -- it is module-scope inside
// channel-local.mjs -- so the POST proxies over the existing
// DATA_HOME/local-channel.json loopback exactly as routes/chat.cjs does, and
// the channel's own /system-turn endpoint builds the meta there. Loopback
// round trip; generous only because the turn lands in a running agent.
const CHANNEL_TIMEOUT_MS = 5_000

const SOURCES = ['corrections', 'reflux', 'dreams', 'checkpoint']
// The shape every "nothing readable" answer falls back to. One literal, so a
// new source cannot be added to SOURCES and forgotten in the fallbacks.
const ZERO_SOURCES = { corrections: 0, reflux: 0, dreams: 0, checkpoint: 0 }
// A recital is one short paragraph, not a listing: at most this many reflux
// proposals are quoted, each clipped. The COUNT is always the honest one.
const RECITAL_MAX_PROPOSALS = 5
const RECITAL_PROPOSAL_CHARS = 120
const STAMP_BASENAME = 'pending-signal.json'
const PROPOSALS_BASENAME = 'reflux-proposals.md'

function createRoutes(staticCtx) {
  const { fs, path, log, sendJson, DATA_HOME, getMemoryService } = staticCtx

  // ── readers: three counts, each failing to 0 on its own ───────────────────

  // The db path exactly as memory/service.mjs resolves it (and as the boot
  // hook does): the explicit override wins, the data home is the default. Read
  // per call, never cached -- a relocated home or a test override must be seen
  // on the next request, not on the next process.
  function memoryDbPath() {
    return process.env.SCHEHERAZADE_MEMORY_DB || path.join(DATA_HOME, 'memory.db')
  }

  // corrections: the still_active count (memory/service.mjs:729's own query,
  // reached through the memory routes' access path instead of a second SQLite
  // connection idiom -- getMemoryService() -> service.query()).
  //
  // The existsSync guard is load-bearing, not defensive: service.query() runs
  // ensureDb(), which opens the file and runs the DDL, so asking a question
  // with no db present would CREATE memory.db. A fresh install must not grow a
  // database because the chat header polled.
  async function countCorrections() {
    try {
      if (!fs.existsSync(memoryDbPath())) return 0
      const service = await getMemoryService()
      const { count } = service.query({ table: 'corrections', filter: { still_active: 1 } })
      return Number.isInteger(count) && count > 0 ? count : 0
    } catch (err) {
      // Loud here, silent to the caller: the pile is a nudge, and a nudge that
      // cannot be computed is 0, not an error page.
      log(`pending-signal: corrections count failed (contributing 0): ${err.message}`)
      return 0
    }
  }

  // reflux: .review/reflux-proposals.md, one proposal per block delimited by a
  // line that is exactly `---`, each carrying `**Status**: PENDING`
  // (cadence/reflux-pass.cjs). Missing dir or file -> no proposals, never an
  // error: a fresh install has not run the reflux pass yet, and the daily
  // clock (cadence/daily-clock.cjs) only creates the file once it has a
  // proposal to write.
  //
  // Returns the count AND the `**Correction**:` lines of the pending blocks --
  // the recital quotes those, which is why this reader is not a bare count.
  function readReflux() {
    const file = path.join(DATA_HOME, '.review', PROPOSALS_BASENAME)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return { count: 0, corrections: [] }
    }
    // Split on the delimiter LINE (trailing whitespace tolerated so a CRLF
    // edit does not silently merge two proposals into one).
    const blocks = []
    let cur = []
    for (const line of text.split('\n')) {
      if (line.trim() === '---') { blocks.push(cur); cur = [] } else { cur.push(line) }
    }
    blocks.push(cur)
    let count = 0
    const corrections = []
    for (const block of blocks) {
      if (!block.some((l) => /^\s*\*\*Status\*\*:\s*PENDING\s*$/.test(l))) continue
      count++
      const line = block.find((l) => /^\s*\*\*Correction\*\*:/.test(l))
      if (line) {
        const said = line.replace(/^\s*\*\*Correction\*\*:\s*/, '').trim()
        if (said) corrections.push(said.slice(0, RECITAL_PROPOSAL_CHARS))
      }
    }
    return { count, corrections }
  }

  // dreams: DATA_HOME/dreams/YYYY-MM-DD.md, counted as FILES -- the boot
  // hook's own count (hooks/session-start.mjs:79), not a scan of the entries
  // inside them. Missing dir -> 0. A file that vanishes between the readdir
  // and the stat is skipped, not fatal.
  function countDreams() {
    try {
      const dir = path.join(DATA_HOME, 'dreams')
      return fs.readdirSync(dir).filter((f) => {
        if (!f.endsWith('.md')) return false
        try { return fs.statSync(path.join(dir, f)).isFile() } catch { return false }
      }).length
    } catch {
      return 0
    }
  }

  // checkpoint (0.3.8, Mino 2026-09-29 "! 기능에서 체크포인트 / 페르소나 정리도
  // 같이"): how many session notes were written after checkpoint.md last
  // changed. Every note she writes without refreshing the snapshot adds one,
  // so a checkpoint that falls behind lights the mark on its own. No
  // checkpoint.md at all = every note counts. Missing session_notes/ -> 0.
  function countCheckpointLag() {
    try {
      const dir = path.join(DATA_HOME, 'session_notes')
      let since = 0
      try { since = fs.statSync(path.join(DATA_HOME, 'checkpoint.md')).mtimeMs } catch { since = 0 }
      return fs.readdirSync(dir).filter((f) => {
        if (!f.endsWith('.md')) return false
        try {
          const st = fs.statSync(path.join(dir, f))
          return st.isFile() && st.mtimeMs > since
        } catch { return false }
      }).length
    } catch {
      return 0
    }
  }

  // ── the stamp: last recital's numbers, compared and never interpreted ─────
  function readStamp() {
    const p = path.join(DATA_HOME, '.gates', STAMP_BASENAME)
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      const out = {}
      for (const k of SOURCES) {
        const n = parsed && parsed[k]
        out[k] = Number.isInteger(n) && n > 0 ? n : 0
      }
      return out
    } catch {
      // No stamp (fresh install) or a torn one reads as "she has recited
      // nothing yet", so the whole current pile lights. That direction is
      // deliberate: the failure mode is one repeat nudge, never a silently
      // swallowed pile (same fail-toward-visible rule as the reflux card's
      // snooze file).
      return { ...ZERO_SOURCES }
    }
  }

  function writeStamp(current) {
    const p = path.join(DATA_HOME, '.gates', STAMP_BASENAME)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...current, at: new Date().toISOString() }))
    // Atomic: a torn stamp reads as no stamp, which re-lights the mark -- the
    // safe direction, and the same write shape the boot card uses.
    fs.renameSync(tmp, p)
  }

  // Pending = the pile GREW since she last recited it. Per source, so a source
  // that did not grow stays quiet while a new one lights on its own; total is
  // the sum, which is what the page reads. A pile that shrank is simply no
  // longer pending -- nothing to record, nothing to dismiss.
  function pendingOf(current, stamp) {
    const sources = {}
    let total = 0
    for (const k of SOURCES) {
      const d = Math.max(0, (current[k] || 0) - (stamp[k] || 0))
      sources[k] = d
      total += d
    }
    return { sources, total }
  }

  // One read of the world: the current counts plus the reflux proposal lines
  // the recital quotes.
  async function readCurrent() {
    const reflux = readReflux()
    const current = {
      corrections: await countCorrections(),
      reflux: reflux.count,
      dreams: countDreams(),
      checkpoint: countCheckpointLag(),
    }
    return { current, proposals: reflux.corrections }
  }

  // ── the recital ───────────────────────────────────────────────────────────
  // Lowercase `[system]` on purpose: the chat page's parseSystemLine renders a
  // line whose `[system]` sits at index <= 8 as a slim centered divider (the
  // boot line's treatment), not as an agent bubble -- this is an event, not
  // speech. NO "답장하지 마" anywhere in this text, and none of
  // stop-reply-guard's other silence patterns: the recital rides the real home
  // channelId (never 'system'), so the guard FORCES the utterance out. That is
  // the feature, not a side effect (hooks/stop-reply-guard.mjs:117-129, :197).
  function buildRecital(current, proposals) {
    const bits = []
    if (current.corrections > 0) bits.push(`아직 살아있는 교정 ${current.corrections}건`)
    if (current.reflux > 0) bits.push(`검토를 기다리는 환류 제안 ${current.reflux}건`)
    if (current.dreams > 0) bits.push(`꿈 조각 ${current.dreams}개`)
    if (current.checkpoint > 0) bits.push(`체크포인트 이후 쌓인 세션노트 ${current.checkpoint}개`)
    const lines = [`[system] 밀린 게 있다. ${bits.join(', ')}.`]
    if (proposals.length > 0) {
      lines.push(`환류 제안: ${proposals.slice(0, RECITAL_MAX_PROPOSALS).join(' / ')}`)
    }
    // Housekeeping rides every recital (0.3.8): the click is the one moment
    // the user has asked her to catch up, so the snapshot and the persona
    // get tidied in the same turn instead of waiting for a cycle that may
    // never run on this machine.
    lines.push(
      current.checkpoint > 0
        ? `체크포인트가 세션노트 ${current.checkpoint}개만큼 뒤처져 있다. 말 걸기 전에 checkpoint.md를 지금 상태로 새로 써라 (120줄 이하, 덧붙이지 말고 통째로).`
        : '체크포인트는 최신이다. 이번 턴에 상태가 바뀌면 그때 checkpoint.md를 새로 써라.',
    )
    lines.push(
      current.reflux > 0
        ? 'procedures/persona-reflux.md 대로 PENDING 제안마다 self_persona.md를 어떻게 바꿀지 채우고, 유저에게 한 줄씩 들고 가서 승인/거절을 받아라. 승인된 것만 self_persona.md에 반영한다.'
        : '살아있는 교정 중에 self_persona.md와 어긋나는 게 있으면 바꿀 문장을 한 줄로 제안해라. 유저가 승인하기 전엔 self_persona.md를 고치지 않는다.',
    )
    lines.push(
      '유저에게 아직 못 한 말이나 기억이 부족한 부분은 네가 이미 알고 있는 것만으로 직접 짚어라. ' +
      '지금 채팅에서 네 목소리로 먼저 말을 걸어라. 뭐가 밀렸는지, 체크포인트와 페르소나를 어떻게 정리했는지, 뭘 고칠 생각인지 짧게.',
    )
    return lines.join('\n')
  }

  // ── the channel hop (same shape as routes/chat.cjs) ───────────────────────
  // null = not running (file absent, unparseable, or the token/port shape is
  // wrong). Per-request read: the port is OS-picked and changes on every agent
  // restart, so a cached one goes stale exactly when it matters.
  function readChannelEndpoint() {
    try {
      const raw = fs.readFileSync(path.join(DATA_HOME, 'local-channel.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const port = Number(parsed && parsed.port)
      const token = parsed && parsed.token
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null
      if (typeof token !== 'string' || !token) return null
      return { port, token }
    } catch {
      return null
    }
  }

  // {status: 0} = the channel could not be reached at all (dead port from a
  // stale file, or a hung socket past the timeout).
  async function postSystemTurn(ep, content) {
    try {
      const r = await fetch(`http://127.0.0.1:${ep.port}/system-turn`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
      })
      let parsed = null
      try { parsed = await r.json() } catch { /* non-JSON upstream body -> status still tells the story */ }
      return { status: r.status, body: parsed }
    } catch {
      return { status: 0 }
    }
  }

  return [
    // GET /api/pending-signal -- the mark's only input. Reads and computes;
    // writes nothing, starts nothing, and answers 200 with zeros rather than
    // failing. `total` is the PENDING sum (what has not been recited), so the
    // same pile does not light the mark twice; `sources` is that same
    // per-source breakdown and every member defaults to 0.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/pending-signal',
      handler: async (req, res) => {
        try {
          const { current } = await readCurrent()
          const { sources, total } = pendingOf(current, readStamp())
          sendJson(res, 200, { ok: true, total, sources })
        } catch (err) {
          // Unreachable in practice (every reader fails to 0 on its own), but
          // the contract is "never 500" -- an advisory surface that 500s is a
          // mark that cannot be trusted either way.
          log(`pending-signal: read failed (answering empty): ${err.message}`)
          sendJson(res, 200, { ok: true, total: 0, sources: { ...ZERO_SOURCES } })
        }
        return
      },
    },
    // POST /api/pending-signal/recite -- the click. Mutating, so the
    // per-launch Host/Origin/X-Onboard-Token gate has already run.
    //
    //   empty pile   -> injected:false, reason:'empty', no inject call at all
    //   channel down -> injected:false, reason:'offline', NO STAMP: the pile
    //                   is not lost, the mark stays lit, and the page shows no
    //                   error for it (design-0024: a failed nudge is not a
    //                   failure the user needs to see)
    //   delivered    -> injected:true, and ONLY then the stamp
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/pending-signal/recite',
      handler: async (req, res) => {
        let pending = { sources: { ...ZERO_SOURCES }, total: 0 }
        try {
          const { current, proposals } = await readCurrent()
          pending = pendingOf(current, readStamp())
          if (pending.total === 0) {
            sendJson(res, 200, { ok: true, injected: false, total: 0, reason: 'empty' })
            return
          }
          const ep = readChannelEndpoint()
          if (!ep) {
            sendJson(res, 200, { ok: true, injected: false, total: pending.total, reason: 'offline' })
            return
          }
          const r = await postSystemTurn(ep, buildRecital(current, proposals))
          if (r.status !== 202) {
            // 401 (a token from a stale file the moment after a restart) and a
            // dead port land here too, on purpose: the client's move is
            // identical for all of them (retry after the next click) and none
            // of them is worth an error toast on a nudge.
            sendJson(res, 200, { ok: true, injected: false, total: pending.total, reason: 'offline' })
            return
          }
          // Stamped after the inject landed, never before: the stamp means
          // "she has been told", and a stamp written for a turn that never
          // arrived would swallow the pile.
          let stamped = true
          try {
            writeStamp(current)
          } catch (err) {
            stamped = false
            log(`pending-signal: stamp write failed (the mark will stay lit): ${err.message}`)
          }
          // total is what is pending RIGHT NOW, in every branch of this route:
          // the stamp just made it 0 (the same number the next GET reports), or
          // the old value when the stamp could not be written.
          sendJson(res, 200, { ok: true, injected: true, total: stamped ? 0 : pending.total })
        } catch (err) {
          log(`pending-signal: recite failed (injecting nothing): ${err.message}`)
          sendJson(res, 200, { ok: true, injected: false, total: pending.total, reason: 'offline' })
        }
        return
      },
    },
  ]
}

module.exports = { createRoutes }
