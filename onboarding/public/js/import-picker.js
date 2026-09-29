// import-picker.js -- the shared copy-into-store picker (design-0022 §4).
// One implementation for the onboarding wizard (step 1b) and Settings >
// Import, so both paths list the same plan, offer the same per-file
// checkboxes and POST the same /api/migrate/import. The server re-plans and
// copies only allowlisted paths, so what is sent from here is a choice, never
// an authority. Sources are never read in place by the app after this.
;(function () {
  'use strict'
  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }


  // opts: { tools, T (copy.js step1b strings), api, GEN (error text fn),
  //   list, copyBtn, statusEl, skipBtn?, onCopied?(result), onSkip?() }
  function render(opts) {
    const { tools, T, api, list, copyBtn, statusEl, skipBtn } = opts
    statusEl.className = 'status-line'
    statusEl.textContent = ''
    list.innerHTML = ''
    const checks = [] // { tool, path, size, cb }
    function refresh() {
      const n = checks.filter((c) => c.cb.checked).length
      copyBtn.textContent = T.copy(n)
      copyBtn.disabled = n === 0
      for (const t of tools) {
        const mine = checks.filter((c) => c.tool === t.id)
        const on = mine.filter((c) => c.cb.checked)
        t._meta.textContent = T.toolLine(on.length, mine.length, fmtSize(on.reduce((a, c) => a + c.size, 0)))
        t._head.checked = on.length > 0
        t._head.indeterminate = on.length > 0 && on.length < mine.length
      }
    }

    for (const t of tools) {
      const card = document.createElement('div')
      card.className = 'import-tool'
      const head = document.createElement('label')
      head.className = 'import-tool-head'
      const headCb = document.createElement('input')
      headCb.type = 'checkbox'
      head.appendChild(headCb)
      head.appendChild(document.createTextNode(t.label))
      const root = document.createElement('span')
      root.className = 'import-tool-root'
      root.textContent = t.root
      head.appendChild(root)
      card.appendChild(head)
      const meta = document.createElement('div')
      meta.className = 'import-tool-meta'
      card.appendChild(meta)

      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = T.showFiles(t.items.length)
      details.appendChild(summary)
      const fileList = document.createElement('div')
      fileList.className = 'import-file-list'
      for (const it of t.items) {
        const row = document.createElement('label')
        row.className = 'import-file-row'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = !!it.defaultOn
        cb.onchange = refresh
        row.appendChild(cb)
        const p = document.createElement('span')
        p.className = 'import-file-path'
        p.textContent = it.path
        row.appendChild(p)
        const kind = document.createElement('span')
        kind.className = 'import-file-kind'
        kind.textContent = T.kinds[it.kind] || it.kind
        row.appendChild(kind)
        const size = document.createElement('span')
        size.className = 'import-file-size'
        size.textContent = fmtSize(it.size)
        row.appendChild(size)
        fileList.appendChild(row)
        checks.push({ tool: t.id, path: it.path, size: it.size, cb })
      }
      details.appendChild(fileList)
      card.appendChild(details)

      if (t.items.some((it) => it.kind === 'transcript')) {
        const note = document.createElement('div')
        note.className = 'import-tool-meta'
        note.textContent = T.transcriptNote
        card.appendChild(note)
      }
      if (t.leftInPlace && t.leftInPlace.length) {
        const left = document.createElement('div')
        left.className = 'import-tool-meta'
        left.textContent = T.leftInPlace(t.leftInPlace.map((l) => l.name))
        card.appendChild(left)
      }

      // Tool-level box: all on if anything is off, else all off.
      headCb.onchange = () => {
        const mine = checks.filter((c) => c.tool === t.id)
        const target = headCb.checked
        for (const c of mine) c.cb.checked = target
        refresh()
      }
      t._meta = meta
      t._head = headCb
      list.appendChild(card)
    }
    refresh()

    if (skipBtn) {
      skipBtn.textContent = T.skip
      skipBtn.disabled = false
      skipBtn.onclick = () => { if (opts.onSkip) opts.onSkip() }
    }

    copyBtn.onclick = async () => {
      const selections = {}
      for (const c of checks) {
        if (!c.cb.checked) continue
        ;(selections[c.tool] = selections[c.tool] || []).push(c.path)
      }
      // Custom folders (Settings > Hand it over) are re-planned server side by root.
      const customRoots = tools.filter((t) => t.custom && selections[t.id]).map((t) => t.root)
      copyBtn.disabled = true
      if (skipBtn) skipBtn.disabled = true
      statusEl.className = 'status-line pending'
      statusEl.textContent = T.copying
      try {
        const r = await api('/api/migrate/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(customRoots.length ? { selections, customRoots } : { selections }),
        })
        statusEl.className = 'status-line success'
        statusEl.textContent = T.done(r.copied.length)
        if (r.heldBack && r.heldBack.length) {
          const held = document.createElement('div')
          held.className = 'import-held'
          held.textContent = `${T.heldBack(r.heldBack.length)} ` +
            r.heldBack.map((h) => `${h.path} (${T.reasons[h.reason] || h.reason})`).join('; ')
          statusEl.appendChild(held)
        }
        list.querySelectorAll('input').forEach((i) => { i.disabled = true })
        if (skipBtn) { skipBtn.textContent = ''; skipBtn.classList.add('hidden') }
        if (opts.onCopied) opts.onCopied(r)
      } catch (err) {
        statusEl.className = 'status-line failure'
        statusEl.textContent = opts.GEN(err.message)
        copyBtn.disabled = false
        if (skipBtn) skipBtn.disabled = false
      }
    }
  }

  window.ImportPicker = { render, fmtSize }
})()
