// A plain same-origin renderer: no preload, IPC, Node, or executable agent HTML.
;(function () {
  const $ = id => document.getElementById(id)
  let shapeHeight = -1
  let current = null, lastId = null, pointerInside = false, pointerQueue = Promise.resolve()
  let drag = null, dragged = false, sending = false, avatarUrl = null, avatarAt = 0
  async function api(route, body) {
    const r = await fetch(route, { headers: { 'X-Onboard-Token': window.getOnboardToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(6000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }
  const command = (action, args = {}) => api('/api/companion', { action, ...args })
  // stt.js (loaded after this file) talks through window.api like the main pages.
  window.api = async (route, options = {}) => {
    const r = await fetch(route, { ...options, headers: { ...(options.headers || {}), 'X-Onboard-Token': window.getOnboardToken() } })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
    return body
  }
  window.SeraCompanionError = async message => {
    // Expand the native window as well as the DOM; Face alone is only 64px.
    try { render(await command('call-error', { message: String(message) })) }
    catch { $('bubble').hidden = false }
    $('failure').textContent = String(message); $('failure').hidden = false
    measureBubble()
  }
  let callSpeaking = false
  setInterval(() => {
    const speaking = !!window.SeraCall?.speaking
    if (speaking !== callSpeaking) command('call-speaking', { speaking }).then(() => { callSpeaking = speaking }).catch(() => {})
  }, 250)
  function showFailure() { $('failure').hidden = false; $('failure').textContent = '보내지 못했어요. 연결을 확인하고 다시 보내 주세요.' }
  async function action(name, args) { try { render(await command(name, args)) } catch { showFailure() } }
  function render(state) {
    current = state
    const orbMode = state.variant === 'orb'
    $('face').hidden = orbMode; $('orb-wrap').hidden = !orbMode
    document.body.dataset.variant = orbMode ? 'orb' : 'face'
    if (state.geometry) {
      const surface = orbMode ? $('orb-wrap') : $('face')
      surface.style.left = `${state.geometry.face.x}px`; surface.style.top = `${state.geometry.face.y}px`
      $('bubble').style.top = `${state.geometry.bubbleTop || 0}px`
      $('bubble').style.left = `${state.geometry.bubbleLeft || 0}px`
      document.body.dataset.placement = state.geometry.placement
    }
    voice.update(state)
    $('face').dataset.ring = state.ring
    $('face').setAttribute('aria-label', state.ring === 'attention' ? '세라 · 확인할 이야기가 있어요' : '세라와 이야기하기')
    $('bubble').hidden = !state.bubble
    $('connection').textContent = state.connected ? '' : '채팅 연결 확인 중'
    if (!state.bubble) { lastId = null; shapeHeight = -1; return }
    const b = state.bubble
    if (b.id !== lastId) {
      $('message').textContent = b.text
      $('failure').hidden = true
      lastId = b.id
    }
    $('approval').hidden = $('approval-note').hidden = b.kind !== 'approval-reply'
    $('main').hidden = b.kind !== 'approval-reply'
    $('reply-form').hidden = ['error', 'retrying'].includes(b.kind)
    $('bubble').classList.toggle('expects-reply', ['compose', 'question', 'approval-reply'].includes(b.kind) || !!$('reply').value)
    measureBubble()
  }
  function measureBubble() {
    if ($('bubble').hidden) return
    const height = Math.ceil($('bubble').getBoundingClientRect().height)
    if (height !== shapeHeight) { shapeHeight = height; command('shape', { height }).then(render).catch(() => { shapeHeight = -1 }) }
  }
  new ResizeObserver(measureBubble).observe($('bubble'))
  function pointer(inside) {
    if (pointerInside === inside) return
    pointerInside = inside
    pointerQueue = pointerQueue.then(() => command('pointer', { inside })).catch(() => { pointerInside = !inside })
  }
  document.addEventListener('mousemove', e => pointer(!!e.target.closest('.surface')))
  document.addEventListener('mouseleave', () => { if (!drag) pointer(false) })
  for (const el of document.querySelectorAll('.surface')) {
    el.addEventListener('mouseenter', () => pointer(true))
    el.addEventListener('mouseleave', () => { if (!drag) pointer(false) })
  }
  $('bubble').addEventListener('pointerdown', () => command('touch').catch(() => {}))
  $('bubble').addEventListener('input', () => command('touch').catch(() => {}))
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !window.SeraCall?.active) action('dismiss')
    // Space = pause/resume speech, never while typing in the reply box.
    if (e.code === 'Space' && current?.variant === 'orb' && !e.target.closest('input, textarea, button')) { e.preventDefault(); voice.togglePause() }
  })
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.surface')) action('dismiss') })
  $('main').onclick = () => action('main')
  // Face and orb share drag-to-move. A plain click on the face opens the
  // bubble; on the orb it pauses/resumes speech, or opens the bubble when quiet.
  const tap = () => (current?.variant === 'orb' && voice.togglePause()) || action('open')
  for (const handle of [$('face'), $('orb')]) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      drag = { x: e.screenX, y: e.screenY, handle }; dragged = false
      handle.setPointerCapture(e.pointerId)
    })
    handle.addEventListener('pointermove', e => {
      if (!drag || dragged || Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 4) return
      dragged = true
      pointerQueue = pointerQueue.then(() => command('drag-start')).catch(showFailure)
    })
    handle.addEventListener('pointerup', endDrag)
    handle.addEventListener('pointercancel', endDrag)
  }
  async function endDrag(e) {
    if (!drag) return
    const { handle } = drag
    drag = null
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
    if (dragged) { await pointerQueue; await action('drag-end') }
    else await tap()
  }
  $('face').addEventListener('click', e => { if (e.detail === 0) action('open') })
  async function send(text) {
    if (sending || !text.trim()) return
    sending = true
    for (const id of ['send', 'allow', 'deny']) $(id).disabled = true
    try { render(await command('reply', { text })); $('reply').value = '' }
    catch { showFailure() }
    finally { sending = false; for (const id of ['send', 'allow', 'deny']) $(id).disabled = false }
  }
  $('reply-form').onsubmit = e => { e.preventDefault(); send($('reply').value) }
  $('allow').onclick = () => send(`이 질문에 대한 답: “${current.bubble.text.slice(0,2000)}”\n허용할게요.`)
  $('deny').onclick = () => send(`이 질문에 대한 답: “${current.bubble.text.slice(0,2000)}”\n하지 말아 주세요.`)
  async function refreshAvatar() {
    if (Date.now() - avatarAt < 30000) return
    avatarAt = Date.now()
    try {
      const r = await fetch('/api/settings/avatar', { headers: { 'X-Onboard-Token': window.getOnboardToken() }, cache: 'no-cache' })
      if (!r.ok) return
      const next = URL.createObjectURL(await r.blob())
      $('avatar').src = next
      if (avatarUrl) URL.revokeObjectURL(avatarUrl)
      avatarUrl = next
    } catch { /* Keep the last face or the shipped fallback. */ }
  }
  // ── voice: read-aloud playback + orb + mic (design-0027) ─────────────────
  // While the companion is on, THIS renderer owns read-aloud (tts.js in the
  // chat window goes silent), for both variants: audio plays once. One
  // persistent <audio> element feeds one MediaElementSource -> AnalyserNode ->
  // destination, so the orb reads the same samples that reach the speakers.
  const voice = (function () {
    const core = window.SeraTTSCore
    const el = new Audio()
    let ctx = null, analyser = null, queue = null, ttsOn = false, ttsAt = 0, sttOn = false
    let lastSeq = null, finishClip = null, orb = null, mode = 'idle'
    function tap() {
      if (ctx) return
      ctx = new AudioContext()
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.6
      ctx.createMediaElementSource(el).connect(analyser); analyser.connect(ctx.destination)
    }
    window.SeraCompanionAudioTap = audio => {
      tap(); ctx.resume().catch(() => {})
      const source = ctx.createMediaElementSource(audio); source.connect(analyser); kick()
      return () => { source.disconnect(); kick() }
    }
    function ensureQueue() {
      return (queue ||= core.createSpeechQueue({
        synth: async text => {
          const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Onboard-Token': window.getOnboardToken() }, body: JSON.stringify({ text }) })
          if (!r.ok) throw new Error(`tts HTTP ${r.status}`)
          return URL.createObjectURL(await r.blob())
        },
        play: url => new Promise(resolve => {
          tap(); ctx.resume().catch(() => {})
          const done = () => { el.onended = el.onerror = null; finishClip = null; URL.revokeObjectURL(url); resolve(); kick() }
          finishClip = done
          el.onended = done; el.onerror = done
          el.src = url
          el.play().then(kick, done)
        }),
        stopPlayback: () => { el.pause(); finishClip?.() },
        onState: (_s, e) => { if (e) console.warn('[companion tts]', e); kick() },
      }))
    }
    async function syncVoice() {
      if (Date.now() - ttsAt < 15000) return
      ttsAt = Date.now()
      try { const s = await window.api('/api/tts/status'); ttsOn = s.enabled && s.modelsPresent } catch { ttsOn = false }
      try { const s = await window.api('/api/stt/status'); sttOn = s.enabled && s.modelsPresent } catch { sttOn = false }
      $('b-mic').disabled = !!window.SeraCall?.active || (!sttOn && mode === 'idle')
    }
    function state() {
      if (window.SeraCall?.speaking) return 'speaking'
      const stt = window.SeraSTT?.mode
      if (stt === 'listening' || stt === 'processing') return 'listening'
      if (!el.paused && !el.ended && el.currentSrc) return 'speaking'
      return 'idle'
    }
    function kick() { orb?.kick(); $('b-stop').disabled = !queue?.running && !window.SeraCall?.speaking; $('b-mic').classList.toggle('on', state() === 'listening'); $('b-mic').setAttribute('aria-pressed', String(state() === 'listening')) }
    function update(s) {
      syncVoice()
      if (s.variant === 'orb' && !orb && window.SeraCompanionOrb) orb = window.SeraCompanionOrb.createOrb($('orb'), { getAnalyser: () => analyser, getState: state })
      if (s.variant === 'orb') kick(); else orb?.stop()
      // Seed on first sight so retained replies are never replayed.
      const items = s.speech || []
      const top = items.length ? items[items.length - 1].seq : 0
      if (lastSeq === null) { lastSeq = top; return }
      for (const m of items) {
        if (m.seq <= lastSeq) continue
        lastSeq = m.seq
        if (window.SeraCall?.active || !ttsOn || !core) continue
        const clean = core.cleanForSpeech(m.text)
        if (clean) ensureQueue().enqueue(clean)
      }
    }
    function togglePause() {
      if (!el.currentSrc || el.ended || !queue?.running) return false
      if (el.paused) el.play().catch(() => {}); else el.pause()
      kick(); return true
    }
    // Mic: STT's own start/stop (stt.js) on a hidden composer field; partials
    // share the bubble as ghost text; finals land in its reply field, never sent.
    const input = $('ct-input')
    input.addEventListener('input', () => {
      $('ghost').textContent = input.value
      $('ghost').hidden = !input.value
    })
    async function mic() {
      if (window.SeraCall?.active) return
      const stt = window.SeraSTT
      if (!stt) return
      if (stt.mode === 'listening') {
        await stt.stop(); kick()
        const text = input.value.trim()
        $('ghost').textContent = ''; $('ghost').hidden = true; input.value = ''
        if (text) {
          if (!current?.bubble) await action('open')
          $('reply').value = text; $('bubble').classList.add('expects-reply'); $('reply').focus()
        }
      } else if (stt.mode === 'idle') {
        queue?.stop() // no echo: Sera stops talking while the user speaks
        input.value = ''
        if (!current?.bubble) await action('open')
        const started = stt.start()
        kick(); await started; kick()
      }
    }
    window.SeraCompanionSpeechStop = () => queue?.stop()
    $('b-power').onclick = () => { window.SeraCall?.stop(); queue?.stop(); action('settings', { enabled: false }) }
    $('b-stop').onclick = () => { window.SeraCall?.stopSpeech(); queue?.stop(); kick() }
    $('b-mic').onclick = mic
    const wrap = $('orb-wrap')
    wrap.addEventListener('mouseenter', () => wrap.classList.add('hov'))
    wrap.addEventListener('mousemove', () => wrap.classList.add('hov'))
    wrap.addEventListener('mouseleave', () => wrap.classList.remove('hov'))
    $('b-stop').disabled = true
    return { update, togglePause }
  })()

  async function poll() {
    try { render(await api('/api/companion')); await refreshAvatar() }
    catch { $('connection').textContent = '연결을 확인해 주세요' }
    setTimeout(poll, 250)
  }
  poll()
})()
