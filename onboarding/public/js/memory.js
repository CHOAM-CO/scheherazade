// memory.js — the Memory page as a folder: tree on the left (the agent's home
// folder plus virtual entries), reader on the right. Fact tables come from
// memory_query (per-entry delete kept), session events from memory_events, per
// the pane-copy / opener-criteria source note (2026-07-03) §A.
// Confidence is never fetched into the DOM; source_session is never
// rendered raw anywhere below -- only derived dates.

;(function () {
  const C = window.COPY.memoryPane
  const GEN = window.COPY.genericError
  // Pointers' clear-confirm dialog borrows the generic Cancel label, same as
  // before -- it used to reach into memory.js's own (now-moved) AGENT_COPY;
  // that string now lives in copy.js's `nav` key, where the rest of that
  // const relocated to.
  const NAV = window.COPY.nav

  function $(id) { return document.getElementById(id) }
  // Local-time rendering (the owner 07-13 click-test: raw ISO slicing displayed
  // UTC dates/times). 'sv-SE' fixes only the FORMAT (YYYY-MM-DD / HH:MM);
  // the timezone always comes from the system.
  function isoDate(iso) { return iso ? new Date(iso).toLocaleDateString('sv-SE') : '' }
  function localTime(iso) { return iso ? new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '' }

  // window.api() / window.showToast() now live in nav.js (loaded before this
  // file on memory.html) -- consolidated from what used to be local copies
  // here and in settings.js.

  function confirmDialog(message, confirmText, cancelText) {
    return window.openConfirmDialog({
      dialog: $('m-dialog'), text: $('m-dialog-text'),
      confirmBtn: $('m-dialog-confirm'), cancelBtn: $('m-dialog-cancel'),
      message, confirmText, cancelText,
    })
  }

  function confirmDelete(message) {
    return confirmDialog(message, C.deleteConfirm, C.deleteCancel)
  }

  // Tri-state open_threads status. `status` + `last_touched_at` are the
  // only signals available -- this staleness cutoff (14 days) is this
  // build's own inferred rule, not specified in the copy file, since the
  // copy only names the three end-state labels without a derivation rule.
  const STALE_DAYS = 14
  function threadStatusLabel(row) {
    if (row.status && row.status !== 'open') return C.threadStatus.done
    const touched = new Date(row.last_touched_at)
    const ageDays = (Date.now() - touched.getTime()) / (1000 * 60 * 60 * 24)
    return ageDays > STALE_DAYS ? C.threadStatus.stale : C.threadStatus.active
  }

  function prefValueLabel(value) {
    return C.prefValueLabels[value] !== undefined ? C.prefValueLabels[value] : value
  }

  const ROW_FORMATTERS = {
    user_facts: (row) => ({
      value: row.value,
      meta: `Learned ${isoDate(row.created_at)} · Last confirmed ${isoDate(row.last_confirmed_at)}`,
    }),
    open_threads: (row) => ({
      value: row.summary,
      meta: `Started ${isoDate(row.opened_at)} · ${threadStatusLabel(row)}`,
    }),
    corrections: (row) => ({
      value: `${row.what_was_wrong} → now ${row.correct_behavior}`,
      meta: isoDate(row.corrected_at),
    }),
    preferences: (row) => ({
      value: `${C.prefKeyLabels[row.key] || row.key}: ${prefValueLabel(row.value)}`,
      meta: `Changed ${isoDate(row.updated_at)}`,
    }),
  }

  let displayName = 'Scheherazade'

  const TABLES = ['user_facts', 'open_threads', 'corrections', 'preferences']
  // A file touched within this window gets the "recent" dot in the tree.
  const RECENT_DOT_MS = 3 * 24 * 60 * 60 * 1000
  const RECENT_LIST_MAX = 30
  const NARROW_QUERY = '(max-width: 820px)'
  const TEXT_EXT = /\.(md|txt|json)$/i

  const F = C.folder
  const state = {
    view: { key: 'table:user_facts', kind: 'table', table: 'user_facts' },
    tree: null, // { root, exists, nodes, truncated, depthCapped } | { error }
    treeSet: new Set(), // rel path of every file in the tree
    recent: [], // ledger rows
    recentRel: new Map(), // rel path -> ts, only rows inside the agent folder
    open: new Set(['v:recent', 'v:known']), // expanded folders, kept across reloads
    renderSeq: 0, // drops a slow response after the user clicked elsewhere
  }

  function el(tag, className, text) {
    const n = document.createElement(tag)
    if (className) n.className = className
    if (text !== undefined) n.textContent = text
    return n
  }
  function fmtSize(n) {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }
  function baseName(p) {
    const s = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    return s >= 0 ? p.slice(s + 1) : p
  }

  // ── reader pane ───────────────────────────────────────────────────────
  // Every view starts from a clean reader and gets back the three slots it
  // may use (hint / status / body) plus an actions row.
  function resetReader(label, hint) {
    $('reader-label').textContent = label
    $('reader-hint').textContent = hint || ''
    $('reader-hint').classList.toggle('hidden', !hint)
    const st = $('reader-status')
    st.textContent = ''
    st.className = 'status-line'
    $('reader-body').textContent = ''
    $('reader-actions').textContent = ''
    return $('reader-body')
  }
  function setStatus(text, kind) {
    const st = $('reader-status')
    st.className = kind ? `status-line ${kind}` : 'status-line'
    st.textContent = text
  }
  function addAction(text, onClick) {
    const b = el('button', 'secondary', text)
    b.onclick = onClick
    $('reader-actions').appendChild(b)
    return b
  }
  function emptyState(text) { return el('div', 'empty-state', text) }

  // ── views ─────────────────────────────────────────────────────────────
  // "What I remember" (Dreaming feature, 2026-08-16). Read-only: this pane
  // never writes -- the agent rewrites memory-summary.md itself, overnight,
  // by following procedures/memory-consolidation.md. Markdown goes through
  // window.renderMarkdown (markdown.js), the SAME textContent-only renderer
  // chat.js uses for model output -- this string is model-authored prose
  // too, and must never ride innerHTML.
  async function viewRemember(seq) {
    const R = C.remember
    const body = resetReader(R.label)
    // No pane-level Refresh: the page-level one (m-refresh) already reloads
    // tree + current view. Two stacked Refresh buttons, the owner 2026-09-30.
    let data
    try {
      data = await api('/api/memory/summary')
    } catch (err) {
      if (seq !== state.renderSeq) return
      setStatus(R.loadError(err.message), 'failure')
      return
    }
    if (seq !== state.renderSeq) return
    if (!data.exists) {
      body.appendChild(emptyState(R.empty(displayName)))
      return
    }
    const md = el('div', 'chat-msg')
    renderMarkdown(md, data.markdown)
    body.appendChild(md)
    const when = data.updatedISO ? `${isoDate(data.updatedISO)} ${localTime(data.updatedISO)}` : ''
    setStatus(when ? R.updated(when) : '')
  }

  // One file from the agent's folder. .md goes through the same
  // textContent-only renderer; .txt/.json are shown verbatim in a <pre>.
  async function viewFile(seq, rel) {
    const body = resetReader(baseName(rel), rel)
    let data
    try {
      data = await api(`/api/agent-files/file?path=${encodeURIComponent(rel)}`)
    } catch (err) {
      if (seq !== state.renderSeq) return
      setStatus(F.fileLoadError(err.message), 'failure')
      return
    }
    if (seq !== state.renderSeq) return
    const when = data.mtimeISO ? `${isoDate(data.mtimeISO)} ${localTime(data.mtimeISO)}` : ''
    $('reader-hint').textContent = F.fileMeta(data.path, fmtSize(data.size), when)
    if (/^journals\//.test(rel)) body.appendChild(el('div', 'field-hint mem-note', F.journalFileNote))
    if (data.truncated) setStatus(F.fileTruncated(Math.round(data.text.length / 1024)), 'pending')
    if (!data.text.trim()) {
      body.appendChild(emptyState(F.fileEmpty))
    } else if (/\.md$/i.test(rel)) {
      const md = el('div', 'chat-msg')
      renderMarkdown(md, data.text)
      body.appendChild(md)
    } else {
      body.appendChild(el('pre', 'mem-raw', data.text))
    }
  }

  // One of the four fact tables, with the delete control per row.
  async function viewTable(seq, table) {
    const body = resetReader(C.categories[table].label, F.tableIntro(displayName))
    let rows
    try {
      rows = (await api(`/api/memory/${table}`)).rows
    } catch (err) {
      if (seq !== state.renderSeq) return
      body.appendChild(emptyState(GEN(err.message)))
      return
    }
    if (seq !== state.renderSeq) return
    const box = el('div', 'entries')
    body.appendChild(box)
    if (rows.length === 0) {
      const emptyCopy = C.categories[table].empty
      box.appendChild(emptyState(typeof emptyCopy === 'function' ? emptyCopy(displayName) : emptyCopy))
      return
    }
    const format = ROW_FORMATTERS[table]
    for (const row of rows) {
      const formatted = format(row)
      const rowEl = el('div', 'entry-row')
      const main = el('div', 'entry-main')
      main.appendChild(el('div', 'entry-value', formatted.value))
      main.appendChild(el('div', 'entry-meta', formatted.meta))
      const delBtn = el('button', 'entry-delete', C.deleteLabel)
      delBtn.onclick = async () => {
        const confirmed = await confirmDelete(C.deleteDialog(displayName))
        if (!confirmed) return
        try {
          await api(`/api/memory/${table}/${row.id}`, { method: 'DELETE' })
          showToast(C.deleteToast)
          if (state.view.key === `table:${table}`) viewTable(++state.renderSeq, table)
        } catch (err) {
          showToast(GEN(err.message))
        }
      }
      rowEl.appendChild(main)
      rowEl.appendChild(delBtn)
      box.appendChild(rowEl)
    }
  }

  async function viewSession(seq) {
    const body = resetReader(C.sessionGroupTitle)
    let result
    try {
      result = await api('/api/memory/session-events')
    } catch (err) {
      if (seq !== state.renderSeq) return
      setStatus(GEN(err.message), 'failure')
      return
    }
    if (seq !== state.renderSeq) return
    if (!result.events || result.events.length === 0) {
      body.appendChild(emptyState(F.sessionEmpty))
      return
    }
    const box = el('div', 'entries')
    body.appendChild(box)
    for (const ev of result.events) {
      const row = el('div', 'entry-row')
      const main = el('div', 'entry-main')
      const tableLabel = (C.categories[ev.table] && C.categories[ev.table].label) || ev.table
      const eventLabel = C.eventLabels[ev.event] || ev.event
      let preview = ''
      if (ev.preview) {
        const fmt = ROW_FORMATTERS[ev.table]
        if (fmt) preview = ' — ' + fmt(ev.preview).value
      }
      main.appendChild(el('div', 'entry-value', `${tableLabel} · ${eventLabel}${preview}`))
      main.appendChild(el('div', 'entry-meta', localTime(ev.at)))
      row.appendChild(main)
      box.appendChild(row)
    }
  }

  // The DB journal (memory.db journal_entries, via journal_write). NOT the
  // journals/ files -- those are day files the agent writes from session
  // notes. Different stores, no mirroring, so this view says which it is.
  async function viewJournalDb(seq) {
    const J = C.journal
    const body = resetReader(F.journalDbNode, J.intro)
    body.appendChild(el('div', 'field-hint mem-note', F.journalDbNote))
    let data
    try {
      data = await api('/api/journal')
    } catch (err) {
      // Fail loud: an unreachable journal must not render as an empty one.
      if (seq !== state.renderSeq) return
      setStatus(J.loadError(err.message), 'failure')
      return
    }
    if (seq !== state.renderSeq) return
    const rows = data.rows || []
    const gaps = data.gaps || []
    if (gaps.length > 0) setStatus(J.gaps(gaps.length))
    if (rows.length === 0) {
      body.appendChild(emptyState(J.empty))
      return
    }
    const listEl = el('div', 'entries')
    body.appendChild(listEl)
    for (const row of rows) {
      const card = el('div', 'journal-day')
      const head = el('div', 'journal-day-head')
      head.appendChild(el('span', 'journal-date', row.date))
      const del = el('button', 'secondary journal-del', J.del)
      del.addEventListener('click', async () => {
        const ok = await confirmDialog(J.delConfirm(row.date), J.delOk, NAV.cancel)
        if (!ok) return
        del.disabled = true
        try {
          await api(`/api/journal/${row.date}`, { method: 'DELETE' })
          showToast(J.deleted)
          if (state.view.key === 'journal-db') viewJournalDb(++state.renderSeq)
        } catch (err) {
          del.disabled = false
          showToast(J.failed(err.message))
        }
      })
      head.appendChild(del)
      card.appendChild(head)
      // The body is the agent's own prose, including its timestamp seams. It is
      // shown as written -- textContent, never innerHTML: this string came from
      // a model and must never be able to become markup.
      card.appendChild(el('div', 'journal-body', row.body))
      listEl.appendChild(card)
    }
  }

  // Imported pointers. Note what does NOT happen here: opening this view does
  // not scan anything. GET /api/memory/pointers reads the table only. The scan
  // runs on the button and nowhere else -- opt-in has to mean opt-in even when
  // scanning would be convenient.
  async function viewPointers(seq) {
    const P = C.pointers
    const body = resetReader(P.label, P.intro)
    const coverageEl = el('div', 'pointers-coverage')
    const entries = el('div', 'entries')
    body.appendChild(coverageEl)
    body.appendChild(entries)

    function paint(data) {
      const rows = data.rows || []
      coverageEl.textContent = ''
      for (const c of data.coverage || []) {
        coverageEl.appendChild(el('div', 'pointers-coverage-line', P.coverage(c.label, c.found, c.note)))
        if (c.suppressed > 0) coverageEl.appendChild(el('div', 'pointers-coverage-line pointers-suppressed', P.suppressed(c.suppressed)))
      }
      entries.textContent = ''
      if (!rows.length) {
        entries.appendChild(el('div', 'entry-empty', P.empty))
        return
      }
      for (const r of rows) {
        const item = el('div', 'entry pointer-entry')
        // The pointer shows WHERE and (at most) a heading. There is no body
        // text to show, because none was ever read.
        item.appendChild(el('div', 'pointer-path', r.path))
        item.appendChild(el('div', 'pointer-meta', [r.source_tool, r.topic].filter(Boolean).join(' · ')))
        entries.appendChild(item)
      }
    }
    async function load() {
      try {
        const data = await api('/api/memory/pointers')
        if (seq === state.renderSeq) paint(data)
      } catch (err) {
        console.error('pointer load failed:', err)
      }
    }
    const scanBtn = addAction(P.scan, async () => {
      scanBtn.disabled = true
      setStatus(P.scanning, 'pending')
      try {
        const result = await api('/api/memory/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        const truncated = (result.coverage || []).some((c) => c.truncated)
        setStatus(P.scanned(result.written || 0, truncated))
        await load()
      } catch (err) {
        setStatus(String(err.message || err), 'failure')
      } finally {
        scanBtn.disabled = false
      }
    })
    const clearBtn = addAction(P.clear, async () => {
      const ok = await confirmDialog(P.clearConfirm, P.clearOk, NAV.cancel)
      if (!ok) return
      clearBtn.disabled = true
      try {
        await api('/api/memory/pointers', { method: 'DELETE' })
        setStatus(P.cleared)
        await load()
      } catch (err) {
        setStatus(String(err.message || err), 'failure')
      } finally {
        clearBtn.disabled = false
      }
    })
    await load()
  }

  function renderView() {
    const seq = ++state.renderSeq
    const v = state.view
    if (v.kind === 'remember') return viewRemember(seq)
    if (v.kind === 'file') return viewFile(seq, v.rel)
    if (v.kind === 'table') return viewTable(seq, v.table)
    if (v.kind === 'journal-db') return viewJournalDb(seq)
    if (v.kind === 'session') return viewSession(seq)
    if (v.kind === 'pointers') return viewPointers(seq)
    return undefined
  }

  // ── tree ──────────────────────────────────────────────────────────────
  function isNarrow() { return window.matchMedia && window.matchMedia(NARROW_QUERY).matches }

  function setTreeOpen(open) {
    $('mem-tree').classList.toggle('open', open)
    $('mem-tree-toggle').setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  function viewLabel() {
    const v = state.view
    if (v.kind === 'remember') return C.remember.label
    if (v.kind === 'file') return baseName(v.rel)
    if (v.kind === 'table') return C.categories[v.table].label
    if (v.kind === 'journal-db') return F.journalDbNode
    if (v.kind === 'session') return C.sessionGroupTitle
    return C.pointers.label.replace(/ \(.*$/, '')
  }
  function updateToggle() { $('mem-tree-toggle').textContent = `${F.treeToggle} · ${viewLabel()}` }

  // The selection lives in the URL hash (#file:journals/2026-09-28.md,
  // #table:user_facts, #journal-db ...) so a reload lands where you were.
  function viewFromKey(key) {
    if (key === 'remember' || key === 'journal-db' || key === 'session' || key === 'pointers') return { key, kind: key }
    if (key.startsWith('table:') && TABLES.includes(key.slice(6))) return { key, kind: 'table', table: key.slice(6) }
    if (key.startsWith('file:') && TEXT_EXT.test(key)) {
      const rel = key.slice(5)
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) state.open.add(`dir:${parts.slice(0, i).join('/')}`)
      return { key, kind: 'file', rel }
    }
    return null
  }

  function select(view) {
    state.view = view
    try { history.replaceState(null, '', `#${encodeURIComponent(view.key)}`) } catch { /* file:// or sandbox */ }
    renderTree()
    updateToggle()
    if (isNarrow()) setTreeOpen(false)
    renderView()
  }

  // Which recent ledger paths can the reader open? Inside the agent folder AND
  // something the file route would serve. Everything else keeps the old
  // behaviour: hand it to the OS (/api/files/open).
  function relInsideHome(abs) {
    const root = state.tree && state.tree.root
    if (!root) return null
    const norm = abs.replace(/\\/g, '/')
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!norm.startsWith(r + '/')) return null
    const rel = norm.slice(r.length + 1)
    const segs = rel.split('/')
    if (segs.some((s) => !s || s.startsWith('.')) || !TEXT_EXT.test(rel)) return null
    return rel
  }

  function collectRecentRel() {
    state.recentRel = new Map()
    for (const row of state.recent) {
      const rel = relInsideHome(row.path)
      if (rel && Date.now() - row.ts < RECENT_DOT_MS) state.recentRel.set(rel, row.ts)
    }
  }
  function hasRecent(node) {
    if (node.type === 'file') return state.recentRel.has(node.path)
    return (node.children || []).some(hasRecent)
  }

  function nodeButton(label, opts) {
    const b = el('button', 'mem-node' + (opts.active ? ' active' : '') + (opts.folder ? ' mem-folder-row' : ''))
    b.type = 'button'
    b.style.paddingLeft = `${0.55 + opts.depth * 0.95}rem`
    b.appendChild(el('span', 'mem-caret', opts.folder ? (opts.open ? '▾' : '▸') : ''))
    const name = el('span', 'mem-name', label)
    if (opts.title) b.title = opts.title
    b.appendChild(name)
    if (opts.dot) {
      const d = el('span', 'mem-dot')
      d.title = F.recentDot
      b.appendChild(d)
    }
    if (opts.badge) b.appendChild(el('span', 'mem-badge', opts.badge))
    if (opts.folder) {
      b.setAttribute('aria-expanded', opts.open ? 'true' : 'false')
    } else if (opts.active) {
      b.setAttribute('aria-current', 'true')
    }
    b.onclick = opts.onClick
    return b
  }

  // A folder row plus its children, honoring the persisted open-set.
  function folder(parent, key, label, depth, dot, fillChildren, badge) {
    const open = state.open.has(key)
    parent.appendChild(nodeButton(label, {
      folder: true, open, depth, dot: dot && !open, badge,
      onClick: () => {
        if (state.open.has(key)) state.open.delete(key)
        else state.open.add(key)
        renderTree()
      },
    }))
    if (open) fillChildren()
  }

  function renderFileNodes(parent, nodes, depth) {
    for (const n of nodes) {
      if (n.type === 'dir') {
        folder(parent, `dir:${n.path}`, `${n.name}/`, depth, hasRecent(n), () => renderFileNodes(parent, n.children, depth + 1), String(n.children.length))
      } else {
        const key = `file:${n.path}`
        parent.appendChild(nodeButton(n.name, {
          depth, dot: state.recentRel.has(n.path), active: state.view.key === key,
          onClick: () => select({ key, kind: 'file', rel: n.path }),
        }))
      }
    }
  }

  function renderTree() {
    const tree = $('mem-tree')
    const keepScroll = tree.scrollTop
    tree.textContent = ''
    const v = state.view

    // "What I remember" panel removed 0.3.12 (the owner 10-01: the agent
    // never reads it). What I know about you first, then Recent.
    folder(tree, 'v:known', F.knownNode, 0, false, () => {
      for (const t of TABLES) {
        tree.appendChild(nodeButton(C.categories[t].label, {
          depth: 1, active: v.key === `table:${t}`,
          onClick: () => select({ key: `table:${t}`, kind: 'table', table: t }),
        }))
      }
    })

    // Recent: the file ledger. Inside the agent folder -> opens in the reader;
    // outside (e.g. ~/.chromux/config.json) -> the OS opens it, as before.
    const recentRows = state.recent.slice(0, RECENT_LIST_MAX)
    folder(tree, 'v:recent', F.recentNode, 0, false, () => {
      if (recentRows.length === 0) tree.appendChild(el('div', 'mem-note-row', F.recentEmpty))
      for (const row of recentRows) {
        const rel = relInsideHome(row.path)
        const inTree = rel && (!state.tree || state.tree.truncated || state.treeSet.has(rel))
        // Inside the agent folder show the folder-relative path: a bare
        // "2026-09-28.md" says nothing about which folder it lives in.
        tree.appendChild(nodeButton(rel || baseName(row.path), {
          depth: 1,
          dot: rel && state.recentRel.has(rel),
          active: inTree && v.key === `file:${rel}`,
          badge: inTree ? '' : '↗',
          title: inTree ? row.path : `${row.path}\n${F.recentOutside}`,
          onClick: inTree
            ? () => select({ key: `file:${rel}`, kind: 'file', rel })
            : async () => {
              try {
                await api('/api/files/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: row.path }) })
              } catch (err) {
                showToast(C.recentFiles.openFail(err.message))
              }
            },
        }))
      }
    }, recentRows.length ? String(recentRows.length) : '')

    // The real folder.
    if (!state.tree) {
      // still loading
    } else if (state.tree.error) {
      tree.appendChild(el('div', 'mem-note-row failure', F.treeLoadError(state.tree.error)))
    } else if (!state.tree.nodes.length) {
      tree.appendChild(el('div', 'mem-note-row', F.treeEmpty))
    } else {
      tree.appendChild(el('div', 'mem-rule'))
      renderFileNodes(tree, state.tree.nodes, 0)
      if (state.tree.truncated) tree.appendChild(el('div', 'mem-note-row', F.treeCapped))
      else if (state.tree.depthCapped) tree.appendChild(el('div', 'mem-note-row', F.treeDeep))
      tree.appendChild(el('div', 'mem-rule'))
    }

    folder(tree, 'v:jdb', F.journalDbNode, 0, false, () => {
      tree.appendChild(nodeButton(F.journalDbEntry, {
        depth: 1, active: v.key === 'journal-db', onClick: () => select({ key: 'journal-db', kind: 'journal-db' }),
      }))
      tree.appendChild(nodeButton(F.sessionNode, {
        depth: 1, active: v.key === 'session', onClick: () => select({ key: 'session', kind: 'session' }),
      }))
    })

    // Imported pointers: locations only, at the very bottom (the owner 08-24).
    tree.appendChild(nodeButton(F.pointersNode, {
      depth: 0, active: v.key === 'pointers', onClick: () => select({ key: 'pointers', kind: 'pointers' }),
    }))

    tree.scrollTop = keepScroll
  }

  async function loadTreeData() {
    let tree
    try {
      tree = await api('/api/agent-files/tree')
    } catch (err) {
      tree = { error: err.message, nodes: [] }
    }
    state.tree = tree
    state.treeSet = new Set()
    const walk = (ns) => { for (const n of ns || []) { if (n.type === 'file') state.treeSet.add(n.path); else walk(n.children) } }
    walk(tree.nodes)
    try {
      state.recent = ((await api('/api/files/recent')).rows || [])
    } catch (err) {
      console.error('recent files load failed:', err)
      state.recent = []
    }
    collectRecentRel()
    renderTree()
  }

  async function loadImportCandidates() {
    const { rows } = await api('/api/memory/import-candidates')
    const container = $('ai-import-pending')
    container.replaceChildren()
    for (const row of rows) {
      const item = document.createElement('div')
      const text = document.createElement('p')
      text.textContent = `${row.source}: “${row.text}” — is this right?`
      item.append(text)
      for (const [label, decision] of [['Accept', 'accepted'], ['Reject', 'rejected']]) {
        const button = document.createElement('button')
        button.className = 'secondary'
        button.textContent = label
        button.onclick = async () => {
          const buttons = item.querySelectorAll('button')
          buttons.forEach(b => { b.disabled = true })
          try {
            await api('/api/memory/import-candidates', { method: 'POST', body: JSON.stringify({ id: row.id, decision }) })
            await loadImportCandidates()
            if (decision === 'accepted') await renderView()
          } catch (err) {
            $('ai-import-status').textContent = err.message
            buttons.forEach(b => { b.disabled = false })
          }
        }
        item.append(button)
      }
      container.append(item)
    }
  }

  function initImport() {
    const I = C.aiImport
    $('ai-import-title').textContent = I.title
    $('ai-import-intro').textContent = I.intro
    $('ai-import-source-label').textContent = I.origin
    $('ai-import-file-label').textContent = I.file
    $('ai-import-choose').textContent = I.chooseFile
    $('ai-import-submit').textContent = I.submit
    for (const [value, label] of I.origins) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      $('ai-import-source').append(option)
    }
    const showName = () => { $('ai-import-file-name').textContent = $('ai-import-file').files[0]?.name || I.noFile }
    showName()
    $('ai-import-choose').onclick = () => $('ai-import-file').click()
    $('ai-import-file').onchange = showName
    $('ai-import-submit').onclick = async () => {
      const file = $('ai-import-file').files[0]
      if (!file) { $('ai-import-status').textContent = I.chooseFirst; return }
      const button = $('ai-import-submit')
      button.disabled = true
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error(I.tooBig)
        const result = await api('/api/memory/ai-import', { method: 'POST', body: JSON.stringify({
          filename: file.name, content: await file.text(), source: $('ai-import-source').value,
        }) })
        $('ai-import-status').textContent = I.staged(result.staged)
        await loadImportCandidates()
      } catch (err) { $('ai-import-status').textContent = err.message }
      finally { button.disabled = false }
    }
    loadImportCandidates().catch(err => { $('ai-import-status').textContent = err.message })
  }

  async function init() {
    initImport()
    try {
      const cfg = await api('/api/config')
      displayName = cfg.DISPLAY_NAME || displayName
    } catch (err) {
      console.error(err)
    }

    $('m-title').textContent = C.title
    $('m-subtitle').textContent = C.subtitle(displayName)
    $('mem-tree').setAttribute('aria-label', F.treeAria)
    $('mem-tree-toggle').onclick = () => setTreeOpen(!$('mem-tree').classList.contains('open'))
    state.treeSet = new Set()

    const refreshBtn = $('m-refresh')
    refreshBtn.textContent = C.refreshLabel
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true
      try {
        await Promise.all([loadTreeData(), renderView(), loadImportCandidates()])
        showToast(C.refreshToast)
      } finally {
        refreshBtn.disabled = false
      }
    }

    let fromHash = null
    try { fromHash = viewFromKey(decodeURIComponent(location.hash.slice(1))) } catch { /* bad escape */ }
    if (fromHash) state.view = fromHash
    renderTree()
    updateToggle()
    renderView()
    await loadTreeData()
  }

  init()
})()
