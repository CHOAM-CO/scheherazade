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
  }

  function $(id) { return document.getElementById(id) }
  function showStep(name) {
    document.querySelectorAll('.step').forEach((el) => el.classList.add('hidden'))
    const target = document.querySelector(`.step[data-step="${name}"]`)
    if (!target) throw new Error(`no such step section: ${name}`) // fail loud on a wiring bug
    target.classList.remove('hidden')
  }

  async function api(path, options) {
    const res = await fetch(path, options)
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
    let activeTab = C.step1.tabs[0].id
    state.provider = activeTab

    function renderHint() {
      const tab = C.step1.tabs.find((t) => t.id === activeTab)
      $('s1-hint').textContent = tab.hint
    }

    C.step1.tabs.forEach((tab) => {
      const el = document.createElement('div')
      el.className = 'tab' + (tab.id === activeTab ? ' active' : '')
      el.textContent = tab.label
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
      state.tutorialIndex = 0
      renderTutorialStep()
      showStep('4b')
    }
    $('s4-later').onclick = () => {
      window.location.href = '/waiting'
    }
  }

  // ── Step 4b: Discord tutorial (6 steps, last one validates) ─────────
  function renderTutorialStep() {
    const steps = C.discordTutorial.steps
    const idx = state.tutorialIndex
    const isLast = idx === steps.length - 1

    $('s4b-title').textContent = C.step4.title
    const bodyEl = $('s4b-tutorial-body')
    bodyEl.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'tutorial-step'
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
    bodyEl.appendChild(wrap)

    $('s4b-progress').textContent = `${idx + 1} / ${steps.length}`
    $('s4b-prev').textContent = C.discordTutorial.prevButton
    $('s4b-prev').disabled = idx === 0
    $('s4b-prev').onclick = () => {
      state.tutorialIndex -= 1
      renderTutorialStep()
    }

    const tokenField = $('s4b-token-field')
    const statusEl = $('s4b-status')
    statusEl.classList.add('hidden')
    statusEl.textContent = ''

    if (isLast) {
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

  // ── Step 5: handoff ──────────────────────────────────────────────────
  function renderStep5() {
    $('s5-title').textContent = C.step5.title
    $('s5-body').textContent = C.step5.body(state.displayName)
    $('s5-open').textContent = C.step5.button
    $('s5-open').onclick = async () => {
      try {
        await api('/api/discord/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guildId: state.discordGuildId, channelId: state.discordChannelId }),
        })
      } catch (err) {
        alert(C.genericError(err.message))
      }
    }
  }

  // ── init: resume support for the /waiting -> ?step=4 round trip ─────
  async function init() {
    renderStep0()
    renderStep1()
    renderStep2()
    renderStep3()

    const params = new URLSearchParams(window.location.search)
    const resumeStep = params.get('step')
    if (resumeStep === '4') {
      try {
        const cfg = await api('/api/config')
        state.displayName = cfg.DISPLAY_NAME || C.step2.defaultName
        state.provider = cfg.PROVIDER || null
        renderStep4()
        showStep('4')
        return
      } catch (err) {
        // Fail loud but don't strand the user on a blank page -- fall back
        // to step 0 and surface the error.
        console.error(err)
      }
    }

    showStep('0')
  }

  init()
})()
