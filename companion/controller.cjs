'use strict'

const path = require('node:path')
const { modeFields, modeOf } = require('../onboarding/public/js/companion-mode.cjs')
const { isCallEnabled } = require('../onboarding/call-state.cjs')
const { readState, writeState, initialAnchor, clampAnchor, layout, hitShape, fullscreenDecision, canProactive, classifyMessage, readConfig: parseConfig, sizeOf, VARIANTS, speakable } = require('./model.cjs')
const { createFullscreenProbe } = require('./fullscreen.cjs')

// readConfig/writeConfig are the agent config accessors (COMPANION_ENABLED,
// COMPANION_VARIANT; default off / 'face'). Without them an in-memory config is
// used, which is what the electron-free tests get.
function createCompanion({ electron, home, url, bootPathFor, openMain, log, now = Date.now, probeOverride, autoPoll = true, platform = process.platform,
  readConfig, writeConfig }) {
  if (!readConfig || !writeConfig) {
    const memory = {}
    readConfig = () => ({ ...memory }); writeConfig = fields => Object.assign(memory, fields)
  }
  const { app, BrowserWindow, screen, Tray, Menu, nativeImage, shell } = electron
  const token = new URL(bootPathFor('/'), url).searchParams.get('t')
  const bootAt = now()
  let callHud = false
  const load = () => ({ ...readState(home, log), ...parseConfig(readConfig()), ...(callHud ? { enabled: true, variant: 'orb' } : {}) })
  let settings = load()
  const size = () => sizeOf(settings.variant)
  // companion.json's own 'enabled' is a 0026 leftover; the agent config is the
  // only switch, so the file always records false.
  const persist = value => writeState(home, { ...value, enabled: false })
  let win = null, tray = null, timer = null, stopped = false, polling = false
  let anchor, display, geometry, bubble = null, serial = 0, cursor = null, lastError = null
  let busy = false, connected = false, providerHealthy = false, awaiting = null, awaitingUntil = 0, lastNudge = null
  let fullscreen = { fullscreen: false, known: process.platform === 'win32' }, hidden = false
  let touched = false, expiresAt = 0, dragging = null, bubbleHeight = 0, shapeKey = null
  const shaped = platform === 'win32' || platform === 'linux'
  // Lazy: off means not even the native fullscreen probe gets loaded.
  let probeFn = probeOverride || null
  const probe = () => (probeFn ||= createFullscreenProbe({ BrowserWindow, log, platform }))()
  let dragTimer = null, listening = false
  // Audio-once rule (design-0027): while the companion is on, the companion
  // renderer owns read-aloud. New agent replies are handed to it here (last 8,
  // by seq) and the chat window's tts.js stays silent.
  let speech = []
  let callEnabled = false, speaking = false
  // Reserve the existing bubble bounds/hit shape during calls, even after blur or dismissal.
  const visibleBubble = () => bubble || (callEnabled ? { kind: 'call', text: '', id: 'call' } : null)

  async function request(route, body) {
    const r = await fetch(new URL(route, url), {
      headers: { 'X-Onboard-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) throw new Error(`companion request ${route.split('?')[0]}: HTTP ${r.status}`)
    return r.json()
  }
  function reposition() {
    if (!win || win.isDestroyed()) return
    const displays = screen.getAllDisplays()
    display = displays.find(d => d.id === display?.id) || screen.getPrimaryDisplay()
    anchor = clampAnchor(anchor, display.workArea, size())
    geometry = layout(anchor, display.workArea, !!visibleBubble(), size(), bubbleHeight || 320)
    win.setBounds(geometry.bounds)
    applyShape()
  }
  function applyShape() {
    if (!shaped || !win || !geometry) return
    const key = JSON.stringify([geometry, visibleBubble() ? bubbleHeight || 320 : 0])
    if (key === shapeKey) return
    win.setShape(hitShape(geometry, visibleBubble() ? bubbleHeight || 320 : 0))
    shapeKey = key
  }
  function remember() {
    settings = { ...persist({ ...settings, displayId: String(display.id),
      positions: { ...settings.positions, [display.id]: anchor } }), ...parseConfig(readConfig()) }
  }
  function ensureWindow() {
    if (win && !win.isDestroyed()) return
    const initial = initialAnchor(settings, screen.getAllDisplays(), screen.getPrimaryDisplay(), size())
    anchor = initial.anchor; display = initial.display
    geometry = layout(anchor, display.workArea, false, size())
    win = new BrowserWindow({ ...geometry.bounds, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false,
      maximizable: false, minimizable: false, hasShadow: false, title: 'Sera companion',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.isSeraCompanion = true
    win.setIgnoreMouseEvents(!shaped, { forward: true })
    shapeKey = null; applyShape()
    if (platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== new URL(url).origin || new URL(target).pathname !== '/companion.html') event.preventDefault()
    })
    win.once('ready-to-show', () => { if (settings.enabled && !hidden && win) win.showInactive() })
    win.on('blur', () => { if (bubble) collapse() })
    win.on('closed', () => { win = null })
    win.loadURL(new URL(bootPathFor('/companion.html'), url).href).catch(e => log(`companion load failed: ${e.message}`))
  }
  function trayFallback() {
    if (!hidden) { if (tray) { tray.destroy(); tray = null }; return }
    if (!tray) tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'onboarding', 'public', 'img', 'agent-avatar.png')).resize({ width: 24, height: 24 }))
    tray.setToolTip('세라 · 전체 화면에서는 잠시 숨겨져 있어요')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '세라 열기', click: openMain },
      ...['off', 'voice', 'companion', 'companion-voice'].map((mode, i) => ({ label: ['Off', 'Voice', 'Companion', 'Companion + voice'][i], type: 'radio', checked: modeOf(readConfig()) === mode, click: () => command({ action: 'settings', mode }).catch(e => log(e.message)) })),
    ]))
    tray.removeAllListeners('click'); tray.on('click', openMain)
  }
  function collapse() {
    bubble = null; touched = false; expiresAt = 0; bubbleHeight = 0
    if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(!shaped, { forward: true }); reposition() }
  }
  function showBubble(kind, text, id) {
    // Never displace an unresolved ask with a casual line or a later completion.
    if (bubble && ['question', 'approval-reply', 'error'].includes(bubble.kind) && kind === 'proactive') return
    bubble = { kind, text: String(text).slice(0, 16000), id: String(id || ++serial) }
    touched = false; expiresAt = kind === 'proactive' ? now() + 20000 : 0
    reposition()
    if (hidden) {
      if (tray) tray.setToolTip('세라 · 확인할 이야기가 있어요')
      if (settings.sound && !['proactive', 'retrying'].includes(kind)) shell.beep()
    } else if (win) win.showInactive()
  }
  function eligible() {
    return canProactive({ now: now(), bootAt, lastAt: lastNudge, intervalMinutes: settings.intervalMinutes,
      enabled: settings.enabled && connected && providerHealthy, ...fullscreen, busy: busy || !!awaiting, bubble: !!bubble })
  }
  function snapshot() {
    return { available: true, ...settings, preferences: parseConfig(readConfig()), callHud, bubble: visibleBubble(), speaking, ring: bubble && ['question', 'approval-reply', 'error'].includes(bubble.kind) ? 'attention' : busy || awaiting ? 'thinking' : 'idle',
      speech, connected, hiddenByFullscreen: hidden, fullscreenKnown: fullscreen.known, geometry }
  }
  async function command(body) {
    const bad = () => { const e = new Error('invalid companion command'); e.code = 'BAD_COMMAND'; throw e }
    if (!body || typeof body !== 'object') bad()
    if (body.action !== 'settings' && !settings.enabled) {
      const e = new Error('companion disabled'); e.code = 'DISABLED'; throw e
    }
    switch (body.action) {
      case 'settings': {
        if (body.mode !== undefined && body.enabled !== undefined) bad()
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') bad()
        if (body.sound !== undefined && typeof body.sound !== 'boolean') bad()
        if (body.intervalMinutes !== undefined && (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 5 || body.intervalMinutes > 1440)) bad()
        if (body.variant !== undefined && !VARIANTS.includes(body.variant)) bad()
        const fields = {
          ...(body.mode === undefined ? {} : modeFields(body.mode)),
          ...(body.enabled === undefined ? {} : { COMPANION_ENABLED: String(body.enabled) }),
          ...(body.variant === undefined ? {} : { COMPANION_VARIANT: body.variant }) }
        if (Object.keys(fields).length) writeConfig(fields)
        if (fields.CALL_ENABLED === 'false') setCallEnabled(false)
        if (body.mode !== undefined) trayFallback()
        const before = settings.variant
        settings = { ...persist({ ...settings,
          ...(body.sound === undefined ? {} : { sound: body.sound }),
          ...(body.intervalMinutes === undefined ? {} : { intervalMinutes: body.intervalMinutes }) }), ...parseConfig(readConfig()), ...(callHud ? { enabled: true, variant: 'orb' } : {}) }
        if (settings.enabled) {
          start(); ensureWindow(); fullscreen = probe(); applyVisibility()
          if (before !== settings.variant) { shapeKey = null; reposition() }
        } else { callEnabled = false; speaking = false; collapse(); awaiting = null; dragging = null; hidden = false; trayFallback(); if (win) win.destroy(); cursor = null; halt() }
        break
      }
      case 'pointer':
        if (typeof body.inside !== 'boolean') bad()
        if (win && !shaped) win.setIgnoreMouseEvents(!body.inside, { forward: true })
        break
      case 'call-error':
        if (typeof body.message !== 'string' || !body.message.trim()) bad()
        showBubble('error', body.message, `call-error-${++serial}`); break
      case 'call-speaking':
        if (typeof body.speaking !== 'boolean') bad()
        speaking = body.speaking; break
      case 'shape':
        if (!Number.isFinite(body.height) || body.height < 0 || body.height > 320) bad()
        bubbleHeight = body.height; reposition(); break
      case 'touch': touched = true; break
      case 'dismiss': collapse(); break
      case 'open':
        if (!settings.enabled) bad()
        if (bubble) collapse()
        else showBubble('compose', '여기서 이야기해 주세요.', 'compose')
        break
      case 'drag-start':
        if (!win || !settings.enabled) bad()
        dragging = { start: screen.getCursorScreenPoint(), anchor: { ...anchor }, until: now() + 15000 }
        break
      case 'drag-end': if (dragging) { dragging = null; remember() }; break
      case 'reply': {
        if (!settings.enabled || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) bad()
        if (cursor === null) { const seed = await request('/api/chat/out?since=0'); cursor = seed.latest }
        const previous = awaiting
        awaiting = 'reply'; awaitingUntil = now() + 10 * 60000
        try { await request('/api/chat/in', { text: body.text }); collapse() }
        catch (e) { awaiting = previous; throw e }
        break
      }
      case 'main': openMain(); break
      default: bad()
    }
    return snapshot()
  }
  function applyVisibility() {
    const decision = fullscreenDecision({ enabled: settings.enabled, ...fullscreen, ...(callHud ? { fullscreen: false } : {}) })
    const changed = hidden !== decision.hiddenByFullscreen
    hidden = decision.hiddenByFullscreen
    if (win) {
      if (!decision.visible) win.hide()
      else if (!win.isVisible()) win.showInactive()
    }
    if (changed) trayFallback()
  }
  async function poll() {
    if (stopped || polling) return
    polling = true
    clearTimeout(timer)
    try {
      if (settings.enabled) {
        fullscreen = probe(); applyVisibility()
        if (expiresAt && !touched && now() >= expiresAt) collapse()
        if (awaiting && now() >= awaitingUntil) awaiting = null
        const [chatResult, errorResult, statusResult, callResult] = await Promise.allSettled([
          request(`/api/chat/out?since=${cursor ?? 0}`), request('/api/agent/turn-error'), request('/api/agent/status'), request('/api/call'),
        ])
        if (callResult.status === 'fulfilled' && callEnabled !== !!callResult.value.enabled) {
          if (callHud && !callResult.value.enabled) setCallEnabled(false)
          callEnabled = !!callResult.value.enabled
          if (!callEnabled) speaking = false
          reposition()
        }
        const chat = chatResult.status === 'fulfilled' ? chatResult.value : null
        connected = !!chat
        busy = !!chat?.state?.awaitingReplySince || !!chat?.draft || statusResult.value?.state === 'connecting'
        const retryBubble = bubble?.kind === 'retrying'
        if (chat) {
          const seed = cursor === null
          for (const item of chat.items || []) {
            if (seed) continue
            if (speakable(item)) speech = [...speech, { seq: item.seq, text: item.text.slice(0, 16000) }].slice(-8)
            if (item.kind === 'message' && item.role === 'user' && awaiting === 'proactive') awaiting = null
            const kind = classifyMessage(item, awaiting) || (retryBubble && speakable(item) ? 'reply' : null)
            if (kind) {
              if (kind !== 'proactive' || (!fullscreen.fullscreen && fullscreen.known)) showBubble(kind, item.text, `chat-${item.seq}`)
              if (awaiting === 'proactive') awaiting = null
            }
            if (['turn-end', 'turn-aborted'].includes(item.kind)) awaiting = null
          }
          cursor = chat.latest
        }
        const error = errorResult.status === 'fulfilled' ? errorResult.value : null
        providerHealthy = statusResult.value?.state === 'live' && !(error?.present && error.fresh)
        const retrying = error?.present && error.fresh && error.subtype === 'retrying'
        if (retrying) {
          if (bubble?.kind !== 'retrying') showBubble('retrying', '다시 보내는 중...', 'retrying')
        } else if (errorResult.status === 'fulfilled' && bubble?.kind === 'retrying') collapse()
        if (error?.present && error.fresh && !retrying && error.ts !== lastError) {
          lastError = error.ts
          const fromProactive = awaiting === 'proactive'
          awaiting = null
          if (!fromProactive)
          showBubble('error', error.subtype === 'AUTH'
            ? 'Claude 로그인이 만료되어 답하지 못하고 있어요. 설정에서 다시 로그인해 주세요.'
            : `답하는 중에 문제가 생겼어요.\n${error.detail}`, `error-${error.ts}`)
        }
        if (eligible()) await request('/api/companion/nudge', {})
      }
    } catch (e) { log(`companion poll: ${e.message}`) }
    finally { polling = false; if (!stopped && autoPoll && settings.enabled) timer = setTimeout(poll, 1000) }
  }
  // Cursor sampling happens ONLY during an explicit avatar drag, never idle.
  const dragTick = () => {
    if (!dragging || !win) return
    if (now() >= dragging.until) { dragging = null; remember(); return }
    const point = screen.getCursorScreenPoint()
    display = screen.getDisplayNearestPoint(point)
    anchor = clampAnchor({ x: dragging.anchor.x + point.x - dragging.start.x, y: dragging.anchor.y + point.y - dragging.start.y }, display.workArea, size())
    reposition()
  }
  function displaysChanged() {
    if (!win) return
    const selected = initialAnchor(settings, screen.getAllDisplays(), screen.getPrimaryDisplay(), size())
    anchor = selected.anchor; display = selected.display; reposition()
  }
  // Everything periodic exists only while enabled: off = no window, no poll,
  // no drag sampler, no display listeners, no proactive nudges.
  function start() {
    if (stopped || listening) return
    listening = true
    dragTimer = setInterval(dragTick, 30)
    screen.on('display-removed', displaysChanged)
    screen.on('display-metrics-changed', displaysChanged)
    if (autoPoll) { clearTimeout(timer); timer = setTimeout(poll, 1000) }
  }
  function halt() {
    if (!listening) return
    listening = false
    clearTimeout(timer); timer = null; clearInterval(dragTimer); dragTimer = null
    screen.removeListener('display-removed', displaysChanged)
    screen.removeListener('display-metrics-changed', displaysChanged)
  }
  function setCallEnabled(enabled) {
    if (!enabled && (callHud || callEnabled)) {
      // Tray changes have no initiating renderer. Notify every open renderer
      // through the same call channel used by the header/settings component.
      for (const window of BrowserWindow.getAllWindows?.() || []) {
        const script = "(() => { const c = new BroadcastChannel('sera-call-settings'); c.postMessage({ enabled: false }); c.close() })()"
        Promise.resolve(window.webContents.executeJavaScript(script)).catch(e => log(`[call broadcast] ${e.message}`))
      }
    }
    if (callHud === !!enabled && callEnabled === !!enabled) return snapshot()
    callHud = !!enabled
    callEnabled = !!enabled
    speaking = false
    settings = load()
    collapse(); shapeKey = null
    if (settings.enabled) {
      start(); ensureWindow(); fullscreen = probe(); reposition(); applyVisibility()
    } else {
      awaiting = null; dragging = null; hidden = false; trayFallback()
      if (win) win.destroy()
      cursor = null; halt()
    }
    return snapshot()
  }
  function dispose() {
    halt(); stopped = true
    if (tray) { tray.destroy(); tray = null }
    if (win) win.destroy()
  }
  app.once('before-quit', dispose)
  const bootConfig = readConfig()
  if (bootConfig.CALL_ENABLED === 'true' && !isCallEnabled(bootConfig)) writeConfig({ CALL_ENABLED: 'false' })
  if (isCallEnabled(bootConfig)) setCallEnabled(true)
  else if (settings.enabled) { start(); ensureWindow(); fullscreen = probe(); applyVisibility() }
  return { snapshot, command, setCallEnabled, dispose, poll, isWindow: candidate => candidate === win,
    get active() { return listening },
    claimNudge() {
      if (!eligible()) return false
      lastNudge = now(); awaiting = 'proactive'; awaitingUntil = now() + 60000
      return true
    },
    nudgeResult(ok) { if (!ok && awaiting === 'proactive') awaiting = null },
  }
}
module.exports = { createCompanion }
