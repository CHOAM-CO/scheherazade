// tts.js -- read-aloud (읽어주기). Settings: one toggle + voice picker + download
// progress. Chat: when enabled, each NEW completed agent reply is cleaned
// (tts-core.cjs), synthesized locally (POST /api/tts -> audio/wav) and queued
// so replies never overlap; a stop button sits in the chat while speaking.
;(function () {
  const ko = (document.documentElement?.lang || navigator.language || 'en').startsWith('ko')
  const T = ko
    ? { label: '읽어주기', note: '답장을 이 기기에서 바로 음성으로 읽어줍니다 (오프라인). 처음 켤 때 음성 모델을 한 번 받습니다', toggle: '답장 소리 내어 읽기', voice: '목소리', voiceDefault: '기본 목소리', add: 'wav로 목소리 추가', adding: '목소리 만드는 중', addName: '목소리 이름', added: n => `목소리 추가됨: ${n}`, remove: '삭제', needModel: '먼저 읽어주기를 켜서 음성 모델을 받아야 합니다', dl: (d, t) => `음성 모델 받는 중 ${mb(d)} / ${mb(t)} MB`, ready: '준비됨', loading: '음성 엔진 불러오는 중', missing: t => `켜면 음성 모델 ${mb(t)} MB를 받음`, err: e => `오류: ${e}`, stop: '읽기 멈춤' }
    : { label: 'Read aloud', note: 'Replies are spoken on this device (offline). The first enable downloads the voice model once. To add a voice, choose a clear WAV recording with one speaker.', toggle: 'Speak replies', voice: 'Voice', voiceDefault: 'Default voice', add: 'Add a voice from a wav', adding: 'Creating voice', addName: 'Voice name', added: n => `Voice added: ${n}`, remove: 'Delete', needModel: 'Turn read-aloud on first so the voice model is downloaded', dl: (d, t) => `Downloading voice model ${mb(d)} / ${mb(t)} MB`, ready: 'Ready', loading: 'Loading voice engine', missing: t => `Enabling downloads ${mb(t)} MB`, err: () => 'Voice settings could not be applied. Try again or check Logs.', stop: 'Stop voice' }
  function mb(n) { return Math.round((n || 0) / 1048576) }
  const token = () => window.getOnboardToken?.() || ''
  const getStatus = () => window.api('/api/tts/status')
  const postSettings = body => window.api('/api/tts/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  // ── settings card ───────────────────────────────────────────────────────
  function mountSettings() {
    const about = document.getElementById('set-about')
    if (!about) return
    const card = document.createElement('div')
    card.className = 'category'
    card.id = 'set-tts'
    const label = document.createElement('div'); label.className = 'category-label'; label.textContent = T.label
    const note = document.createElement('p'); note.className = 'subtitle'; note.textContent = T.note
    const row = document.createElement('div'); row.className = 'agent-control-row'
    const lab = document.createElement('label'); lab.htmlFor = 'set-tts-enabled'; lab.textContent = T.toggle
    const box = document.createElement('input'); box.type = 'checkbox'; box.id = 'set-tts-enabled'
    row.append(lab, box)
    const row2 = document.createElement('div'); row2.className = 'agent-control-row'
    const lab2 = document.createElement('label'); lab2.htmlFor = 'set-tts-voice'; lab2.textContent = T.voice
    const sel = document.createElement('select'); sel.id = 'set-tts-voice'
    const del = document.createElement('button'); del.type = 'button'; del.className = 'secondary'; del.textContent = T.remove
    row2.append(lab2, sel, del)
    const row3 = document.createElement('div'); row3.className = 'agent-control-row'
    const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'secondary'; addBtn.id = 'set-tts-add'; addBtn.textContent = T.add
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.wav,audio/wav,audio/x-wav'; file.hidden = true
    const nameIn = document.createElement('input'); nameIn.type = 'text'; nameIn.id = 'set-tts-voice-name'; nameIn.placeholder = T.addName; nameIn.maxLength = 40
    const nameLabel = document.createElement('label'); nameLabel.htmlFor = nameIn.id; nameLabel.textContent = T.addName
    file.setAttribute('aria-label', T.add)
    row3.append(nameLabel, nameIn, addBtn, file)
    const state = document.createElement('div'); state.className = 'agent-control-hint'; state.id = 'set-tts-state'
    const credit = document.createElement('div'); credit.className = 'agent-control-hint'; credit.id = 'set-tts-credit'
    card.append(label, note, row, row2, row3, state, credit)
    const group = document.getElementById('set-companion-voice')
    if (group) group.append(card)
    else about.parentNode.insertBefore(card, about)
    let timer = null
    let last = null
    let revision = 0
    let saving = false
    state.setAttribute('role', 'status')
    box.disabled = sel.disabled = true
    function paint(s) {
      last = s
      box.checked = s.enabled
      sel.textContent = ''
      for (const v of s.voices) { const o = document.createElement('option'); o.value = v.id; o.textContent = v.builtin ? 'Sera' : v.name; sel.appendChild(o) }
      sel.value = s.voice
      del.hidden = !!(s.voices.find(v => v.id === s.voice) || {}).builtin
      credit.textContent = s.credit || ''
      const d = s.download
      if (d.state === 'downloading') state.textContent = `${T.dl(d.done, d.total)}${d.total > 0 ? ` · ${Math.min(100, Math.round(d.done / d.total * 100))}%` : ''}`
      else if (d.state === 'error') state.textContent = T.err(d.error)
      else if (!s.modelsPresent) state.textContent = `${ko ? '미설치' : 'Not installed'} · ${T.missing(s.totalBytes)}`
      else if (s.engine === 'loading') state.textContent = T.loading
      else if (s.engine === 'error') state.textContent = T.err(s.engineError)
      else state.textContent = T.ready
      clearTimeout(timer)
      if (d.state === 'downloading' || s.engine === 'loading') timer = setTimeout(refresh, 1000)
    }
    async function refresh() {
      const requestRevision = revision
      try {
        const s = await getStatus()
        if (requestRevision !== revision || saving) return
        paint(s); box.disabled = sel.disabled = false
      } catch (e) { if (requestRevision === revision) state.textContent = T.err(e.message) }
    }
    async function saveSettings(body) {
      if (saving || !last) return
      const previous = last
      saving = true; revision++; clearTimeout(timer)
      box.disabled = sel.disabled = del.disabled = addBtn.disabled = true
      try { paint(await postSettings(body)) }
      catch (e) {
        paint(previous)
        clearTimeout(timer) // Keep the error visible until the user retries.
        state.textContent = T.err(e.message)
      } finally {
        saving = false
        box.disabled = sel.disabled = del.disabled = addBtn.disabled = false
      }
    }
    box.onchange = () => saveSettings({ enabled: box.checked })
    sel.onchange = () => saveSettings({ voice: sel.value })
    del.onclick = async () => {
      if (last && (last.voices.find(v => v.id === sel.value) || {}).builtin) return
      try { paint(await window.api('/api/tts/voices/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sel.value }) })) } catch (e) { state.textContent = T.err(e.message) }
    }
    addBtn.onclick = () => {
      if (last && !last.modelsPresent) { state.textContent = T.needModel; return }
      file.value = ''; file.click()
    }
    file.onchange = async () => {
      const f = file.files && file.files[0]
      if (!f) return
      // Electron has no window.prompt: the name comes from the text field, else the file name.
      const name = nameIn.value.trim() || f.name.replace(/\.wav$/i, '')
      addBtn.disabled = true; state.textContent = T.adding
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        const r = await window.api('/api/tts/voices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, wavBase64: btoa(bin) }) })
        paint(r); nameIn.value = ''; state.textContent = T.added(r.added.name)
      } catch (e) { state.textContent = T.err(e.message) } finally { addBtn.disabled = false }
    }
    refresh()
  }

  // ── chat auto-play ──────────────────────────────────────────────────────
  let enabled = false
  let audio = null
  let stopBtn = null
  let queue = null
  function ensureQueue() {
    if (queue) return queue
    const core = window.SeraTTSCore
    queue = core.createSpeechQueue({
      synth: async text => {
        const res = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Onboard-Token': token() }, body: JSON.stringify({ text }) })
        if (!res.ok) throw new Error(`tts HTTP ${res.status}`)
        return URL.createObjectURL(await res.blob())
      },
      play: url => new Promise(resolve => {
        audio = new Audio(url)
        const done = () => { URL.revokeObjectURL(url); audio = null; resolve() }
        audio.onended = done; audio._done = done
        const failed = () => { window.showToast?.('Could not play voice. Try reading the reply again.'); done() }
        audio.onerror = failed
        audio.play().catch(failed)
      }),
      stopPlayback: () => { if (audio) { audio.pause(); audio._done?.() } },
      onState: (s, e) => { if (e) { console.warn('[tts]', e); window.showToast?.('Could not play voice. Try reading the reply again.') } if (stopBtn) stopBtn.hidden = s === 'idle' },
    })
    return queue
  }
  function mountStop() {
    const bar = document.querySelector('.chat-composer-bar')
    if (!bar || stopBtn) return
    stopBtn = document.createElement('button')
    stopBtn.className = 'secondary tts-stop'
    stopBtn.textContent = T.stop
    stopBtn.hidden = true
    stopBtn.type = 'button'
    stopBtn.title = window.COPY.tts[ko ? 'stopTitleKo' : 'stopTitle']
    stopBtn.onclick = () => queue?.stop()
    bar.insertBefore(stopBtn, document.getElementById('ct-stop') || document.getElementById('ct-send'))
  }
  // Audio-once rule (design-0027): while the desktop companion is on, it plays
  // read-aloud itself (one renderer, one AudioContext), so the chat stays silent.
  let companionSpeaks = false
  async function syncEnabled() {
    try { const s = await getStatus(); enabled = s.enabled && s.modelsPresent } catch {}
    try { const c = await window.api('/api/companion'); companionSpeaks = !!(c.available && c.enabled) } catch { companionSpeaks = false }
  }

  window.SeraTTS = {
    // chat.js calls this only for NEW agent replies (not the seeded history).
    onReply(text) {
      if (window.SeraCall?.active || !enabled || companionSpeaks || !window.SeraTTSCore) return
      const clean = window.SeraTTSCore.cleanForSpeech(text)
      if (clean) ensureQueue().enqueue(clean)
    },
    stop() { queue?.stop() },
  }

  if (document.getElementById('set-about')) mountSettings()
  else { mountStop(); syncEnabled(); setInterval(syncEnabled, 15000); document.addEventListener('visibilitychange', () => { if (!document.hidden) syncEnabled() }) }
})()
