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
    $('status').textContent = s.available ? '' : 'Available in the desktop app only.'
  }
  async function save(body, okText = 'Saved.') {
    try { render(await post(body)); $('status').textContent = okText }
    catch { $('status').textContent = 'Could not save settings. Please try again.' }
  }
  try { render(await window.api('/api/companion')) }
  catch { $('status').textContent = 'Could not load settings.' }
  $('enabled').onchange = async () => { $('enabled').disabled = true; try { await save({ enabled: $('enabled').checked }) } finally { $('enabled').disabled = false } }
  for (const r of radios()) r.onchange = () => { if (r.checked) save({ variant: r.value }) }
  $('save').onclick = async () => {
    if (!$('interval').reportValidity()) return
    $('save').disabled = true
    try { await save({ intervalMinutes: Number($('interval').value), sound: $('sound').checked }) }
    finally { $('save').disabled = false }
  }
})()
