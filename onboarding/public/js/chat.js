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
//    gone (Mino's 07-30 repro). User bubbles now come from the transcript
//    echo (a send triggers an immediate poll), never from a local append:
//    one source of truth, no dedup bookkeeping.
//  - A failed send KEEPS the text in the input. Losing the user's message
//    to a restart race is the one unforgivable failure here.
//
// DM interaction states (v0.0.34, Mino 07-30 17:41 "인스타 DM쓰는것처럼"):
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

;(function () {
  const C = window.COPY.chat

  const POLL_MS = 1000
  const STATUS_EVERY_TICKS = 5 // /status is a live /health probe upstream; 5s is fresh enough
  const MAX_CLIENT_MSGS = 500 // mirror of the channel's MAX_QUEUE
  const TYPING_SHOW_MAX_MS = 3 * 60 * 1000
  const REACTIONS = ['👍', '❤️'] // mirror of the channel's USER_REACTIONS

  function $(id) { return document.getElementById(id) }

  const pane = $('ct-pane')
  const input = $('ct-input')
  const sendBtn = $('ct-send')

  let nextSeq = null // null = cursor not seeded yet (first poll renders nothing)
  let msgCount = 0
  let pollTimer = null
  let tick = 0
  let emptyEl = null
  let lastStatus = null
  let bubbles = new Map() // seq -> bubble element, for attaching reaction badges
  let lastUserBubble = null
  let awaitingSince = null // state.awaitingReplySince from the last /out
  let channelUp = false // freshest signal: did the last /out poll succeed
  let typingEl = null
  let readEl = null
  // P1 v2 live run fold (aside port, Mino 2026-08-05 19:49 "어사이드 렌더링
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

  function setStatics() {
    $('ct-title').textContent = C.title
    $('ct-subtitle').textContent = C.subtitle
    sendBtn.textContent = C.send
    input.placeholder = C.placeholder
    $('ct-status').textContent = C.statusChecking
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
  // path up to the first " — ", then any guidance clause.
  const IMG_MARKER_RE = /^\[image attached: (.+?) — [^\]]*\]$/
  function splitImageMarkers(text) {
    const images = []
    const kept = []
    for (const line of String(text || '').split('\n')) {
      const m = line.match(IMG_MARKER_RE)
      if (m) images.push(m[1].split(/[\\/]/).pop())
      else kept.push(line)
    }
    return { shown: kept.join('\n'), images }
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

  function appendMsg(m) {
    clearEmpty()
    const stick = atBottom()
    const role = roleOf(m)
    // P1 v2: the reply that ends the wait collapses the live run timeline
    // into its "Worked for Ns" resting state (aside behavior — we fold tool
    // labels, not streamed thinking text).
    if (role === 'agent') finalizeActivityFold()
    const el = document.createElement('div')
    el.className = `chat-msg chat-${role}`
    el.dataset.seq = m.seq
    const { shown, images } = splitImageMarkers(m.text)
    renderMarkdown(el, shown)
    // P1 v2: no role labels — identity is carried by the asymmetry itself
    // (user = right-aligned accent glass bubble, agent = flat document
    // flow), per Mino's 2026-08-05 19:40 verdict on the labeled flat look
    // ("누가 누군지 잘 안보이잖아").
    for (const name of images) appendAttachmentImage(el, name, stick || role === 'user')
    if (role === 'agent') attachReactBar(el, m.seq, shown)
    else { lastUserBubble = el; attachCopyBar(el, shown) }
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
  // Mino). The badge itself renders from the transcript echo
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
    runSummary.textContent = C.activityRunning(activityLog.length)
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
    activityLog = []
  }

  function discardRun() {
    if (runEl) runEl.remove()
    runEl = null
    runSummary = null
    activityLog = []
  }

  function renderItem(m) {
    if (m.kind === 'reaction') applyReaction(m)
    else if (m.kind === 'activity') showActivity(m)
    else appendMsg(m)
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

  // Both DM affordances from the one server value (see header). Runs every
  // poll tick, success or failure -- the failure path is what retires the
  // dots when the channel dies mid-wait.
  function updatePresence() {
    const waiting = awaitingSince !== null && channelUp
    // A live run only makes sense while work is owed. If the wait died
    // (channel down, no reply ever) the open timeline would sit there as
    // dressed-up silence — close it into its honest summary once the
    // typing cap has passed. (A reply landing finalizes it earlier via
    // finalizeActivityFold; this is the no-reply path only.)
    if (!waiting && runEl && Date.now() - lastActivityAt > TYPING_SHOW_MAX_MS) closeRun()
    // Typing dots only before the first step lands — once the live
    // timeline is on screen, the run itself is the liveness signal
    // (aside shows the working steps, not dots beside them).
    const typing = waiting && !runEl && (Date.now() - awaitingSince) < TYPING_SHOW_MAX_MS
    if (typing) {
      if (!typingEl) {
        typingEl = document.createElement('div')
        typingEl.className = 'chat-typing chat-msg chat-agent'
        typingEl.setAttribute('aria-label', C.typingAria)
        for (let i = 0; i < 3; i++) typingEl.appendChild(document.createElement('span'))
      }
      const stick = atBottom()
      pane.appendChild(typingEl) // appendChild moves it back to the end if new bubbles landed above
      if (stick) pane.scrollTop = pane.scrollHeight
    } else if (typingEl) {
      typingEl.remove()
      typingEl = null
    }
    if (waiting && lastUserBubble) {
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
      el.textContent = C.statusUp(detail)
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
        for (const m of seed.items) renderItem(m)
        nextSeq = seed.latest
        awaitingSince = (seed.state && seed.state.awaitingReplySince) || null
        channelUp = true
        showEmpty()
      } else {
        const result = await window.api(`/api/chat/out?since=${nextSeq}`)
        if (result.missed) appendGap()
        for (const m of result.items) renderItem(m)
        nextSeq = result.latest
        awaitingSince = (result.state && result.state.awaitingReplySince) || null
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
    updatePresence()
    if (tick % STATUS_EVERY_TICKS === 0) await refreshStatus()
    tick++
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(pollOnce, pollAgain ? 0 : POLL_MS)
    pollAgain = false
  }

  // Immediate drain, used right after a successful send: the user bubble is
  // the transcript echo, and waiting up to POLL_MS for it reads as lag.
  function pollNow() {
    if (pollTimer) clearTimeout(pollTimer)
    pollOnce()
  }

  // ── image attachments (2026-08-04, Mino "인앱챗에 이미지 업로드할수
  // 있는 방법이 없음") ─────────────────────────────────────────────────
  // Flow: pick/paste -> POST /api/chat/upload (base64 JSON) -> pending
  // chip; send() appends one "[image attached: <path> — read it with the
  // Read tool]" line per chip, the same local-path convention Discord
  // inbound images use, so the agent opens them with Read. Uploaded files
  // live in DATA_HOME/chat_uploads/.
  let pendingAttachments = [] // { name, path, chip }

  // Vision capability of the CURRENT lane (Mino 2026-08-04 19:56 "비전없는
  // 모델 fallback은 생각해놓고 개발한거 맞지?" -- honest answer was no, this
  // is the fix). Three states, never a guess:
  //   'yes'     -> normal marker (agent Reads the image)
  //   'no'      -> soft warning toast on attach + marker tells the agent to
  //                SAY it cannot see images instead of hallucinating contents
  //   'unknown' -> marker carries the conditional honesty clause
  // The ollama rows are bound from live ollama.com/library scrapes
  // (2026-08-04): kimi-k2.7-code carries the vision capability pill
  // ("image and video input via MoonViT"); glm-5.2 and deepseek-v4-flash
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
      // 0.1.4 policy (Mino): first-party (Claude/Codex) = yes; everything
      // else defaults to NO (server attaches a Gemma caption) unless the
      // model is on the known-vision list. No 'unknown' state -- its marker
      // invited a Read-tool image read that poisoned non-vision transcripts.
      if (/^claude/.test(provider) || /^claude/.test(model) || provider === 'chatgpt') {
        visionState = 'yes'
      } else {
        const VISION_YES = new Set(['kimi-k2.7-code', 'kimi-k3', 'kimi-k2.6', 'gemma4', 'qwen3.5', 'minimax-m3', 'mistral-large-3'])
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
    chip.textContent = `${att.kind === 'text' ? '📄' : att.kind === 'pdf' ? '📕' : '🖼'} ${att.name} `
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

  const ATTACH_NAME_RE = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|tsv|json|log|xml|yaml|yml)$/i
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

  function init() {
    setStatics()
    sendBtn.onclick = send
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
