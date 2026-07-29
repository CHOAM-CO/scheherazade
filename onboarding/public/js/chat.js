// chat.js — /chat in-app conversation page (in-app chat slice 4,
// docs/in-app-chat-plan.md). The page end of the local channel backend:
// polls GET /api/chat/out by cursor (1s, same cadence as logs.js), sends
// via POST /api/chat/in (window.api attaches the per-launch onboard token),
// and renders honestly when the channel is down instead of pretending.
//
// What this page deliberately does NOT do (plan §out-of-scope): history
// persistence, uploads, multiple threads. One list, one input.
//
// Two shapes worth naming:
//  - The outbound queue holds AGENT messages only (channel-local.mjs:
//    inbound user text goes to the MCP notification, never into the queue).
//    So user bubbles are rendered locally at send time, and a reload starts
//    the view at "now" -- replaying the retained queue would show a
//    one-sided conversation that reads as broken, so the first poll seeds
//    the cursor and renders nothing.
//  - A failed send KEEPS the text in the input. Losing the user's message
//    to a restart race is the one unforgivable failure here.

;(function () {
  const C = window.COPY.chat

  const POLL_MS = 1000
  const STATUS_EVERY_TICKS = 5 // /status is a live /health probe upstream; 5s is fresh enough
  const MAX_CLIENT_MSGS = 500 // mirror of the channel's MAX_QUEUE

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

  // textContent ONLY -- message text (either side's) never rides innerHTML.
  function appendMsg(role, text) {
    clearEmpty()
    const stick = atBottom()
    const el = document.createElement('div')
    el.className = `chat-msg chat-${role}`
    el.textContent = text
    pane.appendChild(el)
    msgCount++
    while (msgCount > MAX_CLIENT_MSGS && pane.firstChild) {
      pane.firstChild.remove()
      msgCount--
    }
    if (stick || role === 'user') pane.scrollTop = pane.scrollHeight
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

  async function pollOnce() {
    try {
      if (nextSeq === null) {
        // Seed the cursor; render nothing (see header -- the queue is
        // agent-side only, replaying it reads as a one-sided conversation).
        const seed = await window.api('/api/chat/out?since=0')
        nextSeq = seed.latest
        showEmpty()
      } else {
        const result = await window.api(`/api/chat/out?since=${nextSeq}`)
        if (result.missed) appendGap()
        for (const m of result.items) appendMsg('agent', m.text)
        nextSeq = result.latest
        showEmpty()
      }
    } catch (err) {
      // 503/502 land here via window.api's !res.ok throw. The periodic
      // status refresh below names the state; the cursor survives for when
      // the channel comes back, so no state to update here.
    }
    if (tick % STATUS_EVERY_TICKS === 0) await refreshStatus()
    tick++
    pollTimer = setTimeout(pollOnce, POLL_MS)
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
      appendMsg('user', text)
      input.value = ''
      input.style.height = 'auto'
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
