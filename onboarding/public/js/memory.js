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
    // Mute-revert offer (2026-07-13). Deliberately describes the OBSERVED
    // behavior ("hasn't replied") rather than diagnosing a cause -- the one
    // time we shipped a cause ("this model can't call tools") it turned out to
    // be false under 7 live conditions. State what we saw; offer the undo.
    muteWarn: (n, m) => `${m} was asked to reply ${n}× and didn't. The agent may be unable to send messages.`,
    muteRevert: (m) => `Go back to ${m}`,
    muteRevertConfirm: (m) => `Switch back to ${m}? The agent will restart.`,
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

  // Model catalog + provider gate. A model is selectable only if its provider
  // is the onboarded PROVIDER (single-provider today; claude-subscription
  // counts as claude). Claude ids use CLI aliases (version-independent).
  const MODEL_CATALOG = [
    { id: 'opus', label: 'Claude Opus', providers: ['claude', 'claude-cli', 'claude-subscription'] },
    { id: 'sonnet', label: 'Claude Sonnet', providers: ['claude', 'claude-cli', 'claude-subscription'] },
    // Kimi: DROPPED entirely (Mino, 2026-07-14 09:27 "키미는 프로바이더째로
    // 드랍하자"). History compressed so nobody re-litigates it:
    //   - Went mute in Mino's install (07-13). The first diagnosis ("ollama
    //     lane can't produce tool_use", welded here at 638fbf7) was FALSIFIED
    //     live the same night in 7 conditions incl. the real CLI + a real MCP
    //     server with file receipts -- the lane DOES carry kimi tool calls.
    //   - The failing transcript itself (chunsik session cd209c48, read 07-14
    //     01:3x) showed kimi emitting raw <|tool_call...|> token sequences
    //     that leaked as text in THAT session: the emission is intermittent,
    //     and when it happens the lane cannot translate it. The fix would have
    //     been a translating proxy (est. half-day+); Mino called the lane not
    //     worth it.
    //   - The mute-strike ledger (hooks/stop-reply-guard.mjs +
    //     /api/agent/mute-status + revert banner) was born from this case and
    //     STAYS: it convicts mute agents on real behavior, whatever the model.
    //     (A swap-time smoke test can only acquit falsely -- every probe
    //     passed the model that was mute in production.)
    // deepseek verified live by Mino (2026-07-13 19:41 "딥시크 정상작동 확인",
    // same round as glm/sonnet-5/opus-4.8; model-swap continuity also held).
    { id: 'deepseek-v4-pro:cloud', label: 'DeepSeek V4 Pro', providers: ['ollama'] },
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
    // The revert button fires the SAME /api/agent/model route as the dropdown,
    // so it must sit behind the SAME lock (red-team 2026-07-13: it was added
    // outside it). Button-disable is this page's only concurrency defense --
    // the server is deliberately not serialized -- so a control that skips it
    // can race a swap that's already in flight.
    $('agent-mute-revert').disabled = disabled
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
    // Rides the existing 2s poll rather than adding a second timer: the mute
    // check is one cheap file read server-side, and a separate cadence would
    // just be another thing that can drift out of sync with the status line.
    // Failures are swallowed inside renderMuteBanner -- a mute-check outage
    // must never take down the status poll that everything else depends on.
    await renderMuteBanner()
    agentPollTimer = setTimeout(pollAgentStatusOnce, AGENT_POLL_INTERVAL_MS)
  }

  // The revert offer. Shown ONLY when the guard's ledger says the running model
  // was explicitly told to send and still didn't (threshold strikes), AND we
  // know a model to go back to. No previous model -> no banner: an offer with
  // nowhere to go is just an alarm.
  async function renderMuteBanner() {
    const banner = $('agent-mute-banner')
    if (!banner) return
    let s
    try {
      s = await api('/api/agent/mute-status')
    } catch (err) {
      console.error('mute status poll failed:', err)
      return // leave the banner in whatever state it was; don't flap on a blip
    }
    const tripped = (s.strikes || 0) >= (s.threshold || 2) && Boolean(s.previousModel)
    if (!tripped) { banner.hidden = true; return }
    $('agent-mute-text').textContent = AGENT_COPY.muteWarn(s.strikes, s.model || 'the model')
    const btn = $('agent-mute-revert')
    btn.textContent = AGENT_COPY.muteRevert(s.previousModel)
    // The banner can first APPEAR mid-action (this poll runs every 2s), and a
    // freshly-shown button defaults to enabled -- so it has to inherit the lock
    // on render, not only when setAgentControlsDisabled happens to fire.
    btn.disabled = agentControlsBusy
    btn.onclick = async () => {
      // Second half of the lock: `disabled` blocks the click, but the confirm
      // dialog is async -- an action can start WHILE this dialog is open. Re-check
      // on the way out so a swap that began during the prompt isn't raced.
      if (agentControlsBusy) return
      const ok = await confirmDialog(AGENT_COPY.muteRevertConfirm(s.previousModel), AGENT_COPY.switchOk, AGENT_COPY.cancel)
      if (!ok || agentControlsBusy) return
      // Route through the same swap lane as the dropdown (which records the
      // new PREVIOUS_* pair and clears the ledger) instead of a bespoke revert
      // endpoint -- one swap path, one place for swap semantics to live.
      const body = s.previousProvider ? { model: s.previousModel, provider: s.previousProvider } : { model: s.previousModel }
      const accepted = await fireControl('model', body)
      if (accepted) {
        banner.hidden = true
        currentModel = s.previousModel
        if (s.previousProvider) currentProvider = s.previousProvider
        populateModelSelect(currentModel)
      }
    }
    banner.hidden = false
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
      // Models withdrawn for observed production failure (see catalog note).
      if (m.disabled) opt.disabled = true
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
      const ok = await confirmDialog(P.clearConfirm, P.clearOk, AGENT_COPY.cancel)
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
