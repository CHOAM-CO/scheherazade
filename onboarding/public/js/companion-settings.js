// Enabled/variant save immediately; interval/sound remain a separate draft.
;(async function () {
  const $ = name => document.getElementById(`set-companion-${name}`)
  const radios = () => document.querySelectorAll('input[name="set-companion-variant"]')
  const post = body => window.api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', ...body }) })
  const ko = (document.documentElement?.lang || navigator.language || 'en').startsWith('ko')
  let server = null
  let busy = false
  $('status').setAttribute('role', 'status')
  function controls() {
    for (const el of [$('enabled'), ...radios(), $('save'), $('interval'), $('sound')]) el.disabled = busy || !server?.available
    $('interval').disabled ||= window.HOST_PLATFORM !== 'win32'
  }
  function renderImmediate() {
    // The runtime may force a call-only orb; settings always edit persisted preferences.
    const preferences = server?.preferences || server
    $('enabled').checked = !!preferences?.enabled
    for (const r of radios()) r.checked = r.value === (preferences?.variant || 'face')
  }
  async function save(body) {
    if (busy || !server?.available) return
    busy = true; controls()
    try {
      server = await post(body)
      renderImmediate() // Never replace the interval/sound draft on toggle saves.
      if ('intervalMinutes' in body) $('interval').value = server.intervalMinutes
      if ('sound' in body) $('sound').checked = !!server.sound
      $('status').textContent = ko ? '저장됨' : 'Saved.'
    } catch {
      renderImmediate()
      $('status').textContent = ko ? '저장 실패. 다시 시도해 주세요' : 'Could not save settings. Please try again.'
    } finally { busy = false; controls() }
  }
  controls()
  try {
    server = await window.api('/api/companion')
    renderImmediate()
    if (server.intervalMinutes) $('interval').value = server.intervalMinutes
    if (server.sound !== undefined) $('sound').checked = !!server.sound
    $('status').textContent = server.available ? '' : (ko ? '데스크톱 앱에서만 사용 가능' : 'Available in the desktop app only.')
  } catch { $('status').textContent = ko ? '설정 불러오기 실패' : 'Could not load settings.' }
  controls()
  $('enabled').onchange = () => save({ enabled: $('enabled').checked })
  for (const r of radios()) r.onchange = () => { if (r.checked) return save({ variant: r.value }) }
  $('save').onclick = () => {
    if (!$('interval').reportValidity()) return
    return save({ intervalMinutes: Number($('interval').value), sound: $('sound').checked })
  }
})()
