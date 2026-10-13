import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createCompanion } = require('../companion/controller.cjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-window-'))
let clock = 1000, fullscreen = false, known = true, latest = 3, items = [], error = { present: false }, nudges = 0, replies = [], beeps = 0, mainOpens = 0
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok ${count} - ${name}`) }
const windows = [], trays = [], requests = []
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.bounds = options; this.visible = false; this.dead = false; this.focused = false; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn }; windows.push(this) }
  setBounds(b) { this.bounds = b }
  setShape(rects) { this.shape = rects }
  isDestroyed() { return this.dead }
  setIgnoreMouseEvents(ignore, opts) { this.ignore = ignore; this.forward = opts.forward }
  setVisibleOnAllWorkspaces() {}
  loadURL(url) { this.url = url; return Promise.resolve() }
  showInactive() { this.visible = true }
  isVisible() { return this.visible }
  hide() { this.visible = false }
  destroy() { this.dead = true; this.emit('closed') }
}
class Tray extends EventEmitter {
  constructor() { super(); trays.push(this) }
  setToolTip(text) { this.text = text }
  setContextMenu(menu) { this.menu = menu }
  destroy() { this.dead = true }
}
const screen = new EventEmitter()
const primary = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 } }
screen.getAllDisplays = () => [primary]
screen.getPrimaryDisplay = () => primary
screen.getCursorScreenPoint = () => ({ x: 200, y: 200 })
screen.getDisplayNearestPoint = () => primary
const app = new EventEmitter()
let controller
const srv = http.createServer(async (req, res) => {
  requests.push({ route: req.url, token: req.headers['x-onboard-token'] })
  let body = ''; for await (const b of req) body += b
  const route = new URL(req.url, 'http://localhost').pathname
  let data = {}
  if (route === '/api/chat/out') data = { latest, items: items.filter(m => m.seq > Number(new URL(req.url, 'http://localhost').searchParams.get('since'))), state: {} }
  else if (route === '/api/agent/status') data = { state: 'live' }
  else if (route === '/api/agent/turn-error') data = error
  else if (route === '/api/chat/in') { replies.push(JSON.parse(body)); data = { ok: true } }
  else if (route === '/api/companion/nudge') { if (controller.claimNudge()) nudges++; data = { injected: true } }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data))
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${srv.address().port}`
controller = createCompanion({ electron: { app, BrowserWindow: Window, screen, Tray, Menu: { buildFromTemplate: x => x }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, shell: { beep: () => beeps++ } },
  home, url, bootPathFor: to => `/boot?t=test-token&to=${encodeURIComponent(to)}`, openMain: () => mainOpens++, log: console.error,
  now: () => clock, probeOverride: () => ({ fullscreen, known }), autoPoll: false, platform: 'win32' })
const add = text => { items.push({ seq: ++latest, role: 'agent', kind: 'message', text }) }
try {
  await test('off by default creates no window', () => assert.equal(windows.length, 0))
  await test('invalid settings rejected without enabling', async () => { await assert.rejects(controller.command({ action: 'settings', enabled: 'yes' }), { code: 'BAD_COMMAND' }); assert.equal(controller.snapshot().enabled, false) })
  await test('enable creates isolated transparent non-taskbar surface', async () => {
    await controller.command({ action: 'settings', enabled: true })
    const o = windows[0].options
    assert.equal(o.frame, false); assert.equal(o.transparent, true); assert.equal(o.skipTaskbar, true); assert.equal(o.alwaysOnTop, true)
    assert.equal(o.webPreferences.contextIsolation, true); assert.equal(o.webPreferences.sandbox, true); assert.equal(o.webPreferences.nodeIntegration, false); assert.equal(o.webPreferences.preload, undefined)
    assert.equal(windows[0].focused, false); assert.equal(windows[0].isSeraCompanion, true)
  })
  await test('Windows shape accepts face clicks and clips transparent corners', () => { assert.equal(windows[0].ignore, false); assert.equal(windows[0].shape.length, 64); assert.ok(windows[0].shape[0].x > 0) })
  await test('renderer navigation cannot leave companion page', () => { let stopped = false; windows[0].webContents.emit('will-navigate', { preventDefault: () => stopped = true }, 'https://example.com'); assert.equal(stopped, true); assert.equal(windows[0].openHandler().action, 'deny') })
  await test('initial retained history is not replayed', async () => { await controller.poll(); assert.equal(controller.snapshot().bubble, null) })
  await test('ordinary chat completion stays quiet', async () => { add('Finished.'); await controller.poll(); assert.equal(controller.snapshot().bubble, null) })
  await test('question opens without focusing window', async () => { add('Which one?'); await controller.poll(); assert.equal(controller.snapshot().bubble.kind, 'question'); assert.equal(windows[0].focused, false) })
  await test('dismissed question does not repeat', async () => { await controller.command({ action: 'dismiss' }); await controller.poll(); assert.equal(controller.snapshot().bubble, null) })
  await test('pointer hit enables interaction', async () => { await controller.command({ action: 'pointer', inside: true }); assert.equal(windows[0].ignore, false) })
  await test('reply uses existing chat endpoint', async () => { await controller.command({ action: 'reply', text: 'The blue one.' }); assert.deepEqual(replies, [{ text: 'The blue one.' }]) })
  await test('response to companion reply comes back into bubble', async () => { add('Done, blue.'); await controller.poll(); assert.equal(controller.snapshot().bubble.kind, 'reply') })
  await test('later completion in same turn also returns', async () => { add('The final file is ready.'); await controller.poll(); assert.equal(controller.snapshot().bubble.text, 'The final file is ready.') })
  await test('blur collapses bubble', () => { windows[0].emit('blur'); assert.equal(controller.snapshot().bubble, null) })
  items.push({ seq: ++latest, kind: 'turn-end', role: 'agent' }); await controller.poll()
  await test('529 retry shows one quiet status, not an error bubble', async () => {
    error = { present: true, fresh: true, ts: 80, subtype: 'retrying', detail: 'HTTP 529 overloaded' }
    await controller.poll()
    assert.equal(controller.snapshot().bubble.kind, 'retrying')
    assert.equal(controller.snapshot().bubble.text, '다시 보내는 중...')
    assert.notEqual(controller.snapshot().ring, 'attention')
    const id = controller.snapshot().bubble.id
    error.ts++; await controller.poll()
    assert.equal(controller.snapshot().bubble.id, id)
  })
  await test('successful retry replaces status with the answer', async () => {
    error = { present: false }; add('Recovered answer.'); await controller.poll()
    assert.equal(controller.snapshot().bubble.kind, 'reply')
    assert.equal(controller.snapshot().bubble.text, 'Recovered answer.')
  })
  await test('exhausted overload replaces retry status with error', async () => {
    error = { present: true, fresh: true, ts: 90, subtype: 'retrying', detail: 'retry your request' }; await controller.poll()
    error = { present: true, fresh: true, ts: 91, subtype: 'error_during_execution', detail: 'HTTP 529 overloaded' }; await controller.poll()
    assert.equal(controller.snapshot().bubble.kind, 'error')
    await controller.command({ action: 'dismiss' })
  })
  await test('fresh auth marker opens error', async () => { error = { present: true, fresh: true, ts: 100, subtype: 'AUTH' }; await controller.poll(); assert.equal(controller.snapshot().bubble.kind, 'error') })
  await test('dismissed auth marker does not repeat', async () => { await controller.command({ action: 'dismiss' }); await controller.poll(); assert.equal(controller.snapshot().bubble, null) })
  await test('known auth failure blocks proactive', async () => { clock += 120001; await controller.poll(); assert.equal(nudges, 0) })
  error = { present: false }
  await test('one proactive turn after boot grace', async () => { await controller.poll(); assert.equal(nudges, 1) })
  await test('proactive response auto-collapses after 20 seconds', async () => { add('A quiet thought.'); await controller.poll(); assert.equal(controller.snapshot().bubble.kind, 'proactive'); clock += 20001; await controller.poll(); assert.equal(controller.snapshot().bubble, null) })
  await test('cooldown prevents retry even after dismissal', async () => { await controller.poll(); assert.equal(nudges, 1) })
  await test('fullscreen hides face and creates tray', async () => { fullscreen = true; await controller.poll(); assert.equal(windows[0].visible, false); assert.equal(trays.length, 1); assert.equal(controller.snapshot().hiddenByFullscreen, true) })
  await test('fullscreen blocks proactive after interval elapses', async () => { clock += 45 * 60000; await controller.poll(); assert.equal(nudges, 1) })
  await test('hidden attention sounds only when opted in', async () => { add('One more question?'); await controller.poll(); assert.equal(beeps, 0); await controller.command({ action: 'settings', sound: true }); add('Can I proceed?'); await controller.poll(); assert.equal(beeps, 1) })
  await test('tray opens main, not companion', () => { trays[0].emit('click'); assert.equal(mainOpens, 1) })
  await test('fullscreen exit restores without focus and removes tray', async () => { fullscreen = false; await controller.poll(); assert.equal(windows[0].visible, true); assert.equal(windows[0].focused, false); assert.equal(trays[0].dead, true) })
  await test('unknown fullscreen blocks proactive', async () => { await controller.command({ action: 'dismiss' }); known = false; await controller.poll(); assert.equal(nudges, 1) })
  await test('all requests carry same per-launch auth token', () => assert.ok(requests.length > 0 && requests.every(r => r.token === 'test-token')))
  await test('disable destroys companion only and persists off', async () => { await controller.command({ action: 'settings', enabled: false }); assert.equal(windows[0].dead, true); assert.equal(controller.snapshot().enabled, false); assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'companion.json'))).enabled, false) })
  await test('disabled poll produces no traffic', async () => { const n = requests.length; await controller.poll(); assert.equal(requests.length, n) })
} finally {
  controller.dispose(); srv.closeAllConnections(); await new Promise(r => srv.close(r))
  for (const f of fs.readdirSync(home)) fs.unlinkSync(path.join(home, f)); fs.rmdirSync(home)
}
console.log(`${count} companion controller checks passed`)
