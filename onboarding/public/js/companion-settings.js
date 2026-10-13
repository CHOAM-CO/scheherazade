// Companion settings stay independent of the main window's layout and glass.
;(async function () {
  const $ = name => document.getElementById(`set-companion-${name}`)
  function render(s) {
    $('enabled').checked = !!s.enabled
    $('interval').value = s.intervalMinutes || 45
    $('sound').checked = !!s.sound
    $('save').disabled = !s.available
    if (!s.available) $('status').textContent = '앱에서만 사용할 수 있어요.'
  }
  try { render(await window.api('/api/companion')) }
  catch { $('status').textContent = '설정을 불러오지 못했어요.' }
  $('save').onclick = async () => {
    if (!$('interval').reportValidity()) return
    $('save').disabled = true
    try {
      render(await window.api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settings', enabled: $('enabled').checked, intervalMinutes: Number($('interval').value), sound: $('sound').checked }) }))
      $('status').textContent = '저장했어요.'
    } catch { $('status').textContent = '저장하지 못했어요. 다시 시도해 주세요.' }
    finally { $('save').disabled = false }
  }
})()
