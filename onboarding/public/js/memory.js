// memory.js — read-only memory pane (+ per-entry delete). Renders the 4
// category tables via memory_query and the "이번 세션에서 기억한 것" group
// via memory_events, per
// ~/Documents/MAGI_Memory/projects/scheherazade_pane_copy_opener_criteria_2026-07-03.md §A.
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
  // Local-time rendering (Mino 07-13 click-test: raw ISO slicing displayed
  // UTC dates/times). 'sv-SE' fixes only the FORMAT (YYYY-MM-DD / HH:MM);
  // the timezone always comes from the system.
  function isoDate(iso) { return iso ? new Date(iso).toLocaleDateString('sv-SE') : '' }
  function localTime(iso) { return iso ? new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '' }

  // window.api() / window.showToast() now live in nav.js (loaded before this
  // file on memory.html) -- consolidated from what used to be local copies
  // here and in settings.js.

  function confirmDialog(message, confirmText, cancelText) {
    return new Promise((resolve) => {
      const dialog = $('m-dialog')
      $('m-dialog-text').textContent = message
      $('m-dialog-confirm').textContent = confirmText
      $('m-dialog-cancel').textContent = cancelText
      dialog.classList.remove('hidden')
      const cleanup = (result) => {
        dialog.classList.add('hidden')
        $('m-dialog-confirm').onclick = null
        $('m-dialog-cancel').onclick = null
        resolve(result)
      }
      $('m-dialog-confirm').onclick = () => cleanup(true)
      $('m-dialog-cancel').onclick = () => cleanup(false)
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
      meta: `알게 된 날 ${isoDate(row.created_at)} · 마지막 확인 ${isoDate(row.last_confirmed_at)}`,
    }),
    open_threads: (row) => ({
      value: row.summary,
      meta: `시작 ${isoDate(row.opened_at)} · ${threadStatusLabel(row)}`,
    }),
    corrections: (row) => ({
      value: `${row.what_was_wrong} → 이제 ${row.correct_behavior}`,
      meta: isoDate(row.corrected_at),
    }),
    preferences: (row) => ({
      value: `${C.prefKeyLabels[row.key] || row.key}: ${prefValueLabel(row.value)}`,
      meta: `바뀐 날 ${isoDate(row.updated_at)}`,
    }),
  }

  let displayName = '세헤라자드'

  async function loadCategory(table) {
    const container = $(`cat-${table}-entries`)
    container.innerHTML = ''
    let rows
    try {
      const result = await api(`/api/memory/${table}`)
      rows = result.rows
    } catch (err) {
      container.innerHTML = ''
      const errEl = document.createElement('div')
      errEl.className = 'empty-state'
      errEl.textContent = GEN(err.message)
      container.appendChild(errEl)
      return
    }
    if (rows.length === 0) {
      const emptyCopy = C.categories[table].empty
      const text = typeof emptyCopy === 'function' ? emptyCopy(displayName) : emptyCopy
      const el = document.createElement('div')
      el.className = 'empty-state'
      el.textContent = text
      container.appendChild(el)
      return
    }
    const format = ROW_FORMATTERS[table]
    for (const row of rows) {
      const formatted = format(row)
      const rowEl = document.createElement('div')
      rowEl.className = 'entry-row'
      const main = document.createElement('div')
      main.className = 'entry-main'
      const valueEl = document.createElement('div')
      valueEl.className = 'entry-value'
      valueEl.textContent = formatted.value
      const metaEl = document.createElement('div')
      metaEl.className = 'entry-meta'
      metaEl.textContent = formatted.meta
      main.appendChild(valueEl)
      main.appendChild(metaEl)
      const delBtn = document.createElement('button')
      delBtn.className = 'entry-delete'
      delBtn.textContent = C.deleteLabel
      delBtn.onclick = async () => {
        const confirmed = await confirmDelete(C.deleteDialog(displayName))
        if (!confirmed) return
        try {
          await api(`/api/memory/${table}/${row.id}`, { method: 'DELETE' })
          showToast(C.deleteToast)
          loadCategory(table)
          loadSessionGroup()
        } catch (err) {
          showToast(GEN(err.message))
        }
      }
      rowEl.appendChild(main)
      rowEl.appendChild(delBtn)
      container.appendChild(rowEl)
    }
  }

  async function loadSessionGroup() {
    const groupEl = $('m-session-group')
    let result
    try {
      result = await api('/api/memory/session-events')
    } catch (err) {
      groupEl.classList.add('hidden')
      return
    }
    if (!result.events || result.events.length === 0) {
      groupEl.classList.add('hidden')
      return
    }
    groupEl.classList.remove('hidden')
    $('m-session-label').textContent = C.sessionGroupTitle
    const listEl = $('m-session-list')
    listEl.innerHTML = ''
    for (const ev of result.events) {
      const row = document.createElement('div')
      row.className = 'entry-row'
      const main = document.createElement('div')
      main.className = 'entry-main'
      const valueEl = document.createElement('div')
      valueEl.className = 'entry-value'
      const tableLabel = (window.COPY.memoryPane.categories[ev.table] && window.COPY.memoryPane.categories[ev.table].label) || ev.table
      const eventLabel = C.eventLabels[ev.event] || ev.event
      let preview = ''
      if (ev.preview) {
        const fmt = ROW_FORMATTERS[ev.table]
        if (fmt) preview = ' — ' + fmt(ev.preview).value
      }
      valueEl.textContent = `${tableLabel} · ${eventLabel}${preview}`
      const metaEl = document.createElement('div')
      metaEl.className = 'entry-meta'
      const time = localTime(ev.at)
      metaEl.textContent = time
      main.appendChild(valueEl)
      main.appendChild(metaEl)
      row.appendChild(main)
      listEl.appendChild(row)
    }
  }

  // ── Imported pointers (v0.0.4 item d) ─────────────────────────────────
  // Copy discipline: say what this IS (locations), what it is NOT (a copy of
  // your files), and what it costs. The scan opens nothing but markdown
  // headings, and never enters a credential path -- if we claim that, the copy
  // has to be plain enough that the claim is checkable.
  const POINTERS_COPY = {
    label: '다른 도구의 메모리 (위치만)',
    intro: '다른 AI 도구가 이 Mac에 남긴 메모리 파일의 "위치"를 찾아 목록으로 둡니다. 내용을 복사해 오지 않고, 제 기억에 섞지도 않습니다. 로그인 정보가 있는 경로는 스캔 대상에서 원천 제외됩니다.',
    scan: '지금 찾아보기',
    clear: '목록 비우기',
    scanning: '찾는 중…',
    // Truncation is stated, never silent: a capped list that reads as complete
    // is a lie the user has no way to detect.
    scanned: (n, truncated) => (truncated
      ? `${n}개를 찾았습니다 (상한에 걸려 일부만 표시됩니다).`
      : `${n}개를 찾았습니다.`),
    cleared: '목록을 비웠습니다.',
    empty: '아직 찾아본 적이 없습니다.',
    clearConfirm: '이 목록을 전부 비울까요?',
    clearOk: '비우기',
    coverage: (label, found, note) => `${label}: ${found}개 — ${note}`,
    // A heading we refused to keep because it looked like a credential. Silence
    // here would be the same bug in a friendlier coat: the user would never learn
    // that we ate a label, and could not tell a caught key from an over-strict
    // filter. Zero is normal, so this line only appears when it isn't zero.
    suppressed: (n) => `제목 ${n}개는 열쇠처럼 보여서 목록에 담지 않았습니다 (파일 위치는 그대로 있습니다).`,
  }

  async function init() {
    try {
      const cfg = await api('/api/config')
      displayName = cfg.DISPLAY_NAME || displayName
    } catch (err) {
      console.error(err)
    }

    $('m-title').textContent = C.title
    $('m-subtitle').textContent = C.subtitle(displayName)
    $('m-settings-link').textContent = window.COPY.settings.title

    for (const table of ['user_facts', 'open_threads', 'corrections', 'preferences']) {
      $(`cat-${table}-label`).textContent = C.categories[table].label
    }

    const refreshBtn = $('m-refresh')
    refreshBtn.textContent = C.refreshLabel
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true
      try {
        await Promise.all([
          loadSessionGroup(),
          ...['user_facts', 'open_threads', 'corrections', 'preferences'].map((t) => loadCategory(t)),
        ])
        showToast(C.refreshToast)
      } finally {
        refreshBtn.disabled = false
      }
    }

    renderJournal()
    renderPointers()
    await loadSessionGroup()
    for (const table of ['user_facts', 'open_threads', 'corrections', 'preferences']) {
      loadCategory(table)
    }
  }

  // The journal (v0.0.5). The four tables below are what the agent knows ABOUT
  // the user; this is what its days were like. It sits first for that reason.
  const JOURNAL_COPY = {
    label: '일지',
    intro: '에이전트가 하루의 끝에 스스로 쓴 기록입니다. 요약이 아니라 그날의 이야기예요. 한 번 쓴 줄은 고칠 수 없고, 지울 수 있는 건 회원님뿐입니다.',
    empty: '아직 쓴 일지가 없습니다.',
    // A gap is stated, never hidden. "The agent ran that day and wrote nothing"
    // and "nothing happened that day" are different facts, and only one of them
    // is a bug -- so the user gets to tell them apart.
    gaps: (n) => `기록이 비어있는 날이 ${n}일 있습니다 (에이전트는 그날 켜져 있었지만 아무것도 쓰지 않았어요).`,
    del: '이 날 지우기',
    delConfirm: (d) => `${d} 일지를 지울까요? 되돌릴 수 없습니다.`,
    delOk: '지우기',
    deleted: '지웠습니다.',
  }

  async function renderJournal() {
    const J = JOURNAL_COPY
    $('cat-journal-label').textContent = J.label
    $('journal-intro').textContent = J.intro
    const listEl = $('journal-entries')
    const statusEl = $('journal-status')
    listEl.innerHTML = ''
    statusEl.textContent = ''

    let data
    try {
      data = await api('/api/journal')
    } catch (err) {
      // Fail loud: an unreachable journal must not render as an empty one.
      statusEl.textContent = `일지를 불러오지 못했습니다 (${err.message}).`
      return
    }

    const rows = data.rows || []
    const gaps = data.gaps || []
    if (gaps.length > 0) statusEl.textContent = J.gaps(gaps.length)
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = J.empty
      listEl.appendChild(empty)
      return
    }

    for (const row of rows) {
      const card = document.createElement('div')
      card.className = 'journal-day'

      const head = document.createElement('div')
      head.className = 'journal-day-head'
      const dateEl = document.createElement('span')
      dateEl.className = 'journal-date'
      dateEl.textContent = row.date
      head.appendChild(dateEl)

      const del = document.createElement('button')
      del.className = 'secondary journal-del'
      del.textContent = J.del
      del.addEventListener('click', async () => {
        const ok = await confirmDialog(J.delConfirm(row.date), J.delOk)
        if (!ok) return
        del.disabled = true
        try {
          await api(`/api/journal/${row.date}`, { method: 'DELETE' })
          showToast(J.deleted)
          await renderJournal()
        } catch (err) {
          del.disabled = false
          showToast(`실패: ${err.message}`)
        }
      })
      head.appendChild(del)
      card.appendChild(head)

      // The body is the agent's own prose, including its timestamp seams. It is
      // shown as written -- textContent, never innerHTML: this string came from
      // a model and must never be able to become markup.
      const body = document.createElement('div')
      body.className = 'journal-body'
      body.textContent = row.body
      card.appendChild(body)

      listEl.appendChild(card)
    }
  }

  // Imported pointers. Note what does NOT happen here: opening this page does
  // not scan anything. GET /api/memory/pointers reads the table only. The scan
  // runs on the button and nowhere else -- opt-in has to mean opt-in even when
  // scanning would be convenient.
  function renderPointers() {
    const P = POINTERS_COPY
    $('cat-pointers-label').textContent = P.label
    $('pointers-intro').textContent = P.intro
    const scanBtn = $('pointers-scan')
    const clearBtn = $('pointers-clear')
    const statusEl = $('pointers-status')
    scanBtn.textContent = P.scan
    clearBtn.textContent = P.clear

    function paint(data) {
      const rows = data.rows || []
      const cov = data.coverage || []
      $('pointers-coverage').innerHTML = ''
      for (const c of cov) {
        const line = document.createElement('div')
        line.className = 'pointers-coverage-line'
        line.textContent = P.coverage(c.label, c.found, c.note)
        $('pointers-coverage').appendChild(line)
        if (c.suppressed > 0) {
          const warn = document.createElement('div')
          warn.className = 'pointers-coverage-line pointers-suppressed'
          warn.textContent = P.suppressed(c.suppressed)
          $('pointers-coverage').appendChild(warn)
        }
      }
      const entries = $('pointers-entries')
      entries.innerHTML = ''
      if (!rows.length) {
        const empty = document.createElement('div')
        empty.className = 'entry-empty'
        empty.textContent = P.empty
        entries.appendChild(empty)
        return
      }
      for (const r of rows) {
        const el = document.createElement('div')
        el.className = 'entry pointer-entry'
        // The pointer shows WHERE and (at most) a heading. There is no body
        // text to show, because none was ever read.
        const loc = document.createElement('div')
        loc.className = 'pointer-path'
        loc.textContent = r.path
        const meta = document.createElement('div')
        meta.className = 'pointer-meta'
        meta.textContent = [r.source_tool, r.topic].filter(Boolean).join(' · ')
        el.appendChild(loc)
        el.appendChild(meta)
        entries.appendChild(el)
      }
    }

    async function load() {
      try {
        paint(await api('/api/memory/pointers'))
      } catch (err) {
        console.error('pointer load failed:', err)
      }
    }

    scanBtn.onclick = async () => {
      scanBtn.disabled = true
      statusEl.textContent = P.scanning
      try {
        const result = await api('/api/memory/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        const truncated = (result.coverage || []).some((c) => c.truncated)
        statusEl.textContent = P.scanned(result.written || 0, truncated)
        await load()
      } catch (err) {
        statusEl.className = 'status-line failure'
        statusEl.textContent = String(err.message || err)
      } finally {
        scanBtn.disabled = false
      }
    }

    clearBtn.onclick = async () => {
      const ok = await confirmDialog(P.clearConfirm, P.clearOk, NAV.cancel)
      if (!ok) return
      clearBtn.disabled = true
      try {
        await api('/api/memory/pointers', { method: 'DELETE' })
        statusEl.textContent = P.cleared
        await load()
      } catch (err) {
        statusEl.className = 'status-line failure'
        statusEl.textContent = String(err.message || err)
      } finally {
        clearBtn.disabled = false
      }
    }

    load()
  }

  init()
})()
