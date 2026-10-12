// nav.js — shared shell for every post-onboarding page (memory / connectors /
// settings). Loads after copy.js, before the page-specific script, and
// renders into <div id="app-nav"> at the top of each page's .page-shell.
//
// Mechanically extracted from memory.js's "Agent control panel" (Slice 2,
// 2026-07-09) per docs/ia-subpage-plan.md's shell principle: "셸은 현실,
// 설정은 의도" -- read-only status + the command-shaped actions (start/stop/
// restart/Discord open) + the mute-revert banner live here; the model/effort
// SELECT config moved to settings.js. Same endpoints, same polling cadence,
// same copy as before (still eng placeholder pending the owner's copy-track
// localization pass -- unchanged by this move, just relocated).
//
// Also the new single home for window.api()/window.showToast(), previously
// duplicated in memory.js + settings.js (wizard.js keeps its own local
// copies -- the onboarding wizard page never includes this shell).

;(function () {
  const NAV = window.COPY.nav
  const GEN = window.COPY.genericError

  function $(id) { return document.getElementById(id) }

  // ── window.avatarUrl (2026-09-28, profile picture) ──────────────────────
  // ONE resolver, two consumers: chat.js's sender row and settings.js's
  // preview. Both need the agent's picture as something an <img src> can
  // hold, and neither can point src at the API directly: every /api GET is
  // X-Onboard-Token-gated, so a bare `<img src="/api/settings/avatar">` is a
  // 403, not a picture. The token therefore has to ride a fetch, and the
  // bytes come back as a blob object URL -- the same shape (and the same
  // reason) as chat.js's appendAttachmentImage.
  //
  // The fallback is the STATIC file, which carries no secret and is
  // Host-gated only, so it IS loadable as a plain src. A failed fetch (an
  // older server, a page opened outside the app) degrades to it rather than
  // to a broken-image icon -- there is no state in which this avatar has
  // nothing to show.
  //
  // Memoized per page: a chat with fifty agent runs fetches the picture
  // once, and every row shares one object URL.
  //
  // Two slots (0.3.5, 2026-09-29): `slot` is 'agent' (the default, and every
  // 0.3.4 call site, unchanged) or 'user'. The user slot has NO fallback --
  // there is no shipped face to put on the user's own rows -- so an empty
  // user slot (the route's 404 no_picture) or a failed fetch resolves null,
  // and the caller draws nothing. The agent slot still never resolves null.
  const AVATAR_FALLBACK_URL = '/img/agent-avatar.png'
  window.AVATAR_FALLBACK_URL = AVATAR_FALLBACK_URL
  const AVATAR_ROUTES = { agent: '/api/settings/avatar', user: '/api/settings/user-avatar' }
  const avatarUrlPromises = { agent: null, user: null }
  window.avatarUrl = function avatarUrl(slot = 'agent') {
    if (avatarUrlPromises[slot]) return avatarUrlPromises[slot]
    const fallback = slot === 'agent' ? AVATAR_FALLBACK_URL : null
    avatarUrlPromises[slot] = (async () => {
      try {
        const res = await fetch(AVATAR_ROUTES[slot], {
          headers: { 'X-Onboard-Token': window.getOnboardToken() || '' },
          // The route answers max-age=86400 and a REPLACEMENT avatar reuses
          // the same URL, so without this a browser could show yesterday's
          // picture for a day. The file is one small square; revalidating
          // costs less than being wrong.
          cache: 'no-cache',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return URL.createObjectURL(await res.blob())
      } catch {
        return fallback
      }
    })()
    return avatarUrlPromises[slot]
  }
  // Drop the memo so the next avatarUrl(slot) re-reads the disk. Called by
  // settings.js after an upload or a removal -- the consumers re-point their
  // src at the new value, which is why the old object URL is deliberately
  // NOT revoked here (an already-painted chat row still holds it).
  window.avatarUrlForget = function avatarUrlForget(slot = 'agent') { avatarUrlPromises[slot] = null }

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

  // routeSwitchPreview (0.3.14): ask main what a model/effort pick WOULD do
  // (GET /api/agent/route-preview) so the confirm dialog says "takes effect
  // on the next message" only when the route proxy really absorbs it.
  // Resolves 'live' | 'restart'; any failure is 'restart' -- the wording the
  // dialog always had, never a promise the app cannot keep.
  window.routeSwitchPreview = async function routeSwitchPreview(params) {
    try {
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(params || {})) if (v) q.set(k, v)
      const r = await window.api(`/api/agent/route-preview?${q.toString()}`)
      return r && r.mode === 'live' ? 'live' : 'restart'
    } catch (err) {
      console.error('route preview failed (falling back to restart wording):', err)
      return 'restart'
    }
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
  // IA v2 (2026-08-13, the owner "너무 잡다하고 어디에 뭐있는지 모르겠음 ... GUI 붙어있는
  // 에이전트들 참고해서 대공사"): 7 flat tabs read as an undifferentiated pile.
  // Collapsed to FOUR daily surfaces -- Chat (talk), Memory (what it remembers),
  // Settings (how it's set up), Logs (debug) -- with the config-family pages
  // (Channels, Model & Providers, Appearance) demoted to a Settings sub-nav.
  // This is the chat-primary + settings-cluster shape the referenced desktop
  // agent apps use. Routing is UNCHANGED -- each page keeps its own URL; only
  // the nav reflects the hierarchy, so the fold carries no reroute risk.
  const TABS = [
    { id: 'chat', href: '/chat', label: NAV.tabs.chat },
    // Model & Providers promoted OUT of the Settings cluster to a primary
    // tab between Chat and Memory (the owner 08-24 01:16) -- with the model/
    // effort quick-switch living in the chat composer area, the full picker
    // is a daily surface now, not config-family.
    { id: 'connectors', href: '/connectors', label: NAV.subModel },
    { id: 'memory', href: '/memory', label: NAV.tabs.memory },
    { id: 'settings', href: '/settings', label: NAV.tabs.settings },
    // logs LAST, deliberately low-key (the owner 07-16: "버튼 어딘가에 짱박아놓고")
    // -- a dev/debug surface, not a daily destination.
    { id: 'logs', href: '/logs', label: NAV.tabs.logs },
  ]

  const SETTINGS_FAMILY = new Set(['settings', 'channels', 'appearance'])

  // The raw page identity from the URL (never hand-set, so it can't drift).
  function rawPageId() {
    const path = window.location.pathname
    if (path.startsWith('/chat')) return 'chat'
    if (path.startsWith('/channels')) return 'channels'
    if (path.startsWith('/connectors')) return 'connectors'
    if (path.startsWith('/settings')) return 'settings'
    if (path.startsWith('/appearance')) return 'appearance'
    if (path.startsWith('/logs')) return 'logs'
    return 'memory' // '/memory' and '/' both read as home
  }
  // Which PRIMARY tab lights up: settings-family pages roll up to 'settings'.
  function activePrimaryId() {
    const raw = rawPageId()
    return SETTINGS_FAMILY.has(raw) ? 'settings' : raw
  }

  // ── shell skeleton ──────────────────────────────────────────────────────
  // Was memory.html's static cat-agent-control markup; relocated into JS
  // since it now has to render identically on three separate HTML pages.
  // Structure/classes are unchanged from the original (agent-control-actions,
  // mute-banner, status-line) so app.css's existing rules keep applying —
  // only .app-nav/.nav-status/.nav-tabs/.nav-tab are genuinely new classes.
  function renderSkeleton(root) {
    const active = activePrimaryId()
    const rawPage = rawPageId()
    root.innerHTML =
      '<div class="nav-status">' +
        '<span class="category-label" id="nav-agent-label"></span>' +
        '<span class="status-line" id="nav-status-line"></span>' +
        // Failure cause (2026-08-06, 0.67 clean-mac feedback: the shell
        // showed only the word "Failed" while status.detail held the whole
        // diagnosis -- "실패해도 되는데 원인은 알아야지"). Filled only on
        // failed; full text rides the title attr when it truncates.
        '<span class="nav-status-detail failure" id="nav-status-cause"></span>' +
        '<span class="nav-status-detail" id="nav-status-model"></span>' +
        '<span class="nav-status-detail" id="nav-status-effort"></span>' +
        '<span class="nav-status-detail" id="nav-status-context"></span>' +
        '<span class="nav-status-detail" id="nav-status-autonomy"></span>' +
        '<div class="agent-control-actions">' +
          '<button class="secondary nav-ctl" id="nav-btn-startstop"></button>' +
          '<button class="secondary nav-ctl hidden" id="nav-btn-restart"></button>' +
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
      // turn-error banner (2026-08-04, the owner "클로드도 동작안함. 인증
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
    // Shared rail: page layout owns its slot, the shell owns the links/state.
    if (SETTINGS_FAMILY.has(rawPage)) {
      const rail = document.querySelector('.settings-rail')
      if (!rail) return
      rail.replaceChildren()
      rail.setAttribute('aria-label', NAV.tabs.settings)
      const P = window.COPY.polish
      const entries = [
        { id: 'settings', key: 'general', href: '/settings#set-identity' },
        { id: 'channels', key: 'channels', href: '/channels' },
        { id: 'appearance', key: 'appearance', href: '/appearance' },
        { id: 'system', key: 'system', href: '/settings#set-sudo' },
        { id: 'permissions', key: 'permissions', href: '/settings#set-perms' },
      ]
      for (const t of entries) {
        const a = document.createElement('a')
        a.href = t.href
        a.textContent = P[t.key]
        a.classList.toggle('active', t.id === rawPage)
        if (t.id === rawPage) a.setAttribute('aria-current', 'page')
        a.addEventListener('click', () => {
          if (rawPage !== 'settings' || !t.href.startsWith('/settings#')) return
          for (const link of rail.querySelectorAll('a')) {
            link.classList.toggle('active', link === a)
            if (link === a) link.setAttribute('aria-current', 'location')
            else link.removeAttribute('aria-current')
          }
        })
        rail.appendChild(a)
      }
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

  // Live route switch (chat model/effort pickers, 0.4.4): the proxy moves at
  // once but the status poll only refetches spawn-info on a STATE change, so
  // the header kept the old model name until the next transition (Mino
  // 2026-10-12 15:12 "info쪽에서는 리프레시 안됨"). The picker calls this
  // right after POST /api/agent/model answers mode 'live'.
  window.refreshAgentReality = async () => {
    await refreshSpawnInfo()
    if (lastPolledState) renderRealityDetails(lastPolledState)
  }

  function renderRealityDetails(state) {
    const running = state === 'live' || state === 'connecting'
    // 0.2.6 UI pass: the header names the agent, not its species — "세라",
    // not "AGENT" — whenever the spawn carries a name (dev-serve-ui has no
    // agentControls, so the copy label stays the fallback there).
    if (spawnInfo && spawnInfo.name) $('nav-agent-label').textContent = spawnInfo.name
    // spawn.live (route proxy, 2026-10-07): the model/effort the proxy sends
    // NOW; a live switch moves it without a respawn. Falls back to the birth
    // pick when main has no live record.
    const live = spawnInfo && spawnInfo.live ? spawnInfo.live : null
    $('nav-status-model').textContent = running && spawnInfo ? ((live && live.model) || spawnInfo.model || '') : ''
    $('nav-status-effort').textContent = running && spawnInfo ? ((live && live.effort) || spawnInfo.effort || '') : ''
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

  function renderAgentStatus(state, status) {
    const line = $('nav-status-line')
    // Healthy = dot only (the owner 08-20 21:26 "Running 빼고 초록색 인디케이터만"):
    // same silence-when-normal rule as the chat status row. Every OTHER state
    // keeps its word — orange alone can't say connecting-vs-idle, grey alone
    // can't say stopped-vs-blank, and color-only fails colorblind users.
    // The word survives as a hover title for discoverability.
    line.textContent = state === 'live' ? '' : (NAV.states[state] || state)
    line.title = NAV.states[state] || state
    line.className = 'status-line'
    if (state === 'live') line.classList.add('success')
    else if (state === 'failed') line.classList.add('failure')
    else if (state === 'connecting' || state === 'idle') line.classList.add('pending')
    // The state word alone said "Failed" while the WHY sat unread in
    // status.detail (0.67 clean-mac feedback). Shown verbatim -- the server
    // strings already carry the fix (e.g. cli_missing includes the install
    // command); synthesizing a friendlier line here would hide the receipt.
    const cause = $('nav-status-cause')
    if (cause) {
      const text = state === 'failed' && status ? (status.detail || status.code || '') : ''
      cause.textContent = text
      cause.title = text
      cause.classList.toggle('hidden', !text)
    }
    const running = state === 'live' || state === 'connecting'
    const toggle = $('nav-btn-startstop')
    toggle.textContent = running ? NAV.stop : NAV.start
    toggle.dataset.action = running ? 'stop' : 'start'
    // Semantic color so the action reads before the label does: Stop = danger,
    // Start = go. Skipped while a control is busy so the spinner state isn't
    // repainted mid-flight by a status poll.
    if (!controlsBusy) {
      toggle.classList.toggle('is-stop', running)
      toggle.classList.toggle('is-start', !running)
    }
    $('nav-btn-restart').classList.toggle('hidden', !running)
    renderRealityDetails(state)
  }

  function setControlsDisabled(disabled) {
    controlsBusy = disabled
    if (disabled) {
      busyStartState = lastPolledState
      busySawChange = false
      busyDeadline = Date.now() + MAX_DISABLE_MS
    } else {
      // Settled: clear the spinner/pressed state from whichever button fired.
      $('nav-btn-startstop').classList.remove('is-busy')
      $('nav-btn-restart').classList.remove('is-busy')
    }
    $('nav-btn-startstop').disabled = disabled
    $('nav-btn-restart').disabled = disabled
    const revert = $('nav-mute-revert')
    if (revert) revert.disabled = disabled
  }

  // Map a lifecycle action to the button that triggers it, so the busy/pressed
  // spinner lands on the exact control the user clicked (not both).
  function ctlButtonFor(action) {
    if (action === 'restart') return $('nav-btn-restart')
    return $('nav-btn-startstop') // start / stop / model-revert all ride this
  }

  async function pollAgentStatusOnce() {
    try {
      const result = await window.api('/api/agent/status')
      // A state transition can mean a NEW child (restart, model swap) --
      // refetch its birth record before rendering, so the model/effort
      // details never describe the previous child.
      if (result.state !== lastPolledState) await refreshSpawnInfo()
      renderAgentStatus(result.state, result)
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
    // Pressed/busy spinner on the exact button that fired (start/stop/restart).
    const fired = ctlButtonFor(action)
    if (fired && fired.classList.contains('nav-ctl')) fired.classList.add('is-busy')
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
    const enabledBackends = String(cfg.CHANNEL_BACKENDS || cfg.CHANNEL_BACKEND || 'discord').toLowerCase().split(',').map((x) => x.trim())
    if (enabledBackends.includes('discord') && cfg.HOME_GUILD_ID && cfg.homeChannelId) {
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
