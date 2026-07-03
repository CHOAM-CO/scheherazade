// settings.js — minimal v1 settings page: rename agent + Slack placeholder.
;(function () {
  const C = window.COPY.settings
  const GEN = window.COPY.genericError

  function $(id) { return document.getElementById(id) }

  async function api(path, options) {
    const res = await fetch(path, options)
    let body = {}
    try {
      body = await res.json()
    } catch (err) {
      throw new Error(`non-JSON response from ${path}: ${err.message}`)
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status} from ${path}`)
    return body
  }

  function showToast(text) {
    const el = $('set-toast')
    el.textContent = text
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
  }

  async function init() {
    $('set-title').textContent = C.title
    $('set-back-link').textContent = C.backToMemory
    $('set-rename-label').textContent = C.renameLabel
    $('set-rename-save').textContent = C.renameButton
    $('set-slack-label').textContent = C.slackLabel
    $('set-slack-note').textContent = C.slackNote

    try {
      const cfg = await api('/api/config')
      $('set-rename-input').value = cfg.DISPLAY_NAME || ''
    } catch (err) {
      console.error(err)
    }

    $('set-rename-save').onclick = async () => {
      const name = $('set-rename-input').value.trim()
      const statusEl = $('set-rename-status')
      if (!name) return
      try {
        await api('/api/settings/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: name }),
        })
        showToast(C.renameSaved)
        statusEl.classList.add('hidden')
      } catch (err) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = GEN(err.message)
      }
    }
  }

  init()
})()
