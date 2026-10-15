;(async function () {
  const C = window.COPY.profiles
  const $ = name => document.getElementById(`profiles-${name}`)
  for (const el of document.querySelectorAll('[data-profile-copy]')) el.textContent = C[el.dataset.profileCopy]
  let state = null
  let busy = false
  const controls = []
  let focusAfter = null
  function validation() {
    const name = $('name').value
    if (!/^[a-z0-9-]{1,24}$/.test(name)) return C.invalid
    if (name === 'default') return C.reserved
    if (state?.profiles.some(profile => profile.name === name)) return C.duplicate
    return ''
  }
  function update() {
    const error = validation()
    $('validation').textContent = $('name').value ? error : ''
    $('name').setAttribute('aria-invalid', String(!!$('name').value && !!error))
    $('create').disabled = busy || !state || !!error
    $('name').disabled = busy
    $('copy-settings').disabled = busy
    $('shared-memory').disabled = busy || !state
    $('retry').disabled = busy
    for (const { button, blocked } of controls) button.disabled = busy || blocked
  }
  async function request(path, options) {
    const result = await window.api(path, options)
    if (!result.ok) throw new Error(result.error || C.failed)
    return result
  }
  function render() {
    $('shared-memory').checked = state.sharedMemoryRead !== false
    controls.length = 0
    $('list').replaceChildren()
    $('status').textContent = state.profiles.length ? '' : C.empty
    for (const [index, profile] of state.profiles.entries()) {
      const row = document.createElement('section')
      row.className = 'category'
      const heading = document.createElement('h3')
      heading.textContent = `${profile.displayName || C.default} (${profile.name || C.default})`
      row.appendChild(heading)
      const status = document.createElement('p')
      status.textContent = profile.running ? C.running : C.stopped
      row.appendChild(status)
      for (const badge of [profile.isDefault && C.default, profile.name === state.current && C.current].filter(Boolean)) {
        const label = document.createElement('span')
        label.className = 'chip'
        label.textContent = badge
        row.appendChild(label)
      }
      const reason = profile.isDefault ? C.defaultReason : profile.running ? C.closeFirst : ''
      if (reason) {
        const note = document.createElement('p')
        note.id = `profiles-reason-${index}`
        note.textContent = reason
        row.appendChild(note)
      }
      const actions = document.createElement('div')
      actions.className = 'button-row'
      for (const action of ['open', 'shortcut', 'delete']) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = action === 'delete' ? 'danger' : 'secondary'
        button.textContent = C[action]
        button.setAttribute('aria-label', `${heading.textContent} ${C[action]}`)
        const blocked = action === 'delete' && !!reason
        if (blocked) button.setAttribute('aria-describedby', `profiles-reason-${index}`)
        controls.push({ button, blocked })
        button.onclick = () => perform(async () => {
          if (blocked) return
          if (action === 'delete' && !await window.confirmDialog(C.confirm(profile.name), C.delete, C.cancel)) return
          // The empty default name is represented by the reserved default route name.
          const base = `/api/profiles/${encodeURIComponent(profile.name || 'default')}`
          const result = await request(action === 'delete' ? base : `${base}/${action}`, { method: action === 'delete' ? 'DELETE' : 'POST' })
          window.showToast(action === 'shortcut' ? C.shortcutDone(result.path) : action === 'delete' ? C.deleted : C.opened)
          await refresh()
          // Removed rows cannot retain focus after mutation.
          focusAfter = $('retry')
        })
        actions.appendChild(button)
      }
      row.appendChild(actions)
      $('list').appendChild(row)
    }
    update()
  }
  async function refresh() {
    state = await request('/api/profiles')
    render()
  }
  async function perform(task) {
    if (busy) return
    focusAfter = document.activeElement
    busy = true; update()
    try { await task() } catch (error) { window.showToast(C.error(error)) }
    finally { busy = false; update(); focusAfter?.focus(); focusAfter = null }
  }
  $('shared-memory').onchange = () => perform(async () => {
    await request('/api/profiles/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedMemoryRead: $('shared-memory').checked }) })
    await refresh()
  })
  $('name').oninput = update
  $('retry').onclick = () => perform(refresh)
  $('form').onsubmit = event => {
    event.preventDefault()
    if (!state || validation()) return
    return perform(async () => {
      const name = $('name').value
      await request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, copyFrom: $('copy-settings').checked }) })
      $('name').value = ''
      window.showToast(C.created)
      await refresh()
      focusAfter = $('name')
      await request(`/api/profiles/${encodeURIComponent(name)}/open`, { method: 'POST' })
      await refresh()
    })
  }
  $('status').textContent = C.loading
  update()
  state = await window.profilesReady
  if (state) render()
  else $('status').textContent = C.failed
  update()
})()
