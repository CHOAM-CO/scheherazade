// memory.js — read-only memory pane (+ per-entry delete). Renders the 4
// category tables via memory_query and the "이번 세션에서 기억한 것" group
// via memory_events, per
// ~/Documents/MAGI_Memory/projects/scheherazade_pane_copy_opener_criteria_2026-07-03.md §A.
// Confidence is never fetched into the DOM; source_session is never
// rendered raw anywhere below -- only derived dates.

;(function () {
  const C = window.COPY.memoryPane
  const GEN = window.COPY.genericError

  function $(id) { return document.getElementById(id) }
  // Local-time rendering (Mino 07-13 click-test: raw ISO slicing displayed
  // UTC dates/times). 'sv-SE' fixes only the FORMAT (YYYY-MM-DD / HH:MM);
  // the timezone always comes from the system.
  function isoDate(iso) { return iso ? new Date(iso).toLocaleDateString('sv-SE') : '' }
  function localTime(iso) { return iso ? new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '' }

  async function api(path, options) {
    const opts = options ? { ...options } : {}
    // localhost-auth gate (security review, 2026-07-03): every mutating
    // (non-GET) request must carry the per-launch token the server
    // injected into this page's <head> -- see copy.js's getOnboardToken().
    if (opts.method && opts.method !== 'GET') {
      opts.headers = { ...(opts.headers || {}), 'X-Onboard-Token': window.getOnboardToken() || '' }
    }
    const res = await fetch(path, opts)
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
    const el = $('m-toast')
    el.textContent = text
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
  }

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

  // ── Agent control panel (Slice 2, 2026-07-09) ──────────────────────────
  // #2 model select / #4 model switch / #5 on-off, on the steady-state home
  // pane. Copy below is eng placeholder (Mino's copy track localizes). The
  // server control routes are fire-and-forget 202 -> the client polls
  // /api/agent/status to observe the transition, and the in-flight guard
  // (setAgentControlsDisabled) is the ONLY concurrency defense -- the server
  // is deliberately not serialized (Mino 2026-07-09 YAGNI).
  const AGENT_COPY = {
    label: 'AGENT',
    modelLabel: 'Model',
    effortLabel: 'Effort',
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    states: { live: 'Running', connecting: 'Starting…', stopped: 'Stopped', failed: 'Failed', idle: 'Not started' },
    switchConfirm: (m) => `Switch model to ${m}? The agent will restart.`,
    effortConfirm: (e) => `Switch effort to ${e}? The agent will restart.`,
    switchOk: 'Switch',
    stopConfirm: 'Stop the agent?',
    stopOk: 'Stop',
    cancel: 'Cancel',
    openDiscord: 'Open Discord',
  }

  // Model catalog + provider gate. A model is selectable only if its provider
  // is the onboarded PROVIDER (single-provider today; claude-subscription
  // counts as claude). Claude ids use CLI aliases (version-independent).
  const MODEL_CATALOG = [
    { id: 'opus', label: 'Claude Opus', providers: ['claude', 'claude-subscription'] },
    { id: 'sonnet', label: 'Claude Sonnet', providers: ['claude', 'claude-subscription'] },
    // Kimi CONFIRMED incompatible (Mino live test 2026-07-13 19:15-19:20,
    // transcript cd209c48): the model TRIED to call reply but its native
    // <|tool_call_argument_begin|> token format leaked into plain text --
    // the ollama Anthropic-compat lane never produced a tool_use block, so
    // the agent is silently mute (3/3 turns, tool_use count 0). Listing a
    // model whose tool calls don't parse in this harness ships a dead agent;
    // stays visible-but-unselectable until a swap-time tool-call smoke test
    // exists (v0.0.4) and it passes.
    { id: 'kimi-k2.7-code:cloud', label: 'Kimi K2.7 Code (툴콜 비호환)', providers: ['ollama'], brokenToolUse: true },
    // Same lane, tool-call format UNVERIFIED in this harness -- selectable
    // (that's what click-testing is for) but labeled so a mute agent after
    // swapping here is a known suspect, not a mystery.
    { id: 'deepseek-v4-pro:cloud', label: 'DeepSeek V4 Pro (툴콜 미검증)', providers: ['ollama'] },
    // glm-5.2 tool-use verified live by Mino (2026-07-13 19:32, same ollama
    // lane as kimi: "glm5.2 << 문제 전혀없음") -- label cleared same day it
    // was added. sonnet-5 / opus-4.8 verified in the same test round.
    { id: 'glm-5.2:cloud', label: 'GLM 5.2', providers: ['ollama'] },
    { id: 'gpt', label: 'GPT (Codex)', providers: ['chatgpt'] },
  ]

  // Effort selector (Mino 07-13 click-test item 2: sonnet-5 felt slow -- the
  // old hardwired max bought thinking budget casual chat doesn't need).
  // 'high' is run.sh's own `${EFFORT_LEVEL:-high}` default; labels say so
  // rather than pre-selecting silently.
  const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
  const EFFORT_DEFAULT = 'high'

  const AGENT_POLL_INTERVAL_MS = 2000
  const MAX_DISABLE_MS = 30000
  let agentPollTimer = null
  let agentControlsBusy = false
  let lastPolledState = null
  let busyStartState = null
  let busySawChange = false
  let busyDeadline = 0
  let currentProvider = null
  let currentModel = ''
  let currentEffort = EFFORT_DEFAULT
  // Providers with a usable credential/login artifact right now, computed
  // server-side (07-13 multi-provider unlock). The onboarded provider is
  // always treated as available even if the server list momentarily misses
  // it -- the running agent is its own proof.
  let availableProviders = []

  function stopAgentPoll() { if (agentPollTimer) { clearTimeout(agentPollTimer); agentPollTimer = null } }

  function renderAgentStatus(state) {
    const line = $('agent-status-line')
    line.textContent = AGENT_COPY.states[state] || state
    line.className = 'status-line'
    if (state === 'live') line.classList.add('success')
    else if (state === 'failed') line.classList.add('failure')
    else if (state === 'connecting' || state === 'idle') line.classList.add('pending')
    const running = state === 'live' || state === 'connecting'
    const toggle = $('agent-btn-startstop')
    toggle.textContent = running ? AGENT_COPY.stop : AGENT_COPY.start
    toggle.dataset.action = running ? 'stop' : 'start'
    $('agent-btn-restart').classList.toggle('hidden', !running)
  }

  function setAgentControlsDisabled(disabled) {
    agentControlsBusy = disabled
    if (disabled) {
      // Snapshot the state the action fired from + arm the backstop deadline.
      busyStartState = lastPolledState
      busySawChange = false
      busyDeadline = Date.now() + MAX_DISABLE_MS
    }
    $('agent-model-select').disabled = disabled
    $('agent-effort-select').disabled = disabled
    $('agent-btn-startstop').disabled = disabled
    $('agent-btn-restart').disabled = disabled
  }

  async function pollAgentStatusOnce() {
    try {
      const result = await api('/api/agent/status')
      renderAgentStatus(result.state)
      lastPolledState = result.state
      if (agentControlsBusy) {
        // Button-disable is the ONLY concurrency defense (server isn't
        // serialized), so it must hold for the WHOLE action, not just to the
        // first poll. The polled status is noisy mid-transition: a stale-fresh
        // .agent-live marker still reads 'live' for seconds into a stop/restart,
        // and a just-started agent reads 'stopped' until its spawn stamps
        // 'connecting'. Re-enabling on "state != connecting" alone would release
        // mid-action and let a second click race the first (intentionalStopMode
        // is a single global flag -- a Stop landing during a Restart corrupts
        // it). So: require having OBSERVED the state leave what it was when the
        // action fired (busySawChange) before accepting a terminal state -- the
        // "wait for the process to actually turn over" Mino asked for. The
        // deadline is the backstop so a missed transition can't lock forever.
        if (result.state !== busyStartState) busySawChange = true
        const settled = result.state !== 'connecting' && busySawChange
        if (settled || Date.now() >= busyDeadline) setAgentControlsDisabled(false)
      }
    } catch (err) {
      console.error('agent status poll failed:', err)
    }
    agentPollTimer = setTimeout(pollAgentStatusOnce, AGENT_POLL_INTERVAL_MS)
  }

  // Returns true when the server accepted the action (202), false when it
  // rejected or the request failed -- callers that mutate local state before
  // firing (model/effort switch) roll back on false (spark review 07-13:
  // a 409'd cross-provider switch used to leave currentProvider drifted
  // until page reload).
  async function fireControl(action, body) {
    if (agentControlsBusy) return false
    setAgentControlsDisabled(true)
    try {
      await api(`/api/agent/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      // Stay disabled until pollAgentStatusOnce sees a settled state.
      return true
    } catch (err) {
      console.error(`agent ${action} failed:`, err)
      showToast(GEN(err.message))
      setAgentControlsDisabled(false)
      return false
    }
  }

  function populateModelSelect(model) {
    const sel = $('agent-model-select')
    sel.innerHTML = ''
    // If the live MODEL isn't a catalog id (e.g. a pinned 'claude-opus-4-6'),
    // surface it as-is so the dropdown reflects reality, not a guess.
    if (model && !MODEL_CATALOG.some((m) => m.id === model)) {
      const opt = document.createElement('option')
      opt.value = model
      opt.textContent = `${model} (current)`
      opt.selected = true
      sel.appendChild(opt)
    }
    for (const m of MODEL_CATALOG) {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = m.label
      // A model is selectable if ANY of its providers is authenticated --
      // not just the currently-running one (07-13 multi-provider unlock).
      if (!m.providers.some((p) => availableProviders.includes(p))) opt.disabled = true
      // Confirmed-broken tool-use models are never selectable (see catalog note).
      if (m.brokenToolUse) opt.disabled = true
      if (m.id === model) opt.selected = true
      sel.appendChild(opt)
    }
  }

  function populateEffortSelect(effort) {
    const sel = $('agent-effort-select')
    sel.innerHTML = ''
    for (const level of EFFORT_LEVELS) {
      const opt = document.createElement('option')
      opt.value = level
      opt.textContent = level === EFFORT_DEFAULT ? `${level} (default)` : level
      if (level === effort) opt.selected = true
      sel.appendChild(opt)
    }
  }

  // The provider a model switch must run under: keep the current provider
  // when it can serve the model, otherwise the first authenticated provider
  // that can. Returns null when none can (shouldn't happen for an enabled
  // option, but fail closed).
  function providerForModel(modelId) {
    const entry = MODEL_CATALOG.find((m) => m.id === modelId)
    if (!entry) return currentProvider // pinned non-catalog id: stay put
    if (entry.providers.includes(currentProvider)) return currentProvider
    return entry.providers.find((p) => availableProviders.includes(p)) || null
  }

  async function renderAgentControl() {
    $('cat-agent-control-label').textContent = AGENT_COPY.label
    $('agent-model-label').textContent = AGENT_COPY.modelLabel
    $('agent-effort-label').textContent = AGENT_COPY.effortLabel

    let cfg = {}
    try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    currentProvider = cfg.PROVIDER || null
    currentModel = cfg.MODEL || ''
    currentEffort = EFFORT_LEVELS.includes(cfg.EFFORT_LEVEL) ? cfg.EFFORT_LEVEL : EFFORT_DEFAULT
    availableProviders = Array.isArray(cfg.availableProviders) ? cfg.availableProviders.slice() : []
    if (currentProvider && !availableProviders.includes(currentProvider)) availableProviders.push(currentProvider)
    populateModelSelect(currentModel)
    populateEffortSelect(currentEffort)

    $('agent-model-select').onchange = async (e) => {
      const model = e.target.value
      if (model === currentModel) return
      const provider = providerForModel(model)
      if (!provider) { e.target.value = currentModel; return } // fail closed: no authed provider serves it
      const ok = await confirmDialog(AGENT_COPY.switchConfirm(model), AGENT_COPY.switchOk, AGENT_COPY.cancel)
      if (!ok) { e.target.value = currentModel; return }
      const prevModel = currentModel
      const prevProvider = currentProvider
      currentModel = model
      currentProvider = provider
      const accepted = await fireControl('model', provider !== prevProvider ? { model, provider } : { model })
      if (!accepted) {
        currentModel = prevModel
        currentProvider = prevProvider
        e.target.value = prevModel
      }
    }

    $('agent-effort-select').onchange = async (e) => {
      const effort = e.target.value
      if (effort === currentEffort) return
      const ok = await confirmDialog(AGENT_COPY.effortConfirm(effort), AGENT_COPY.switchOk, AGENT_COPY.cancel)
      if (!ok) { e.target.value = currentEffort; return }
      const prevEffort = currentEffort
      currentEffort = effort
      const accepted = await fireControl('effort', { effort })
      if (!accepted) {
        currentEffort = prevEffort
        e.target.value = prevEffort
      }
    }

    $('agent-btn-startstop').onclick = async () => {
      const action = $('agent-btn-startstop').dataset.action
      if (action === 'stop') {
        const ok = await confirmDialog(AGENT_COPY.stopConfirm, AGENT_COPY.stopOk, AGENT_COPY.cancel)
        if (!ok) return
      }
      await fireControl(action)
    }
    $('agent-btn-restart').onclick = () => fireControl('restart')

    // Discord-open button (moved here from wizard renderStep5Live, which the
    // onboarding auto-nav now skips). Needs BOTH ids: guild from .agent-config
    // (persisted at discord/validate), channel from .env via the camelCase
    // ride-along. Installs onboarded before HOME_GUILD_ID persistence existed
    // won't have the guild id -> button stays hidden until re-onboarding.
    // Deliberately NOT part of setAgentControlsDisabled: opening a browser tab
    // is independent of agent lifecycle.
    const discordBtn = $('agent-btn-discord')
    if (cfg.HOME_GUILD_ID && cfg.homeChannelId) {
      discordBtn.textContent = AGENT_COPY.openDiscord
      discordBtn.classList.remove('hidden')
      discordBtn.onclick = async () => {
        try {
          await api('/api/discord/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guildId: cfg.HOME_GUILD_ID, channelId: cfg.homeChannelId }),
          })
        } catch (err) {
          console.error('discord open failed:', err)
          showToast(GEN(err.message))
        }
      }
    }

    stopAgentPoll()
    pollAgentStatusOnce()
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

    renderAgentControl()
    await loadSessionGroup()
    for (const table of ['user_facts', 'open_threads', 'corrections', 'preferences']) {
      loadCategory(table)
    }
  }

  init()
})()
