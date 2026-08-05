// nav.js — shared shell for every post-onboarding page (memory / connectors /
// settings). Loads after copy.js, before the page-specific script, and
// renders into <div id="app-nav"> at the top of each page's .page-shell.
//
// Mechanically extracted from memory.js's "Agent control panel" (Slice 2,
// 2026-07-09) per docs/ia-subpage-plan.md's shell principle: "셸은 현실,
// 설정은 의도" -- read-only status + the command-shaped actions (start/stop/
// restart/Discord open) + the mute-revert banner live here; the model/effort
// SELECT config moved to settings.js. Same endpoints, same polling cadence,
// same copy as before (still eng placeholder pending Mino's copy-track
// localization pass -- unchanged by this move, just relocated).
//
// Also the new single home for window.api()/window.showToast(), previously
// duplicated in memory.js + settings.js (wizard.js keeps its own local
// copies -- the onboarding wizard page never includes this shell).

;(function () {
  const NAV = window.COPY.nav
  const GEN = window.COPY.genericError

  function $(id) { return document.getElementById(id) }

  // ── window.api (consolidated; was duplicated in memory.js + settings.js) ──
  window.api = async function api(path, options) {
    const opts = options ? { ...options } : {}
    // localhost-auth gate (security review 2026-07-03; widened to ALL
    // requests 2026-08-04): every /api request must carry the per-launch
    // token the server injected into this page's <head> -- see copy.js's
    // getOnboardToken(). GETs included: the server now rejects tokenless
    // reads too, since the memory tables live behind GET routes.
    opts.headers = { ...(opts.headers || {}), 'X-Onboard-Token': window.getOnboardToken() || '' }
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

  // ── window.showToast (consolidated; was duplicated in memory.js + settings.js) ──
  // Targets whichever `.toast` element the current page declares -- every
  // page still owns its own toast <div> (unchanged), only the function moved.
  window.showToast = function showToast(text) {
    const el = document.querySelector('.toast')
    if (!el) return
    el.textContent = text
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
  }

  // ── window.confirmDialog ────────────────────────────────────────────────
  // NOT part of the task's explicit consolidation list, but required by the
  // split: fireControl's stop-confirm and the mute-revert-confirm both used
  // to share memory.js's #m-dialog markup, and that markup only exists on
  // memory.html. Since nav.js now renders on pages that never had a dialog
  // element (settings.html, connectors.html), the shell grows its own,
  // built the same way the rest of this file builds its DOM (dynamically,
  // since it has to work on any page). memory.js keeps its OWN separate
  // #m-dialog-backed confirmDialog untouched, for its delete/pointer-clear
  // confirms -- this one only backs the shell's own confirms and (by
  // necessity, same reasoning) settings.js's model/effort switch confirms.
  let dialogEl = null
  function ensureDialog() {
    if (dialogEl) return dialogEl
    dialogEl = document.createElement('div')
    dialogEl.className = 'dialog-backdrop hidden'
    dialogEl.innerHTML =
      '<div class="dialog-box">' +
        '<p class="nav-dialog-text"></p>' +
        '<div class="dialog-actions">' +
          '<button class="secondary nav-dialog-cancel"></button>' +
          '<button class="danger nav-dialog-confirm"></button>' +
        '</div>' +
      '</div>'
    document.body.appendChild(dialogEl)
    return dialogEl
  }
  window.confirmDialog = function confirmDialog(message, confirmText, cancelText) {
    return new Promise((resolve) => {
      const dialog = ensureDialog()
      dialog.querySelector('.nav-dialog-text').textContent = message
      const confirmBtn = dialog.querySelector('.nav-dialog-confirm')
      const cancelBtn = dialog.querySelector('.nav-dialog-cancel')
      confirmBtn.textContent = confirmText
      cancelBtn.textContent = cancelText
      dialog.classList.remove('hidden')
      const cleanup = (result) => {
        dialog.classList.add('hidden')
        confirmBtn.onclick = null
        cancelBtn.onclick = null
        resolve(result)
      }
      confirmBtn.onclick = () => cleanup(true)
      cancelBtn.onclick = () => cleanup(false)
    })
  }

  // ── nav tabs ────────────────────────────────────────────────────────────
  // AUTHORED structure (the tab bar itself is new -- three pages didn't
  // exist together before this split); labels reuse the same words already
  // shipped as page titles (memoryPane.title / settings.title / the new
  // connectors.title) rather than inventing new ones. Active tab is derived
  // from the URL, never hand-set, so it can't drift from reality.
  const TABS = [
    // chat first (in-app chat slice 4, 2026-07-30). NAMED DEVIATION from
    // Mino 07-16 "맨 앞에 채널 섹션": that order was set when messengers
    // were the only way to talk to the agent; this tab IS the talking.
    // Flagged in the slice-4 report -- if Mino wants channels back first,
    // this one line is the revert.
    { id: 'chat', href: '/chat', label: NAV.tabs.chat },
    // channels next (multichannel v0.0.18, Mino 07-16 "맨 앞에 채널 섹션").
    // '/' still lands on /memory -- tab ORDER changed, the home page didn't;
    // changing the landing is a separate product call, not a ride-along.
    { id: 'channels', href: '/channels', label: NAV.tabs.channels },
    { id: 'memory', href: '/memory', label: NAV.tabs.memory },
    { id: 'connectors', href: '/connectors', label: NAV.tabs.connectors },
    { id: 'settings', href: '/settings', label: NAV.tabs.settings },
    { id: 'appearance', href: '/appearance', label: NAV.tabs.appearance },
    // logs LAST, deliberately low-key (Mino 07-16: "버튼 어딘가에 짱박아놓고")
    // -- a dev/debug surface, not a daily destination.
    { id: 'logs', href: '/logs', label: NAV.tabs.logs },
  ]

  function activeTabId() {
    const path = window.location.pathname
    if (path.startsWith('/chat')) return 'chat'
    if (path.startsWith('/channels')) return 'channels'
    if (path.startsWith('/connectors')) return 'connectors'
    if (path.startsWith('/settings')) return 'settings'
    if (path.startsWith('/appearance')) return 'appearance'
    if (path.startsWith('/logs')) return 'logs'
    return 'memory' // '/memory' and '/' both read as home
  }

  // ── shell skeleton ──────────────────────────────────────────────────────
  // Was memory.html's static cat-agent-control markup; relocated into JS
  // since it now has to render identically on three separate HTML pages.
  // Structure/classes are unchanged from the original (agent-control-actions,
  // mute-banner, status-line) so app.css's existing rules keep applying —
  // only .app-nav/.nav-status/.nav-tabs/.nav-tab are genuinely new classes.
  function renderSkeleton(root) {
    const active = activeTabId()
    root.innerHTML =
      '<div class="nav-status">' +
        '<span class="category-label" id="nav-agent-label"></span>' +
        '<span class="status-line" id="nav-status-line"></span>' +
        '<span class="nav-status-detail" id="nav-status-model"></span>' +
        '<span class="nav-status-detail" id="nav-status-effort"></span>' +
        '<span class="nav-status-detail" id="nav-status-context"></span>' +
        '<span class="nav-status-detail" id="nav-status-autonomy"></span>' +
        '<div class="agent-control-actions">' +
          '<button class="secondary" id="nav-btn-startstop"></button>' +
          '<button class="secondary hidden" id="nav-btn-restart"></button>' +
          '<button class="secondary hidden" id="nav-btn-discord"></button>' +
        '</div>' +
      '</div>' +
      '<div class="mute-banner" id="nav-mute-banner" hidden>' +
        '<div class="mute-banner-text" id="nav-mute-text"></div>' +
        '<button type="button" id="nav-mute-revert"></button>' +
      '</div>' +
      // update banner reuses .mute-banner styling on purpose -- same
      // "attention strip under the status row" slot, different concern
      '<div class="mute-banner" id="nav-update-banner" hidden>' +
        '<div class="mute-banner-text" id="nav-update-text"></div>' +
        '<button type="button" id="nav-update-open"></button>' +
      '</div>' +
      // turn-error banner (2026-08-04, Mino "클로드도 동작안함. 인증
      // 맛탱이간듯?"): when the model call itself fails (429 limit, 401
      // auth), the lane used to log to a file nobody reads and the UI
      // showed a healthy green "Running". This strip carries the actual
      // upstream error text so the user can tell limit-hit from re-login
      // without opening logs. Same .mute-banner slot as the other two.
      '<div class="mute-banner" id="nav-turnerror-banner" hidden>' +
        '<div class="mute-banner-text" id="nav-turnerror-text"></div>' +
        '<button type="button" id="nav-turnerror-dismiss"></button>' +
      '</div>' +
      '<div class="nav-tabs"></div>'
    $('nav-agent-label').textContent = NAV.label
    const tabsEl = root.querySelector('.nav-tabs')
    for (const t of TABS) {
      const a = document.createElement('a')
      a.href = t.href
      a.className = 'nav-tab' + (t.id === active ? ' active' : '')
      a.textContent = t.label
      tabsEl.appendChild(a)
    }
  }

  // ── status + lifecycle controls (start/stop/restart), extracted from
  // memory.js's renderAgentStatus/setAgentControlsDisabled/pollAgentStatusOnce
  // /fireControl. Scoped to only the elements the shell owns -- the
  // model/effort selects that used to share one disable-lock with these
  // moved to settings.js and now lock independently there (see settings.js
  // for that half). ──
  const AGENT_POLL_INTERVAL_MS = 2000
  const MAX_DISABLE_MS = 30000
  let agentPollTimer = null
  let controlsBusy = false
  let lastPolledState = null
  let busyStartState = null
  let busySawChange = false
  let busyDeadline = 0
  // Spawn-time reality (IA v0.0.9, "셸은 현실"): the running child's birth
  // model/effort from GET /api/agent/spawn-info -- NOT config. Refetched on
  // every state transition (a restart births a new child), blanked when
  // nothing runs: a stopped agent has no live model, and showing config
  // there would be intent dressed as status.
  let spawnInfo = null

  async function refreshSpawnInfo() {
    try {
      spawnInfo = (await window.api('/api/agent/spawn-info')).spawn
    } catch (err) {
      console.error('spawn-info fetch failed:', err)
    }
  }

  function renderRealityDetails(state) {
    const running = state === 'live' || state === 'connecting'
    $('nav-status-model').textContent = running && spawnInfo ? (spawnInfo.model || '') : ''
    $('nav-status-effort').textContent = running && spawnInfo ? (spawnInfo.effort || '') : ''
    renderContextGauge(state)
  }

  // ── context gauge (v0.0.22) ─────────────────────────────────────────────
  // Occupancy snapshot from GET /api/context-status (written by the
  // context-gauge hook on every agent turn). Polled on its own slow timer:
  // the number only moves when the agent takes a turn, so 10s is plenty and
  // keeps the shell's 2s status poll unchanged. Gauge shows only while the
  // agent runs -- a stopped agent's last occupancy is history, not status
  // (same "셸은 현실" rule as model/effort above).
  const CONTEXT_POLL_MS = 10000
  let contextStatus = null

  function fmtTokens(n) {
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
  }

  function renderContextGauge(state) {
    const el = $('nav-status-context')
    if (!el) return
    const running = state === 'live' || state === 'connecting'
    if (!running || !contextStatus || !contextStatus.available) {
      el.textContent = ''
      el.classList.remove('gauge-warn')
      return
    }
    const used = fmtTokens(contextStatus.contextTokens)
    if (contextStatus.carriedOver) {
      // Previous session's leftover, kept so the gauge is not blank before
      // the new session's first turn. Say so, and never warn on it -- a
      // ghost at 80% is history, not an emergency (2026-07-28 live catch:
      // an unmarked 133K leftover read as "133K at boot").
      el.textContent = NAV.contextGaugePrev(used)
      el.classList.remove('gauge-warn')
    } else if (contextStatus.cap) {
      el.textContent = NAV.contextGauge(contextStatus.pct, used, fmtTokens(contextStatus.cap))
      // 80%+: autocompact territory -- the exact thrash the gauge exists to
      // make visible before it costs minutes per turn.
      el.classList.toggle('gauge-warn', contextStatus.pct >= 80)
    } else {
      el.textContent = NAV.contextGaugeNoCap(used)
      el.classList.remove('gauge-warn')
    }
  }

  async function pollContextStatusOnce() {
    try {
      contextStatus = await window.api('/api/context-status')
    } catch (err) {
      contextStatus = null
    }
    renderContextGauge(lastPolledState)
    setTimeout(pollContextStatusOnce, CONTEXT_POLL_MS)
  }

  function renderAgentStatus(state) {
    const line = $('nav-status-line')
    line.textContent = NAV.states[state] || state
    line.className = 'status-line'
    if (state === 'live') line.classList.add('success')
    else if (state === 'failed') line.classList.add('failure')
    else if (state === 'connecting' || state === 'idle') line.classList.add('pending')
    const running = state === 'live' || state === 'connecting'
    const toggle = $('nav-btn-startstop')
    toggle.textContent = running ? NAV.stop : NAV.start
    toggle.dataset.action = running ? 'stop' : 'start'
    $('nav-btn-restart').classList.toggle('hidden', !running)
    renderRealityDetails(state)
  }

  function setControlsDisabled(disabled) {
    controlsBusy = disabled
    if (disabled) {
      busyStartState = lastPolledState
      busySawChange = false
      busyDeadline = Date.now() + MAX_DISABLE_MS
    }
    $('nav-btn-startstop').disabled = disabled
    $('nav-btn-restart').disabled = disabled
    const revert = $('nav-mute-revert')
    if (revert) revert.disabled = disabled
  }

  async function pollAgentStatusOnce() {
    try {
      const result = await window.api('/api/agent/status')
      // A state transition can mean a NEW child (restart, model swap) --
      // refetch its birth record before rendering, so the model/effort
      // details never describe the previous child.
      if (result.state !== lastPolledState) await refreshSpawnInfo()
      renderAgentStatus(result.state)
      lastPolledState = result.state
      if (controlsBusy) {
        if (result.state !== busyStartState) busySawChange = true
        const settled = result.state !== 'connecting' && busySawChange
        if (settled || Date.now() >= busyDeadline) setControlsDisabled(false)
      }
    } catch (err) {
      console.error('agent status poll failed:', err)
    }
    // Rides the existing 2s poll rather than adding a second timer -- same
    // reasoning as the original: a mute-check outage must never take down
    // the status poll everything else depends on.
    await renderMuteBanner()
    await renderTurnErrorBanner()
    agentPollTimer = setTimeout(pollAgentStatusOnce, AGENT_POLL_INTERVAL_MS)
  }

  async function fireControl(action, body) {
    if (controlsBusy) return false
    setControlsDisabled(true)
    try {
      await window.api(`/api/agent/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      // Stay disabled until pollAgentStatusOnce sees a settled state.
      return true
    } catch (err) {
      console.error(`agent ${action} failed:`, err)
      window.showToast(GEN(err.message))
      setControlsDisabled(false)
      return false
    }
  }

  // ── update-available banner (tester #5 v1, 2026-08-04): notify + open the
  // public release page. One-shot per page load; the server caches the
  // GitHub check (6h ok / 10min fail) so this costs nothing to call. ──────
  async function renderUpdateBanner() {
    const banner = $('nav-update-banner')
    if (!banner) return
    let u
    try {
      u = await window.api('/api/update/check')
    } catch (err) {
      return // no update info is a non-event; never nag on a failed check
    }
    if (!u || !u.ok || !u.hasUpdate) { banner.hidden = true; return }
    $('nav-update-text').textContent = NAV.updateAvailable(u.latest, u.current)
    const btn = $('nav-update-open')
    btn.textContent = NAV.updateOpen
    btn.onclick = () => window.open(u.url, '_blank', 'noopener')
    banner.hidden = false
  }

  // ── turn-error banner (2026-08-04): shows the lane's last failed model
  // call. Throttled to 10s inside the 2s ride-along poll (a local file read
  // server-side, but no reason to hammer it). Dismiss remembers the marker's
  // ts, so the SAME error stays hidden while a NEW failure re-raises the
  // strip -- an error banner you can silence forever would just recreate the
  // silent-death this exists to kill. ──
  const TURNERROR_POLL_MS = 10000
  let turnErrorLastCheck = 0
  let turnErrorDismissedTs = 0
  async function renderTurnErrorBanner() {
    const banner = $('nav-turnerror-banner')
    if (!banner) return
    if (Date.now() - turnErrorLastCheck < TURNERROR_POLL_MS) return
    turnErrorLastCheck = Date.now()
    let e
    try {
      e = await window.api('/api/agent/turn-error')
    } catch (err) {
      return // poll blip; leave the banner as it was
    }
    if (!e || !e.present || !e.fresh || e.ts === turnErrorDismissedTs) { banner.hidden = true; return }
    $('nav-turnerror-text').textContent = NAV.turnError(e.subtype, e.detail)
    const btn = $('nav-turnerror-dismiss')
    btn.textContent = NAV.turnErrorDismiss
    btn.onclick = () => { turnErrorDismissedTs = e.ts; banner.hidden = true }
    banner.hidden = false
  }

  // ── mute/revert banner, extracted from memory.js's renderMuteBanner ──────
  async function renderMuteBanner() {
    const banner = $('nav-mute-banner')
    if (!banner) return
    let s
    try {
      s = await window.api('/api/agent/mute-status')
    } catch (err) {
      console.error('mute status poll failed:', err)
      return // leave the banner in whatever state it was; don't flap on a blip
    }
    const tripped = (s.strikes || 0) >= (s.threshold || 2) && Boolean(s.previousModel)
    if (!tripped) { banner.hidden = true; return }
    $('nav-mute-text').textContent = NAV.muteWarn(s.strikes, s.model || 'the model')
    const btn = $('nav-mute-revert')
    btn.textContent = NAV.muteRevert(s.previousModel)
    btn.disabled = controlsBusy
    btn.onclick = async () => {
      if (controlsBusy) return
      const ok = await window.confirmDialog(NAV.muteRevertConfirm(s.previousModel), NAV.switchOk, NAV.cancel)
      if (!ok || controlsBusy) return
      const body = s.previousProvider ? { model: s.previousModel, provider: s.previousProvider } : { model: s.previousModel }
      const accepted = await fireControl('model', body)
      if (accepted) {
        banner.hidden = true
        // No direct model-text write here (the old line set it to
        // previousModel by hand): the revert restarts the child, the next
        // status poll sees the state transition and refetches spawn-info,
        // and the reality slot updates from the NEW child's birth record.
        // Hand-writing intent into the reality slot is the exact class
        // this file's own header principle forbids.
      }
    }
    banner.hidden = false
  }

  // ── shell init ───────────────────────────────────────────────────────────
  async function initShell() {
    const root = $('app-nav')
    if (!root) return // page doesn't include the shell mount point
    renderSkeleton(root)

    let cfg = {}
    try { cfg = await window.api('/api/config') } catch (err) { console.error(err) }

    // Discord-open button (moved here from memory.js's renderAgentControl,
    // which had itself inherited it from wizard.js's renderStep5Live).
    // Needs BOTH ids: guild from .agent-config, channel from .env via the
    // camelCase ride-along. Installs onboarded before HOME_GUILD_ID
    // persistence existed won't have the guild id -> button stays hidden.
    const discordBtn = $('nav-btn-discord')
    // Multichannel (v0.0.18): the open-Discord affordance only makes sense
    // when discord IS the active backend -- on slack/telegram it would open
    // a channel the agent no longer lives in. CHANNEL_BACKEND rides
    // /api/config's readAgentConfig() spread; absent = discord (legacy).
    const activeBackend = String(cfg.CHANNEL_BACKEND || 'discord').toLowerCase()
    if (activeBackend === 'discord' && cfg.HOME_GUILD_ID && cfg.homeChannelId) {
      discordBtn.textContent = NAV.openDiscord
      discordBtn.classList.remove('hidden')
      discordBtn.onclick = async () => {
        try {
          await window.api('/api/discord/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guildId: cfg.HOME_GUILD_ID, channelId: cfg.homeChannelId }),
          })
        } catch (err) {
          console.error('discord open failed:', err)
          window.showToast(GEN(err.message))
        }
      }
    }

    $('nav-btn-startstop').onclick = async () => {
      const action = $('nav-btn-startstop').dataset.action
      if (action === 'stop') {
        // Honest autonomy note, composed at click time from the CURRENT
        // config: stopping the agent stops tonight's cycle too (the tick
        // runs inside the agent's own channel process). Never the reverse
        // claim -- see the copy entry's own comment.
        const autonomyOn = String(cfg.AUTONOMY || '').toLowerCase() === 'yes'
        const text = autonomyOn ? NAV.stopConfirm + NAV.stopConfirmAutonomyNote : NAV.stopConfirm
        const ok = await window.confirmDialog(text, NAV.stopOk, NAV.cancel)
        if (!ok) return
      }
      await fireControl(action)
    }
    // LABEL THE BUTTON (alignment/copy pass 2026-07-25). renderAgentStatus()
    // unhides #nav-btn-restart whenever the agent is running, but nothing in
    // this file ever assigned its textContent -- so a blank, unlabeled button
    // sat in the persistent top bar of every page the whole time the agent
    // was up, and clicking it restarted the child. NAV.restart already
    // existed in copy.js and was simply never read. Set here (init, once)
    // rather than in renderAgentStatus, which runs on every poll.
    $('nav-btn-restart').textContent = NAV.restart
    $('nav-btn-restart').onclick = () => fireControl('restart')

    // Model/effort details are REALITY, not config: filled by
    // renderRealityDetails() from spawn-info once the first status poll
    // lands (blank while stopped -- a stopped agent has no live model).
    // The config snapshot display this replaces showed the dropdown value
    // as if it were a running state; that is the live-lie class the 07-14
    // model-mismatch catch was about, and the merge principle ("셸은 현실,
    // 설정은 의도") exists to kill it.
    //
    // Autonomy badge (red-team fold #3): the one setting that spends money
    // while nobody watches gets a permanent spot in the always-visible bar.
    const autonomyEl = $('nav-status-autonomy')
    if (String(cfg.AUTONOMY || '').toLowerCase() === 'yes') {
      autonomyEl.textContent = NAV.autonomyBadge(cfg.AUTONOMY_WINDOW_START || '02:00', cfg.AUTONOMY_WINDOW_END || '06:00')
    } else {
      autonomyEl.textContent = ''
    }

    await refreshSpawnInfo()
    pollAgentStatusOnce()
    pollContextStatusOnce()
    renderUpdateBanner() // one-shot; server caches the GitHub check
  }

  document.addEventListener('DOMContentLoaded', initShell)
})()
