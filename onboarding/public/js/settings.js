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

    // ── about / manual update check (2026-08-04, Mino "오토 업데이트
    // 버튼 어딨니?" -- the nav banner is silent when you're current, so
    // this is the always-present surface: version + Check now). ────────
    $('set-group-about').textContent = C.groupAbout || 'About'
    $('set-about-label').textContent = C.aboutLabel || 'App'
    const updStatus = $('set-update-status')
    const updOpen = $('set-update-open')
    api('/api/update/check').then((u) => {
      // cached read on load: paint version + state without spending a
      // GitHub call (the server serves its 6h cache here)
      $('set-about-version').textContent = C.aboutVersion(u.current || '?')
      if (u.ok && u.hasUpdate) {
        updStatus.textContent = C.updateAvailableLine(u.latest)
        updOpen.textContent = C.updateOpenButton
        updOpen.classList.remove('hidden')
        updOpen.onclick = () => window.open(u.url, '_blank', 'noopener')
      }
    }).catch(() => { $('set-about-version').textContent = C.aboutVersion('?') })
    $('set-update-check').textContent = C.updateCheckButton
    $('set-update-check').onclick = async () => {
      const btn = $('set-update-check')
      btn.disabled = true
      updStatus.className = 'status-line pending'
      updStatus.textContent = C.updateChecking
      try {
        const u = await api('/api/update/check?force=1')
        $('set-about-version').textContent = C.aboutVersion(u.current || '?')
        if (!u.ok) {
          updStatus.className = 'status-line failure'
          updStatus.textContent = C.updateCheckFailed(u.detail)
        } else if (u.hasUpdate) {
          updStatus.className = 'status-line'
          updStatus.textContent = C.updateAvailableLine(u.latest)
          updOpen.textContent = C.updateOpenButton
          updOpen.classList.remove('hidden')
          updOpen.onclick = () => window.open(u.url, '_blank', 'noopener')
        } else {
          updStatus.className = 'status-line success'
          updStatus.textContent = C.updateUpToDate
          updOpen.classList.add('hidden')
        }
      } catch (err) {
        updStatus.className = 'status-line failure'
        updStatus.textContent = GEN(err.message)
      } finally {
        btn.disabled = false
      }
    }

    // ── danger zone: clean uninstall (v0.0.35) ─────────────────────────
    $('set-group-danger').textContent = C.groupDanger || 'Danger zone'
    $('set-danger-label').textContent = C.dangerLabel
    $('set-danger-note').textContent = C.dangerNote
    $('set-danger-delete').textContent = C.dangerButton
    $('set-danger-delete').onclick = async () => {
      let name = 'Scheherazade'
      try { name = (await api('/api/config')).DISPLAY_NAME || name } catch { /* generic name is fine */ }
      const ok = await window.confirmDialog(C.dangerConfirm(name), C.dangerConfirmButton, C.dangerCancel)
      if (!ok) return
      const btn = $('set-danger-delete')
      btn.disabled = true
      try {
        await api('/api/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'DELETE' }),
        })
        // The server answers, then exits: this toast is the last thing the
        // window shows before the app closes itself.
        showToast(C.dangerDone)
      } catch (err) {
        btn.disabled = false
        showToast(GEN(err.message))
      }
    }
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
    // Both of these are macOS-only surfaces, hidden rather than rendered
    // empty on Windows (Mino, first win install 2026-08-03):
    //  - permissions: every row is a TCC/macOS wall, and the buttons open
    //    x-apple.systempreferences: URLs that do nothing off macOS.
    //  - topology: attach mode IS tmux, which does not exist here; the copy
    //    tells the user to paste a command into Terminal to tie "macOS
    //    permissions to Terminal's lineage".
    if (window.IS_MAC) {
      renderPermissions().catch((err) => console.error(err))
      renderTopology().catch((err) => console.error(err))
    } else {
      for (const id of ['set-perms', 'set-topology']) {
        const el = document.getElementById(id)
        if (el) el.classList.add('hidden')
      }
    }
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
  // Ollama by-URL picker sentinel (2026-08-04) -- same action-not-state
  // contract as CUSTOM_MODEL_SENTINEL; never sent to the server.
  const OLLAMA_URL_SENTINEL = '__ollama_url__'
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
    // Ollama defaults re-picked by Mino 2026-08-04 19:17 ("이거 세개는 기본
    // 지원하고"): Kimi 2.7 Code / GLM 5.2 / DeepSeek V4 Flash (0731).
    // DeepSeek V4 Pro row dropped in the same ask. Ids are the LIVE
    // ollama.com catalog names (all three re-verified against /v1/models
    // today) -- the signin-era ':cloud' suffixes are gone from new rows;
    // old stored ids still work via normalizeOllamaCloudModel at spawn.
    //
    // Kimi note: kimi-k2 was dropped provider-wide 07-14 after the mute
    // incident (raw <|tool_call|> leakage on the LOCAL ollama lane; history
    // in git blame of this block). kimi-k2.7-code is a different model on a
    // different lane (ollama.com cloud, Anthropic-compat) and comes back on
    // Mino's explicit ask -- the mute-strike ledger stays as the backstop.
    { id: 'kimi-k2.7-code', label: 'Kimi 2.7 Code', group: 'Ollama', providers: ['ollama'] },
    // glm tool-use verified live by Mino (07-13 "glm5.2 << 문제 전혀없음";
    // re-verified on the cloud key lane today, 0.49 Bearer fix round).
    { id: 'glm-5.2', label: 'GLM 5.2', group: 'Ollama', providers: ['ollama'] },
    // deepseek verified live by Mino on v0.0.40 ("딥시크 확인 완료, 잘
    // 붙는다", 11:46) and the 0731 tag confirmed present in today's catalog.
    { id: 'deepseek-v4-flash:0731', label: 'DeepSeek V4 Flash (0731)', group: 'Ollama', providers: ['ollama'] },
    // By-URL picker (Mino 19:17): paste https://ollama.com/library/{name}
    // to run any catalog model the three rows above don't list. ACTION row
    // like the Custom sentinel below -- reveals the URL field, never POSTs
    // its own value. Gated on the ollama provider being authed (unlike
    // Custom, which opts out of gating entirely).
    { id: OLLAMA_URL_SENTINEL, label: C.ollamaUrlCatalogLabel, group: 'Ollama', providers: ['ollama'] },
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
      // Ollama by-URL picker (Mino 19:17): action row, same contract as
      // Custom above -- reset the select, reveal the paste field.
      if (model === OLLAMA_URL_SENTINEL) {
        e.target.value = currentModel
        const field = $('set-ollama-url-field')
        if (field) { field.classList.remove('hidden'); $('set-ollama-url-input').focus() }
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

    // ── ollama by-URL apply (Mino 19:17: "URL 입력받아서 ...
    // /library/{model_name} 파싱해서 드랍다운리스트에 없어도 모델 셀렉
    // 가능") ────────────────────────────────────────────────────────────
    $('set-ollama-url-hint').textContent = C.ollamaUrlHint
    $('set-ollama-url-input').placeholder = C.ollamaUrlPlaceholder
    $('set-ollama-url-apply').textContent = C.ollamaUrlApply
    $('set-ollama-url-apply').onclick = async () => {
      const raw = $('set-ollama-url-input').value.trim()
      const statusLine = $('set-ollama-url-status')
      const applyBtn = $('set-ollama-url-apply')
      if (!raw) return
      // Accept the library URL (https://ollama.com/library/kimi-k3, with or
      // without scheme/query/fragment) OR a bare model id (name / name:tag).
      // The URL form never carries a tag; a pasted bare id may.
      let parsed = null
      const urlMatch = raw.match(/ollama\.com\/library\/([A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?)/)
      if (urlMatch) parsed = urlMatch[1]
      else if (/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(raw)) parsed = raw
      if (!parsed) {
        statusLine.className = 'status-line failure'
        statusLine.textContent = C.ollamaUrlParseFailed
        return
      }
      if (!availableProviders.includes('ollama')) {
        statusLine.className = 'status-line failure'
        statusLine.textContent = C.ollamaUrlNoKey
        return
      }
      applyBtn.disabled = true
      statusLine.className = 'status-line pending'
      statusLine.textContent = C.ollamaUrlChecking(parsed)
      // Pre-flight against ollama.com with the STORED key (keyless validate
      // falls back to it server-side) -- today's field day was one wrong
      // model name after another, so the catalog check runs before the
      // restart, not after. Warn-don't-block on model absence: the catalog
      // fetch is best-effort and a brand-new model may lag it.
      let warnLine = ''
      try {
        const v = await api('/api/byok/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'ollama', model: parsed }),
        })
        if (v.ok === false) {
          statusLine.className = 'status-line failure'
          statusLine.textContent = GEN(v.reason || 'validation failed')
          applyBtn.disabled = false
          return
        }
        if (v.modelPresent === false) warnLine = C.ollamaUrlModelWarn(parsed)
      } catch (err) { /* validate blip: proceed, the turn-error banner backstops */ }
      const ok = await window.confirmDialog(
        (warnLine ? warnLine + ' ' : '') + C.switchConfirm(parsed), C.switchOk, C.cancel)
      if (!ok) { applyBtn.disabled = false; statusLine.textContent = ''; return }
      const prevModel = currentModel
      const prevProvider = currentProvider
      currentModel = parsed
      currentProvider = 'ollama'
      const accepted = await fireControl('model', prevProvider !== 'ollama' ? { model: parsed, provider: 'ollama' } : { model: parsed })
      applyBtn.disabled = false
      if (!accepted) {
        currentModel = prevModel
        currentProvider = prevProvider
        statusLine.className = 'status-line failure'
        statusLine.textContent = C.ollamaUrlApplyFailed
        return
      }
      statusLine.className = 'status-line success'
      statusLine.textContent = C.ollamaUrlApplied(parsed)
      populateModelSelect(parsed)
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
  // Comparison for the save-time credential warning below. ORIGIN, not host:
  // an earlier version dropped the scheme, so moving a saved credential from
  // https://api.vendor.com to http://api.vendor.com read as "same host" and
  // said nothing -- a silent TLS downgrade that puts the key on the wire in
  // cleartext. Same host, different port is also a different service and
  // counts. A path change does not. Anything unparseable is treated as
  // DIFFERENT (warn rather than stay quiet); the server validates the URL for
  // real, this only decides whether to say something.
  const originOf = (u) => { try { return new URL(u).origin } catch { return '' } }
  const sameOrigin = (a, b) => { const x = originOf(a); return Boolean(x) && x === originOf(b) }

  // Decides whether saving is about to send an API key somewhere it was not
  // paired with. Pulled out as a PURE function on purpose: this predicate got
  // it wrong twice (once warning on the wrong comparison, once phrasing the
  // wrong key), and both times nothing could catch it because browser JS has
  // no test harness here. scripts/test-custom-key-host.mjs extracts this
  // function by name from this file's source and executes it -- so renaming it
  // breaks that test loudly, which is the intended trade.
  //
  // Returns { warn, stored, priorUrl }. `stored` selects the copy: a stored
  // key and a pasted key are different objects and the dialog must not call
  // one the other.
  function credentialCrossesHosts({ nextUrl, typedKey, keyFromPaste, pastedKeyBaseUrl, storedUrl, hasStoredKey }) {
    const typed = String(typedKey || '').trim()
    const reusingStoredKey = !typed && Boolean(hasStoredKey)
    const carryingPastedKey = Boolean(typed) && Boolean(keyFromPaste)
    if (!reusingStoredKey && !carryingPastedKey) return { warn: false, stored: false, priorUrl: '' }
    // A pasted key's reference host is the URL that arrived WITH it; a stored
    // key's is the URL it was stored under. One comparison cannot serve both.
    const priorUrl = carryingPastedKey ? String(pastedKeyBaseUrl || '') : String(storedUrl || '')
    // No reference recorded is UNKNOWN, not safe -- a key stored through
    // /api/byok/validate leaves no CUSTOM_BASE_URL behind, and a stored key
    // with no known host would otherwise travel anywhere in silence. A pasted
    // key with no baseUrl cannot happen (the paste is refused without one),
    // so that branch stays quiet rather than crying wolf.
    const warn = priorUrl ? !sameOrigin(priorUrl, nextUrl) : reusingStoredKey
    return { warn, stored: reusingStoredKey, priorUrl }
  }

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
    // Whether the value sitting in the key field came from a PASTE rather than
    // from the user's own typing -- the save-time host warning below turns on
    // it. Declared per render, so it resets with the form; cleared as soon as
    // the user edits the field, because from that point the value is theirs
    // and they chose it against the URL they can see.
    let keyFromPaste = false
    // The baseUrl that arrived in the SAME paste as the key. This is the host
    // the pasted key was paired with, and the only correct thing to compare a
    // later URL change against.
    let pastedKeyBaseUrl = ''
    $('set-custom-key-input').oninput = () => { keyFromPaste = false; pastedKeyBaseUrl = '' }

    // Pasted definition (2026-07-29). Resolves server-side and fills the three
    // fields above; it never saves. The status line stays visible after a
    // successful fill (unlike the save path's transient toast) because the
    // user's next action is to look UP at fields that just changed under them.
    $('set-custom-json-status').classList.add('hidden') // stale "filled in" must not survive a re-render (this runs again after every save)
    $('set-custom-json-summary').textContent = C.customJsonSummary
    $('set-custom-json-note').textContent = C.customJsonNote
    $('set-custom-json-input').placeholder = C.customJsonPlaceholder
    $('set-custom-json-load').textContent = C.customJsonLoad
    $('set-custom-json-load').onclick = async () => {
      const statusEl = $('set-custom-json-status')
      statusEl.classList.add('hidden')
      const json = $('set-custom-json-input').value
      if (!json.trim()) {
        statusEl.textContent = C.customJsonEmpty
        statusEl.classList.remove('hidden')
        return
      }
      const btn = $('set-custom-json-load')
      btn.disabled = true
      try {
        const parsed = await api('/api/agent/custom-provider/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ json }),
        })
        $('set-custom-url-input').value = parsed.baseUrl
        $('set-custom-model-input').value = parsed.model
        // ALWAYS assign, never `if (parsed.apiKey)`. A conditional here leaks
        // across fills: paste A carries a key, paste B (a different endpoint)
        // does not, and the key field -- type="password", so the user cannot
        // see it -- still holds A's key, which then gets saved and sent to B's
        // host. Every fill leaves the field showing exactly what the CURRENT
        // paste says. (Red-team catch, 2026-07-29.)
        $('set-custom-key-input').value = parsed.apiKey || ''
        keyFromPaste = Boolean(parsed.apiKey)
        pastedKeyBaseUrl = parsed.apiKey ? parsed.baseUrl : ''
        // Blank field means "keep the stored key" at the save route, so when
        // the paste has no key AND one is on file, say so -- otherwise the
        // user switches endpoint believing no key is involved while the
        // previous provider's key keeps being sent.
        statusEl.textContent = parsed.apiKey
          ? C.customJsonLoadedWithKey
          : (cfg.hasCustomApiKey ? C.customJsonLoadedKeptKey : C.customJsonLoaded)
        statusEl.classList.remove('hidden')
      } catch (err) {
        // The server's refusals are the useful message here (">1 provider",
        // unsupported api dialect, bad base URL) -- show them verbatim rather
        // than flattening every failure into one generic line.
        statusEl.textContent = GEN(err.message)
        statusEl.classList.remove('hidden')
      } finally {
        btn.disabled = false
      }
    }

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
      // A key is about to be sent to a host it was not entered for.
      //
      // Two ways to get here, and the confirm dialog is the only place that
      // catches BOTH, which is why the check lives at save rather than at the
      // point any single field changes:
      //   1. A pasted definition filled the key field for endpoint A, then the
      //      preset dropdown or the URL box changed the host to B. Nothing
      //      clears the key on those paths (see presetSel.onchange above), and
      //      the field is type="password" so a populated one is invisible.
      //   2. The field is BLANK and a key is on file. Blank means "keep the
      //      stored key" at the save route -- the documented convention -- so
      //      changing only the URL silently re-points the stored credential at
      //      a new host. That path predates the paste box entirely.
      // Both end with a credential at a host the user never paired it with.
      // We do not block it (pointing one key at two proxies is legitimate);
      // we refuse to let it happen without saying the host out loud.
      // NOT warned about: a key the user typed into the field during this
      // visit. They entered it while looking at the URL box, so it is the
      // host they meant. Warning there would fire on the single most common
      // flow -- "switching proxies, here is its key" -- and a warning that
      // cries wolf on the normal case gets clicked through on the abnormal
      // one, which costs more than it saves. Hence keyFromPaste, cleared the
      // moment the user touches the field themselves.
      // TWO cases, TWO reference hosts. Collapsing them onto one comparison
      // (the stored CUSTOM_BASE_URL) was wrong in both directions:
      //   - it MISSED the leak it was written for. Saved localhost:8766, paste
      //     vendor-A's url+key, then pick the Grok preset -> url returns to
      //     localhost:8766, stored-vs-final says "same host", no warning, and
      //     vendor A's key is saved against localhost:8766.
      //   - it FIRED on the normal case. Paste a definition whose baseUrl and
      //     apiKey travel together, change nothing, and it warned -- about a
      //     key that was paired with that exact host inside the same blob.
      // A pasted key's reference is the URL that arrived WITH it; a stored
      // key's reference is the URL it was stored under.
      const verdict = credentialCrossesHosts({
        nextUrl: baseUrl,
        typedKey: apiKey,
        keyFromPaste,
        pastedKeyBaseUrl,
        storedUrl: cfg.CUSTOM_BASE_URL || '',
        hasStoredKey: Boolean(cfg.hasCustomApiKey),
      })
      // Three outcomes, three strings -- see copy.js. `priorOrigin` is empty
      // when the reference URL is missing OR unparseable, and both mean the
      // same thing to the user: we cannot name the host it came from, so we
      // must not print one.
      const nextOrigin = originOf(baseUrl) || baseUrl
      const priorOrigin = originOf(verdict.priorUrl)
      let confirmText
      if (!verdict.warn) confirmText = C.customSwitchConfirm(model)
      else if (!verdict.stored) confirmText = C.customSwitchConfirmPastedKeyToNewHost(model, nextOrigin, priorOrigin || verdict.priorUrl)
      else if (priorOrigin) confirmText = C.customSwitchConfirmKeyToNewHost(model, nextOrigin, priorOrigin)
      else confirmText = C.customSwitchConfirmKeyNoPriorHost(model, nextOrigin)
      const ok = await window.confirmDialog(confirmText, C.switchOk, C.cancel)
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
