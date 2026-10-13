// A plain same-origin renderer: no preload, IPC, Node, or executable agent HTML.
;(function () {
  const $ = id => document.getElementById(id)
  let shapeHeight = -1
  let current = null, lastId = null, pointerInside = false, pointerQueue = Promise.resolve()
  let drag = null, dragged = false, sending = false, avatarUrl = null, avatarAt = 0
  async function api(route, body) {
    const r = await fetch(route, { headers: { 'X-Onboard-Token': window.getOnboardToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(6000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }
  const command = (action, args = {}) => api('/api/companion', { action, ...args })
  function showFailure() { $('failure').hidden = false; $('failure').textContent = '보내지 못했어요. 연결을 확인하고 다시 보내 주세요.' }
  async function action(name, args) { try { render(await command(name, args)) } catch { showFailure() } }
  function render(state) {
    current = state
    if (state.geometry) {
      $('face').style.left = `${state.geometry.face.x}px`; $('face').style.top = `${state.geometry.face.y}px`
      document.body.dataset.placement = state.geometry.placement
    }
    $('face').dataset.ring = state.ring
    $('face').setAttribute('aria-label', state.ring === 'attention' ? '세라 · 확인할 이야기가 있어요' : '세라와 이야기하기')
    $('bubble').hidden = !state.bubble
    $('connection').textContent = state.connected ? '' : '채팅 연결 확인 중'
    if (!state.bubble) { lastId = null; shapeHeight = -1; return }
    const b = state.bubble
    if (b.id !== lastId) {
      $('message').textContent = b.text
      $('failure').hidden = true
      lastId = b.id
    }
    $('approval').hidden = $('approval-note').hidden = b.kind !== 'approval-reply'
    $('reply-form').hidden = b.kind === 'error'
    const height = Math.ceil($('bubble').getBoundingClientRect().height)
    if (height !== shapeHeight) { shapeHeight = height; command('shape', { height }).catch(() => { shapeHeight = -1 }) }
  }
  function pointer(inside) {
    if (pointerInside === inside) return
    pointerInside = inside
    pointerQueue = pointerQueue.then(() => command('pointer', { inside })).catch(() => { pointerInside = !inside })
  }
  document.addEventListener('mousemove', e => pointer(!!e.target.closest('.surface')))
  document.addEventListener('mouseleave', () => { if (!drag) pointer(false) })
  for (const el of document.querySelectorAll('.surface')) {
    el.addEventListener('mouseenter', () => pointer(true))
    el.addEventListener('mouseleave', () => { if (!drag) pointer(false) })
  }
  $('bubble').addEventListener('pointerdown', () => command('touch').catch(() => {}))
  $('bubble').addEventListener('input', () => command('touch').catch(() => {}))
  $('close').onclick = () => action('dismiss')
  document.addEventListener('keydown', e => { if (e.key === 'Escape') action('dismiss') })
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.surface')) action('dismiss') })
  $('main').onclick = () => action('main')
  $('face').addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    drag = { x: e.screenX, y: e.screenY }; dragged = false
    $('face').setPointerCapture(e.pointerId)
  })
  $('face').addEventListener('pointermove', e => {
    if (!drag || dragged || Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 4) return
    dragged = true
    pointerQueue = pointerQueue.then(() => command('drag-start')).catch(showFailure)
  })
  async function endDrag(e) {
    if (!drag) return
    drag = null
    if ($('face').hasPointerCapture(e.pointerId)) $('face').releasePointerCapture(e.pointerId)
    if (dragged) { await pointerQueue; await action('drag-end') }
    else await action('open')
  }
  $('face').addEventListener('pointerup', endDrag)
  $('face').addEventListener('pointercancel', endDrag)
  $('face').addEventListener('click', e => { if (e.detail === 0) action('open') })
  async function send(text) {
    if (sending || !text.trim()) return
    sending = true
    for (const id of ['send', 'allow', 'deny']) $(id).disabled = true
    try { render(await command('reply', { text })); $('reply').value = '' }
    catch { showFailure() }
    finally { sending = false; for (const id of ['send', 'allow', 'deny']) $(id).disabled = false }
  }
  $('reply-form').onsubmit = e => { e.preventDefault(); send($('reply').value) }
  $('allow').onclick = () => send(`이 질문에 대한 답: “${current.bubble.text.slice(0,2000)}”\n허용할게요.`)
  $('deny').onclick = () => send(`이 질문에 대한 답: “${current.bubble.text.slice(0,2000)}”\n하지 말아 주세요.`)
  async function refreshAvatar() {
    if (Date.now() - avatarAt < 30000) return
    avatarAt = Date.now()
    try {
      const r = await fetch('/api/settings/avatar', { headers: { 'X-Onboard-Token': window.getOnboardToken() }, cache: 'no-cache' })
      if (!r.ok) return
      const next = URL.createObjectURL(await r.blob())
      $('avatar').src = next
      if (avatarUrl) URL.revokeObjectURL(avatarUrl)
      avatarUrl = next
    } catch { /* Keep the last face or the shipped fallback. */ }
  }
  async function poll() {
    try { render(await api('/api/companion')); await refreshAvatar() }
    catch { $('connection').textContent = '연결을 확인해 주세요' }
    setTimeout(poll, 250)
  }
  poll()
})()
