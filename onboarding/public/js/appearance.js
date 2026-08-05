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
    for (const btn of document.querySelectorAll('#ap-bg-options button')) {
      btn.classList.toggle('active', btn.dataset.value === current.bg)
    }
    for (const btn of document.querySelectorAll('#ap-fg-options button')) {
      btn.classList.toggle('active', btn.dataset.value === current.fg)
    }
    for (const btn of document.querySelectorAll('#ap-blur-options button')) {
      btn.classList.toggle('active', btn.dataset.value === current.blur)
    }
    $('ap-accent-picker').value = current.accent
    $('ap-bg-picker').value = current.bg
    $('ap-fg-picker').value = current.fg
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
    $('ap-bg-row-label').textContent = C.bgRowLabel
    $('ap-fg-row-label').textContent = C.fgRowLabel
    $('ap-blur-label').textContent = C.blurLabel
    $('ap-reset').textContent = C.reset

    // Blur 3단 (v3): the ONLY exposed granularity — macOS gives blur per
    // material, not per radius, so a continuous slider would lie.
    const blurBox = $('ap-blur-options')
    for (const key of M.BLUR_LEVELS) {
      const b = document.createElement('button')
      b.className = 'secondary ap-option'
      b.dataset.value = key
      b.textContent = C.blurLevels[key] || key
      b.addEventListener('click', () => update({ blur: key }))
      blurBox.appendChild(b)
    }

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

    // v2: swatches are plain hex quick-picks; the picker beside them writes
    // the SAME field, so a swatch click and a picker drag are one path.
    const swatchRow = (boxId, presets, field) => {
      const box = $(boxId)
      for (const hex of presets) {
        const b = document.createElement('button')
        b.className = 'ap-swatch'
        b.dataset.value = hex
        b.title = hex
        b.style.background = hex
        b.setAttribute('aria-label', hex)
        b.addEventListener('click', () => update({ [field]: hex }))
        box.appendChild(b)
      }
    }
    swatchRow('ap-accent-options', M.PRESET_ACCENTS, 'accent')
    swatchRow('ap-bg-options', M.PRESET_BGS, 'bg')
    swatchRow('ap-fg-options', M.PRESET_FGS, 'fg')
    // 'input' fires continuously while the native picker drags — the page
    // repaints live (Mino: "실시간으로 변하는거 볼 수 있게"); the save stays
    // debounced so drags don't hammer the PUT endpoint.
    $('ap-accent-picker').addEventListener('input', (e) => update({ accent: e.target.value }))
    $('ap-bg-picker').addEventListener('input', (e) => update({ bg: e.target.value }))
    $('ap-fg-picker').addEventListener('input', (e) => update({ fg: e.target.value }))

    // v3: the raw 7-material switcher is gone — Blur (above) is the whole
    // macOS/Windows backdrop surface now. The CSS side of the page can't
    // preview the backdrop change; the PUT live-applies setVibrancy /
    // setBackgroundMaterial so the user sees the real window change.

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
