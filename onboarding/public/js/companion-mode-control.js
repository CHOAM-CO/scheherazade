// Two presentations, one persisted mode and voice-status core.
;(function () {
  const slots = [...document.querySelectorAll('[data-companion-mode]')]
  if (!slots.length) return
  const modes = [
    ['off', 'Off', 'No companion or voice.'],
    ['voice', 'Voice', 'Chat read-aloud without a companion.'],
    ['companion', 'Companion', 'Silent companion.'],
    ['companion-voice', 'Companion + voice', 'Read replies aloud.'],
  ]
  let busy = false, mode = 'off', voice = null
  const callChannel = new BroadcastChannel('sera-call-settings')
  function node(tag, className, text) {
    const n = document.createElement(tag)
    if (className) n.className = className
    if (text) n.textContent = text
    return n
  }
  const views = slots.map((slot, i) => {
    const status = node('span', 'field-hint'); status.setAttribute('role', 'status')
    const prepare = node('button', 'secondary', 'Set up voice'); prepare.type = 'button'
    prepare.title = 'Download or initialize the local voice model'
    prepare.onclick = async () => {
      prepare.disabled = true
      try { await window.api('/api/tts/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refresh() }
      catch (e) { status.textContent = `Voice setup failed: ${e.message}` }
      finally { prepare.disabled = false }
    }
    let inputs, button, select
    if (slot.id === 'qb-companion') {
      button = node('button', 'qb secondary icon-button'); button.type = 'button'
      button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M8 10h.01M16 10h.01M8 14s4 3 8 0"/></svg>'
      const tooltip = node('span', 'qb-tooltip'); tooltip.setAttribute('role', 'tooltip'); button.append(tooltip)
      const panel = node('div'), list = node('div'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', 'Companion & voice')
      inputs = modes.map(([value, name, description]) => {
        const label = node('label'), input = node('input'); input.type = 'radio'; input.name = `companion-mode-${i}`; input.value = value
        input.onchange = () => change(input.value)
        label.append(input, node('span', '', `${name} — ${description}`)); list.append(label)
        return input
      })
      panel.append(list, node('p', 'field-hint', 'Microphone and Call remain opt-in.'), status, prepare)
      const popover = window.createQuickbarPopover(button)
      button.onclick = () => { if (popover.isOpen) popover.close(); else popover.open(panel, 'Companion & voice') }
      slot.replaceChildren(button)
    } else {
      const label = node('label', '', 'Companion & voice')
      select = node('select'); select.id = `companion-mode-${i}`; label.htmlFor = select.id
      for (const [value, name] of modes) { const option = node('option', '', name); option.value = value; select.append(option) }
      select.onchange = () => change(select.value); inputs = [select]
      slot.replaceChildren(label, select, status, prepare)
    }
    return { inputs, button, select, status, prepare }
  })
  function paint(unavailable = false) {
    for (const v of views) {
      v.inputs.forEach(input => { input.disabled = busy || unavailable; if (v.select) input.value = mode; else input.checked = input.value === mode })
      if (v.button) {
        const name = modes.find(m => m[0] === mode)?.[1] || 'Off'
        v.button.dataset.state = mode === 'off' ? 'off' : 'on'; v.button.title = name; v.button.setAttribute('aria-label', name)
        v.button.querySelector('.qb-tooltip').textContent = name
      }
      v.prepare.hidden = !['voice', 'companion-voice'].includes(mode) || !voice || (voice.modelsPresent && voice.engine !== 'error')
      v.status.textContent = !voice ? 'Voice status unavailable' : voice.download?.state === 'downloading' ? `Voice downloading ${voice.download.done} / ${voice.download.total} bytes` : voice.download?.state === 'error' ? `Voice download failed: ${voice.download.error}` : voice.engine === 'error' ? `Voice engine failed: ${voice.engineError}` : !voice.modelsPresent ? 'Voice model not installed' : `Voice ${voice.engine || 'ready'}`
    }
  }
  async function change(next) {
    if (busy) return
    busy = true; paint()
    try {
      await window.api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', mode: next }) })
      window.dispatchEvent(new Event('companion-mode-change'))
    } catch { window.showToast?.('Could not change companion and voice. Check Settings > Voice and Logs.') }
    finally { busy = false; await refresh() }
  }
  async function refresh() {
    if (busy) return
    try {
      const s = await window.api('/api/companion'); mode = s.mode
      try { voice = await window.api('/api/tts/status') } catch { voice = null }
      paint()
    } catch { paint(true) }
  }
  refresh(); setInterval(refresh, 5000)
  callChannel.onmessage = refresh
  window.addEventListener('focus', refresh)
  window.addEventListener('companion-mode-change', refresh)
})()
