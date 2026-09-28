// chat.js — /chat in-app conversation page (in-app chat slice 4,
// docs/in-app-chat-plan.md). The page end of the local channel backend:
// polls GET /api/chat/out by cursor (1s, same cadence as logs.js), sends
// via POST /api/chat/in (window.api attaches the per-launch onboard token),
// and renders honestly when the channel is down instead of pretending.
//
// What this page deliberately does NOT do (plan §out-of-scope): uploads,
// multiple threads. One list, one input.
//
// Two shapes worth naming:
//  - The channel's queue is the TRANSCRIPT (both roles, channel-local.mjs)
//    and this page replays it in full on every load. v0.0.31 shipped the
//    opposite -- user bubbles were DOM-only and the first poll seeded the
//    cursor past everything already queued -- so navigating away erased the
//    user's half and swallowed any reply that landed while the page was
//    gone (the owner's 07-30 repro). User bubbles now come from the transcript
//    echo (a send triggers an immediate poll), never from a local append:
//    one source of truth, no dedup bookkeeping.
//  - A failed send KEEPS the text in the input. Losing the user's message
//    to a restart race is the one unforgivable failure here.
//
// DM interaction states (v0.0.34, the owner 07-30 17:41 "인스타 DM쓰는것처럼"):
//  - "Read" + typing dots both derive from ONE server value,
//    state.awaitingReplySince (channel-local.mjs transcriptState) -- no
//    client-side guessing about what the agent received. Read is honest by
//    construction (a user message only enters the transcript after delivery
//    into the agent process); typing means "delivered, no reply yet" and is
//    CAPPED at 3 minutes -- past that, endless dots would dress a silent
//    agent (the 0.0.31 failure class) as an active one.
//  - Reactions are transcript items (kind:'reaction') replayed like
//    messages: a tap POSTs /api/chat/react and the badge renders from the
//    transcript echo via pollNow(), same one-source-of-truth as sends.
//
// Live turn state (design-0025, 2026-09-28, the owner "얘가 툴콜중인지 세션이
// 끊긴건지 ... 인디케이팅좀 예쁘게"): the in-flight signals above each used to
// re-derive "is a turn running" from their own slice of the facts (the dots
// from `waiting`, the fold from its own staleness guard, Stop from `hidden`)
// and they disagreed the moment the lane died mid-turn -- the poll failed, the
// dots/Stop/Read retired, and the run fold, Think fold and draft bubble stayed
// up over a turn that no longer existed. They now all read ONE derived state:
// js/turn-state.cjs (loaded before this file, the same dual-environment
// contract model-catalog.cjs holds, so the derivation is testable without a
// DOM). This file only paints what it returns.

;(function () {
  const C = window.COPY.chat

  const TURN = window.SCHZ_TURN_STATE // js/turn-state.cjs (see the header)
  const POLL_MS = 1000
  const STATUS_EVERY_TICKS = 5 // /status is a live /health probe upstream; 5s is fresh enough
  const LANE_STATUS_MS = 2000 // /api/agent/status, fetched only while a turn is in flight
  const MAX_CLIENT_MSGS = 500 // mirror of the channel's MAX_QUEUE
  const TYPING_SHOW_MAX_MS = TURN ? TURN.TYPING_SHOW_MAX_MS : 3 * 60 * 1000
  const REACTIONS = ['👍', '❤️'] // mirror of the channel's USER_REACTIONS

  function $(id) { return document.getElementById(id) }

  const pane = $('ct-pane')
  const input = $('ct-input')
  const sendBtn = $('ct-send')
  // Stop + steer (0.3.1). stopBtn only exists while a turn is in flight;
  // steerHint says what the (still live) textarea will do while it is.
  const stopBtn = $('ct-stop')
  const steerHint = $('ct-steer-hint')
  let stopBusy = false // one press per run: the second click has nothing to kill

  let nextSeq = null // null = cursor not seeded yet (first poll renders nothing)
  let msgCount = 0
  let pollTimer = null
  let tick = 0
  let emptyEl = null
  let lastStatus = null
  let bubbles = new Map() // seq -> bubble element, for attaching reaction badges
  let lastUserBubble = null
  let lastRenderedRole = null // 0.2.6 UI pass: agent-run grouping for the sender row
  let agentName = '' // filled from the status probe (setStatus detail)
  // Profile picture (2026-09-28, the owner "프로필 사진"): one value for every
  // sender row. It starts on the STATIC fallback so a row rendered before
  // nav.js's token-bearing fetch resolves is already complete -- a picture
  // that appears a beat after the name is a visible jump in the feed.
  let avatarSrc = window.AVATAR_FALLBACK_URL || '/img/agent-avatar.png'
  window.avatarUrl().then((u) => { avatarSrc = u })
  let awaitingSince = null // state.awaitingReplySince from the last /out
  let channelUp = false // freshest signal: did the last /out poll succeed
  let readEl = null
  // ── live turn state (design-0025) ────────────────────────────────────────
  // The derivation's inputs, and its one output. `turnState` is what every
  // render site reads; nothing below re-derives "is a turn running".
  let turnState = 'idle'
  let lastAbort = null // {reason, elapsedMs, at} -- the newest turn-abort item of THIS turn
  let stoppingAt = null // ms epoch the Stop press landed (holds until the abort lands)
  let restartingAt = null // ms epoch the restart action was fired
  let diedInFlight = false // this turn was watched dying; a live poll does not un-die it
  let sawWorkSinceWait = false // any activity/think/draft since the unanswered message
  let lastStepLabel = '' // the last activity item's label (the run fold's live summary text)
  let laneStatus = null // GET /api/agent/status, fetched only while a turn is in flight
  let lanePolledAt = 0
  // The rail: one line for the states where a turn is NOT being worked on
  // (다시 붙는 중 / 세션 끊김 / Stopping…) and the elapsed chip's home when no
  // run fold is on screen. The dots ride inside it -- same element and same
  // class as before, so the CSS contract is untouched.
  let turnEl = null
  let turnDotsEl = null
  let turnLabelEl = null
  let turnChipEl = null
  let runLabelEl = null // the live run fold's step label (its own summary span)
  let runChipEl = null // the elapsed chip while the live run fold holds the step label
  // P1 v2 live run fold (aside port, the owner 2026-08-05 19:49 "어사이드 렌더링
  // 잘 베끼셈"): while the agent works, steps render LIVE into an open
  // <details> timeline; the reply that ends the wait collapses the SAME
  // element into a "Worked for Ns" summary. (v1 showed one latest-wins
  // status line and rebuilt the fold after the fact.)
  const MAX_FOLD_LINES = 60
  let runEl = null // the live <details>; null when no run is on screen
  let runSummary = null
  let activityLog = []
  let activityStart = 0
  let lastActivityAt = 0
  // 0.2.1 collapsible Think fold (the owner 08-19 "우리도 띵크 접이식으로
  // 가자"): the dsh lane streams the model's reasoning as kind:'think'
  // transcript items (paragraph-sized flushes). One <details> per turn,
  // COLLAPSED by default — the summary pulses while thinking, settles to
  // "Thought process" when the reply lands. The claude lane never posts
  // these, so the fold simply never appears there.
  const MAX_THINK_PARAS = 40
  let thinkEl = null
  let thinkSummary = null
  let thinkParas = 0
  // 0.2.4 answer-stream draft (the owner "두두두둑"): /out returns a `draft`
  // string while the dsh lane streams the answer's text-deltas. One agent
  // bubble grows in place (markdown re-render is destructive, so full-text
  // re-render each tick is safe); the real transcript message retires it.
  // The claude lane never streams, so the bubble simply never appears there.
  let draftEl = null
  // 0.2.15 background-subagent pill (the owner 08-24 "서브 스폰하면 서브도
  // working 정보에 띄우게"): /out returns a live `bg` roster; while any
  // entry exists the pill stays visible EVEN AFTER the turn's run fold
  // collapsed -- turn end is not work end when children are running.
  let bgEl = null

  function setStatics() {
    $('ct-title').textContent = C.title
    $('ct-subtitle').textContent = C.subtitle
    sendBtn.textContent = C.send
    input.placeholder = C.placeholder
    if (stopBtn) {
      stopBtn.textContent = C.stop
      stopBtn.setAttribute('aria-label', C.stopAria)
      stopBtn.onclick = requestStop
    }
    if (steerHint) steerHint.textContent = C.steerHint
    $('ct-status').textContent = C.statusChecking
    const newConvoBtn = $('ct-new-convo')
    if (newConvoBtn) newConvoBtn.textContent = C.newConversation
    jumpBtn.textContent = C.jumpToLatest
    jumpBtn.onclick = () => { pane.scrollTop = pane.scrollHeight; hideJump() }
    // reaching the bottom by hand retires the pill too
    pane.addEventListener('scroll', () => { if (atBottom()) hideJump() })
  }

  function atBottom() {
    // P1: 100px "near bottom" threshold (was 8px — any upward wheel broke
    // the stick with no way back but manual scroll). Past the threshold,
    // auto-scroll stops and the jump pill appears instead of yanking the
    // viewport (ChatGPT/Claude convention).
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100
  }

  const jumpBtn = $('ct-jump')
  // Dedicated class (not the global display:none .hidden) so the pill can
  // scale/fade in and out (aside's scroll-to-bottom affordance).
  function showJump() { jumpBtn.classList.remove('chat-pill-hidden') }
  function hideJump() { jumpBtn.classList.add('chat-pill-hidden') }

  function showEmpty() {
    if (emptyEl || msgCount) return
    // P1: example prompts instead of a blank sentence (Notion pattern).
    // A click FILLS the composer — the user keeps the send trigger.
    emptyEl = document.createElement('div')
    emptyEl.className = 'chat-empty'
    const title = document.createElement('div')
    title.className = 'chat-empty-title'
    title.textContent = C.emptyTitle
    emptyEl.appendChild(title)
    for (const example of C.emptyExamples) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chat-empty-item'
      b.textContent = example
      b.onclick = () => { input.value = example; input.focus() }
      emptyEl.appendChild(b)
    }
    pane.appendChild(emptyEl)
  }

  function clearEmpty() {
    if (!emptyEl) return
    emptyEl.remove()
    emptyEl = null
  }

  // NO innerHTML -- message text (either side's) is model output and forwarded
  // human text, i.e. exactly where an injection would arrive. renderMarkdown
  // builds DOM nodes and puts every character through createTextNode, so the
  // original textContent-only guarantee survives the addition of formatting
  // (markdown.js header has the reasoning). Message text is still written
  // BEFORE any child node (react bar, badge) is attached: renderMarkdown
  // clears the element first, so calling it later would wipe them.
  // Image-attachment markers (2026-08-04): the send path appends
  // "[image attached: <path> — read it with the Read tool]" lines so the
  // AGENT gets a Read-able local path (Discord-inbound convention). For
  // DISPLAY those lines are lifted out and rendered as thumbnails instead
  // of raw paths. The blob fetch goes through fetch-with-token, not
  // <img src> -- every /api GET is X-Onboard-Token-gated, so a bare src
  // would 403.
  // Tolerant of every markerFor() variant (and 0.0.54's original text):
  // path up to the first " — ", then any guidance clause. The clause is
  // OPTIONAL since 0.1.18 — agent-emitted markers (send_file, windowshot
  // skill) may carry a bare path.
  const IMG_MARKER_RE = /^\[image attached: (.+?)(?: — [^\]]*)?\]$/
  // 0.1.18 (attachments both ways): [file attached:] / [PDF attached:]
  // lines used to render as raw path prose; now they lift into a
  // download-chip through the same basename-in-chat_uploads serve route the
  // image bubbles use. Only names actually inside chat_uploads resolve —
  // anything else renders the honest missing-note.
  const FILE_MARKER_RE = /^\[(?:file|PDF) attached: (.+?)(?: — [^\]]*)?\]$/
  function splitImageMarkers(text) {
    const images = []
    const files = []
    const kept = []
    for (const line of String(text || '').split('\n')) {
      const im = line.match(IMG_MARKER_RE)
      if (im) { images.push(im[1].split(/[\\/]/).pop()); continue }
      const fm = line.match(FILE_MARKER_RE)
      if (fm) { files.push(fm[1].split(/[\\/]/).pop()); continue }
      kept.push(line)
    }
    return { shown: kept.join('\n'), images, files }
  }

  async function appendAttachmentFile(el, name) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'chat-attach-chip'
    // Server-minted names are ts_stem.ext (user uploads) or ts_agent_base
    // (agent sends) — show the human tail, keep the full name for the fetch.
    chip.textContent = `📎 ${name.replace(/^\d+_(agent_)?/, '')}`
    chip.onclick = async () => {
      try {
        const res = await fetch(`/api/chat/upload/${encodeURIComponent(name)}`, {
          headers: { 'X-Onboard-Token': window.getOnboardToken() || '' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = name.replace(/^\d+_(agent_)?/, '')
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
      } catch {
        showToast(C.attachMissing(name))
      }
    }
    el.appendChild(chip)
  }

  async function appendAttachmentImage(el, name, wantScroll) {
    try {
      const res = await fetch(`/api/chat/upload/${encodeURIComponent(name)}`, {
        headers: { 'X-Onboard-Token': window.getOnboardToken() || '' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const img = document.createElement('img')
      img.className = 'chat-attach-img'
      img.alt = name
      img.onload = () => { if (wantScroll) pane.scrollTop = pane.scrollHeight }
      img.src = URL.createObjectURL(blob)
      el.appendChild(img)
    } catch {
      // Deleted upload, or a transcript replayed on another machine: name
      // it honestly instead of a broken-image icon.
      const note = document.createElement('span')
      note.className = 'chat-attach-missing'
      note.textContent = C.attachMissing(name)
      el.appendChild(note)
    }
  }

  // 0.2.6 UI pass (the owner "UI/UX 검증해서 디벨롭"): system/boot announcements
  // ("🔁 [system] 에이전트 세션 기동 — <ISO> (Thu)") used to render as
  // full agent bubbles, and after a few restarts they OUTNUMBERED the real
  // conversation (field capture 2026-08-20: 5 of 7 visible bubbles were
  // session-boot pills). They are events, not speech — render as a slim
  // centered timeline divider instead. Text shape is the boot announcer's;
  // the ISO timestamp is condensed to HH:MM.
  function parseSystemLine(text) {
    const s = String(text || '')
    const i = s.indexOf('[system]')
    if (i === -1 || i > 8) return null // leading emoji at most, else not a system line
    let label = s.slice(i + 8).trim()
    const iso = label.match(/(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}[^\s]*\s*(?:\([A-Za-z]{3}\))?/)
    if (iso) label = label.replace(iso[0], '').replace(/[—–-]\s*$/, '').trim() + ` · ${iso[2]}:${iso[3]}`
    return label
  }

  // The memory mark's node (2026-09-28). One builder, two homes: the sender
  // row's tail when the flagged reply opens a run, the bubble's corner when it
  // continues one. textContent, never innerHTML — the injection-posture pin
  // that every node type on this surface keeps. The glyph is decorative to a
  // sighted reader's eye but the mark is not: aria-label + title carry the
  // meaning in words, so it is announced once and hover-explained.
  function memoryMarkNode() {
    const mark = document.createElement('span')
    mark.className = 'chat-memory-mark'
    mark.textContent = C.memoryMarkGlyph
    mark.setAttribute('aria-label', C.memoryMarkAria)
    mark.title = C.memoryMarkAria
    return mark
  }

  function appendMsg(m) {
    clearEmpty()
    const stick = atBottom()
    const role = roleOf(m)
    // P1 v2: the reply that ends the wait collapses the live run timeline
    // into its "Worked for Ns" resting state (aside behavior — we fold tool
    // labels, not streamed thinking text).
    if (role === 'agent') { finalizeActivityFold(); finalizeThinkFold(); discardDraft() }
    const sysLabel = role === 'agent' ? parseSystemLine(m.text) : null
    if (sysLabel !== null) {
      const div = document.createElement('div')
      div.className = 'chat-sysline'
      div.dataset.seq = m.seq
      const span = document.createElement('span')
      span.textContent = sysLabel
      div.appendChild(span)
      pane.appendChild(div)
      bubbles.set(m.seq, div)
      msgCount++
      lastRenderedRole = null // a session boundary breaks the bubble run
      if (stick) pane.scrollTop = pane.scrollHeight
      return
    }
    // 0.2.6 UI pass: an agent RUN opens with a sender row (name + time) —
    // identity used to ride on bubble asymmetry alone, which held for two
    // parties but left runs undated and the agent nameless on screen.
    // Only the first bubble of a run gets the row; consecutive agent
    // bubbles stay unlabeled (iMessage grouping).
    //
    // memoryMark (2026-09-28, the owner's "기억을 꺼낸 티 내기" → "완전 굿"):
    // a reply whose item carries `fromMemory` (the channel's per-turn flag for
    // a memory read; see POST /memory-read in channel-local.mjs) gets one
    // small glyph. It is built here, before the row is appended, so the mark
    // rides the sender row when there is one and the bubble itself when there
    // is not — a flagged reply mid-run (step commentary, then a read, then
    // the answer) still gets marked instead of silently dropping it. Either
    // way it is createElement + textContent, never innerHTML.
    const memoryMark = role === 'agent' && m.fromMemory === true
    let placedMemoryMark = false
    if (role === 'agent' && lastRenderedRole !== 'agent') {
      const meta = document.createElement('div')
      meta.className = 'chat-meta'
      // The picture leads the row (2026-09-28, profile picture): identity is
      // carried by the asymmetry alone since P1 v2, and this is the one
      // per-run mark that names WHO without a second role label.
      // createElement, never innerHTML -- the injection-posture pin.
      const av = document.createElement('img')
      av.className = 'chat-meta-avatar'
      av.alt = '' // decorative: the name span beside it IS the label
      av.src = avatarSrc
      // A stale avatar path (the file was removed, the fetch lost a race)
      // degrades to the shipped fallback instead of a broken-image icon.
      // onerror is cleared first so a fallback that ALSO fails cannot loop.
      av.onerror = () => { av.onerror = null; av.src = window.AVATAR_FALLBACK_URL || '/img/agent-avatar.png' }
      meta.appendChild(av)
      const nm = document.createElement('span')
      nm.className = 'chat-meta-name'
      nm.textContent = agentName || 'Agent'
      meta.appendChild(nm)
      if (m.ts) {
        const tm = document.createElement('span')
        tm.className = 'chat-meta-time'
        const d = new Date(m.ts)
        tm.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        meta.appendChild(tm)
      }
      if (memoryMark) { meta.appendChild(memoryMarkNode()); placedMemoryMark = true }
      pane.appendChild(meta)
    }
    lastRenderedRole = role
    const el = document.createElement('div')
    el.className = `chat-msg chat-${role}`
    el.dataset.seq = m.seq
    const { shown, images, files } = splitImageMarkers(m.text)
    renderMarkdown(el, shown)
    // P1 v2: no role labels — identity is carried by the asymmetry itself
    // (user = right-aligned accent glass bubble, agent = flat document
    // flow), per the owner's 2026-08-05 19:40 verdict on the labeled flat look
    // ("누가 누군지 잘 안보이잖아").
    for (const name of images) appendAttachmentImage(el, name, stick || role === 'user')
    for (const name of files) appendAttachmentFile(el, name)
    if (role === 'agent') attachReactBar(el, m.seq, shown)
    else { lastUserBubble = el; attachCopyBar(el, shown) }
    if (memoryMark && !placedMemoryMark) {
      // No sender row to sit beside (this bubble continues a run), so the
      // mark falls back to the bubble's own trailing corner — the other
      // corner from the hover react bar. Absolutely positioned there, so it
      // cannot add a line to the bubble or move the text it marks; in the
      // sender row the same is true for a different reason (the row's height
      // is the 20px avatar's, which a 0.68rem glyph cannot change).
      const cornerMark = memoryMarkNode()
      cornerMark.dataset.place = 'corner'
      el.appendChild(cornerMark)
    }
    pane.appendChild(el)
    bubbles.set(m.seq, el)
    msgCount++
    while (msgCount > MAX_CLIENT_MSGS && pane.firstChild) {
      const gone = pane.firstChild
      if (gone.dataset && gone.dataset.seq) bubbles.delete(Number(gone.dataset.seq))
      if (gone === lastUserBubble) lastUserBubble = null
      gone.remove()
      msgCount--
    }
    if (stick || role === 'user') pane.scrollTop = pane.scrollHeight
    else if (role === 'agent') showJump() // landed off-screen — offer the way back
  }

  // Hover affordance on agent bubbles -- the fixed two-emoji menu the
  // channel accepts, plus a copy button (2026-08-05, colleague feedback via
  // the owner). The badge itself renders from the transcript echo
  // (applyReaction), never optimistically.
  function attachReactBar(el, seq, copyText) {
    const bar = document.createElement('span')
    bar.className = 'chat-react-bar'
    for (const emoji of REACTIONS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = emoji
      btn.setAttribute('aria-label', C.reactAria(emoji))
      btn.onclick = () => sendReaction(seq, emoji)
      bar.appendChild(btn)
    }
    appendCopyBtn(bar, copyText)
    el.appendChild(bar)
  }

  // User bubbles get the same hover pill with only the copy button -- the
  // channel accepts reactions on agent messages, not on the user's own.
  function attachCopyBar(el, copyText) {
    if (!String(copyText || '').trim()) return // image-only bubble
    const bar = document.createElement('span')
    bar.className = 'chat-react-bar'
    appendCopyBtn(bar, copyText)
    el.appendChild(bar)
  }

  // Copies the DISPLAYED text -- image markers are already lifted out by
  // splitImageMarkers, and the marker line is plumbing, not something a
  // user wants in their clipboard. Same clipboard+toast pattern as logs.js.
  function appendCopyBtn(bar, copyText) {
    const text = String(copyText || '')
    if (!text.trim()) return // nothing meaningful to copy
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chat-copy-btn'
    btn.textContent = '⧉'
    btn.setAttribute('aria-label', C.copyAria)
    btn.title = C.copyAria
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text)
        window.showToast(C.copied)
      } catch (err) {
        console.error('clipboard write failed:', err)
        window.showToast(C.copyFailed)
      }
    }
    bar.appendChild(btn)
  }

  // One badge per reactor per bubble: reacting again replaces (DM semantics),
  // and the replay converges to the latest without duplicate chips.
  function applyReaction(m) {
    const target = bubbles.get(m.targetSeq)
    if (!target) return // target fell out of the retained window -- honest skip
    const from = m.role === 'user' ? 'user' : 'agent'
    let badge = target.querySelector(`.chat-react-badge[data-from="${from}"]`)
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'chat-react-badge'
      badge.dataset.from = from
      target.appendChild(badge)
      target.classList.add('chat-has-react')
    }
    badge.textContent = m.emoji
  }

  // Live run timeline (aside port): every step appends a row into an OPEN
  // <details> while the agent works — the reader watches the run happen and
  // can collapse it by hand (we set .open once at creation and never fight
  // the user's toggle). The reply that ends the wait closes the same
  // element into a "Worked for Ns" summary — no rebuild, the DOM the
  // reader watched IS the record.
  function showActivity(m) {
    const stick = atBottom()
    if (!runEl) {
      runEl = document.createElement('details')
      runEl.className = 'chat-activity-fold chat-run-live'
      runEl.open = true
      runEl.setAttribute('aria-label', C.activityAria)
      runSummary = document.createElement('summary')
      // Two spans, not one textContent: the LABEL is the current step (rewritten
      // per event) and the CHIP is the turn's elapsed clock (rewritten per
      // tick, design-0025) -- one string would have to be rebuilt by both.
      runLabelEl = document.createElement('span')
      runLabelEl.className = 'chat-run-label'
      runChipEl = document.createElement('span')
      runChipEl.className = 'chat-turn-elapsed'
      // The chip ticks every second and the pane is aria-live="polite": an
      // announced clock is noise a screen reader cannot escape from, so the
      // clock is hidden from the a11y tree while the label beside it is not.
      runChipEl.setAttribute('aria-hidden', 'true')
      runSummary.append(runLabelEl, runChipEl)
      runEl.appendChild(runSummary)
      activityStart = Date.now()
    }
    lastActivityAt = Date.now()
    activityLog.push(String(m.text || ''))
    if (activityLog.length > MAX_FOLD_LINES) {
      activityLog.shift()
      const first = runEl.querySelector('.fold-line')
      if (first) first.remove()
    }
    const row = document.createElement('div')
    row.className = 'fold-line'
    row.textContent = String(m.text || '')
    runEl.appendChild(row)
    // storyteller status (0.2.11): per-event verb, falls back to the old
    // counter copy if the key is missing (stale cached copy.js)
    lastStepLabel = String(m.text || '')
    sawWorkSinceWait = true // a tool call is on screen: a death now landed on a tool result
    runLabelEl.textContent = C.statusLive ? C.statusLive(lastStepLabel, activityLog.length) : C.activityRunning(activityLog.length)
    pane.appendChild(runEl) // appendChild moves it back to the end
    if (stick) pane.scrollTop = pane.scrollHeight
  }

  // Collapse the live timeline into its resting summary. Staleness guard
  // kept from v1: if the last step is older than the typing cap, the wait
  // it belonged to died — sitting a dead run above a LATER reply would
  // mislabel that turn, so it is dropped instead of closed.
  function finalizeActivityFold() {
    if (!runEl) { activityLog = []; return }
    if (Date.now() - lastActivityAt > TYPING_SHOW_MAX_MS) { discardRun(); return }
    closeRun()
  }

  function closeRun() {
    const secs = Math.max(1, Math.round((lastActivityAt - activityStart) / 1000))
    runSummary.textContent = C.activityFoldSummary(activityLog.length, secs)
    runEl.setAttribute('aria-label', C.activityFoldAria)
    runEl.open = false
    runEl.classList.remove('chat-run-live')
    runEl = null
    runSummary = null
    runLabelEl = null // the resting summary has no chip: the work is over
    runChipEl = null
    activityLog = []
  }

  function discardRun() {
    if (runEl) runEl.remove()
    runEl = null
    runSummary = null
    runLabelEl = null
    runChipEl = null
    activityLog = []
  }

  // ── Think fold (0.2.1) ─────────────────────────────────────────────────
  // Reasoning paragraphs accumulate into ONE closed <details> per turn.
  // Closed is the design ("접이식") — .open is never set, and a user who
  // opens it mid-turn is not fought (we only append children). Paragraphs
  // past the cap drop from the TOP, matching the activity fold's ring.
  function showThink(m) {
    const text = String(m.text || '').trim()
    if (!text) return
    const stick = atBottom()
    if (!thinkEl) {
      thinkEl = document.createElement('details')
      thinkEl.className = 'chat-think-fold chat-think-live'
      thinkEl.setAttribute('aria-label', C.thinkAria)
      thinkSummary = document.createElement('summary')
      thinkSummary.textContent = C.thinkLive || C.thinkSummary
      thinkEl.appendChild(thinkSummary)
      thinkParas = 0
    }
    const para = document.createElement('div')
    para.className = 'think-para'
    para.textContent = text
    thinkEl.appendChild(para)
    thinkParas++
    if (thinkParas > MAX_THINK_PARAS) {
      const first = thinkEl.querySelector('.think-para')
      if (first) { first.remove(); thinkParas-- }
    }
    pane.appendChild(thinkEl) // moves back to the end if bubbles landed above
    lastActivityAt = Date.now() // thinking IS liveness for the run staleness guard
    sawWorkSinceWait = true // reasoning on screen is work on screen (design-0025 tail)
    if (stick) pane.scrollTop = pane.scrollHeight
  }

  // The reply landing settles the fold: pulse off, resting summary. The
  // fold KEEPS its content (unlike typing dots) — the reasoning is the
  // record the reader may want after the fact.
  function finalizeThinkFold() {
    if (!thinkEl) return
    thinkSummary.textContent = C.thinkFoldSummary
    thinkEl.classList.remove('chat-think-live')
    thinkEl = null
    thinkSummary = null
    thinkParas = 0
  }

  function renderItem(m) {
    if (m.kind === 'reaction') applyReaction(m)
    else if (m.kind === 'turn-end') { finalizeActivityFold(); finalizeThinkFold() } // background turns end with no bubble (0.2.11 stuck-Thinking fix)
    else if (m.kind === 'turn-abort') showTurnAbort(m) // a turn that ended with no answer (design-0025)
    else if (m.kind === 'activity') showActivity(m)
    else if (m.kind === 'think') showThink(m)
    else appendMsg(m)
  }

  // The turn-abort line (design-0025, 2026-09-28). The server item is facts
  // only -- { reason: 'stop'|'death'|'stall', elapsedMs, at }, text deliberately
  // empty -- and copy.js composes the sentence, the same split every other
  // string on this surface keeps. It is a SETTLE, not a message: it closes
  // whatever the turn was drawing with the EXISTING close (the same three calls
  // appendMsg runs for an agent reply), then leaves one quiet line behind.
  // Because the item is persisted and clears awaitingReplySince server-side, a
  // reload can no longer resurrect the stuck folds it exists to end.
  function showTurnAbort(m) {
    closeTurnFolds()
    lastAbort = {
      reason: typeof m.reason === 'string' ? m.reason : null,
      elapsedMs: Number.isFinite(m.elapsedMs) ? m.elapsedMs : null,
      at: Number.isFinite(m.at) ? m.at : Date.now(),
    }
    const stick = atBottom()
    const el = document.createElement('div')
    el.className = 'chat-turn-abort'
    el.dataset.seq = m.seq
    el.textContent = C.turnAbort ? C.turnAbort(lastAbort.reason, lastAbort.elapsedMs, turnTail()) : ''
    pane.appendChild(el)
    msgCount++
    // A turn boundary breaks the bubble run, exactly like a session line: the
    // next agent message opens with its sender row again instead of inheriting
    // the group of a turn that is over.
    lastRenderedRole = null
    if (stick) pane.scrollTop = pane.scrollHeight
  }

  // The existing close, not a new one: the same three calls appendMsg runs when
  // an agent turn ends. Used by the abort item above and by the render path
  // when the derived state says nothing is running (design-0025 §linking/gone).
  function closeTurnFolds() {
    finalizeActivityFold()
    finalizeThinkFold()
    discardDraft()
  }

  // Background pill: one line above the controls row, present only while
  // the roster is non-empty. Rebuilt from scratch each poll (it is one
  // short text line -- no incremental DOM to get wrong).
  function renderBg(list) {
    const labels = Array.isArray(list) ? list.map((t) => (t && t.label) || '').filter(Boolean) : []
    if (!labels.length) {
      if (bgEl) { bgEl.remove(); bgEl = null }
      return
    }
    if (!bgEl) {
      bgEl = document.createElement('p')
      bgEl.className = 'chat-bg-pill'
      bgEl.setAttribute('aria-label', C.bgPillAria)
      const status = $('ct-status')
      if (status && status.parentNode) status.insertAdjacentElement('afterend', bgEl)
      else pane.appendChild(bgEl)
    }
    bgEl.textContent = C.bgPill(labels)
  }

  // The growing draft bubble. Same classes as a real agent bubble plus
  // chat-draft (styling hook); no seq, no react bar, no bubbles entry --
  // those all belong to the authoritative message that replaces it.
  function renderDraft(text) {
    const stick = atBottom()
    if (!draftEl) {
      draftEl = document.createElement('div')
      draftEl.className = 'chat-msg chat-agent chat-draft'
    }
    renderMarkdown(draftEl, text)
    pane.appendChild(draftEl) // keep it below think/activity folds
    lastActivityAt = Date.now() // streaming IS liveness
    sawWorkSinceWait = true // a streaming answer is work on screen (design-0025 tail)
    if (stick) pane.scrollTop = pane.scrollHeight
  }

  function discardDraft() {
    if (!draftEl) return
    draftEl.remove()
    draftEl = null
  }

  async function sendReaction(seq, emoji) {
    try {
      await window.api('/api/chat/react', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emoji, targetSeq: seq }),
      })
      pollNow()
    } catch (err) {
      console.error('chat react failed:', err)
      window.showToast(C.reactFailed)
    }
  }

  // ── the live turn: one derivation, one paint (design-0025) ───────────────
  // Everything the pane shows about a turn in flight is painted here, from the
  // state js/turn-state.cjs derives. Runs every poll tick, success or failure --
  // the failure path is exactly the one that used to leave the pane dressed up
  // as working over a turn that was already dead.

  // Where a death landed, from what THIS pane has seen: work was on screen (a
  // tool call was running and its result never came back) or nothing was (the
  // agent died before it wrote a word). The same discriminator the supervisor's
  // own record uses; computed here so the pane can say it even when the abort
  // record never reaches this page.
  function turnTail() { return sawWorkSinceWait ? 'tool_result' : 'user' }

  function deriveTurn() {
    if (!TURN) {
      // A page whose turn-state.cjs failed to load (torn cache) degrades to the
      // pre-0025 reading rather than going blank: dots while a turn is owed.
      const up = awaitingSince !== null && channelUp
      return {
        state: up ? 'working' : 'idle',
        inFlight: up,
        elapsedMs: awaitingSince === null ? null : Date.now() - awaitingSince,
        reason: null, tail: null, agentOff: false,
      }
    }
    return TURN.deriveTurnState({
      now: Date.now(),
      awaitingSince,
      pollUp: channelUp,
      abortAt: lastAbort ? lastAbort.at : null,
      abortReason: lastAbort ? lastAbort.reason : null,
      stoppingAt,
      restartingAt,
      died: diedInFlight,
      lane: laneStatus,
      tail: turnTail(),
    })
  }

  // The rail's one line per non-working state. `state` is the derivation's
  // answer; every string is copy.js's (the server sends facts, not voice).
  function turnLine(st) {
    if (st.state === 'stopping') return C.stopping
    if (st.state === 'linking') return C.turnReconnecting || ''
    if (st.state === 'gone') {
      if (st.agentOff) return C.turnGoneOff || ''
      return C.turnGone ? C.turnGone(st.tail) : ''
    }
    return ''
  }

  function ensureTurnRail() {
    if (turnEl) return turnEl
    turnEl = document.createElement('div')
    turnEl.className = 'chat-turn-rail'
    turnDotsEl = document.createElement('span')
    turnDotsEl.className = 'chat-typing'
    turnDotsEl.setAttribute('aria-label', C.typingAria)
    for (let i = 0; i < 3; i++) turnDotsEl.appendChild(document.createElement('span'))
    turnLabelEl = document.createElement('span')
    turnLabelEl.className = 'chat-turn-label'
    turnChipEl = document.createElement('span')
    turnChipEl.className = 'chat-turn-elapsed'
    turnChipEl.setAttribute('aria-hidden', 'true') // see showActivity: a ticking clock must not be read out
    turnEl.append(turnDotsEl, turnLabelEl, turnChipEl)
    return turnEl
  }

  function renderTurn() {
    const prevState = turnState
    const st = deriveTurn()
    turnState = st.state
    const running = st.state === 'working' || st.state === 'stalled'

    // Stop + steer ride the derived state the dots and the folds trust -- one
    // source of truth for "work is owed", so the button cannot offer to stop a
    // turn that is not running. Send deliberately stays visible beside Stop
    // rather than being swapped out: mid-turn sends MERGE into the running turn
    // (probe 6), and that steering is a feature, not an accident to disable
    // away. (.hidden, not style.display -- [hidden] is the page's convention.)
    if (stopBtn) {
      stopBtn.hidden = !st.inFlight
      // The gone state's composer action is a RESTART, not a Stop (design-0025
      // §gone): there is nothing left to kill. It fires the app's own lifecycle
      // route (POST /api/agent/restart) -- the same one the shell's restart
      // button uses, with the same word. No spawn path is invented here.
      const mode = st.state === 'gone' ? 'restart' : 'stop'
      if (stopBtn.dataset.mode !== mode) {
        stopBtn.dataset.mode = mode
        stopBtn.textContent = mode === 'restart' ? window.COPY.nav.restart : C.stop
        stopBtn.setAttribute('aria-label', mode === 'restart' ? window.COPY.nav.restart : C.stopAria)
        stopBtn.onclick = mode === 'restart' ? restartLane : requestStop
      }
    }
    if (steerHint) steerHint.hidden = !running
    input.placeholder = running ? C.steerPlaceholder : C.placeholder

    // A run fold only makes sense while work is owed. If the wait died (the
    // channel went down, no reply ever) an open timeline would sit there as
    // dressed-up silence -- close it into its honest summary once the typing cap
    // has passed. (A reply landing finalizes it earlier via appendMsg; a
    // turn-abort item finalizes it via showTurnAbort. This is the no-reply
    // path only.)
    if (!st.inFlight && runEl && Date.now() - lastActivityAt > TYPING_SHOW_MAX_MS) closeRun()
    // Linking / gone / stopping all mean nothing is running behind the folds
    // (design-0025). Closed on the transition, not every tick: the close is
    // idempotent, but a state that keeps re-closing would drop a draft the
    // server is still streaming on the tick the poll came back.
    if (st.inFlight && !running && prevState !== st.state) closeTurnFolds()
    // From the first gone tick on, this turn is known dead -- a poll that comes
    // back does not resurrect it (the derivation's `died` latch).
    if (st.state === 'gone') diedInFlight = true

    const chip = st.inFlight && C.turnElapsed ? C.turnElapsed(st.elapsedMs) : ''
    const rail = ensureTurnRail()
    let label = turnLine(st)
    let dots = false
    if (running) {
      // The current step label (design-0025 §2): the last activity item's
      // label, which the run fold already receives. Falls back to the working
      // phrase only while nothing else on screen is saying it -- the draft
      // bubble and the Think fold carry their own words.
      const fallback = (draftEl || thinkEl) ? '' : (C.thinkLive || C.thinkSummary)
      label = lastStepLabel || fallback
      dots = st.state === 'working' && !runEl && !draftEl
    }
    // While the live run fold is on screen it owns the step label, so the chip
    // rides ITS summary and the rail stays out of the way (one label on screen,
    // never two). Every other in-flight state is the rail's.
    const railWanted = st.inFlight && !runEl
    if (runChipEl) runChipEl.textContent = chip
    if (railWanted) {
      turnDotsEl.classList.toggle('hidden', !dots)
      turnLabelEl.textContent = label
      turnLabelEl.classList.toggle('hidden', !label)
      turnChipEl.textContent = chip
      turnChipEl.classList.toggle('hidden', !chip)
      const stick = atBottom()
      pane.appendChild(rail) // appendChild moves it back to the end if new bubbles landed above
      if (stick) pane.scrollTop = pane.scrollHeight
    } else if (turnEl) {
      turnEl.remove()
    }

    if (st.inFlight && lastUserBubble) {
      if (!readEl) {
        readEl = document.createElement('div')
        readEl.className = 'chat-read-label'
        readEl.textContent = C.read
      }
      lastUserBubble.insertAdjacentElement('afterend', readEl)
    } else if (readEl) {
      readEl.remove()
      readEl = null
    }
  }

  function appendGap() {
    const el = document.createElement('div')
    el.className = 'chat-gap'
    el.textContent = C.gapMarker
    pane.appendChild(el)
  }

  function setStatus(kind, detail) {
    const key = `${kind}:${detail || ''}`
    if (key === lastStatus) return
    lastStatus = key
    const el = $('ct-status')
    el.classList.remove('chat-status-up', 'chat-status-down')
    if (kind === 'up') {
      if (detail) agentName = String(detail) // sender-row name rides the same probe
      // Healthy = SILENT (the owner 08-20 21:22): the standing "X is listening."
      // line carried zero information the header dot doesn't — the row now
      // renders only for abnormal states (CSS collapses it when empty).
      el.textContent = ''
      el.classList.add('chat-status-up')
    } else if (kind === 'not_running') {
      el.textContent = C.statusNotRunning
      el.classList.add('chat-status-down')
    } else {
      el.textContent = C.statusUnreachable
      el.classList.add('chat-status-down')
    }
  }

  // The wrong-backend banner is RETIRED (2026-08-05): every backend now
  // hosts the local chat surface (startLocalChatSurface in channel-local.mjs
  // rides along in channel/-slack/-telegram.mjs), so "the agent talks
  // through discord, chat is off" stopped being a state that exists. Down
  // now only means the agent itself is down, which the status line says.
  async function refreshStatus() {
    try {
      const s = await window.api('/api/chat/status')
      if (s.up) setStatus('up', s.agent || '')
      else setStatus(s.reason === 'not_running' ? 'not_running' : 'unreachable')
    } catch (err) {
      console.error('chat status failed:', err)
      setStatus('unreachable')
    }
  }

  // 'user' passes through, anything else renders as the agent: the enum is
  // channel-owned and this page must not invent a third bubble style for a
  // value it doesn't know.
  function roleOf(m) { return m.role === 'user' ? 'user' : 'agent' }

  let polling = false
  let pollAgain = false

  // ── the derivation's inputs, kept current ────────────────────────────────
  // A turn BEGINS on the tick the server first reports an unanswered message
  // (awaitingReplySince null -> non-null). Everything the previous turn left on
  // the pane -- its step label, its abort record, its death latch, a Stop press
  // that never got its item -- belongs to that turn and goes now. Called BEFORE
  // the items render, so the seed branch can build this turn's knowledge
  // (sawWorkSinceWait) on a clean slate.
  function beginTurnLatches() {
    sawWorkSinceWait = false
    lastStepLabel = ''
    lastAbort = null
    diedInFlight = false
    stoppingAt = null
  }

  // The one writer of `awaitingSince`. A turn ENDS by the server nulling it
  // (the turn-abort item landing is what does that), and nothing here clears a
  // latch on the way out: the latches are read once more by the derivation
  // before the idle answer is painted, which is how the settled line keeps its
  // reason.
  function applyAwaiting(next) {
    const prev = awaitingSince
    if (prev === null && next !== null) beginTurnLatches()
    awaitingSince = next
  }

  // GET /api/agent/status, the design's one extra fetch (its §"no new polling
  // rail": this endpoint is already served). Only while a turn is in flight --
  // an idle pane has no turn to have a verdict about -- and throttled, because
  // the /out poll runs at 250ms while a draft paints and this probe is a live
  // upstream /health, not a cheap read.
  async function pollLaneStatus() {
    if (awaitingSince === null) { laneStatus = null; return }
    const now = Date.now()
    if (now - lanePolledAt < LANE_STATUS_MS) return
    lanePolledAt = now
    try {
      const s = await window.api('/api/agent/status')
      laneStatus = s && typeof s.state === 'string' ? s : null
    } catch {
      // A failed /api/agent/status is not evidence about the lane: this probe
      // is one more call to the same supervisor the /out poll already reported
      // on, so a throw here adds no fact. Drop the stale verdict; the poll's own
      // channelUp is what carries a death.
      laneStatus = null
    }
  }

  async function pollOnce() {
    // Re-entrancy guard: pollNow() can fire while a poll is awaiting its
    // fetch. Two concurrent drains would both read the same cursor and
    // render every item twice -- so the second call just asks the in-flight
    // one to go again immediately.
    if (polling) { pollAgain = true; return }
    polling = true
    try {
      if (nextSeq === null) {
        // First successful contact: replay the whole retained transcript
        // (both roles -- see header). The cursor lands on `latest`, so the
        // steady-state branch below only ever renders what's new.
        const seed = await window.api('/api/chat/out?since=0')
        applyAwaiting((seed.state && seed.state.awaitingReplySince) || null)
        for (const m of seed.items) renderItem(m)
        nextSeq = seed.latest
        if (typeof seed.draft === 'string' && seed.draft) renderDraft(seed.draft)
        else discardDraft()
        renderBg(seed.bg)
        channelUp = true
        showEmpty()
      } else {
        const result = await window.api(`/api/chat/out?since=${nextSeq}`)
        if (result.missed) appendGap()
        applyAwaiting((result.state && result.state.awaitingReplySince) || null)
        for (const m of result.items) renderItem(m)
        nextSeq = result.latest
        if (typeof result.draft === 'string' && result.draft) renderDraft(result.draft)
        else discardDraft()
        renderBg(result.bg)
        channelUp = true
        showEmpty()
      }
    } catch (err) {
      // 503/502 land here via window.api's !res.ok throw. The periodic
      // status refresh below names the state; the cursor survives for when
      // the channel comes back, so no state to update here.
      channelUp = false
    } finally {
      polling = false
    }
    await pollLaneStatus()
    renderTurn()
    if (tick % STATUS_EVERY_TICKS === 0) await refreshStatus()
    tick++
    if (pollTimer) clearTimeout(pollTimer)
    // While a draft is painting, poll faster: 1s granularity reads as
    // chunky paragraphs, 250ms reads as 두두두둑. Costs a few extra
    // loopback GETs only during active generation.
    pollTimer = setTimeout(pollOnce, pollAgain ? 0 : (draftEl ? 250 : POLL_MS))
    pollAgain = false
  }

  // Immediate drain, used right after a successful send: the user bubble is
  // the transcript echo, and waiting up to POLL_MS for it reads as lag.
  function pollNow() {
    if (pollTimer) clearTimeout(pollTimer)
    pollOnce()
  }

  // ── new conversation (clean break, 2026-08-18) ────────────────────────────
  // Blow away everything the pane drew for the OLD thread so the next poll
  // re-seeds from the (server-cleared) transcript at cursor 0. Mirrors every
  // render variable init/pollOnce/appendMsg/showActivity/renderTurn keep --
  // leaving any of them pointing at a removed node would strand a badge, a
  // typing dot, or a run fold on top of the fresh conversation. nextSeq=null
  // forces the seed branch (since=0) on the next poll, which now returns an
  // empty transcript (seq preserved server-side, so no cursor rewind).
  function resetClientRenderState() {
    pane.textContent = ''
    bubbles = new Map()
    msgCount = 0
    emptyEl = null
    lastUserBubble = null
    readEl = null
    runEl = null
    runSummary = null
    activityLog = []
    thinkEl = null
    thinkSummary = null
    thinkParas = 0
    draftEl = null
    awaitingSince = null
    nextSeq = null
    // design-0025: the turn state and its latches are per-thread too. The pane
    // wipe above already dropped the rail node; null the handles so the next
    // render rebuilds it, and reset the derivation to a clean idle.
    turnEl = null
    turnDotsEl = null
    turnLabelEl = null
    turnChipEl = null
    runLabelEl = null
    runChipEl = null
    turnState = 'idle'
    lastAbort = null
    stoppingAt = null
    restartingAt = null
    diedInFlight = false
    sawWorkSinceWait = false
    lastStepLabel = ''
    laneStatus = null
    lanePolledAt = 0
    channelUp = false
    hideJump()
  }

  // Irreversible, so it confirms first (repo idiom: window.confirmDialog, the
  // same modal settings.js uses for its destructive actions -- richer and more
  // reliable in the Electron window than a bare confirm()). On accept: fire
  // POST /api/agent/new-conversation (202 = the server cleared the transcript,
  // dropped the session id, and is respawning the lane with NO checkpoint
  // handoff and memory.db untouched), empty the pane immediately, and let the
  // status line narrate the brief respawn via refreshStatus. The failed-send
  // rule does not apply here (nothing typed is at stake), so a failure is just
  // a toast.
  async function startNewConversation() {
    const ok = await window.confirmDialog(C.newConversationConfirm, C.newConversationConfirmOk, window.COPY.nav.cancel)
    if (!ok) return
    const btn = $('ct-new-convo')
    if (btn) btn.disabled = true
    try {
      await window.api('/api/agent/new-conversation', { method: 'POST' })
      resetClientRenderState()
      channelUp = false // the lane is respawning; the next poll re-confirms
      window.showToast(C.newConversationStarting)
      refreshStatus() // narrate the respawn immediately (Connecting…/isn't answering)
      pollNow()       // re-seed the empty transcript as soon as the lane is back
    } catch (err) {
      console.error('new conversation failed:', err)
      window.showToast(C.newConversationFailed)
    } finally {
      if (btn) btn.disabled = false
    }
  }

  // ── image attachments (2026-08-04, the owner "인앱챗에 이미지 업로드할수
  // 있는 방법이 없음") ─────────────────────────────────────────────────
  // Flow: pick/paste -> POST /api/chat/upload (base64 JSON) -> pending
  // chip; send() appends one "[image attached: <path> — read it with the
  // Read tool]" line per chip, the same local-path convention Discord
  // inbound images use, so the agent opens them with Read. Uploaded files
  // live in DATA_HOME/chat_uploads/.
  let pendingAttachments = [] // { name, path, chip }

  // Vision capability of the CURRENT lane (the owner 2026-08-04 19:56 "비전없는
  // 모델 fallback은 생각해놓고 개발한거 맞지?" -- honest answer was no, this
  // is the fix). Three states, never a guess:
  //   'yes'     -> normal marker (agent Reads the image)
  //   'no'      -> soft warning toast on attach + marker tells the agent to
  //                SAY it cannot see images instead of hallucinating contents
  //   'unknown' -> marker carries the conditional honesty clause
  // The ollama rows are bound from live ollama.com/library scrapes
  // (2026-08-04): kimi-k2.7-code carries the vision capability pill
  // ("image and video input via MoonViT"); glm-5.2 and deepseek-v4-flash
  // are text-only. deepseek-v4.1-flash (added 2026-09-16) IS vision-capable --
  // ollama.com library `vision` pill, input "Text, Image" -- and is on the
  // YES list below; the older deepseek-v4-flash line above still stands.
  // have no vision badge. Attaching is never BLOCKED -- the model table
  // could be stale, and a false block is worse than a soft warning.
  let visionState = 'unknown'
  let visionWarned = false
  // Lane status chip (0.1.4, PO item #3): show which model/provider this
  // chat is riding and whether it can see images. The chip is populated
  // from the SAME resolve pass the markers use, so it can never disagree
  // with the behavior it describes.
  function renderLaneChip(spawn) {
    const chip = $('ct-lane-chip')
    if (!chip) return
    const model = String((spawn && spawn.model) || '').replace(/:.*$/, '')
    if (!model) { chip.hidden = true; return }
    const provider = String((spawn && spawn.provider) || '')
    const vis = visionState === 'yes' ? C.laneChipVisionYes : C.laneChipVisionNo
    chip.textContent = `${model}${provider ? ` · ${provider}` : ''} · ${vis}`
    chip.hidden = false
  }
  async function resolveVisionState() {
    let spawnSeen = null
    try {
      const spawn = (await window.api('/api/agent/spawn-info')).spawn
      spawnSeen = spawn
      const provider = String((spawn && spawn.provider) || '')
      const model = String((spawn && spawn.model) || '').replace(/:.*$/, '') // strip :tag
      // Mirror of http-server.cjs's laneVision -- change both together.
      // 0.1.4 policy (the owner): first-party (Claude/Codex) = yes; everything
      // else defaults to NO (server attaches a Gemma caption) unless the
      // model is on the known-vision list. No 'unknown' state -- its marker
      // invited a Read-tool image read that poisoned non-vision transcripts.
      if (/^claude/.test(provider) || /^claude/.test(model) || provider === 'chatgpt' || provider === 'dsh') {
        // dsh: the lane lifts image markers into inline image parts and
        // routes the turn to its vision model itself -- mirror of
        // http-server.cjs laneVision, change both together.
        visionState = 'yes'
      } else {
        const VISION_YES = new Set(['kimi-k2.7-code', 'kimi-k3', 'kimi-k2.6', 'gemma4', 'qwen3.5', 'minimax-m3', 'mistral-large-3', 'deepseek-v4.1-flash', 'glm-5.3-flash'])
        visionState = VISION_YES.has(model) ? 'yes' : 'no'
      }
    } catch { visionState = 'unknown' }
    renderLaneChip(spawnSeen)
  }

  function markerFor(att) {
    // 0.1.4: kind from the upload response. 'text' is safe for ANY lane to
    // Read; 'image' and 'pdf' are vision-gated (Read renders PDF pages as
    // images, so a non-vision lane must not open either).
    if (att.kind === 'text') {
      return `[file attached: ${att.path} — open it with the Read tool]`
    }
    if (att.kind === 'file') {
      // 0.1.18: media/archive — binary, so Read is useless on every lane;
      // shell tools can still process it (ffprobe, unzip -l, checksums).
      return `[file attached: ${att.path} — a media/archive file. Do NOT open it with the Read tool; use shell tools if the user asks you to work with it.]`
    }
    const noun = att.kind === 'pdf' ? 'PDF' : 'image'
    if (att.caption) {
      // Vision stand-in (0.0.56): the server already had a small vision
      // model describe the image; the text-only lane gets the CONTENT.
      // Brackets/newlines stripped -- the marker must stay one parseable line.
      const clean = String(att.caption.text || '').replace(/[\[\]]/g, '').replace(/\s*\n+\s*/g, ' ').slice(0, 2000)
      return `[image attached: ${att.path} — this model cannot view images directly; a vision model (${att.caption.model}) described it: "${clean}"]`
    }
    if (visionState === 'no') {
      return `[${noun} attached: ${att.path} — NOTE: this model cannot view ${noun === 'PDF' ? 'PDFs (their pages render as images)' : 'images'}. Do NOT open it with the Read tool; do not guess the contents; tell the user honestly that you cannot see it on the current model.]`
    }
    return `[${noun} attached: ${att.path} — read it with the Read tool]`
  }

  function renderAttachChip(att) {
    const box = $('ct-attach-chips')
    if (!box) return
    const chip = document.createElement('span')
    chip.className = 'chat-attach-chip'
    chip.textContent = `${att.kind === 'text' ? '📄' : att.kind === 'pdf' ? '📕' : att.kind === 'file' ? '📎' : '🖼'} ${att.name} `
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'link'
    x.textContent = '×'
    x.onclick = () => {
      pendingAttachments = pendingAttachments.filter((a) => a !== att)
      chip.remove()
    }
    chip.appendChild(x)
    box.appendChild(chip)
    att.chip = chip
  }

  const ATTACH_NAME_RE = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|tsv|json|log|xml|yaml|yml|mp3|m4a|wav|mp4|mov|webm|zip)$/i
  async function uploadImageFile(file) {
    // Accept by MIME for images (paste has no filename) OR by extension for
    // documents -- server re-validates the extension either way.
    const isImage = file && /^image\/(png|jpe?g|gif|webp)$/.test(file.type)
    if (!file || (!isImage && !ATTACH_NAME_RE.test(file.name || ''))) { window.showToast(C.attachBadType); return }
    if (file.size > 10_000_000) { window.showToast(C.attachTooLarge); return }
    const dataBase64 = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] || '')
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
    try {
      const out = await window.api('/api/chat/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name || 'pasted.png', dataBase64 }),
      })
      const att = { name: out.name, path: out.path, kind: out.kind || 'image', caption: out.caption || null }
      pendingAttachments.push(att)
      renderAttachChip(att)
      if (!visionWarned && att.kind !== 'text' && (att.caption || visionState === 'no')) {
        visionWarned = true // once per page load, not once per image
        window.showToast(att.caption ? C.attachCaptioned : C.attachNoVision)
      }
    } catch (err) {
      console.error('attachment upload failed:', err)
      window.showToast(C.attachFailed(err.message))
    }
  }

  // ── STOP / RESTART (0.3.1, design-0025) ───────────────────────────────────
  // The press lands in the `stopping` state IMMEDIATELY (design-0025 §stopping):
  // the derivation holds it from `stoppingAt` until the turn-abort item lands
  // (which nulls awaitingSince and settles the pane) or the hold's own bound
  // runs out, at which point the same facts read as linking/gone rather than
  // leaving the pane pinned on a Stop that never came back.
  //
  // Raw fetch, not window.api: 409 ("the turn finished while your click was in
  // flight") is a normal outcome here, and api() throws on every non-2xx with
  // only a message string to go on. Reading res.status directly is the way to
  // tell "already done" from "could not stop", which are different sentences
  // to a user. Token header mirrors nav.js's api() exactly -- this is a POST,
  // so the server's per-launch gate applies.
  async function requestStop() {
    if (stopBusy) return
    stopBusy = true
    // Enter the held state before the request leaves: the button must read as
    // pressed on the SAME tick, and the transition is what closes the folds.
    stoppingAt = Date.now()
    if (stopBtn) stopBtn.disabled = true
    renderTurn()
    let status = 0
    try {
      const res = await fetch('/api/chat/interrupt', {
        method: 'POST',
        headers: { 'X-Onboard-Token': window.getOnboardToken() || '', 'content-type': 'application/json' },
        body: '{}',
      })
      status = res.status
    } catch (err) {
      console.error('chat stop failed:', err)
    }
    if (status === 200) {
      // Kill in flight. The hold is released by the turn-abort item the server
      // pushes (reason 'stop'), which is exactly what the `stopping` state is
      // waiting on; nothing to do here but let it land. The folds are already
      // closed -- entering `stopping` closed them on the transition, and the
      // elapsed they collapse to is the work that really did happen, with the
      // settled "멈췄음" line right below saying how it ended.
      refreshStatus()
    } else if (status === 409) {
      // There was no turn to stop by the time the click arrived: settle now
      // rather than hold a state whose item will never come.
      stoppingAt = null
      discardRun()
      $('ct-status').textContent = C.stopNoTurn
      refreshStatus()
      renderTurn()
    } else {
      stoppingAt = null
      window.showToast(C.stopFailed)
      refreshStatus()
      renderTurn()
    }
    if (stopBtn) stopBtn.disabled = false
    stopBusy = false
  }

  // The `gone` state's composer action (design-0025 §gone): the turn is dead,
  // so there is nothing to Stop. This fires the app's OWN lifecycle route --
  // POST /api/agent/restart, the same one nav.js's Restart button uses (202,
  // fire-and-forget) -- and invents no spawn path of its own. Between the fire
  // and the lane's return the derivation reads `linking` (its restart hold), so
  // the button does not flip back to Stop while the respawn is in flight.
  async function restartLane() {
    if (stopBusy) return
    stopBusy = true
    restartingAt = Date.now()
    laneStatus = null // the old verdict is about the lane being replaced
    diedInFlight = false
    if (stopBtn) stopBtn.disabled = true
    renderTurn()
    try {
      await window.api('/api/agent/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      refreshStatus() // narrate the respawn (Connecting… / isn't answering)
    } catch (err) {
      console.error('lane restart failed:', err)
      window.showToast(window.COPY.genericError(err.message))
      restartingAt = null // no respawn is coming; fall back to the honest reading
    } finally {
      if (stopBtn) stopBtn.disabled = false
      stopBusy = false
    }
    pollNow()
  }

  async function send() {
    const text = input.value
    if (!text.trim() && pendingAttachments.length === 0) return
    // One marker line per attachment, appended AFTER the user's text --
    // the path is what the agent Reads; the UI re-detects the marker to
    // render the image in the bubble (see appendMsg's image pass).
    const markers = pendingAttachments.map(markerFor).join('\n')
    const outText = markers ? (text.trim() ? `${text}\n${markers}` : markers) : text
    sendBtn.disabled = true
    try {
      await window.api('/api/chat/in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: outText }),
      })
      // No local append: the 202 means the message is already in the
      // transcript, and pollNow() renders it from there (see header).
      // design-0025: the 202 is also proof the lane took the message, so a
      // death latch left by an earlier turn cannot outlive it. If no turn was
      // owed, the whole previous turn's latches go (a fresh begin); a mid-turn
      // send MERGES into the running turn, whose latches are still its own.
      diedInFlight = false
      if (awaitingSince === null) beginTurnLatches()
      input.value = ''
      input.style.height = 'auto'
      pendingAttachments = []
      const box = $('ct-attach-chips')
      if (box) box.textContent = ''
      pollNow()
    } catch (err) {
      // The text stays in the input on purpose -- see header. Chips stay
      // too: a failed send must not eat the attachments either.
      console.error('chat send failed:', err)
      window.showToast(C.sendFailed)
      refreshStatus()
    } finally {
      sendBtn.disabled = false
      input.focus()
    }
  }

  // ── model quick-switch (0.2.6, the owner 08-20 19:09: "LLM 모델 바꾸는건 세팅
  // 말고 챗쪽에 드랍다운으로 두는게 더 편할 것 같음") ─────────────────────
  // A chip-styled native <select> in the composer bar, claude.ai pattern
  // (composer-corner model chip, 08-20 reference capture). Reads the SHARED
  // static catalog (js/model-catalog.cjs) and fires the same POST
  // /api/agent/model the Engine page fires -- one server contract, two
  // surfaces. Engine keeps the full picker (Custom proxy / Ollama-by-URL
  // action rows, effort, apply-state line); this is the quick lane only.
  // Dynamic catalog extras are gone from both surfaces (2026-09-28, the owner:
  // "이거 한쪽으로 통합해줘, 카탈로그 하나로") -- the Engine page used to splice
  // CLI-scanned claude ids and live ollama tags onto this same catalog, and no
  // longer does. Both dropdowns now present exactly js/model-catalog.cjs's
  // rows; a running non-catalog model still shows via the "(current)"
  // passthrough on either side.
  const modelSel = $('ct-model-select')
  const effortSel = $('ct-effort-select') // 0.2.12: effort beside the model chip
  const SET = window.COPY.settings // switchConfirm/switchOk/cancel live there
  let msModel = ''
  let msProvider = null
  let msAvailable = []
  let msEffort = ''
  let msBusy = false

  // Mirror of connectors.js providerForModel: keep the current provider when
  // it can serve the model, else the first authenticated provider that can.
  function msProviderFor(modelId) {
    const entry = window.SCHZ_MODEL_CATALOG.find((m) => m.id === modelId)
    if (!entry) return msProvider // pinned non-catalog id: stay put
    if (entry.providers.includes(msProvider)) return msProvider
    return entry.providers.find((p) => msAvailable.includes(p)) || null
  }

  function msPopulate() {
    modelSel.replaceChildren() // NOT innerHTML — chat.js injection posture (test-chat-surface #1)
    // No stored MODEL (some lanes run on the provider default): a neutral
    // placeholder holds the selected slot so the chip never claims a model
    // the config doesn't. Any real pick still swaps normally.
    if (!msModel) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '—'
      opt.selected = true
      opt.hidden = true
      modelSel.appendChild(opt)
    }
    // Non-catalog live model (old alias / URL-picked / custom): surface
    // as-is so the chip reflects reality, not a guess.
    if (msModel && !window.SCHZ_MODEL_CATALOG.some((m) => m.id === msModel)) {
      const opt = document.createElement('option')
      opt.value = msModel
      opt.textContent = msModel
      opt.selected = true
      modelSel.appendChild(opt)
    }
    const groups = new Map()
    for (const m of window.SCHZ_MODEL_CATALOG) {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = m.label
      if (!m.providers.some((p) => msAvailable.includes(p))) opt.disabled = true
      if (m.id === msModel) opt.selected = true
      if (!groups.has(m.group)) {
        const og = document.createElement('optgroup')
        og.label = m.group
        groups.set(m.group, og)
        modelSel.appendChild(og)
      }
      groups.get(m.group).appendChild(opt)
    }
  }

  // Effort chip (0.2.12, the owner 08-23): same population rule as the Engine
  // page's set-effort-select — static levels from the shared catalog file,
  // "(default)" marks the shipped default.
  function msPopulateEffort() {
    effortSel.replaceChildren() // NOT innerHTML — chat.js injection posture (test-chat-surface #1)
    for (const level of window.SCHZ_EFFORT_LEVELS) {
      const opt = document.createElement('option')
      opt.value = level
      opt.textContent = level === window.SCHZ_EFFORT_DEFAULT ? `${level} (default)` : level
      if (level === msEffort) opt.selected = true
      effortSel.appendChild(opt)
    }
  }

  // After a swap the agent restarts server-side; follow the settle so the
  // lane chip + vision state re-resolve against the NEW spawn, not the old
  // one. Bounded, exists only while a change is in flight (nav.js owns the
  // standing poller).
  async function msSettle() {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const status = await window.api('/api/agent/status')
        if (status.state !== 'connecting') break
      } catch { break }
    }
    resolveVisionState()
  }

  async function initModelSwitch() {
    if (!modelSel || !window.SCHZ_MODEL_CATALOG || !SET) return
    let cfg
    try { cfg = await window.api('/api/config') } catch (err) {
      console.error('model chip config probe failed:', err)
      return // chip stays hidden; Engine page still has the full picker
    }
    msModel = cfg.MODEL || ''
    msProvider = cfg.PROVIDER || null
    msAvailable = Array.isArray(cfg.availableProviders) ? cfg.availableProviders.slice() : []
    // The onboarded provider is always available -- the running agent is
    // its own proof (same clause as the Engine page).
    if (msProvider && !msAvailable.includes(msProvider)) msAvailable.push(msProvider)
    msPopulate()
    modelSel.title = SET.modelLabel
    modelSel.hidden = false
    modelSel.onchange = async (e) => {
      const model = e.target.value
      if (model === msModel || msBusy) { e.target.value = msModel; return }
      const provider = msProviderFor(model)
      if (!provider) { e.target.value = msModel; return } // fail closed
      const ok = await window.confirmDialog(SET.switchConfirm(model), SET.switchOk, SET.cancel)
      if (!ok) { e.target.value = msModel; return }
      const prevModel = msModel
      const prevProvider = msProvider
      msModel = model
      msProvider = provider
      msBusy = true
      modelSel.disabled = true
      try {
        await window.api('/api/agent/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(provider !== prevProvider ? { model, provider } : { model }),
        })
        msSettle()
      } catch (err) {
        console.error('model swap failed:', err)
        window.showToast(window.COPY.genericError(err.message))
        msModel = prevModel
        msProvider = prevProvider
        e.target.value = prevModel
      } finally {
        msBusy = false
        modelSel.disabled = false
      }
    }

    // Effort quick-switch: same /api/agent/effort contract as the Engine
    // page (restarts the agent), same confirm-first + revert-on-failure
    // shape as the model chip above. Shares msBusy so a model swap and an
    // effort swap cannot race each other.
    if (effortSel && Array.isArray(window.SCHZ_EFFORT_LEVELS)) {
      msEffort = window.SCHZ_EFFORT_LEVELS.includes(cfg.EFFORT_LEVEL)
        ? cfg.EFFORT_LEVEL : window.SCHZ_EFFORT_DEFAULT
      msPopulateEffort()
      effortSel.title = SET.effortLabel
      effortSel.hidden = false
      effortSel.onchange = async (e) => {
        const effort = e.target.value
        if (effort === msEffort || msBusy) { e.target.value = msEffort; return }
        const ok = await window.confirmDialog(SET.effortConfirm(effort), SET.switchOk, SET.cancel)
        if (!ok) { e.target.value = msEffort; return }
        const prevEffort = msEffort
        msEffort = effort
        msBusy = true
        modelSel.disabled = true
        effortSel.disabled = true
        try {
          await window.api('/api/agent/effort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ effort }),
          })
          msSettle()
        } catch (err) {
          console.error('effort swap failed:', err)
          window.showToast(window.COPY.genericError(err.message))
          msEffort = prevEffort
          e.target.value = prevEffort
        } finally {
          msBusy = false
          modelSel.disabled = false
          effortSel.disabled = false
        }
      }
    }
  }

  function init() {
    setStatics()
    sendBtn.onclick = send
    const newConvoBtn = $('ct-new-convo')
    if (newConvoBtn) newConvoBtn.onclick = startNewConversation
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        send()
      }
    })
    // Grow the textarea with its content (up to the CSS max-height) so a
    // multi-line thought doesn't scroll inside a one-line box.
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight}px`
    })
    // Image attachments: the + button opens the picker; pasting an image
    // into the textarea uploads it too (screenshots land here). Uploads are
    // sequential on purpose -- each one is a chip the user can still remove.
    const attachBtn = $('ct-attach')
    const fileInput = $('ct-file')
    resolveVisionState() // async, best-effort; 'unknown' until it lands
    initModelSwitch() // async, best-effort; chip stays hidden on any failure
    if (attachBtn && fileInput) {
      attachBtn.title = C.attachTitle
      attachBtn.onclick = () => fileInput.click()
      fileInput.onchange = async () => {
        for (const f of Array.from(fileInput.files || [])) await uploadImageFile(f)
        fileInput.value = '' // re-selecting the same file must fire change again
      }
    }
    input.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || [])
      const imgs = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type))
      if (!imgs.length) return // plain text paste: default behavior untouched
      e.preventDefault()
      for (const it of imgs) {
        const f = it.getAsFile()
        if (f) uploadImageFile(f)
      }
    })
    input.focus()
    pollOnce()
    window.addEventListener('beforeunload', () => { if (pollTimer) clearTimeout(pollTimer) })
  }

  document.addEventListener('DOMContentLoaded', init)
})()
