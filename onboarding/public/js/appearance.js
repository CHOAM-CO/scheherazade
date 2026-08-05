// appearance.js — Appearance tab controller (2026-08-05, Mino "어피어런스
// 탭 만들고 ... CSS들 게이지로 쭉 나열").
//
// Contract with the rest of the system:
//   - appearance-model.js is the ONLY mapping (this file never computes a
//     CSS value itself)
//   - the server injected <style id="appearance-style"> pre-paint; live
//     changes rewrite THAT element, so what you see is exactly what every
//     page will get on next load
//   - saves are debounced PUTs; the page never blocks a slider drag on I/O
;(function () {
  const C = window.COPY.appearance
  const M = window.AppearanceModel

  function $(id) { return document.getElementById(id) }

  let current = M.normalize(null)
  let saveTimer = null

  function styleEl() {
    let el = document.getElementById('appearance-style')
    if (!el) { // dev-serve fallback: page served without injection
      el = document.createElement('style')
      el.id = 'appearance-style'
      document.head.appendChild(el)
    }
    return el
  }

  function applyLive() {
    styleEl().textContent = M.cssText(current)
    renderReadouts()
  }

  function renderReadouts() {
    $('ap-glass-value').textContent = String(current.glass)
    $('ap-fontsize-value').textContent = `${current.fontSize}px`
    for (const btn of document.querySelectorAll('#ap-fontfamily-options button')) {
      btn.classList.toggle('active', btn.dataset.value === current.fontFamily)
    }
    for (const btn of document.querySelectorAll('#ap-accent-options button')) {
      btn.classList.toggle('active', btn.dataset.value === current.accent)
    }
    for (const btn of document.querySelectorAll('#ap-material-options button')) {
      btn.classList.toggle('active', btn.dataset.value === current.macMaterial)
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await window.api('/api/appearance', { method: 'PUT', body: JSON.stringify(current) })
        $('ap-status').textContent = C.saved
      } catch (err) {
        $('ap-status').textContent = `${C.saveFailed}: ${err.message}`
      }
    }, 400)
  }

  function update(patch) {
    current = M.normalize({ ...current, ...patch })
    applyLive()
    scheduleSave()
  }

  function renderStatic() {
    $('ap-title').textContent = C.title
    $('ap-subtitle').textContent = C.subtitle
    $('ap-glass-label').textContent = C.glassLabel
    $('ap-glass-note').textContent = C.glassNote
    $('ap-glass-range-label').textContent = C.glassRangeLabel
    $('ap-type-label').textContent = C.typeLabel
    $('ap-fontsize-label').textContent = C.fontSizeLabel
    $('ap-fontfamily-label').textContent = C.fontFamilyLabel
    $('ap-accent-label').textContent = C.accentLabel
    $('ap-accent-row-label').textContent = C.accentRowLabel
    $('ap-reset').textContent = C.reset

    const famBox = $('ap-fontfamily-options')
    for (const key of Object.keys(M.FONTS)) {
      const b = document.createElement('button')
      b.className = 'secondary ap-option'
      b.dataset.value = key
      b.textContent = C.fonts[key] || key
      b.style.fontFamily = M.FONTS[key]
      b.addEventListener('click', () => update({ fontFamily: key }))
      famBox.appendChild(b)
    }

    const accBox = $('ap-accent-options')
    for (const [key, val] of Object.entries(M.ACCENTS)) {
      const b = document.createElement('button')
      b.className = 'ap-swatch'
      b.dataset.value = key
      b.title = key
      b.style.background = val.accent
      b.setAttribute('aria-label', key)
      b.addEventListener('click', () => update({ accent: key }))
      accBox.appendChild(b)
    }

    // macOS only: the vibrancy material switcher. The CSS side of the page
    // can't preview this (it's the WINDOW backdrop) — the click PUTs and
    // the server live-applies win.setVibrancy, so the user sees the real
    // thing change behind the page.
    const meta = document.querySelector('meta[name="host-platform"]')
    if (meta && meta.content === 'darwin') {
      $('ap-material-row').classList.remove('hidden')
      $('ap-material-label').textContent = C.materialLabel
      const matBox = $('ap-material-options')
      for (const key of M.MAC_MATERIALS) {
        const b = document.createElement('button')
        b.className = 'secondary ap-option'
        b.dataset.value = key
        b.textContent = key
        b.addEventListener('click', () => update({ macMaterial: key }))
        matBox.appendChild(b)
      }
    }

    $('ap-glass-range').addEventListener('input', (e) => update({ glass: e.target.value }))
    $('ap-fontsize-range').addEventListener('input', (e) => update({ fontSize: e.target.value }))
    $('ap-reset').addEventListener('click', () => {
      current = M.normalize(M.DEFAULTS)
      $('ap-glass-range').value = current.glass
      $('ap-fontsize-range').value = current.fontSize
      applyLive()
      scheduleSave()
    })
  }

  async function init() {
    renderStatic()
    try {
      const data = await window.api('/api/appearance')
      current = M.normalize(data.values)
    } catch {
      // defaults already in place; page still works as a live preview
    }
    $('ap-glass-range').value = current.glass
    $('ap-fontsize-range').value = current.fontSize
    applyLive()
  }

  document.addEventListener('DOMContentLoaded', init)
})()
