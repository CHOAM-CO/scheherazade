// Call owns audio only in the active voice surface; dictation stays manual off-call.
;(function () {
  const core = window.SeraCallCore, ko = document.documentElement.lang.startsWith('ko')
  const settings = !!document.getElementById('set-about'), companion = !!document.getElementById('b-mic')
  const channel = new BroadcastChannel('sera-call-settings')
  const post = (url, body) => window.api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let active = false, speaking = false, cursor = null, draft = '', spoken = 0, busy = false, audio = null
  const queue = window.SeraTTSCore.createSpeechQueue({
    synth: async text => {
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Onboard-Token': window.getOnboardToken() }, body: JSON.stringify({ text: window.SeraTTSCore.cleanForSpeech(text) }) })
      if (!r.ok) throw new Error(`TTS ${r.status}`)
      return URL.createObjectURL(await r.blob())
    },
    play: url => new Promise(resolve => {
      audio = new Audio(url); speaking = true
      let done = false
      const finish = () => { if (done) return; done = true; speaking = false; URL.revokeObjectURL(url); audio = null; resolve() }
      audio.onended = finish; audio.onerror = finish; audio._done = finish; audio.play().catch(finish)
    }),
    stopPlayback: () => { if (audio) { audio.pause(); audio._done() } },
  })
  const session = core.createSession({ send: text => { post('/api/chat/in', { text }).catch(e => window.showToast?.(e.message)) }, closeMic: () => window.SeraSTT?.cancel(), clearQueue: () => queue.stop() })
  function off() { if (!active) return; active = false; session.stop(); cursor = null; draft = ''; spoken = 0 }
  window.SeraCall = { get active() { return active }, get speaking() { return speaking }, stop: off, stopSpeech: () => queue.stop(), final: text => session.final(text), partial: text => session.partial(text, () => queue.stop()) }
  const button = document.createElement(settings ? 'input' : 'button')
  button.id = 'call-mode'; button.type = settings ? 'checkbox' : 'button'
  const label = ko ? '통화 모드' : 'Call mode'
  button.title = label; button.setAttribute('aria-label', label)
  const hint = document.createElement('p'); hint.className = 'agent-control-hint'
  hint.textContent = ko ? '읽어주기와 음성 입력을 먼저 켜 주세요' : 'Enable Read aloud and Voice input first.'
  if (settings) {
    const card = document.createElement('div'); card.className = 'category'
    const lab = document.createElement('label'); lab.htmlFor = button.id; lab.textContent = label
    card.append(lab, button, hint); const about = document.getElementById('set-about'); about.before(card)
  } else if (companion) { button.className = 'round'; button.textContent = '☎'; document.getElementById('b-mic').after(button) }
  async function sync() {
    try {
      const s = await window.api('/api/call')
      button.disabled = !s.allowed; button.checked = s.enabled; button.setAttribute('aria-pressed', String(s.enabled)); hint.hidden = s.allowed
      let owns = !settings
      if (!companion && owns) { const c = await window.api('/api/companion'); owns = !(c.available && c.enabled) }
      if (!s.enabled || !owns) { off(); return }
      if (!active) {
        window.SeraTTS?.stop(); window.SeraCompanionSpeechStop?.(); active = true; session.start()
        await window.SeraSTT?.start()
        if (!active) window.SeraSTT?.cancel()
      }
    } catch { off() }
  }
  button[settings ? 'onchange' : 'onclick'] = async () => {
    const enabled = settings ? button.checked : button.getAttribute('aria-pressed') !== 'true'
    if (!enabled) off()
    try { await post('/api/call', { enabled }); channel.postMessage({ enabled }); await sync() } catch (e) { window.showToast?.(e.message); await sync() }
  }
  channel.onmessage = e => { if (!e.data.enabled) off(); sync() }
  // Changes to either prerequisite are propagated immediately from Settings.
  if (settings) document.addEventListener('change', e => {
    if (['set-tts-enabled', 'set-stt-enabled'].includes(e.target.id) && !e.target.checked) {
      post('/api/call', { enabled: false }).then(() => channel.postMessage({ enabled: false })).catch(() => {})
    }
    setTimeout(sync, 300)
  })
  function speak(text, flush) {
    // Drafts are cumulative. Only consume complete sentences once.
    if (!text.startsWith(draft.slice(0, spoken))) { spoken = 0 }
    draft = text
    const part = core.split(text.slice(spoken), flush)
    for (const sentence of part.sentences) queue.enqueue(sentence)
    spoken = text.length - part.rest.length
  }
  async function poll() {
    if (!active || busy) return
    busy = true; const generation = session.generation
    try {
      const r = await window.api(`/api/chat/out?since=${cursor ?? 0}`)
      if (!active || generation !== session.generation) return
      if (cursor === null) { cursor = r.latest; return }
      for (const m of r.items || []) {
        if (m.role === 'user' || (m.kind && m.kind !== 'message') || !m.text || /^\[system\]/i.test(m.text)) continue
        speak(m.text, true); draft = ''; spoken = 0
      }
      cursor = r.latest
      if (r.draft) {
        speak(r.draft, false)
        if (companion) document.getElementById('caption').textContent = r.draft
      }
    } catch (e) { console.warn('[call]', e.message) } finally { busy = false }
  }
  sync(); setInterval(sync, 1000); if (!settings) setInterval(poll, 250)
  window.addEventListener('pagehide', off)
})()
