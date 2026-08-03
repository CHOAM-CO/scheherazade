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

  function setStatics() {
    $('ct-title').textContent = C.title
    $('ct-subtitle').textContent = C.subtitle
    sendBtn.textContent = C.send
    input.placeholder = C.placeholder
    $('ct-status').textContent = C.statusChecking
  }

  function atBottom() {
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 8
  }

  function showEmpty() {
    if (emptyEl || msgCount) return
    emptyEl = document.createElement('div')
    emptyEl.className = 'chat-empty'
    emptyEl.textContent = C.empty
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
  function appendMsg(m) {
    clearEmpty()
    const stick = atBottom()
    const role = roleOf(m)
    const el = document.createElement('div')
    el.className = `chat-msg chat-${role}`
    el.dataset.seq = m.seq
    renderMarkdown(el, m.text)
    if (role === 'agent') attachReactBar(el, m.seq)
    else lastUserBubble = el
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
  }

  // Hover affordance on agent bubbles only -- the fixed two-emoji menu the
  // channel accepts. The badge itself renders from the transcript echo
  // (applyReaction), never optimistically.
  function attachReactBar(el, seq) {
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
    el.appendChild(bar)
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

  function renderItem(m) {
    if (m.kind === 'reaction') applyReaction(m)
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
    const typing = waiting && (Date.now() - awaitingSince) < TYPING_SHOW_MAX_MS
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

  // The backend banner answers the WHY behind a down status: when the agent
  // talks through discord/slack/telegram, channel-local.mjs never runs, so
  // chat here reads not_running forever. That deserves an explanation, not
  // just a red line.
  async function refreshStatus() {
    try {
      const s = await window.api('/api/chat/status')
      const banner = $('ct-backend-banner')
      // The banner explains WHY chat is down -- so it only shows when chat
      // actually IS down. A running channel with a non-local backend value
      // (mid-switch, dev harness) must not read "chat is off" above a
      // conversation that is demonstrably working.
      if (!s.up && s.backend && s.backend !== 'local') {
        banner.textContent = C.wrongBackend(s.backend)
        banner.classList.remove('hidden')
      } else {
        banner.classList.add('hidden')
      }
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

  async function send() {
    const text = input.value
    if (!text.trim()) return
    sendBtn.disabled = true
    try {
      await window.api('/api/chat/in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      // No local append: the 202 means the message is already in the
      // transcript, and pollNow() renders it from there (see header).
      input.value = ''
      input.style.height = 'auto'
      pollNow()
    } catch (err) {
      // The text stays in the input on purpose -- see header.
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
    input.focus()
    pollOnce()
    window.addEventListener('beforeunload', () => { if (pollTimer) clearTimeout(pollTimer) })
  }

  document.addEventListener('DOMContentLoaded', init)
})()
