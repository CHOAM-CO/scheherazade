'use strict'

const path = require('node:path')
const { readState, writeState, initialAnchor, clampAnchor, layout, fullscreenDecision, canProactive, classifyMessage } = require('./model.cjs')
const { createFullscreenProbe } = require('./fullscreen.cjs')

function createCompanion({ electron, home, url, bootPathFor, openMain, log, now = Date.now, probeOverride, autoPoll = true }) {
  const { app, BrowserWindow, screen, Tray, Menu, nativeImage, shell } = electron
  const token = new URL(bootPathFor('/'), url).searchParams.get('t')
  const bootAt = now()
  let settings = readState(home, log)
  let win = null, tray = null, timer = null, stopped = false, polling = false
  let anchor, display, geometry, bubble = null, serial = 0, cursor = null, lastError = null
  let busy = false, connected = false, providerHealthy = false, awaiting = null, awaitingUntil = 0, lastNudge = null
  let fullscreen = { fullscreen: false, known: process.platform === 'win32' }, hidden = false
  let touched = false, expiresAt = 0, dragging = null
  const probe = probeOverride || createFullscreenProbe({ BrowserWindow, log })

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
    anchor = clampAnchor(anchor, display.workArea)
    geometry = layout(anchor, display.workArea, !!bubble)
    win.setBounds(geometry.bounds)
  }
  function remember() {
    settings = writeState(home, { ...settings, displayId: String(display.id),
      positions: { ...settings.positions, [display.id]: anchor } })
  }
  function ensureWindow() {
    if (win && !win.isDestroyed()) return
    const initial = initialAnchor(settings, screen.getAllDisplays(), screen.getPrimaryDisplay())
    anchor = initial.anchor; display = initial.display
    geometry = layout(anchor, display.workArea, false)
    win = new BrowserWindow({ ...geometry.bounds, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false,
      maximizable: false, minimizable: false, hasShadow: false, title: 'Sera companion',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.isSeraCompanion = true
    win.setIgnoreMouseEvents(true, { forward: true })
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
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
    if (tray) return
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'onboarding', 'public', 'img', 'agent-avatar.png')).resize({ width: 24, height: 24 }))
    tray.setToolTip('세라 · 전체 화면에서는 잠시 숨겨져 있어요')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '세라 열기', click: openMain },
      { label: '컴패니언 끄기', click: () => command({ action: 'settings', enabled: false }).catch(e => log(e.message)) },
    ]))
    tray.on('click', openMain)
  }
  function collapse() {
    bubble = null; touched = false; expiresAt = 0
    if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(true, { forward: true }); reposition() }
  }
  function showBubble(kind, text, id) {
    // Never displace an unresolved ask with a casual line or a later completion.
    if (bubble && ['question', 'approval-reply', 'error'].includes(bubble.kind) && kind === 'proactive') return
    bubble = { kind, text: String(text).slice(0, 16000), id: String(id || ++serial) }
    touched = false; expiresAt = kind === 'proactive' ? now() + 20000 : 0
    reposition()
    if (hidden) {
      if (tray) tray.setToolTip('세라 · 확인할 이야기가 있어요')
      if (settings.sound && kind !== 'proactive') shell.beep()
    } else if (win) win.showInactive()
  }
  function eligible() {
    return canProactive({ now: now(), bootAt, lastAt: lastNudge, intervalMinutes: settings.intervalMinutes,
      enabled: settings.enabled && connected && providerHealthy, ...fullscreen, busy: busy || !!awaiting, bubble: !!bubble })
  }
  function snapshot() {
    return { available: true, ...settings, bubble, ring: bubble && ['question', 'approval-reply', 'error'].includes(bubble.kind) ? 'attention' : busy || awaiting ? 'thinking' : 'idle',
      connected, hiddenByFullscreen: hidden, fullscreenKnown: fullscreen.known, geometry }
  }
  async function command(body) {
    const bad = () => { const e = new Error('invalid companion command'); e.code = 'BAD_COMMAND'; throw e }
    if (!body || typeof body !== 'object') bad()
    switch (body.action) {
      case 'settings': {
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') bad()
        if (body.sound !== undefined && typeof body.sound !== 'boolean') bad()
        if (body.intervalMinutes !== undefined && (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 5 || body.intervalMinutes > 1440)) bad()
        settings = writeState(home, { ...settings,
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.sound === undefined ? {} : { sound: body.sound }),
          ...(body.intervalMinutes === undefined ? {} : { intervalMinutes: body.intervalMinutes }) })
        if (settings.enabled) { ensureWindow(); fullscreen = probe(); applyVisibility() }
        else { collapse(); awaiting = null; dragging = null; hidden = false; trayFallback(); if (win) win.destroy(); cursor = null }
        break
      }
      case 'pointer':
        if (typeof body.inside !== 'boolean') bad()
        if (win) win.setIgnoreMouseEvents(!body.inside, { forward: true })
        break
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
    const decision = fullscreenDecision({ enabled: settings.enabled, ...fullscreen })
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
        const [chatResult, errorResult, statusResult] = await Promise.allSettled([
          request(`/api/chat/out?since=${cursor ?? 0}`), request('/api/agent/turn-error'), request('/api/agent/status'),
        ])
        const chat = chatResult.status === 'fulfilled' ? chatResult.value : null
        connected = !!chat
        busy = !!chat?.state?.awaitingReplySince || !!chat?.draft || statusResult.value?.state === 'connecting'
        if (chat) {
          const seed = cursor === null
          for (const item of chat.items || []) {
            if (seed) continue
            if (item.kind === 'message' && item.role === 'user' && awaiting === 'proactive') awaiting = null
            const kind = classifyMessage(item, awaiting)
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
        if (error?.present && error.fresh && error.ts !== lastError) {
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
    finally { polling = false; if (!stopped && autoPoll) timer = setTimeout(poll, 1000) }
  }
  // Cursor sampling happens ONLY during an explicit avatar drag, never idle.
  const dragTimer = setInterval(() => {
    if (!dragging || !win) return
    if (now() >= dragging.until) { dragging = null; remember(); return }
    const point = screen.getCursorScreenPoint()
    display = screen.getDisplayNearestPoint(point)
    anchor = clampAnchor({ x: dragging.anchor.x + point.x - dragging.start.x, y: dragging.anchor.y + point.y - dragging.start.y }, display.workArea)
    reposition()
  }, 30)
  function displaysChanged() {
    if (!win) return
    const selected = initialAnchor(settings, screen.getAllDisplays(), screen.getPrimaryDisplay())
    anchor = selected.anchor; display = selected.display; reposition()
  }
  screen.on('display-removed', displaysChanged)
  screen.on('display-metrics-changed', displaysChanged)
  function dispose() {
    stopped = true; clearTimeout(timer); clearInterval(dragTimer)
    screen.removeListener('display-removed', displaysChanged)
    screen.removeListener('display-metrics-changed', displaysChanged)
    if (tray) { tray.destroy(); tray = null }
    if (win) win.destroy()
  }
  app.once('before-quit', dispose)
  if (settings.enabled) { ensureWindow(); fullscreen = probe(); applyVisibility() }
  if (autoPoll) timer = setTimeout(poll, 1000)
  return { snapshot, command, dispose, poll, isWindow: candidate => candidate === win,
    claimNudge() {
      if (!eligible()) return false
      lastNudge = now(); awaiting = 'proactive'; awaitingUntil = now() + 60000
      return true
    },
    nudgeResult(ok) { if (!ok && awaiting === 'proactive') awaiting = null },
  }
}
module.exports = { createCompanion }
