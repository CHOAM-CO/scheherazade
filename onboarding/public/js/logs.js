// logs.js — /logs session log viewer (v0.0.20, the owner 07-16 "로그 터미널 창").
//
// Cursor-polls GET /api/logs?since=N every second and appends only NEW
// entries (never re-renders the pane -- at 3000 lines a full re-render every
// second would burn the CPU the agent needs). Client keeps its own line
// array as the copy source, capped to the same 3000 the server ring holds.
//
// Follow mode: checkbox ON = pane pinned to bottom on every append. Scrolling
// up flips it OFF automatically (reading old lines must not fight the tail);
// re-checking or scrolling back to the bottom flips it ON.

;(function () {
  const L = window.COPY.logs

  const POLL_MS = 1000
  const MAX_CLIENT_LINES = 3000

  function $(id) { return document.getElementById(id) }

  const pane = $('lg-pane')
  const followBox = $('lg-follow')

  let nextSeq = 0
  let lines = [] // copy-source mirror of what the pane shows
  let pollTimer = null
  let emptyEl = null
  let errNoted = false

  function setStatics() {
    $('lg-title').textContent = L.title
    $('lg-subtitle').textContent = L.subtitle
    $('lg-copy').textContent = L.copyButton
    $('lg-follow-label').textContent = L.followOn
    $('lg-file-note').textContent = ''
  }

  function atBottom() {
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 8
  }

  function showEmpty() {
    if (emptyEl || lines.length) return
    emptyEl = document.createElement('div')
    emptyEl.className = 'log-line log-empty'
    emptyEl.textContent = L.empty
    pane.appendChild(emptyEl)
  }

  function clearEmpty() {
    if (!emptyEl) return
    emptyEl.remove()
    emptyEl = null
  }

  function appendLine(text, cssClass) {
    clearEmpty()
    const el = document.createElement('div')
    el.className = `log-line ${cssClass}`
    el.textContent = text
    pane.appendChild(el)
    lines.push(text)
    // Trim DOM + mirror together so copy always matches what's visible.
    while (lines.length > MAX_CLIENT_LINES) {
      lines.shift()
      if (pane.firstChild) pane.firstChild.remove()
    }
  }

  const STREAM_CLASS = {
    main: 'log-main',
    'main!': 'log-err',
    agent: 'log-agent',
    'agent!': 'log-err',
  }

  function renderEntries(result) {
    if (result.dropped) appendLine(L.gapMarker, 'log-gap')
    for (const e of result.entries) {
      // ts arrives as ISO; show the local clock part only -- the full stamp
      // lives in the disk file for forensic grabs.
      const t = new Date(e.ts)
      const clock = isNaN(t) ? e.ts : t.toTimeString().slice(0, 8)
      appendLine(`${clock} [${e.stream}] ${e.line}`, STREAM_CLASS[e.stream] || 'log-main')
    }
    if (followBox.checked && result.entries.length) pane.scrollTop = pane.scrollHeight
  }

  async function pollOnce() {
    try {
      const result = await window.api(`/api/logs?since=${nextSeq}`)
      renderEntries(result)
      nextSeq = result.nextSeq
      $('lg-file-note').textContent = result.file ? L.fileNote(result.file) : L.fileNoteMissing
      showEmpty()
      errNoted = false
    } catch (err) {
      // Note once per outage, keep polling -- the app coming back should
      // resume the tail without a reload.
      if (!errNoted) {
        console.error('log poll failed:', err)
        window.showToast(L.pollError)
        errNoted = true
      }
    }
    pollTimer = setTimeout(pollOnce, POLL_MS)
  }

  function init() {
    setStatics()

    $('lg-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(lines.join('\n'))
        window.showToast(L.copied)
      } catch (err) {
        console.error('clipboard write failed:', err)
        window.showToast(L.copyFailed)
      }
    }

    // Scroll-driven follow: user scrolling up = stop chasing; returning to
    // the bottom = resume. The checkbox stays the visible state of record.
    pane.addEventListener('scroll', () => {
      if (atBottom()) {
        if (!followBox.checked) followBox.checked = true
      } else if (followBox.checked) {
        followBox.checked = false
      }
    })
    followBox.addEventListener('change', () => {
      if (followBox.checked) pane.scrollTop = pane.scrollHeight
    })

    pollOnce()
    window.addEventListener('beforeunload', () => { if (pollTimer) clearTimeout(pollTimer) })
  }

  document.addEventListener('DOMContentLoaded', init)
})()
