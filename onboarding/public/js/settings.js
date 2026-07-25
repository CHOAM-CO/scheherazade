// settings.js — settings page: rename agent + agent model/effort config
// (moved from memory.js's agent control panel, subpage split 2026-07-14) +
// autonomous cycle. Provider auth + Slack moved to connectors.js.
;(function () {
  const C = window.COPY.settings
  const GEN = window.COPY.genericError

  function $(id) { return document.getElementById(id) }

  // window.api() / window.showToast() now live in nav.js (loaded before this
  // file on settings.html) -- consolidated from what used to be local copies
  // here and in memory.js.

  // ── autonomous cycle (v0.0.6) ──────────────────────────────────────────
  // This section shows the user a number that is being spent on their behalf
  // while they sleep, so it is written to be un-flatterable:
  //   - the token count is the SAME number the cap is enforced against
  //   - when the meter cannot measure, it says that instead of showing 0
  //   - "used 0 tokens" and "cannot tell you how many tokens" never render
  //     the same way, because only one of them means nothing was spent
  const fmtTokens = (n) => Number(n || 0).toLocaleString()

  function renderAutonomy(a) {
    $('set-autonomy-enabled').checked = a.enabled === true
    $('set-autonomy-start').value = a.windowStart
    $('set-autonomy-end').value = a.windowEnd
    $('set-autonomy-cap').value = String(a.cap)

    const usageEl = $('set-autonomy-usage')
    if (a.today && a.today.ok) {
      // Today's TOTAL -- the owner's own conversations included. This is not the
      // number the cap is enforced against (that one is per-night), and the copy
      // says so rather than letting one label cover two measurements.
      usageEl.textContent = `${C.autonomyUsageLabel}: ${fmtTokens(a.today.total)}`
    } else {
      // Not a blank, not a zero. The one sentence the user must never be
      // shown wrongly is "you spent nothing".
      usageEl.textContent = C.autonomyUsageBlind
    }

    const lastEl = $('set-autonomy-last')
    if (a.lastCycle && a.lastCycle.day) {
      const bits = [a.lastCycle.stopped ? C.autonomyLastCycleStopped : C.autonomyLastCycleRan]
      if (typeof a.lastCycle.used === 'number') bits.push(`${fmtTokens(a.lastCycle.used)} ${C.autonomyTokensWord}`)
      if (a.lastCycle.briefed) bits.push(C.autonomyLastCycleBriefed)
      lastEl.textContent = `${C.autonomyLastCycle} (${a.lastCycle.day}): ${bits.join(' / ')}`
    } else if (a.lastSkip) {
      lastEl.textContent = a.lastSkip.reason === 'cap' ? C.autonomySkipCap : C.autonomySkipMeter
    } else {
      lastEl.textContent = C.autonomyLastCycleNone
    }
  }

  async function loadAutonomy() {
    renderAutonomy(await api('/api/autonomy'))
  }

  async function saveAutonomy() {
    const statusEl = $('set-autonomy-status')
    statusEl.classList.add('hidden')
    const cap = Number(String($('set-autonomy-cap').value).replace(/[,\s]/g, ''))
    if (!Number.isFinite(cap) || cap < 0) {
      statusEl.textContent = C.autonomyInvalidCap
      statusEl.classList.remove('hidden')
      return
    }
    const btn = $('set-autonomy-save')
    btn.disabled = true
    try {
      await api('/api/autonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: $('set-autonomy-enabled').checked,
          windowStart: $('set-autonomy-start').value.trim(),
          windowEnd: $('set-autonomy-end').value.trim(),
          cap,
        }),
      })
      showToast(C.autonomySaved)
      await loadAutonomy() // re-read from the server, never trust the form
    } catch (err) {
      statusEl.textContent = /HH:MM|window/.test(err.message) ? C.autonomyInvalidWindow : (GEN.body || err.message)
      statusEl.classList.remove('hidden')
    } finally {
      btn.disabled = false
    }
  }

  async function init() {
    $('set-title').textContent = C.title
    // Three group headings (IA pass 2026-07-25) -- see settings.html.
    // Fallbacks for the same reason waiting.js carries them: a missing key
    // here collapses a group heading to empty space, which reads as a layout
    // bug rather than a copy bug and is much harder to trace back.
    $('set-group-agent').textContent = C.groupAgent || 'Agent'
    $('set-group-engine').textContent = C.groupEngine || 'Engine'
    $('set-group-system').textContent = C.groupSystem || 'System'
    $('set-signin-link').textContent = C.signinLink || 'Manage sign-ins'
    $('set-rename-label').textContent = C.renameLabel
    $('set-rename-save').textContent = C.renameButton

    $('set-autonomy-label').textContent = C.autonomyLabel
    $('set-autonomy-note').textContent = C.autonomyNote
    $('set-autonomy-enabled-label').textContent = C.autonomyEnableLabel
    $('set-autonomy-window-label').textContent = C.autonomyWindowLabel
    $('set-autonomy-window-note').textContent = C.autonomyWindowNote
    $('set-autonomy-cap-label').textContent = C.autonomyCapLabel
    $('set-autonomy-cap-note').textContent = C.autonomyCapNote
    $('set-autonomy-save').textContent = C.autonomySave
    $('set-autonomy-save').addEventListener('click', saveAutonomy)
    loadAutonomy().catch((err) => console.error(err))

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

    renderAgentConfig()
    renderCustomProvider().catch((err) => console.error(err))
    renderPermissions().catch((err) => console.error(err))
    renderTopology().catch((err) => console.error(err))
    renderSudo().catch((err) => console.error(err))
  }

  // ── sudo askpass (0.1.0 prep, P4) ────────────────────────────────────────
  // Write-only password field: the page shows WHETHER a password exists,
  // never the value, and clears the input after a successful save so the
  // plaintext doesn't linger in the DOM.
  async function renderSudo() {
    $('set-sudo-label').textContent = C.sudoLabel
    $('set-sudo-note').textContent = C.sudoNote
    $('set-sudo-enabled-label').textContent = C.sudoEnableLabel
    $('set-sudo-password-label').textContent = C.sudoPasswordLabel
    $('set-sudo-save').textContent = C.sudoSave

    let state = { enabled: false, hasPassword: false }
    try {
      state = await api('/api/sudo/config')
    } catch (err) {
      console.error(err)
    }
    $('set-sudo-enabled').checked = state.enabled === true
    $('set-sudo-state').textContent = state.hasPassword ? C.sudoStateStored : C.sudoStateEmpty

    $('set-sudo-save').onclick = async () => {
      const statusEl = $('set-sudo-status')
      const enabled = $('set-sudo-enabled').checked
      const password = $('set-sudo-password').value
      if (enabled && !password && !state.hasPassword) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = C.sudoNeedPassword
        return
      }
      try {
        await api('/api/sudo/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(password ? { enabled, password } : { enabled }),
        })
        $('set-sudo-password').value = ''
        state = await api('/api/sudo/config')
        $('set-sudo-state').textContent = state.hasPassword ? C.sudoStateStored : C.sudoStateEmpty
        showToast(C.sudoSaved)
        statusEl.classList.add('hidden')
      } catch (err) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = GEN(err.message)
      }
    }
  }

  // ── attach topology (0.1.0 prep, design-0016) ────────────────────────────
  // Select = intent (written to config, effective at next start/restart);
  // the state line + bootstrap card = reality from /api/topology. The app
  // NEVER runs the bootstrap -- it hands out the exact terminal line, because
  // TCC attribution must descend from the user's terminal, not from this
  // per-release binary (the entire point of the topology).
  async function renderTopology() {
    $('set-topology-label').textContent = C.topologyLabel
    $('set-topology-note').textContent = C.topologyNote
    $('set-topology-select-label').textContent = C.topologySelectLabel
    $('set-topology-save').textContent = C.topologySave
    $('set-topology-bootstrap-why').textContent = C.topologyBootstrapWhy
    $('set-topology-bootstrap-copy').textContent = C.topologyBootstrapCopy

    const sel = $('set-topology-select')
    sel.innerHTML = ''
    for (const [value, label] of [['spawn', C.topologySpawnOption], ['attach', C.topologyAttachOption]]) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      sel.appendChild(opt)
    }

    let topo = null
    try {
      topo = await api('/api/topology')
    } catch (err) {
      $('set-topology-state').textContent = GEN(err.message)
      return
    }
    sel.value = topo.topology
    renderTopologyState(topo)

    $('set-topology-bootstrap-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('set-topology-bootstrap-cmd').value)
        showToast(C.topologyBootstrapCopied)
      } catch (err) {
        console.error('clipboard write failed:', err)
      }
    }

    $('set-topology-save').onclick = async () => {
      const statusEl = $('set-topology-status')
      try {
        await api('/api/topology', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topology: sel.value }),
        })
        showToast(C.topologySaved)
        statusEl.classList.add('hidden')
        const fresh = await api('/api/topology')
        renderTopologyState(fresh)
      } catch (err) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = GEN(err.message)
      }
    }
  }

  function renderTopologyState(topo) {
    const stateEl = $('set-topology-state')
    const card = $('set-topology-bootstrap-card')
    if (topo.topology !== 'attach') {
      stateEl.textContent = C.topologyStateSpawn
      card.classList.add('hidden')
      return
    }
    if (!topo.tmuxPresent) {
      stateEl.textContent = C.topologyStateNoTmux
      card.classList.add('hidden')
      return
    }
    if (topo.sessionPresent) {
      stateEl.textContent = topo.paneDead ? C.topologyStatePaneDead : C.topologyStateAttached(topo.attachCmd)
      card.classList.add('hidden')
      return
    }
    stateEl.textContent = C.topologyStateBootstrapNeeded
    $('set-topology-bootstrap-cmd').value = topo.bootstrapCmd
    card.classList.remove('hidden')
  }

  // ── permission checklist (P0, 2026-07-15) ────────────────────────────────
  // docs/permission-visibility-design.md. Render rules mirror the autonomy
  // meter's honesty contract: 'indeterminate' is its own visible state
  // ("확인 불가"), never coerced into granted/denied; heuristic rows carry a
  // "추정" mark; SIP/sudo rows never grow an open-settings button. The
  // automation row is synthesized client-side as indeterminate-until-probed:
  // its probe SENDS an Apple event (may pop the consent dialog), so it only
  // ever runs from its own [확인] button, never from the status load.
  const PERMS_POLL_MS = 3000
  const PERMS_POLL_MAX = 20
  let permsPollTimer = null

  // No emoji (product register, copy.js header) -- state is words + the
  // existing status-line success/failure colors; indeterminate stays the
  // default muted color, visually its own third thing.
  function applyPermBadge(el, row) {
    el.className = 'status-line'
    let text
    if (row.granted === true) { el.classList.add('success'); text = C.permsGranted }
    else if (row.granted === false) { el.classList.add('failure'); text = C.permsDenied }
    else { text = C.permsIndeterminate }
    if (row.kind === 'heuristic' && row.granted !== 'indeterminate') text += ` (${C.permsHeuristicMark})`
    el.textContent = text
  }

  function renderPermRows(rows, deepLinks) {
    const box = $('set-perms-rows')
    box.innerHTML = ''
    // Server rows are the prompt-free set; automation joins client-side.
    const all = rows.slice()
    if (!all.some((r) => r.class === 'automation')) {
      all.push({ class: 'automation', granted: 'indeterminate', kind: 'heuristic' })
    }
    for (const r of all) {
      if (!C.permsClassNames[r.class]) continue // unknown probe row: nothing honest to label it with
      const rowEl = document.createElement('div')
      rowEl.className = 'agent-control-row'
      const label = document.createElement('label')
      label.textContent = C.permsClassNames[r.class]
      rowEl.appendChild(label)

      const right = document.createElement('span')
      const badge = document.createElement('span')
      applyPermBadge(badge, r)
      right.appendChild(badge)

      if (deepLinks && deepLinks[r.class]) {
        const btn = document.createElement('button')
        btn.textContent = C.permsOpenButton
        btn.style.marginLeft = '0.75rem'
        btn.onclick = async () => {
          btn.disabled = true
          try {
            await api('/api/permissions/open', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cls: r.class }),
            })
            showRelaunchBanner()
            startPermsPoll()
          } catch (err) {
            showToast(GEN(err.message))
          } finally {
            btn.disabled = false
          }
        }
        right.appendChild(btn)
      }

      if (r.class === 'automation') {
        const btn = document.createElement('button')
        btn.textContent = C.permsProbeButton
        btn.style.marginLeft = '0.75rem'
        btn.onclick = async () => {
          btn.disabled = true
          badge.className = 'status-line'
          badge.textContent = C.permsLoading
          try {
            const { row: probed } = await api('/api/permissions/probe-automation', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            })
            applyPermBadge(badge, probed)
          } catch (err) {
            badge.textContent = C.permsIndeterminate
            showToast(GEN(err.message))
          } finally {
            btn.disabled = false
          }
        }
        right.appendChild(btn)
      }

      rowEl.appendChild(right)
      box.appendChild(rowEl)

      if (C.permsClassNotes[r.class]) {
        const note = document.createElement('div')
        note.className = 'field-hint'
        note.textContent = C.permsClassNotes[r.class]
        box.appendChild(note)
      }
    }
  }

  function showRelaunchBanner() {
    const el = $('set-perms-relaunch')
    if (!el.classList.contains('hidden')) return
    el.classList.remove('hidden')
    el.textContent = `${C.permsRelaunchNote} `
    const btn = document.createElement('button')
    btn.textContent = C.permsRelaunchButton
    btn.style.marginLeft = '0.5rem'
    // Reuses the FDA relaunch route -- same app, same TCC cache, one path.
    btn.onclick = () => api('/api/onboarding/fda/relaunch', { method: 'POST' }).catch((err) => showToast(GEN(err.message)))
    el.appendChild(btn)
  }

  // Bounded refresh after the user opens a Settings pane: live-state probes
  // (screen/accessibility) reflect a toggle without relaunch, so polling
  // here lets the badge flip in front of the user. FDA stays stale until
  // relaunch -- the banner above owns that truth.
  function startPermsPoll() {
    if (permsPollTimer) return
    let n = 0
    permsPollTimer = setInterval(async () => {
      n += 1
      if (n > PERMS_POLL_MAX) {
        clearInterval(permsPollTimer)
        permsPollTimer = null
        return
      }
      try {
        const data = await api('/api/permissions/status')
        renderPermRows(data.rows, data.deepLinks)
      } catch {
        clearInterval(permsPollTimer)
        permsPollTimer = null
      }
    }, PERMS_POLL_MS)
  }

  async function renderPermissions() {
    $('set-perms-label').textContent = C.permsLabel
    $('set-perms-note').textContent = C.permsNote
    const box = $('set-perms-rows')
    box.textContent = C.permsLoading
    try {
      const data = await api('/api/permissions/status')
      renderPermRows(data.rows, data.deepLinks)
    } catch (err) {
      console.error('permissions status failed:', err)
      box.textContent = C.permsLoadFailed
    }
  }

  // ── agent model/effort config ───────────────────────────────────────────
  // Moved from memory.js's renderAgentControl (Slice 2, 2026-07-09) -- the
  // SELECT-driven half. The read-only status-display half (current
  // model/effort as text, start/stop/restart, mute-revert) now lives in the
  // nav.js shell; this page only writes config. Disable-lock is scoped to
  // just the two selects below (the shell's own start/stop/restart/
  // mute-revert controls lock independently in nav.js -- see there for why
  // this split doesn't recreate the original single 5-control lock).

  // Model catalog + provider gate. A model is selectable only if its provider
  // is the onboarded PROVIDER (single-provider today; claude-subscription
  // counts as claude). Claude ids use CLI aliases (version-independent).
  // Catalog reorg (Mino 2026-07-14 09:45, verbatim ask): "프로바이더별로
  // 정리좀 합시다 ... 버전까지 명시해줘". Groups render as <optgroup>; ids are
  // EXPLICIT versioned model ids, replacing the old version-independent CLI
  // aliases ('opus'/'sonnet'). Existing installs with an alias still stored
  // surface it via the pinned "(current)" passthrough below -- honest, and it
  // heals on the next swap.
  //
  // Receipts for the Claude ids (all ran live in the MAGI fleet):
  // claude-fable-5 + claude-opus-4-8 (ps-verified boots, 07-14),
  // claude-opus-4-6 (fleet default lane), claude-sonnet-5 (conf swap
  // 57e4744, ran 07-05). GPT: gpt-5.6-terra ran live (Skia lane, 07-10);
  // sol/luna are Mino-named siblings -- live-verify on first swap, the
  // mute-strike ledger is the backstop either way.
  const CLAUDE_PROVIDERS = ['claude', 'claude-cli', 'claude-subscription']
  // Sentinel model-select value for the Custom catalog entry below (custom-
  // provider addition, 2026-07-25) -- never sent to the server as a real
  // model id (see the onchange handler's early-return branch for it).
  const CUSTOM_MODEL_SENTINEL = '__custom__'
  const MODEL_CATALOG = [
    { id: 'claude-fable-5', label: 'Claude Fable 5', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', group: 'GPT', providers: ['chatgpt'] },
    { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', group: 'GPT', providers: ['chatgpt'] },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', group: 'GPT', providers: ['chatgpt'] },
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
    { id: 'deepseek-v4-pro:cloud', label: 'DeepSeek V4 Pro', group: 'Ollama', providers: ['ollama'] },
    // glm-5.2 tool-use verified live by Mino (2026-07-13 19:32, same ollama
    // lane as kimi: "glm5.2 << 문제 전혀없음") -- label cleared same day it
    // was added. sonnet-5 / opus-4.8 verified in the same test round.
    { id: 'glm-5.2:cloud', label: 'GLM 5.2', group: 'Ollama', providers: ['ollama'] },
    // (old single 'gpt' Codex entry replaced by the versioned GPT group above)
    // Custom (custom-provider addition, 2026-07-25): NOT a real model id --
    // an ACTION entry, not a switchable state. Selecting it never fires the
    // normal model-swap POST (see the onchange handler below); it just
    // points the user at the always-visible "커스텀 프록시" section further
    // down the page, where the actual base URL / API key / model id fields
    // live (three fields, too many for this single-select row). `custom:
    // true` (not a `providers` entry) so populateModelSelect() below never
    // disables it -- unlike every other row, availability here doesn't
    // depend on computeAvailableProviders() at all.
    { id: CUSTOM_MODEL_SENTINEL, label: C.customCatalogLabel, group: 'Custom', custom: true, providers: [] },
  ]

  // Effort selector (Mino 07-13 click-test item 2: sonnet-5 felt slow -- the
  // old hardwired max bought thinking budget casual chat doesn't need).
  // 'high' is run.sh's own `${EFFORT_LEVEL:-high}` default; labels say so
  // rather than pre-selecting silently.
  const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
  const EFFORT_DEFAULT = 'high'

  let currentProvider = null
  let currentModel = ''
  let currentEffort = EFFORT_DEFAULT
  // Providers with a usable credential/login artifact right now, computed
  // server-side (07-13 multi-provider unlock). The onboarded provider is
  // always treated as available even if the server list momentarily misses
  // it -- the running agent is its own proof.
  let availableProviders = []
  let agentConfigBusy = false

  function setAgentConfigDisabled(disabled) {
    agentConfigBusy = disabled
    $('set-model-select').disabled = disabled
    $('set-effort-select').disabled = disabled
  }

  // Same shape as nav.js's fireControl (POST + disable-lock + error toast) --
  // kept as its own local copy rather than shared, since it locks a disjoint
  // set of controls (see file-header note above). Unlike nav.js, this one
  // re-enables as soon as the request resolves rather than waiting for a
  // polled 'settled' state: this page carries no status poller of its own
  // (pollAgentStatusOnce lives solely in nav.js now), and the real safety net
  // either way is server-side (main.cjs awaits confirmed process death before
  // any respawn) -- the client disable here is UX-only, same as before.
  async function fireControl(action, body) {
    if (agentConfigBusy) return false
    setAgentConfigDisabled(true)
    try {
      await api(`/api/agent/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      return true
    } catch (err) {
      console.error(`agent ${action} failed:`, err)
      showToast(GEN(err.message))
      return false
    } finally {
      setAgentConfigDisabled(false)
    }
  }

  function populateModelSelect(model) {
    const sel = $('set-model-select')
    sel.innerHTML = ''
    // If the live MODEL isn't a catalog id (e.g. an old stored alias like
    // 'opus'/'sonnet' from before the versioned catalog, or a hand-pinned id),
    // surface it as-is so the dropdown reflects reality, not a guess.
    if (model && !MODEL_CATALOG.some((m) => m.id === model)) {
      const opt = document.createElement('option')
      opt.value = model
      opt.textContent = `${model} (current)`
      opt.selected = true
      sel.appendChild(opt)
    }
    // Grouped by provider family (<optgroup>), per Mino 2026-07-14. Group
    // order follows catalog order; entries without a group land at top level.
    const groups = new Map()
    for (const m of MODEL_CATALOG) {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = m.label
      // A model is selectable if ANY of its providers is authenticated --
      // not just the currently-running one (07-13 multi-provider unlock).
      // `m.custom` entries (custom-provider addition) opt OUT of this gate
      // entirely -- they are an action link into the section below, not a
      // switchable state, so availableProviders never applies to them.
      if (!m.custom && !m.providers.some((p) => availableProviders.includes(p))) opt.disabled = true
      // Models withdrawn for observed production failure (see catalog note).
      if (m.disabled) opt.disabled = true
      if (m.id === model) opt.selected = true
      if (m.group) {
        if (!groups.has(m.group)) {
          const og = document.createElement('optgroup')
          og.label = m.group
          groups.set(m.group, og)
          sel.appendChild(og)
        }
        groups.get(m.group).appendChild(opt)
      } else {
        sel.appendChild(opt)
      }
    }
  }

  function populateEffortSelect(effort) {
    const sel = $('set-effort-select')
    sel.innerHTML = ''
    for (const level of EFFORT_LEVELS) {
      const opt = document.createElement('option')
      opt.value = level
      opt.textContent = level === EFFORT_DEFAULT ? `${level} (default)` : level
      if (level === effort) opt.selected = true
      sel.appendChild(opt)
    }
  }

  // ── apply-state line (IA v0.0.9, red-team fold #1) ───────────────────────
  // The selects above are INTENT; the running child is REALITY (recorded at
  // spawn, GET /api/agent/spawn-info). This line explains the gap between
  // them -- most importantly the FAILED state: a spawn refused by the proxy
  // model-receipt gate (07-14 live catch class) lands its reason here, next
  // to the picker that caused it, not only in the app log.
  async function renderApplyState() {
    const el = $('set-apply-state')
    if (!el) return
    el.textContent = C.applyChecking
    let status = null
    let spawn = null
    try {
      status = await api('/api/agent/status')
      spawn = (await api('/api/agent/spawn-info')).spawn
    } catch (err) {
      console.error('apply-state probe failed:', err)
      el.textContent = ''
      return
    }
    if (status.state === 'failed') {
      el.textContent = C.applyFailed(status.detail || status.code || 'unknown')
      return
    }
    if (status.state === 'stopped' || status.state === 'idle') {
      el.textContent = C.applyStopped
      return
    }
    if (status.state === 'connecting') {
      el.textContent = C.applyPending(spawn && spawn.model ? spawn.model : '?')
      return
    }
    // live: compare reality against the current selects' intent.
    const intentModel = $('set-model-select').value
    const intentEffort = $('set-effort-select').value
    if (spawn && spawn.model === intentModel && (spawn.effort || EFFORT_DEFAULT) === intentEffort) {
      el.textContent = C.applyApplied(spawn.model, spawn.effort || EFFORT_DEFAULT)
    } else {
      el.textContent = C.applyMismatch(spawn && spawn.model ? spawn.model : '?')
    }
  }

  // After a model/effort change fires a restart, follow the settle rather
  // than leaving a stale line: poll status until it leaves 'connecting'
  // (bounded), then render the final verdict. This page deliberately has no
  // standing poller (nav.js owns the 2s one); this loop exists only while a
  // change is in flight.
  async function settleApplyState() {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const status = await api('/api/agent/status')
        if (status.state !== 'connecting') break
        $('set-apply-state').textContent = C.applyPending($('set-model-select').value)
      } catch { break }
    }
    renderApplyState()
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

  async function renderAgentConfig() {
    $('set-agent-config-label').textContent = C.agentConfigLabel
    $('set-model-label').textContent = C.modelLabel
    $('set-effort-label').textContent = C.effortLabel

    let cfg = {}
    try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    currentProvider = cfg.PROVIDER || null
    currentModel = cfg.MODEL || ''
    currentEffort = EFFORT_LEVELS.includes(cfg.EFFORT_LEVEL) ? cfg.EFFORT_LEVEL : EFFORT_DEFAULT
    availableProviders = Array.isArray(cfg.availableProviders) ? cfg.availableProviders.slice() : []
    if (currentProvider && !availableProviders.includes(currentProvider)) availableProviders.push(currentProvider)
    populateModelSelect(currentModel)
    populateEffortSelect(currentEffort)

    $('set-model-select').onchange = async (e) => {
      const model = e.target.value
      // Custom (custom-provider addition, 2026-07-25): an action, not a
      // state -- reset the dropdown back to what is actually running and
      // point the user at the always-visible section below instead of
      // firing a model-swap POST with a sentinel that is not a real id.
      if (model === CUSTOM_MODEL_SENTINEL) {
        e.target.value = currentModel
        const section = $('set-custom')
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      if (model === currentModel) return
      const provider = providerForModel(model)
      if (!provider) { e.target.value = currentModel; return } // fail closed: no authed provider serves it
      const ok = await window.confirmDialog(C.switchConfirm(model), C.switchOk, C.cancel)
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
        return
      }
      settleApplyState()
    }

    $('set-effort-select').onchange = async (e) => {
      const effort = e.target.value
      if (effort === currentEffort) return
      const ok = await window.confirmDialog(C.effortConfirm(effort), C.switchOk, C.cancel)
      if (!ok) { e.target.value = currentEffort; return }
      const prevEffort = currentEffort
      currentEffort = effort
      const accepted = await fireControl('effort', { effort })
      if (!accepted) {
        currentEffort = prevEffort
        e.target.value = prevEffort
        return
      }
      settleApplyState()
    }

    renderApplyState()
  }

  // ── custom provider (generic OpenAI-compatible proxy) ───────────────────
  // Settings-page-only addition (2026-07-25) -- like claude-subscription/
  // chatgpt/ollama before it (see http-server.cjs's ROUTER_WIRED comment),
  // there is no onboarding-wizard tab: reachable only from here, via its
  // own dedicated POST /api/agent/custom-provider (base URL + optional API
  // key + model id together -- no existing single-purpose endpoint accepted
  // all three). Always visible, same convention as Autonomy/Topology/Sudo
  // above: every category on this page is shown regardless of the current
  // provider, not gated on it -- switching TO custom and editing an
  // already-custom install's fields are the same form.
  const CUSTOM_PRESETS = [
    { label: C.customPresetClinePass, url: 'http://localhost:18084' },
    { label: C.customPresetGrok, url: 'http://localhost:8766' },
    { label: C.customPresetOllamaCloud, url: 'http://localhost:11434' },
    { label: C.customPresetCodexApi, url: 'http://localhost:18080' },
  ]

  async function renderCustomProvider() {
    $('set-custom-label').textContent = C.customLabel
    $('set-custom-note').textContent = C.customNote
    $('set-custom-preset-label').textContent = C.customPresetLabel
    $('set-custom-url-label').textContent = C.customUrlLabel
    $('set-custom-key-label').textContent = C.customKeyLabel
    $('set-custom-model-label').textContent = C.customModelLabel
    $('set-custom-model-input').placeholder = C.customModelPlaceholder
    $('set-custom-save').textContent = C.customSave

    const presetSel = $('set-custom-preset-select')
    presetSel.innerHTML = ''
    const blankOpt = document.createElement('option')
    blankOpt.value = ''
    blankOpt.textContent = C.customPresetPlaceholder
    presetSel.appendChild(blankOpt)
    for (const preset of CUSTOM_PRESETS) {
      const opt = document.createElement('option')
      opt.value = preset.url
      opt.textContent = preset.label
      presetSel.appendChild(opt)
    }
    // Populate the URL field on pick; the field stays a plain text input
    // the user can still edit afterward -- the preset only pre-fills it.
    presetSel.onchange = () => {
      if (presetSel.value) $('set-custom-url-input').value = presetSel.value
    }

    let cfg = {}
    try { cfg = await api('/api/config') } catch (err) { console.error(err) }
    $('set-custom-url-input').value = cfg.CUSTOM_BASE_URL || ''
    // Model id only pre-fills from the live config when custom is ALREADY
    // the running provider -- otherwise cfg.MODEL belongs to whatever
    // provider IS running, and showing it here would silently imply it is
    // this proxy's model.
    $('set-custom-model-input').value = cfg.PROVIDER === 'custom' ? (cfg.MODEL || '') : ''
    // Write-only, same convention as the sudo password field: never
    // reflects the stored value, only whether one exists (hasCustomApiKey,
    // GET /api/config). Cleared on every render, including right after a
    // successful save below.
    $('set-custom-key-input').value = ''
    $('set-custom-key-input').placeholder = cfg.hasCustomApiKey ? C.customKeyStoredPlaceholder : C.customKeyEmptyPlaceholder

    $('set-custom-save').onclick = async () => {
      const statusEl = $('set-custom-status')
      statusEl.classList.add('hidden')
      const baseUrl = $('set-custom-url-input').value.trim()
      const model = $('set-custom-model-input').value.trim()
      const apiKey = $('set-custom-key-input').value
      if (!baseUrl || !model) {
        statusEl.textContent = C.customMissingFields
        statusEl.classList.remove('hidden')
        return
      }
      const ok = await window.confirmDialog(C.customSwitchConfirm(model), C.switchOk, C.cancel)
      if (!ok) return
      const btn = $('set-custom-save')
      btn.disabled = true
      try {
        await api('/api/agent/custom-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl, apiKey, model }),
        })
        showToast(C.customSaved)
        // Re-read from the server, never trust the form (same principle
        // saveAutonomy() follows above) -- this also refreshes the model
        // select so the new custom model shows as "(current)" and
        // availableProviders now includes 'custom'.
        await renderCustomProvider()
        await renderAgentConfig()
        settleApplyState()
      } catch (err) {
        statusEl.textContent = GEN(err.message)
        statusEl.classList.remove('hidden')
      } finally {
        btn.disabled = false
      }
    }
  }

  init()
})()
