// Shared quickbar dialog lifecycle, positioning and keyboard dismissal.
;(function () {
  let active
  window.createQuickbarPopover = function (button) {
    let panel
    button.setAttribute('aria-haspopup', 'dialog')
    button.setAttribute('aria-expanded', 'false')
    function close(restoreFocus = false) {
      if (!panel) return
      panel.remove(); panel = null
      button.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', keyboard)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      if (active === close) active = null
      if (restoreFocus) button.focus()
    }
    function position() {
      const rect = button.getBoundingClientRect()
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`
      panel.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - panel.offsetHeight - 8))}px`
    }
    function outside(e) { if (!panel.contains(e.target) && !button.contains(e.target)) close() }
    function keyboard(e) { if (e.key === 'Escape') close(true) }
    return {
      get isOpen() { return !!panel }, close,
      open(content, label) {
        active?.(); active = close
        panel = content; panel.classList.add('qb-popover'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', label)
        document.body.append(panel); position()
        button.setAttribute('aria-expanded', 'true')
        document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard)
        window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
        panel.querySelector('input:checked, input, button, select, a')?.focus()
      },
    }
  }
})()
