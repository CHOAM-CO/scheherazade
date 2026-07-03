// wizard.js — client-side step machine for the onboarding wizard.
// No framework, no build step: plain DOM + fetch() against the same-origin
// API served by onboarding/http-server.cjs.

;(function () {
  const C = window.COPY

  const state = {
    provider: null,
    displayName: null,
    tone: null,
    primaryTask: '',
    proactiveEnabled: null,
    proactiveWindowStart: '09:00',
    proactiveWindowEnd: '22:00',
    tutorialIndex: 0,
    discordGuildId: null,
    discordChannelId: null,
    // GET /api/config's routerWired -- gates the ChatGPT/Ollama Cloud tabs
    // in Step 1. Set once in init() before any step renders.
    routerWired: false,
  }

  function $(id) { return document.getElementById(id) }
  function showStep(name) {
    document.querySelectorAll('.step').forEach((el) => el.classList.add('hidden'))
    const target = document.querySelector(`.step[data-step="${name}"]`)
    if (!target) throw new Error(`no such step section: ${name}`) // fail loud on a wiring bug
    target.classList.remove('hidden')
  }

  async function api(path, options) {
    const opts = options ? { ...options } : {}
    // localhost-auth gate (security review, 2026-07-03): every mutating
    // (non-GET) request must carry the per-launch token the server
    // injected into this page's <head> -- see copy.js's getOnboardToken().
    if (opts.method && opts.method !== 'GET') {
      opts.headers = { ...(opts.headers || {}), 'X-Onboard-Token': window.getOnboardToken() || '' }
    }
    const res = await fetch(path, opts)
    let body
    try {
      body = await res.json()
    } catch (err) {
      throw new Error(`non-JSON response from ${path}: ${err.message}`)
    }
    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status} from ${path}`)
    }
    return body
  }

  // ── Step 0 ────────────────────────────────────────────────────────────
  function renderStep0() {
    $('s0-title').textContent = C.step0.title
    $('s0-body').textContent = C.step0.body
    $('s0-next').textContent = C.step0.button
    $('s0-next').onclick = () => showStep('1')
  }

  // ── Step 1: BYOK ─────────────────────────────────────────────────────
  function renderStep1() {
    $('s1-title').textContent = C.step1.title
    $('s1-body').textContent = C.step1.body
    const tabsEl = $('s1-tabs')
    tabsEl.innerHTML = ''
    let activeTab = C.step1.tabs[0].id // always 'claude' -- never disabled
    state.provider = activeTab

    // ROUTER_WIRED gate (Melchior 18:26): non-claude providers stay grey +
    // inert until the router lands server-side (GET /api/config's
    // routerWired). Defense-in-depth -- the server also rejects non-claude
    // BYOK validation while unwired, this just keeps the dead choice from
    // ever being selectable in the first place.
    const noteEl = $('s1-router-note')
    if (!state.routerWired) {
      noteEl.textContent = C.step1.routerDisabledNote
      noteEl.classList.remove('hidden')
    } else {
      noteEl.classList.add('hidden')
      noteEl.textContent = ''
    }

    function renderHint() {
      const tab = C.step1.tabs.find((t) => t.id === activeTab)
      $('s1-hint').textContent = tab.hint
    }

    C.step1.tabs.forEach((tab) => {
      const disabled = tab.id !== 'claude' && !state.routerWired
      const el = document.createElement('div')
      el.className = 'tab' + (tab.id === activeTab ? ' active' : '') + (disabled ? ' disabled' : '')
      el.textContent = disabled ? tab.disabledLabel : tab.label
      if (!disabled) {
        el.onclick = () => {
          activeTab = tab.id
          state.provider = tab.id
          tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
          el.classList.add('active')
          renderHint()
          $('s1-key').value = ''
          $('s1-status').textContent = ''
          $('s1-status').className = 'status-line'
        }
      }
      tabsEl.appendChild(el)
    })
    renderHint()

    $('s1-next').textContent = C.step1.button
    $('s1-status').textContent = ''
    $('s1-status').className = 'status-line'
    $('s1-key').value = ''

    $('s1-next').onclick = async () => {
      const key = $('s1-key').value.trim()
      const statusEl = $('s1-status')
      const btn = $('s1-next')
      btn.disabled = true
      statusEl.className = 'status-line pending'
      statusEl.textContent = C.step1.validating
      try {
        const result = await api('/api/byok/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: state.provider, key }),
        })
        if (result.ok) {
          statusEl.className = 'status-line success'
          statusEl.textContent = C.step1.success
          showStep('2')
        } else {
          statusEl.className = 'status-line failure'
          statusEl.textContent = C.step1.failure(result.reason || '알 수 없는 오류')
        }
      } catch (err) {
        statusEl.className = 'status-line failure'
        statusEl.textContent = C.genericError(err.message)
      } finally {
        btn.disabled = false
      }
    }
  }

  // ── Step 2: name ─────────────────────────────────────────────────────
  function renderStep2() {
    $('s2-title').textContent = C.step2.title
    $('s2-body').textContent = C.step2.body
    $('s2-next').textContent = C.step2.button
    if (!$('s2-name').value) $('s2-name').value = state.displayName || C.step2.defaultName
    $('s2-next').onclick = () => {
      const name = $('s2-name').value.trim() || C.step2.defaultName
      state.displayName = name
      showStep('3')
    }
  }

  // ── Step 3: persona (3 questions) ───────────────────────────────────
  function renderStep3() {
    $('s3-title').textContent = C.step3.title
    $('s3-q1-label').textContent = C.step3.q1Label
    const q1El = $('s3-q1-options')
    q1El.innerHTML = ''
    C.step3.q1Options.forEach((opt, idx) => {
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 's3-q1'
      input.value = opt.value
      if (idx === 0) input.checked = true
      label.appendChild(input)
      label.appendChild(document.createTextNode(' ' + opt.label))
      q1El.appendChild(label)
    })

    $('s3-q2-label').textContent = C.step3.q2Label
    const chipsEl = $('s3-q2-chips')
    chipsEl.innerHTML = ''
    C.step3.q2Chips.forEach((chip) => {
      const el = document.createElement('div')
      el.className = 'chip'
      el.textContent = chip
      el.onclick = () => {
        const field = $('s3-q2-text')
        if (!field.value.trim()) field.value = chip
        else if (!field.value.includes(chip)) field.value += ', ' + chip
      }
      chipsEl.appendChild(el)
    })

    $('s3-q3-label').textContent = C.step3.q3Label
    $('s3-q3-yes-prefix').textContent = C.step3.q3YesPrefix
    $('s3-q3-yes-suffix').textContent = C.step3.q3YesSuffix
    $('s3-q3-no').textContent = C.step3.q3No
    $('s3-q3-note').textContent = C.step3.q3Note
    document.querySelector('input[name="s3-q3"][value="no"]').checked = true

    $('s3-next').textContent = C.step3.button
    $('s3-status').classList.add('hidden')

    $('s3-next').onclick = async () => {
      const tone = document.querySelector('input[name="s3-q1"]:checked').value
      const primaryTask = $('s3-q2-text').value.trim()
      const proactive = document.querySelector('input[name="s3-q3"]:checked').value
      const proactiveEnabled = proactive === 'yes'
      state.tone = tone
      state.primaryTask = primaryTask
      state.proactiveEnabled = proactiveEnabled
      state.proactiveWindowStart = $('s3-q3-start').value
      state.proactiveWindowEnd = $('s3-q3-end').value

      const btn = $('s3-next')
      btn.disabled = true
      try {
        await api('/api/onboarding/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: state.displayName,
            provider: state.provider,
            tone: state.tone,
            primaryTask: state.primaryTask,
            proactiveEnabled: state.proactiveEnabled,
            proactiveWindowStart: state.proactiveWindowStart,
            proactiveWindowEnd: state.proactiveWindowEnd,
          }),
        })
        renderStep4()
        showStep('4')
      } catch (err) {
        const statusEl = $('s3-status')
        statusEl.classList.remove('hidden')
        statusEl.textContent = C.genericError(err.message)
      } finally {
        btn.disabled = false
      }
    }
  }

  // ── Step 4: Discord intro ───────────────────────────────────────────
  function renderStep4() {
    $('s4-title').textContent = C.step4.title
    $('s4-body').textContent = C.step4.body(state.displayName)
    $('s4-start').textContent = C.step4.startButton
    $('s4-later').textContent = C.step4.laterButton
    $('s4-start').onclick = () => {
      state.tutorialIndex = -1 // 2FA pre-warning intro, before step 1 of 6
      renderTutorialStep()
      showStep('4b')
    }
    $('s4-later').onclick = () => {
      window.location.href = '/waiting'
    }
  }

  // ── Step 4b: Discord tutorial (2FA pre-warning intro + 6 numbered
  // steps, last one validates) ─────────────────────────────────────────
  // state.tutorialIndex === -1 is the intro screen (source file's "시작
  // 전 안내" -- shown before step 1 of 6, not itself a numbered step).
  // Folding it into the same prev/next index keeps this a single small
  // state machine instead of a parallel one.
  function renderTutorialStep() {
    const steps = C.discordTutorial.steps
    const idx = state.tutorialIndex
    const isIntro = idx === -1
    const isLast = idx === steps.length - 1

    $('s4b-title').textContent = C.step4.title
    const bodyEl = $('s4b-tutorial-body')
    bodyEl.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'tutorial-step'

    if (isIntro) {
      const textEl = document.createElement('div')
      textEl.className = 'step-text'
      textEl.textContent = C.discordTutorial.preWarning
      wrap.appendChild(textEl)
    } else {
      const idxEl = document.createElement('div')
      idxEl.className = 'step-index'
      idxEl.textContent = `${idx + 1} / ${steps.length}`
      const textEl = document.createElement('div')
      textEl.className = 'step-text'
      textEl.textContent = steps[idx].text(state.displayName)
      wrap.appendChild(idxEl)
      wrap.appendChild(textEl)
      if (steps[idx].shot) {
        const shot = document.createElement('div')
        shot.className = 'screenshot-slot'
        shot.textContent = `[스크린샷 ${idx + 1}: 실제 캡처 예정 — docs/discord-tutorial-shotlist.md 참고]`
        wrap.appendChild(shot)
      }
    }
    bodyEl.appendChild(wrap)

    $('s4b-progress').textContent = isIntro ? '' : `${idx + 1} / ${steps.length}`
    $('s4b-prev').textContent = C.discordTutorial.prevButton
    $('s4b-prev').disabled = isIntro
    $('s4b-prev').onclick = () => {
      state.tutorialIndex -= 1
      renderTutorialStep()
    }

    const tokenField = $('s4b-token-field')
    const statusEl = $('s4b-status')
    statusEl.classList.add('hidden')
    statusEl.textContent = ''

    if (isIntro) {
      tokenField.classList.add('hidden')
      $('s4b-action').textContent = C.discordTutorial.nextButton
      $('s4b-action').disabled = false
      $('s4b-action').onclick = () => {
        state.tutorialIndex += 1
        renderTutorialStep()
      }
    } else if (isLast) {
      tokenField.classList.remove('hidden')
      $('s4b-token-label').textContent = C.discordTutorial.tokenFieldLabel
      $('s4b-action').textContent = C.discordTutorial.validateButton
      $('s4b-action').onclick = async () => {
        const token = $('s4b-token').value.trim()
        const btn = $('s4b-action')
        btn.disabled = true
        statusEl.classList.remove('hidden')
        statusEl.className = 'status-line pending'
        statusEl.textContent = C.discordTutorial.validating
        try {
          const result = await api('/api/discord/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          })
          if (result.ok) {
            state.discordGuildId = result.guildId
            state.discordChannelId = result.channelId
            statusEl.className = 'status-line success'
            statusEl.textContent = C.discordTutorial.success(state.displayName)
            renderStep5()
            showStep('5')
          } else {
            statusEl.className = 'status-line failure'
            statusEl.textContent = C.discordTutorial.failures[result.branch] || C.genericError('알 수 없는 실패')
          }
        } catch (err) {
          statusEl.className = 'status-line failure'
          statusEl.textContent = C.genericError(err.message)
        } finally {
          btn.disabled = false
        }
      }
    } else {
      tokenField.classList.add('hidden')
      $('s4b-action').textContent = C.discordTutorial.nextButton
      $('s4b-action').disabled = false
      $('s4b-action').onclick = () => {
        state.tutorialIndex += 1
        renderTutorialStep()
      }
    }
  }

  // ── Step 5: handoff, liveness-gated, 3-state ─────────────────────────
  // REQUIREMENT 4 (PO, agent-lifecycle fix 2026-07-03): do not show the
  // "waiting for you in Discord" success copy until the agent is actually
  // confirmed live (GET /api/agent/status, backed by main.cjs's child
  // process state + channel.mjs's DATA_HOME/.agent-live heartbeat marker).
  // Three states: connecting (state==='connecting') / live (state==='live')
  // / failed (state==='failed', with a stable `code` enum). The server
  // never sends a free-form reason string to render -- `result.reason` was
  // renamed to `result.code` (stable enum, drives the copy.js cause table)
  // + `result.detail` (free-form debug prose, console-only, never put in
  // the DOM -- Melchior 2026-07-03: that's the "English leaks into the
  // user's screen" bug class).
  let s5PollTimer = null
  const S5_POLL_INTERVAL_MS = 2000

  function stopS5Poll() {
    if (s5PollTimer) {
      clearTimeout(s5PollTimer)
      s5PollTimer = null
    }
  }

  // Renders the step-actions button row. Used by all three states so the
  // connecting -> live transition can reuse the identical single-button
  // layout (grey/disabled -> enabled is the "obvious progress" signal;
  // Melchior impl call 16:44, Idea confirmed) while failed gets its own
  // cause-specific button set.
  function renderStep5Buttons(buttons) {
    const el = $('s5-buttons')
    el.innerHTML = ''
    buttons.forEach((b) => {
      const btn = document.createElement('button')
      if (b.secondary) btn.className = 'secondary'
      btn.textContent = b.label
      btn.disabled = !!b.disabled
      if (b.title) btn.title = b.title
      if (b.onClick) btn.onclick = b.onClick
      el.appendChild(btn)
    })
  }

  function renderStep5Connecting() {
    $('s5-title').textContent = C.step5.connecting.title
    $('s5-body').textContent = C.step5.connecting.body(state.displayName)
    // Same button, same slot, disabled -- not hidden. Layout doesn't jump
    // when this flips to live.
    renderStep5Buttons([{ label: C.step5.connecting.button, disabled: true }])
  }

  function renderStep5Live() {
    $('s5-title').textContent = C.step5.live.title
    $('s5-body').textContent = C.step5.live.body(state.displayName)
    renderStep5Buttons([
      {
        label: C.step5.live.button,
        onClick: async () => {
          try {
            await api('/api/discord/open', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guildId: state.discordGuildId, channelId: state.discordChannelId }),
            })
          } catch (err) {
            alert(C.genericError(err.message))
          }
        },
      },
    ])
  }

  function renderStep5Failed(code) {
    const causes = C.step5.failed.causes
    const row = causes[code] || causes.unknown
    $('s5-title').textContent = C.step5.failed.title
    $('s5-body').textContent = `${row.cause(state.displayName)} ${row.action(state.displayName)}`

    const buttons = row.buttons.map((kind) => {
      if (kind === 'openSettings') {
        // Real navigation -- /settings is a served static route.
        return { label: C.step5.buttonLabels.openSettings, secondary: true, onClick: () => { window.location.href = '/settings' } }
      }
      if (kind === 'backToToken') {
        // Real navigation -- back to the tutorial's last (token-paste) step.
        return {
          label: C.step5.buttonLabels.backToToken,
          secondary: true,
          onClick: () => {
            stopS5Poll()
            state.tutorialIndex = C.discordTutorial.steps.length - 1
            renderTutorialStep()
            showStep('4b')
          },
        }
      }
      if (kind === 'retry') {
        // No respawn endpoint exists yet (source copy file 🔒 #4: "재시도
        // 배선 TODO" -- respawn is explicitly a future ticket, not this
        // task's backend). The honest thing the UI can do today: re-enter
        // connecting and re-poll the real status endpoint. This does not
        // itself restart the agent process.
        return {
          label: C.step5.buttonLabels.retry,
          secondary: true,
          onClick: () => renderStep5(),
        }
      }
      // 'openLogs' (and any future unmapped kind): no log-open route, no
      // exposed log path, no preload/IPC bridge exists anywhere in this
      // codebase today. Rendered per the copy table (button must be
      // present) but disabled rather than wired to a dead click -- a dead
      // click is worse than an honest disabled state. Title text is
      // AUTHORED (not in the copy file), flagged for whoever wires a real
      // log-open endpoint.
      return {
        label: C.step5.buttonLabels[kind] || kind,
        secondary: true,
        disabled: true,
        title: '로그 열기는 아직 연결되지 않았습니다.',
      }
    })
    renderStep5Buttons(buttons)
  }

  async function pollAgentStatus() {
    try {
      const result = await api('/api/agent/status')
      if (result.state === 'live') {
        stopS5Poll()
        renderStep5Live()
        return
      }
      if (result.state === 'failed') {
        stopS5Poll()
        // result.detail is free-form debug prose -- log it, never render
        // it. result.code is the stable enum that drives the cause table.
        if (result.detail) console.error('agent failed:', result.code, result.detail)
        renderStep5Failed(result.code)
        return
      }
      renderStep5Connecting()
    } catch (err) {
      // Fail loud (console), but don't hard-stop polling on one transient
      // fetch error against our own localhost server -- the connecting
      // screen already correctly reflects "not confirmed live yet".
      console.error('agent status poll failed:', err)
    }
    s5PollTimer = setTimeout(pollAgentStatus, S5_POLL_INTERVAL_MS)
  }

  function renderStep5() {
    renderStep5Connecting()
    stopS5Poll()
    pollAgentStatus()
  }

  // ── init: routerWired gate + resume support for the /waiting -> ?step=4
  // round trip ──────────────────────────────────────────────────────────
  async function init() {
    // Fetched once, up front: Step 1's provider tabs need routerWired
    // before they render, and the ?step=4 resume path below needs the same
    // config -- one fetch serves both instead of two.
    let cfg = null
    try {
      cfg = await api('/api/config')
    } catch (err) {
      // Fail loud (console); state.routerWired stays at its safe default
      // (false = non-claude tabs disabled) if config can't be read.
      console.error('config fetch failed:', err)
    }
    state.routerWired = !!(cfg && cfg.routerWired)

    renderStep0()
    renderStep1()
    renderStep2()
    renderStep3()

    const params = new URLSearchParams(window.location.search)
    const resumeStep = params.get('step')
    if (resumeStep === '4' && cfg) {
      state.displayName = cfg.DISPLAY_NAME || C.step2.defaultName
      state.provider = cfg.PROVIDER || null
      renderStep4()
      showStep('4')
      return
    }

    showStep('0')
  }

  init()
})()
