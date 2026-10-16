// One lossless mode surface in chat and the Companion settings card.
;(function () {
  const slots = [...document.querySelectorAll('[data-companion-mode]')]
  if (!slots.length) return
  let busy = false
  const callChannel = new BroadcastChannel('sera-call-settings')
  const controls = slots.map((slot, i) => {
    const label = document.createElement('label')
    label.textContent = 'Companion & voice'
    const select = document.createElement('select')
    select.id = `companion-mode-${i}`; label.htmlFor = select.id
    select.title = 'Off: no companion or voice. Voice: chat read-aloud without a companion. Companion: silent. Companion + voice: read replies aloud. Microphone and Call remain opt-in.'
    select.setAttribute('aria-label', 'Companion & voice')
    for (const [value, text] of [['off', 'Off'], ['voice', 'Voice'], ['companion', 'Companion'], ['companion-voice', 'Companion + voice']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option)
    }
    const status = document.createElement('span'); status.setAttribute('role', 'status'); status.className = 'field-hint'
    const prepare = document.createElement('button'); prepare.type = 'button'; prepare.className = 'secondary'; prepare.textContent = 'Set up voice'
    prepare.title = 'Download or initialize the local voice model'
    prepare.onclick = async () => {
      prepare.disabled = true
      try { await window.api('/api/tts/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refreshVoice() }
      catch (e) { status.textContent = `Voice setup failed: ${e.message}` }
      finally { prepare.disabled = false }
    }
    async function refreshVoice() {
      try {
        const s = await window.api('/api/tts/status')
        prepare.hidden = !['voice', 'companion-voice'].includes(select.value) || (s.modelsPresent && s.engine !== 'error')
        status.textContent = s.download?.state === 'downloading' ? `Voice downloading ${s.download.done} / ${s.download.total} bytes` : s.download?.state === 'error' ? `Voice download failed: ${s.download.error}` : s.engine === 'error' ? `Voice engine failed: ${s.engineError}` : !s.modelsPresent ? 'Voice model not installed' : `Voice ${s.engine || 'ready'}`
      } catch { status.textContent = 'Voice status unavailable' }
    }
    select.refreshVoice = refreshVoice
    slot.replaceChildren(label, select, status, prepare)
    select.onchange = async () => {
      if (busy) return
      busy = true; controls.forEach(c => { c.disabled = true })
      try {
        await window.api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', mode: select.value }) })
        window.dispatchEvent(new Event('companion-mode-change'))
      } catch { window.showToast?.('Could not change companion and voice. Check Settings > Voice and Logs.') }
      finally { busy = false; await refresh() }
    }
    return select
  })
  async function refresh() {
    if (busy) return
    try {
      const s = await window.api('/api/companion')
      controls.forEach(c => { c.value = s.mode; c.dataset.state = s.mode; c.disabled = false })
      await Promise.all(controls.map(c => c.refreshVoice()))
    } catch { controls.forEach(c => { c.disabled = true }) }
  }
  refresh(); setInterval(refresh, 5000)
  callChannel.onmessage = refresh
  window.addEventListener('focus', refresh)
  window.addEventListener('companion-mode-change', refresh)
})()
