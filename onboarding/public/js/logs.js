// Cursor feed is already secret-masked by log-buffer.cjs. Never fetch raw disk bytes.
;(function () {
  const L = window.COPY.logs
  const P = window.COPY.polish
  const $ = id => document.getElementById(id)
  const pane = $('lg-pane')
  const followBox = $('lg-follow')
  let nextSeq = 0, lines = [], pollTimer, paused = false, pending = 0, file = '', errNoted = false
  let source = 'all'
  const levels = new Set(['info', 'warn', 'error'])
  const chips = {}
  function classify(e) {
    const stream = e.stream || 'main'
    const source = stream.startsWith('engine') || /\[dsh-lane\] engine:|\[engine\]/i.test(e.line) ? 'engine' : stream.startsWith('agent') ? 'agent' : 'app'
    const level = stream.endsWith('!') || /\b(error|failed|failure|exception|fatal)\b/i.test(e.line) ? 'error' : /\b(warn|warning)\b/i.test(e.line) ? 'warn' : 'info'
    const t = new Date(e.ts)
    const clock = isNaN(t) ? e.ts : t.toTimeString().slice(0, 8)
    return { ...e, source, level, clock, text: `${clock} [${stream}] ${e.line}` }
  }
  function matcher() {
    const q = $('lg-search').value
    if (!q) return () => true
    try { const re = new RegExp(q, 'i'); return e => re.test(e.text) }
    catch { return e => e.text.toLowerCase().includes(q.toLowerCase()) }
  }
  function refreshCounts() {
    for (const [key, el] of Object.entries(chips)) {
      const count = key === 'all' ? lines.length : lines.filter(e => e.source === key || e.level === key).length
      el.textContent = `${P[key]} ${count}`
      const active = ['all', 'app', 'agent', 'engine'].includes(key) ? source === key : levels.has(key)
      el.classList.toggle('active', active)
      el.setAttribute('aria-pressed', String(active))
    }
    $('lg-new').textContent = P.newLines(pending)
    $('lg-new').classList.toggle('hidden', !paused || !pending)
    $('lg-pause').textContent = paused ? P.resume : P.pause
    $('lg-pause').classList.toggle('is-paused', paused)
  }
  function render() {
    const match = matcher()
    const visible = lines.filter(e => (source === 'all' || source === e.source) && levels.has(e.level) && match(e))
    const fragment = document.createDocumentFragment()
    for (const e of visible) {
      const row = document.createElement('div')
      row.className = `log-line log-${e.level}`
      for (const [cls, text] of [['log-time', e.clock], ['log-source', P[e.source]], ['log-text', e.line]]) {
        const span = document.createElement('span'); span.className = cls; span.textContent = text; row.appendChild(span)
      }
      fragment.appendChild(row)
    }
    if (!visible.length) { const empty = document.createElement('div'); empty.className = 'log-empty'; empty.textContent = L.empty; fragment.appendChild(empty) }
    pane.replaceChildren(fragment)
    if (followBox.checked && !paused) pane.scrollTop = pane.scrollHeight
  }
  function setPaused(value) {
    paused = value; followBox.checked = !value
    if (!value) { pending = 0; render(); pane.scrollTop = pane.scrollHeight }
    refreshCounts()
  }
  async function pollOnce() {
    try {
      const result = await window.api(`/api/logs?since=${nextSeq}`)
      const entries = Array.isArray(result.entries) ? result.entries : []
      if (result.dropped) lines.push(classify({ ts: new Date().toISOString(), stream: 'main', line: L.gapMarker }))
      lines.push(...entries.map(classify)); lines = lines.slice(-3000)
      nextSeq = result.nextSeq
      if (paused) pending += entries.length
      else if (entries.length || result.dropped || !pane.childNodes.length) render()
      file = result.file || ''
      $('lg-open').disabled = !file
      $('lg-file-note').textContent = file ? P.file(file) : L.fileNoteMissing
      refreshCounts(); errNoted = false
    } catch (err) {
      if (!errNoted) { console.error('log poll failed:', err); window.showToast(L.pollError); errNoted = true }
    }
    pollTimer = setTimeout(pollOnce, 1000)
  }
  function init() {
    $('lg-title').textContent = L.title; $('lg-subtitle').textContent = L.subtitle
    $('lg-copy').textContent = P.copy; $('lg-open').textContent = P.open
    $('lg-follow-label').textContent = L.followOn; $('lg-wrap-label').textContent = P.wrap
    $('lg-search').placeholder = P.search; $('lg-search').setAttribute('aria-label', P.search)
    for (const [id, keys] of [['lg-sources', ['all', 'app', 'agent', 'engine']], ['lg-levels', ['info', 'warn', 'error']]]) {
      for (const key of keys) {
        const button = document.createElement('button'); button.className = 'log-chip'; chips[key] = button
        button.onclick = () => { if (id === 'lg-sources') source = key; else if (levels.has(key)) levels.delete(key); else levels.add(key); render(); refreshCounts() }
        $(id).appendChild(button)
      }
    }
    $('lg-search').oninput = render
    $('lg-wrap').onchange = () => pane.classList.toggle('nowrap', !$('lg-wrap').checked)
    $('lg-pause').onclick = () => setPaused(!paused)
    $('lg-new').onclick = () => setPaused(false)
    $('lg-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(lines.map(e => e.text).join('\n')); window.showToast(L.copied) }
      catch (err) { console.error(err); window.showToast(L.copyFailed) }
    }
    $('lg-open').onclick = async () => {
      try { await window.api('/api/logs/open', { method: 'POST' }) }
      catch (err) { window.showToast(window.COPY.genericError(err.message)) }
    }
    pane.addEventListener('scroll', () => {
      if (!paused && pane.scrollHeight - pane.scrollTop - pane.clientHeight > 8) setPaused(true)
    })
    followBox.onchange = () => setPaused(!followBox.checked)
    refreshCounts(); pollOnce()
    window.addEventListener('beforeunload', () => clearTimeout(pollTimer))
  }
  document.addEventListener('DOMContentLoaded', init)
})()
