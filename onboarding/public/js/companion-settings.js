// Companion settings stay independent of the main window's layout and glass.
// Toggle (COMPANION_ENABLED) and variant (COMPANION_VARIANT) save on change,
// like the read-aloud and voice-input cards; interval/sound use the save button.
;(async function () {
  const $ = name => document.getElementById(`set-companion-${name}`)
  const radios = () => document.querySelectorAll('input[name="set-companion-variant"]')
  const post = body => window.api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', ...body }) })
  function render(s) {
    $('enabled').checked = !!s.enabled
    for (const r of radios()) r.checked = r.value === (s.variant || 'face')
    if (s.intervalMinutes) $('interval').value = s.intervalMinutes
    if (s.sound !== undefined) $('sound').checked = !!s.sound
    $('save').disabled = !s.available
    $('status').textContent = s.available ? '' : '앱에서만 사용할 수 있어요.'
  }
  async function save(body, okText = '저장했어요.') {
    try { render(await post(body)); $('status').textContent = okText }
    catch { $('status').textContent = '저장하지 못했어요. 다시 시도해 주세요.' }
  }
  try { render(await window.api('/api/companion')) }
  catch { $('status').textContent = '설정을 불러오지 못했어요.' }
  $('enabled').onchange = async () => { $('enabled').disabled = true; try { await save({ enabled: $('enabled').checked }) } finally { $('enabled').disabled = false } }
  for (const r of radios()) r.onchange = () => { if (r.checked) save({ variant: r.value }) }
  $('save').onclick = async () => {
    if (!$('interval').reportValidity()) return
    $('save').disabled = true
    try { await save({ intervalMinutes: Number($('interval').value), sound: $('sound').checked }) }
    finally { $('save').disabled = false }
  }
})()
