// Call owns audio only in the active voice surface; dictation stays manual off-call.
;(function () {
  const core = window.SeraCallCore, ko = document.documentElement.lang.startsWith('ko')
  const settings = !!document.getElementById('set-about'), companion = !!document.getElementById('b-mic')
  const channel = new BroadcastChannel('sera-call-settings')
  const post = (url, body) => window.api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(url === '/api/call' ? { ...body, lang: ko ? 'ko' : 'en' } : body) }).then(result => {
    if (url === '/api/call' && result.noticeDelivered === false) presentError(ko ? '통화 상태를 에이전트에 알리지 못했어. 연결을 확인해 줘.' : 'Could not tell the agent about call mode. Check the connection.')
    return result
  })
  let enabled = false, retrying = false, remoteSpeaking = false, voiceMuted = false, micMuted = false
  let active = false, speaking = false, cursor = null, busy = false, audio = null, lastEnd = 0, opening = false, syncing = false, playbackStarted = 0, queueStarted = 0, speechStopped = false, detachAudio = null
  function presentError(message) {
    // A call-only companion can close immediately on hangup; retain errors in chat.
    if (companion) channel.postMessage({ type: 'call-error', message })
    if (window.showToast) window.showToast(message)
    else window.SeraCompanionError?.(message)
  }
  const panel = document.createElement('div'), status = document.createElement('span'), hangup = document.createElement('button')
  panel.id = 'call-controls'; panel.className = 'call-controls'; panel.hidden = true
  status.id = 'call-state'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  hangup.id = 'call-end'; hangup.type = 'button'; hangup.textContent = ko ? '통화 종료' : 'End call'; hangup.className = 'secondary'
  hangup.onclick = () => window.SeraCall.stop()
  function muteButton(id, icon) {
    const b = document.createElement('button')
    b.id = id; b.type = 'button'; b.className = 'secondary call-mute'
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}<path class="mute-slash" d="M3 3l18 18"/></svg>`
    return b
  }
  const voiceButton = muteButton('call-voice', '<path d="M11 4L6 8H3v8h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>')
  const micButton = muteButton('call-mic', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>')
  voiceButton.onclick = () => { applyMutes(!voiceMuted, micMuted); publishMutes() }
  micButton.onclick = () => { applyMutes(voiceMuted, !micMuted); publishMutes() }
  panel.append(status, voiceButton, micButton, hangup)
  function publishMutes() { channel.postMessage({ type: 'call-mutes', voiceMuted, micMuted }) }
  function applyMutes(voice, mic) {
    const changedMic = micMuted !== mic
    voiceMuted = voice; micMuted = mic
    if (voiceMuted && active) stopSpeech()
    if (changedMic && active) {
      if (micMuted) { window.SeraSTT?.cancel(); utterance.partial('') }
      else {
        opening = true
        Promise.resolve(window.SeraSTT?.start()).catch(e => presentError(e.message)).finally(() => {
          opening = false
          if (!active || micMuted) window.SeraSTT?.cancel()
        })
      }
    }
    renderState()
  }
  if (!settings) {
    if (companion) document.getElementById('bubble').prepend(panel)
    else document.getElementById('ct-status')?.before(panel)
  }
  function renderState() {
    panel.hidden = !enabled
    if (!settings && !companion) {
      button.title = enabled ? 'End call' : 'Call mode'
      button.setAttribute('aria-label', button.title)
      button.classList.toggle('danger', enabled)
      button.classList.toggle('secondary', !enabled)
      button.innerHTML = enabled
        ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 15v-4q9-8 18 0v4h-5v-4M8 11v4H3"/></svg>'
        : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 3h4l2 5-3 2q2 4 6 6l2-3 5 2v4q0 2-3 2C9 20 4 15 3 6q0-3 2-3Z"/></svg>'
    }
    const text = micMuted ? (ko ? '마이크 꺼짐' : 'Microphone muted') : retrying ? (ko ? '다시 보내는 중...' : 'Retrying...') : (speaking || (!active && remoteSpeaking)) ? (ko ? '말하는 중' : 'Speaking') : utterance.waiting ? (ko ? '듣는 중...' : 'Listening...') : (ko ? '듣는 중' : 'Listening')
    for (const [b, muted, name] of [[voiceButton, voiceMuted, (ko ? '세라 목소리' : 'Sera voice')], [micButton, micMuted, (ko ? '내 마이크' : 'My microphone')]]) {
      b.setAttribute('aria-pressed', String(muted))
      b.title = ko ? `${name} ${muted ? '켜기' : '끄기'}` : `${muted ? 'Unmute' : 'Mute'} ${name}`
      b.setAttribute('aria-label', b.title)
    }
    if (status.textContent !== text) status.textContent = text // Do not re-announce unchanged live text every tick.
  }
  const reply = core.createReplySpeech(text => { const clean = window.SeraTTSCore.cleanForSpeech(text); if (clean && !voiceMuted) { speechStopped = false; queue.enqueue(clean) } })
  function stopSpeech() { speechStopped = true; reply.abandon(); queue.stop(); speaking = false; lastEnd = 0 }
  const ttsRetry = core.createSegmentRetry({ onLimit: e => { presentError(e.message); window.SeraCall.stop() } })
  const queue = window.SeraTTSCore.createSpeechQueue({
    synth: async text => {
      const generation = session.generation
      const blob = await ttsRetry.run(async () => {
        const r = await fetch('/api/tts', { signal: AbortSignal.timeout(60000), method: 'POST', headers: { 'content-type': 'application/json', 'X-Onboard-Token': window.getOnboardToken() }, body: JSON.stringify({ text: window.SeraTTSCore.cleanForSpeech(text) }) })
        if (!r.ok) throw new Error(`TTS ${r.status}`)
        return r.blob()
      }, () => active && generation === session.generation && !speechStopped && !voiceMuted)
      if (!active || generation !== session.generation || speechStopped || voiceMuted) throw new Error('Call speech cancelled')
      return URL.createObjectURL(blob)
    },
    play: url => new Promise(resolve => {
      audio = new Audio(url); speaking = true; playbackStarted = Date.now()
      detachAudio = window.SeraCompanionAudioTap?.(audio)
      const clip = audio
      let done = false
      const finish = () => {
        if (done) return
        done = true; speaking = false; lastEnd = Date.now()
        clip.onended = clip.onerror = clip.onpause = clip.onstalled = clip.onplaying = clip.oncanplay = null
        clip.pause(); detachAudio?.(); detachAudio = null; URL.revokeObjectURL(url); audio = null; resolve()
      }
      clip.onended = finish; clip.onerror = finish
      clip.onpause = () => { if (clip._stalledAt == null) finish() }
      clip.onstalled = () => { if (clip._stalledAt == null) clip._stalledAt = Date.now() }
      clip.onplaying = () => {
        if (clip._stalledAt != null) playbackStarted += Date.now() - clip._stalledAt
        clip._stalledAt = null
      }
      clip.oncanplay = () => { if (clip._stalledAt != null) clip.play().catch(finish) }
      clip._done = finish; clip.play().catch(finish)
    }),
    onState: state => { if (state === 'playing') queueStarted = Date.now(); if (state === 'idle') queueStarted = 0 },
    stopPlayback: () => { speaking = false; if (audio) { const a = audio; a._done(); a.pause() } },
  })
  let posting = false, turnRevision = 0
  const utterance = core.createUtteranceAggregator({ send: text => {
    const generation = session.generation
    posting = true; turnRevision++; utterance.setBlocked(true)
    post('/api/chat/in', { text, origin: 'voice' }).catch(e => {
      if (active && generation === session.generation) presentError(e.message)
    }).finally(() => { if (generation === session.generation) posting = false })
    // A 202 acknowledges delivery, NOT agent completion. Only a fresh /out
    // state can release the single pending utterance below.
  } })
  const session = core.createSession({ send: text => utterance.final(text), closeMic: () => window.SeraSTT?.cancel(), clearQueue: stopSpeech })
  function off() { if (!active) return; active = false; posting = false; turnRevision++; utterance.reset(); session.stop(); cursor = null; reply.reset(); const mic = document.getElementById(companion ? 'b-mic' : 'ct-mic'); if (mic) mic.disabled = false }
  window.SeraCall = { get active() { return active }, get micMuted() { return micMuted }, get voiceMuted() { return voiceMuted }, get speaking() { return active && core.suppressMic(queue.running && !speechStopped, speaking, lastEnd, Date.now()) }, stop() { enabled = false; retrying = false; off(); voiceMuted = micMuted = false; renderState(); post('/api/call', { enabled: false }).then(() => channel.postMessage({ enabled: false })).catch(e => presentError(e.message)) }, stopSpeech, final: text => { if (!micMuted) session.final(text) }, partial: text => { if (active && !micMuted) { utterance.partial(text); session.partial(text, stopSpeech) } } }
  const button = document.createElement(settings ? 'input' : 'button')
  button.id = 'call-mode'; button.type = settings ? 'checkbox' : 'button'
  const label = ko ? '통화 모드' : 'Call mode'
  button.title = label; button.setAttribute('aria-label', label)
  const hint = document.createElement('p'); hint.className = 'agent-control-hint'
  hint.textContent = ko ? '읽어주기와 음성 입력을 먼저 켜 주세요' : 'Enable Read aloud and Voice input first.'
  if (settings) {
    // Settings chrome is English-only (house rule, Mino 2026-10-13 21:00); the companion group hosts the row.
    const lab = document.createElement('label'); lab.htmlFor = button.id; lab.textContent = 'Call mode'
    hint.textContent = 'Enable Read aloud and Voice input first.'; hint.className = 'field-hint'
    const slot = document.getElementById('set-companion-call')
    if (slot) { const row = document.createElement('div'); row.className = 'agent-control-row'; row.append(lab, button); slot.replaceChildren(row, hint) }
    else { const card = document.createElement('div'); card.className = 'category'; card.append(lab, button, hint); document.getElementById('set-about').before(card) }
  } else if (companion) { button.className = 'round'; button.textContent = '☎'; document.getElementById('b-mic').after(button) }
  else { button.className = 'qb secondary icon-button'; document.getElementById('ct-quickbar')?.appendChild(button) }
  async function sync() {
    if (syncing) return
    syncing = true
    try {
      const s = await window.api('/api/call')
      enabled = !!s.enabled; if (!enabled) voiceMuted = micMuted = false; renderState()
      button.disabled = !s.allowed; button.checked = s.enabled; button.setAttribute('aria-pressed', String(s.enabled)); hint.hidden = s.allowed
      let owns = !settings
      if (!companion && owns) { const c = await window.api('/api/companion'); owns = !(c.available && c.enabled) }
      if (!s.enabled || !owns) { off(); return }
      if (!active) {
        window.SeraTTS?.stop(); window.SeraCompanionSpeechStop?.(); window.SeraSTT?.cancel(); active = true; session.start(); utterance.setBlocked(true); ttsRetry.reset()
        opening = true
        try { if (!micMuted) await window.SeraSTT?.start() } finally { opening = false }
        if (!active || micMuted) window.SeraSTT?.cancel()
      }
      if (active && !micMuted && !opening && core.micHealth(active, window.SeraSTT?.mode) === 'failed') {
        const message = ko ? '마이크 연결이 끊겨 통화 모드를 껐어요. 마이크 권한을 확인하고 다시 켜 주세요' : 'Call mode stopped: microphone unavailable. Check microphone permissions and enable it again.'
        presentError(message)
        enabled = false; off(); renderState(); await post('/api/call', { enabled: false }); channel.postMessage({ enabled: false })
      }
      const mic = document.getElementById(companion ? 'b-mic' : 'ct-mic'); if (mic && active) mic.disabled = true
    } catch (e) { console.warn('[call settings]', e.message) } finally { syncing = false }
  }
  button[settings ? 'onchange' : 'onclick'] = async () => {
    const enabled = settings ? button.checked : button.getAttribute('aria-pressed') !== 'true'
    if (!enabled) { window.SeraCall.stop(); return }
    try { await post('/api/call', { enabled }); channel.postMessage({ enabled }); await sync() } catch (e) { presentError(e.message); await sync() }
  }
  channel.onmessage = e => {
    if (e.data.type === 'call-error') {
      if (!companion && !settings && typeof e.data.message === 'string') window.showToast?.(e.data.message)
      return
    }
    if (e.data.type === 'call-mutes') { if (enabled) applyMutes(e.data.voiceMuted === true, e.data.micMuted === true); return }
    if (!e.data.enabled) { enabled = false; off(); voiceMuted = micMuted = false; renderState() }
    sync()
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !enabled || settings || e.isComposing || e.defaultPrevented) return
    const overlay = '.qb-popover, [role="dialog"], dialog, [popover]'
    if (e.target?.closest?.(overlay) || document.activeElement?.closest?.(overlay)) return
    // In chat, Escape stops the running turn first via chat.js. Only idle Escape ends the call.
    const turnStop = document.getElementById('ct-stop')
    if (turnStop && !turnStop.hidden && turnStop.dataset.mode !== 'restart') return
    e.preventDefault(); e.stopImmediatePropagation(); window.SeraCall.stop()
  }, true)
  async function pollState() {
    if (!enabled) return
    try {
      const error = await window.api('/api/agent/turn-error')
      retrying = !!(error?.present && error.fresh && error.subtype === 'retrying')
      // Non-owning chat windows still display the companion's playback state.
      if (!companion && !active) remoteSpeaking = !!(await window.api('/api/companion')).speaking
      renderState()
    } catch { /* Keep the last state during a transient status-poll failure. */ }
  }
  // Changes to either prerequisite are propagated immediately from Settings.
  if (settings) document.addEventListener('change', e => {
    if (!['set-tts-enabled', 'set-stt-enabled'].includes(e.target.id)) return
    if (!e.target.checked) {
      post('/api/call', { enabled: false }).then(() => channel.postMessage({ enabled: false })).catch(() => {})
    }
    setTimeout(sync, 300)
  })
  async function poll() {
    if (!active || busy) return
    busy = true; const generation = session.generation, revision = turnRevision, canSettle = !posting
    try {
      const r = await window.api(`/api/chat/out?since=${cursor ?? 0}`)
      if (!active || generation !== session.generation) return
      // Ignore status snapshots requested before/during publication; otherwise
      // a delayed idle response can release another turn behind the new one.
      if (canSettle && !posting && revision === turnRevision && r.state && Object.hasOwn(r.state, 'awaitingReplySince')) {
        utterance.setBlocked(r.state.awaitingReplySince != null)
      }
      if (cursor === null) { cursor = r.latest; reply.prime(r.draft || ''); return }
      for (const m of r.items || []) {
        if (m.role === 'user' || (m.kind && m.kind !== 'message') || !m.text || /^\[system\]/i.test(m.text)) continue
        reply.update(m.text, true)
      }
      cursor = r.latest
      if (r.draft) {
        reply.update(r.draft, false)
        if (companion) document.getElementById('caption').textContent = r.draft
      }
    } catch (e) { console.warn('[call]', e.message) } finally { busy = false }
  }
  sync(); if (!settings) setInterval(pollState, 1000); setInterval(() => { renderState(); if (audio && core.playbackExpired(audio, playbackStarted, Date.now())) audio._done(); if (queue.running && queueStarted && Date.now() - Math.max(queueStarted, playbackStarted) > 120000) stopSpeech(); }, 250); setInterval(sync, 1000); if (!settings) setInterval(poll, 250)
  window.addEventListener('pagehide', off)
})()
