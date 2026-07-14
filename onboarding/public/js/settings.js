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
    $('set-back-link').textContent = C.backToMemory
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
      if (!m.providers.some((p) => availableProviders.includes(p))) opt.disabled = true
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
      }
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
      }
    }
  }

  init()
})()
