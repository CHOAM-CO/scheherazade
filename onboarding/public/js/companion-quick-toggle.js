// UI only: preserve independent voice/mic consent and existing default-off keys.
;(function () {
  const button = document.getElementById('qb-companion')
  if (!button) return
  const ko = document.documentElement.lang.startsWith('ko')
  let enabled = false, busy = false
  function paint(s) {
    enabled = !!s.enabled
    button.disabled = !s.available
    button.setAttribute('aria-pressed', String(enabled))
    button.dataset.state = enabled ? 'on' : 'off'
    const label = !s.available ? (ko ? '컴패니언 · 앱에서 사용' : 'Companion · desktop app only') :
      (ko ? `컴패니언 ${enabled ? '끄기' : '켜기'}` : `Turn companion ${enabled ? 'off' : 'on'}`)
    button.title = label; button.setAttribute('aria-label', label)
    button.querySelector('.qb-tooltip').textContent = label
  }
  async function refresh() {
    if (busy) return
    try { paint(await window.api('/api/companion')) }
    catch { button.disabled = true; button.title = ko ? '컴패니언 연결 확인 필요' : 'Companion unavailable' }
  }
  button.onclick = async () => {
    if (busy) return
    busy = true; button.disabled = true
    try {
      paint(await window.api('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', enabled: !enabled }) }))
    } catch { window.showToast?.(ko ? '컴패니언을 바꾸지 못했어요. 다시 시도해 주세요.' : 'Could not change companion. Please try again.') }
    finally { busy = false; await refresh() }
  }
  refresh()
  setInterval(refresh, 15000)
  window.addEventListener('focus', refresh)
})()
