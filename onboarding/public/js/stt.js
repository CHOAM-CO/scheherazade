// stt.js -- voice input (음성 입력). Settings: toggle + model selection + download progress,
// placed right under the read-aloud card. Chat: when enabled and the model is
// on disk, a mic button sits in the composer bar. Click toggles listening; Esc
// stops. Mic audio is captured (AudioWorklet, ScriptProcessor fallback),
// downsampled to 16 kHz Float32 (stt-core.cjs) and POSTed in ~100 ms chunks to
// /api/stt/audio; the reply's partial shows live in the input box in grey, and
// the finished text is committed into the input, never auto-sent.
;(function () {
  const ko = (document.documentElement?.lang || navigator.language || 'en').startsWith('ko')
  const T = ko
    ? { label: '음성 입력', note: '말하면 이 기기에서 바로 글자로 받아 적습니다 (오프라인). 처음 켤 때 음성 인식 모델을 한 번 받습니다', toggle: '채팅에 마이크 버튼 표시', dl: (d, t) => `음성 인식 모델 받는 중 ${mb(d)} / ${mb(t)} MB`, ready: '준비됨', missing: t => `켜면 음성 인식 모델 ${mb(t)} MB를 받음`, err: e => `오류: ${e}`, mic: '음성 입력', listening: '듣는 중 (Esc로 멈춤)', processing: '받아 적는 중', denied: '마이크 권한이 없습니다. 시스템 설정에서 마이크를 허용해 주세요', failed: e => `음성 입력 오류: ${e}` }
    : { label: 'Voice input', note: 'Speech is transcribed on this device (offline). The first enable downloads the speech model once.', toggle: 'Show the mic button in chat', dl: (d, t) => `Downloading speech model ${mb(d)} / ${mb(t)} MB`, ready: 'Ready', missing: t => `Enabling downloads ${mb(t)} MB`, err: e => `Error: ${e}`, mic: 'Voice input', listening: 'Listening (Esc to stop)', processing: 'Transcribing', denied: 'No microphone permission. Allow the microphone in System Settings.', failed: e => `Voice input error: ${e}` }
  function mb(n) { return Math.round((n || 0) / 1048576) }
  const token = () => window.getOnboardToken?.() || ''
  const getStatus = () => window.api('/api/stt/status')
  const postJson = (url, body) => window.api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  // ── settings card ───────────────────────────────────────────────────────
  function mountSettings() {
    const about = document.getElementById('set-about')
    if (!about) return
    const card = document.createElement('div')
    card.className = 'companion-setting-section'
    card.id = 'set-stt'
    const label = document.createElement('div'); label.className = 'category-label'; label.textContent = T.label
    const note = document.createElement('p'); note.className = 'subtitle'; note.textContent = T.note
    const row = document.createElement('div'); row.className = 'agent-control-row'
    const lab = document.createElement('label'); lab.htmlFor = 'set-stt-enabled'; lab.textContent = T.toggle
    const box = document.createElement('input'); box.type = 'checkbox'; box.id = 'set-stt-enabled'
    row.append(lab, box)
    const state = document.createElement('div'); state.className = 'agent-control-hint'; state.id = 'set-stt-state'
    const credit = document.createElement('div'); credit.className = 'agent-control-hint'; credit.id = 'set-stt-credit'
    const modelRow = document.createElement('div'); modelRow.className = 'agent-control-row'
    const modelLabel = document.createElement('label'); modelLabel.htmlFor = 'set-stt-model'; modelLabel.textContent = ko ? '인식 모델' : 'Recognition model'
    const modelSelect = document.createElement('select'); modelSelect.id = 'set-stt-model'
    modelRow.append(modelLabel, modelSelect)
    const dumpRow = document.createElement('div'); dumpRow.className = 'agent-control-row'
    const dumpLabel = document.createElement('label'); dumpLabel.htmlFor = 'set-stt-dump'
    dumpLabel.textContent = ko ? '들은 소리 파일로 남기기 (진단용)' : 'Save heard audio to files (diagnostics)'
    const dumpBox = document.createElement('input'); dumpBox.type = 'checkbox'; dumpBox.id = 'set-stt-dump'
    const dumpPath = document.createElement('span'); dumpPath.className = 'agent-control-hint'; dumpPath.style.overflowWrap = 'anywhere'
    dumpRow.append(dumpLabel, dumpBox, dumpPath)
    card.append(label, note, row, modelRow, dumpRow, state, credit)
    const tts = document.getElementById('set-tts')
    const group = document.getElementById('set-companion-mic')
    if (group) group.append(card)
    else if (tts) tts.after(card)
    else about.parentNode.insertBefore(card, about)
    let timer = null
    function paint(s) {
      box.checked = s.enabled
      dumpBox.checked = !!s.dump
      dumpPath.textContent = s.dumpDir || ''
      modelSelect.replaceChildren(...(s.models || []).map(m => {
        const option = document.createElement('option'); option.value = m.id
        option.textContent = `${m.id === '72m' ? (ko ? '소형 · 72M (기본)' : 'Small · 72M (default)') : (ko ? '대형 · 174M' : 'Large · 174M')} · ${mb(m.totalBytes)} MiB`
        return option
      }))
      modelSelect.value = s.modelId || '72m'
      modelSelect.disabled = s.download.state === 'downloading'
      credit.textContent = s.credit || ''
      const d = s.download
      if (d.state === 'downloading') state.textContent = `${T.dl(d.done, d.total)}${d.total > 0 ? ` · ${Math.min(100, Math.round(d.done / d.total * 100))}%` : ''}`
      else if (d.state === 'error') state.textContent = T.err(d.error)
      else if (!s.modelsPresent) state.textContent = `${ko ? '미설치' : 'Not installed'} · ${T.missing(s.totalBytes)}`
      else if (s.engine === 'error') state.textContent = T.err(s.engineError)
      else state.textContent = T.ready
      clearTimeout(timer); timer = null
      if (d.state === 'downloading') timer = setTimeout(refresh, 1000)
    }
    async function refresh() { try { paint(await getStatus()) } catch (e) { state.textContent = T.err(e.message) } }
    modelSelect.onchange = async () => {
      modelSelect.disabled = true
      try { paint(await postJson('/api/stt/settings', { modelId: modelSelect.value })) }
      catch (e) { await refresh(); state.textContent = T.err(e.message) }
      finally { if (!timer) modelSelect.disabled = false }
    }
    dumpBox.onchange = async () => {
      dumpBox.disabled = true
      try { paint(await postJson('/api/stt/settings', { dump: dumpBox.checked })) }
      catch (e) { await refresh(); state.textContent = T.err(e.message) }
      finally { dumpBox.disabled = false }
    }
    box.onchange = async () => { box.disabled = true; try { paint(await postJson('/api/stt/settings', { enabled: box.checked })) } catch (e) { state.textContent = T.err(e.message) } finally { box.disabled = false } }
    refresh()
  }

  // ── chat mic ────────────────────────────────────────────────────────────
  const WORKLET = `class SeraMicTap extends AudioWorkletProcessor {
    process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true }
  }
  registerProcessor('sera-mic-tap', SeraMicTap)`
  const CHUNK = 1600 // 100 ms at 16 kHz

  let epoch = 0
  let btn = null
  let input = null
  let mode = 'idle' // idle | listening | processing
  let cap = null // { stream, ctx, node, src }
  let sid = null
  let base = ''
  let finals = []
  let partial = ''
  let queue = []
  let queued = 0
  let inflight = null
  let audioRetry = null

  function setMode(m) {
    mode = m
    if (!btn) return
    btn.dataset.state = m
    btn.title = m === 'listening' ? T.listening : m === 'processing' ? T.processing : T.mic
    btn.setAttribute('aria-pressed', String(m === 'listening'))
    btn.disabled = m === 'processing'
    if (input) { input.classList.toggle('stt-ghost', m !== 'idle'); input.readOnly = m !== 'idle' }
  }
  function render() {
    if (!input) return
    input.value = window.SeraSTTCore.composeText(base, finals, partial)
    input.dispatchEvent(new Event('input', { bubbles: true })) // chat.js auto-resize
  }
  function take(n) {
    const out = new Float32Array(n)
    let o = 0
    while (o < n && queue.length) {
      const h = queue[0], k = Math.min(h.length, n - o)
      out.set(h.subarray(0, k), o); o += k
      if (k === h.length) queue.shift(); else queue[0] = h.subarray(k)
    }
    queued -= o
    return out.subarray(0, o)
  }
  function pump(flush = false) {
    if (inflight || !sid || (!flush && queued < CHUNK) || !queued) return inflight
    const requestEpoch = epoch
    const pcm = take(flush ? queued : Math.floor(queued / CHUNK) * CHUNK)
    const request = () => fetch('/api/stt/audio', { signal: AbortSignal.timeout(10000), method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Onboard-Token': token(), 'X-STT-Session': sid }, body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    inflight = (audioRetry ? audioRetry.run(request, () => requestEpoch === epoch && mode !== 'idle') : request())
      .then(r => { if (mode === 'idle' || requestEpoch !== epoch) return; if (window.SeraCall?.active) { window.SeraCall.partial(r.partial || ''); for (const text of r.finals) window.SeraCall.final(text); finals = []; base = ''; partial = r.partial || '' } else { finals.push(...r.finals); partial = r.partial || '' }; render() })
      .catch(e => { console.warn('[stt]', e.message) })
      .finally(() => { inflight = null; if (mode === 'listening') pump() })
    return inflight
  }

  async function startCapture() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    let ctx
    try { ctx = new AudioContext({ sampleRate: 16000 }) } catch { ctx = new AudioContext() }
    const down = window.SeraSTTCore.createDownsampler(ctx.sampleRate)
    const onFrame = f => { if (mode !== 'listening' || window.SeraCall?.speaking) return; const d = down(f); if (d.length) { queue.push(d); queued += d.length; pump() } }
    const src = ctx.createMediaStreamSource(stream)
    let node
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
      await ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      node = new AudioWorkletNode(ctx, 'sera-mic-tap')
      node.port.onmessage = e => onFrame(e.data)
    } catch {
      node = ctx.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = e => onFrame(e.inputBuffer.getChannelData(0))
    }
    src.connect(node)
    node.connect(ctx.destination) // keeps the graph pulling; the tap outputs silence
    return { stream, ctx, node, src }
  }
  function stopCapture() {
    if (!cap) return
    try { cap.src.disconnect(); cap.node.disconnect() } catch {}
    for (const t of cap.stream.getTracks()) t.stop()
    cap.ctx.close().catch(() => {})
    cap = null
  }

  async function start() {
    if (mode !== 'idle' || !input) return
    const e = ++epoch
    audioRetry = window.SeraCall?.active ? window.SeraCallCore.createSegmentRetry({ onLimit: () => { window.showToast?.(T.failed('3 consecutive audio uploads failed')); window.SeraCall.stop() } }) : null
    setMode('processing')
    base = input.value; finals = []; partial = ''; queue = []; queued = 0
    try {
      const capture = await startCapture()
      if (e !== epoch) { capture.stream.getTracks().forEach(t => t.stop()); capture.ctx.close(); return }
      cap = capture
      for (const track of cap.stream.getTracks()) track.onended = () => { if (e === epoch) window.SeraSTT.cancel() }
      sid = (await postJson('/api/stt/start', {})).sid
      if (e !== epoch) { const old = sid; sid = null; postJson('/api/stt/stop', { sid: old, cancel: true }).catch(() => {}); return }
      setMode('listening')
    } catch (e) {
      stopCapture(); sid = null; setMode('idle')
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotFoundError')
      window.showToast?.(denied ? T.denied : T.failed(e.message || e.name))
    }
  }
  async function stop() {
    if (mode !== 'listening') return
    setMode('processing')
    stopCapture()
    try {
      await inflight
      await pump(true)
      const r = await postJson('/api/stt/stop', { sid })
      finals.push(...r.finals); partial = ''
    } catch (e) { partial = ''; window.showToast?.(T.failed(e.message)) }
    sid = null
    render()
    setMode('idle')
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }

  function mountMic() {
    input = document.getElementById('ct-input')
    const bar = document.querySelector('.chat-composer-bar')
    if (!input || !bar || btn) return
    const style = document.createElement('style')
    style.textContent = `
      .stt-mic { position: relative; width: 32px; height: 32px; padding: 0; border-radius: var(--radius-m); display: inline-flex; align-items: center; justify-content: center; }
      .stt-mic svg { width: 16px; height: 16px; }
      .stt-mic[data-state="listening"]::after { content: ''; position: absolute; top: 4px; right: 4px; width: 7px; height: 7px; border-radius: 50%; background: #e5484d; animation: stt-pulse 1.2s ease-in-out infinite; }
      .stt-mic[data-state="processing"] { opacity: 0.6; }
      @keyframes stt-pulse { 50% { opacity: 0.35 } }
      #ct-input.stt-ghost { color: var(--fg-dim, #8a8a8a); }`
    document.head.appendChild(style)
    btn = document.createElement('button')
    btn.type = 'button'
    btn.id = 'ct-mic'
    btn.className = 'secondary stt-mic'
    btn.hidden = true
    btn.setAttribute('aria-label', T.mic)
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
    btn.onclick = () => { if (!window.SeraCall?.active) return mode === 'listening' ? stop() : start() }
    const anchor = document.getElementById('ct-stop') || document.getElementById('ct-send')
    bar.insertBefore(btn, anchor)
    setMode('idle')
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && mode === 'listening') { e.preventDefault(); e.stopPropagation(); if (window.SeraCall?.active) window.SeraCall.stop(); else stop() } }, true)
  }
  async function syncEnabled() {
    try {
      const s = await getStatus()
      if (btn) btn.hidden = !(s.enabled && s.modelsPresent) && mode === 'idle'
    } catch {}
  }

  window.SeraSTT = { start, stop, cancel() { epoch++; stopCapture(); const old = sid; sid = null; queue = []; queued = 0; partial = ''; finals = []; setMode('idle'); if (old) postJson('/api/stt/stop', { sid: old, cancel: true }).catch(() => {}) }, get mode() { return mode } }

  if (document.getElementById('set-about')) mountSettings()
  else if (document.getElementById('ct-input')) { mountMic(); syncEnabled(); setInterval(syncEnabled, 15000); document.addEventListener('visibilitychange', () => { if (!document.hidden) syncEnabled() }) }
})()
