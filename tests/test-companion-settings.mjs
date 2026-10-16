// Companion gate (design-0027): COMPANION_ENABLED default off, COMPANION_VARIANT
// default 'face', and nothing (window, timers, route actions, nudges) gets
// through while it is off. Electron is mocked; the HTTP part is the real server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-companion-settings-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.AGENT_DATA_HOME = path.join(tmp, 'data')
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')
fs.mkdirSync(process.env.AGENT_DATA_HOME)
const require = createRequire(import.meta.url)
const model = require('../companion/model.cjs')
const { createCompanion } = require('../companion/controller.cjs')
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`ok ${count} - ${name}`) }

const windows = []
class Window extends EventEmitter {
  constructor(o) { super(); this.options = o; this.bounds = o; this.dead = false; this.visible = false; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; windows.push(this) }
  setBounds(b) { this.bounds = b } setShape(r) { this.shape = r } isDestroyed() { return this.dead }
  setIgnoreMouseEvents() {} setVisibleOnAllWorkspaces() {} loadURL() { return Promise.resolve() }
  showInactive() { this.visible = true } isVisible() { return this.visible } hide() { this.visible = false }
  destroy() { this.dead = true; this.emit('closed') }
}
const screen = new EventEmitter()
const primary = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 } }
Object.assign(screen, { getAllDisplays: () => [primary], getPrimaryDisplay: () => primary, getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => primary })
const electron = { app: new EventEmitter(), BrowserWindow: Window, screen, Tray: class {}, Menu: { buildFromTemplate: x => x }, nativeImage: {}, shell: { beep() {} } }
let probes = 0
const cfg = {}
const home = path.join(tmp, 'companion-home')
const ctl = createCompanion({ electron, home, url: 'http://127.0.0.1:9', bootPathFor: to => `/boot?t=x&to=${encodeURIComponent(to)}`, openMain() {}, log() {},
  probeOverride: () => { probes++; return { fullscreen: false, known: true } }, autoPoll: true, platform: 'win32',
  readConfig: () => ({ ...cfg }), writeConfig: f => Object.assign(cfg, f) })

const { createOnboardingServer, SERVER_TOKEN } = require('../onboarding/http-server.cjs')
const configFile = path.join(process.env.AGENT_DATA_HOME, '.agent-config')
const calls = []
let stub = null
const { server, url } = await createOnboardingServer(null, { companion: () => stub })
const auth = { 'X-Onboard-Token': SERVER_TOKEN, 'Content-Type': 'application/json' }
const post = (route, body) => fetch(new URL(route, url), { method: 'POST', headers: auth, body: JSON.stringify(body) })
try {
  await test('config defaults: off, face', () => assert.deepEqual(model.readConfig({}), { enabled: false, variant: 'face' }))
  await test('only "true" enables; unknown variant falls back to face', () => {
    assert.equal(model.readConfig({ COMPANION_ENABLED: '1' }).enabled, false)
    assert.deepEqual(model.readConfig({ COMPANION_ENABLED: 'true', COMPANION_VARIANT: 'orb' }), { enabled: true, variant: 'orb' })
    assert.equal(model.readConfig({ COMPANION_VARIANT: 'mascot' }).variant, 'face')
  })
  await test('off by default: no window, no timers, no fullscreen probe', () => {
    assert.equal(windows.length, 0); assert.equal(ctl.active, false); assert.equal(probes, 0)
    assert.equal(ctl.snapshot().enabled, false); assert.equal(ctl.snapshot().variant, 'face')
  })
  await test('controller refuses every non-settings action while off', async () => {
    for (const action of ['open', 'reply', 'drag-start', 'pointer', 'main']) await assert.rejects(ctl.command({ action, text: 'hi', inside: true }), { code: 'DISABLED' })
    assert.equal(windows.length, 0)
  })
  await test('claimNudge is false while off', () => assert.equal(ctl.claimNudge(), false))
  await test('enable writes COMPANION_ENABLED and starts the surface', async () => {
    await ctl.command({ action: 'settings', enabled: true })
    assert.equal(cfg.COMPANION_ENABLED, 'true'); assert.equal(windows.length, 1); assert.equal(ctl.active, true)
    assert.deepEqual([windows[0].bounds.width, windows[0].bounds.height], [64, 64])
  })
  await test('variant orb writes COMPANION_VARIANT and resizes without restart', async () => {
    await ctl.command({ action: 'settings', variant: 'orb' })
    assert.equal(cfg.COMPANION_VARIANT, 'orb'); assert.equal(ctl.snapshot().variant, 'orb'); assert.equal(windows.length, 1)
    assert.deepEqual([windows[0].bounds.width, windows[0].bounds.height], [model.SIZES.orb.width, model.SIZES.orb.height])
  })
  await test('bad variant rejected', async () => assert.rejects(ctl.command({ action: 'settings', variant: 'mascot' }), { code: 'BAD_COMMAND' }))
  await test('disable destroys the window and stops all timers', async () => {
    await ctl.command({ action: 'settings', enabled: false })
    assert.equal(windows[0].dead, true); assert.equal(ctl.active, false); assert.equal(cfg.COMPANION_ENABLED, 'false')
  })
  await test('one mode writes companion and TTS together without changing microphone/call consent', async () => {
    cfg.STT_ENABLED = 'true'; cfg.CALL_ENABLED = 'false'
    for (const [mode, companion, tts] of [['voice', 'false', 'true'], ['companion-voice', 'true', 'true'], ['companion', 'true', 'false'], ['off', 'false', 'false']]) {
      await ctl.command({ action: 'settings', mode })
      assert.equal(cfg.COMPANION_ENABLED, companion); assert.equal(cfg.TTS_ENABLED, tts)
      assert.equal(cfg.STT_ENABLED, 'true'); assert.equal(cfg.CALL_ENABLED, 'false')
    }
    let broadcasts = 0
    Window.getAllWindows = () => [{ webContents: { executeJavaScript: async () => { broadcasts++ } } }]
    cfg.CALL_ENABLED = 'true'
    await ctl.command({ action: 'settings', mode: 'companion-voice' })
    ctl.setCallEnabled(true)
    await ctl.command({ action: 'settings', mode: 'off' })
    assert.equal(ctl.snapshot().callHud, false)
    await ctl.command({ action: 'settings', mode: 'off' })
    assert.equal(broadcasts, 1, 'only the true-to-false call transition broadcasts')
    delete Window.getAllWindows
    await ctl.command({ action: 'settings', mode: 'companion-voice' })
    assert.equal(cfg.CALL_ENABLED, 'false'); assert.equal(ctl.snapshot().callHud, false)
    await ctl.command({ action: 'settings', mode: 'off' })
    await assert.rejects(ctl.command({ action: 'settings', mode: 'invalid' }), { code: 'BAD_COMMAND' })
  })
  await test('companion.json does not carry the switch', () => assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'companion.json'))).enabled, false))
  await test('speakable mirrors chat read-aloud filter', () => {
    assert.equal(model.speakable({ role: 'agent', kind: 'message', text: '안녕' }), true)
    assert.equal(model.speakable({ role: 'agent', kind: 'message', text: '[system] reset' }), false)
    assert.equal(model.speakable({ role: 'user', kind: 'message', text: 'x' }), false)
    assert.equal(model.speakable({ role: 'agent', kind: 'activity', text: 'x' }), false)
  })

  // HTTP: the route that opens the companion refuses while the config is off.
  stub = { snapshot: () => ({ available: true, enabled: false }), command: async b => { calls.push(b.action); return { ok: true } }, claimNudge: () => { calls.push('nudge'); return true }, nudgeResult() {} }
  await test('route: open refused with 409 while off, controller never called', async () => {
    const r = await post('/api/companion', { action: 'open' })
    assert.equal(r.status, 409); assert.deepEqual(calls, [])
  })
  await test('route: nudge refused while off without touching the controller', async () => {
    assert.deepEqual(await (await post('/api/companion/nudge', {})).json(), { injected: false }); assert.deepEqual(calls, [])
  })
  await test('route: settings is allowed while off (it is the toggle)', async () => {
    assert.equal((await post('/api/companion', { action: 'settings', enabled: true })).status, 200); assert.deepEqual(calls, ['settings'])
  })
  stub = null
  await test('route without electron: GET reports defaults from config', async () => {
    const s = await (await fetch(new URL('/api/companion', url), { headers: auth })).json()
    assert.deepEqual(s, { available: false, enabled: false, variant: 'face', mode: 'off' })
  })
  await test('route without electron: settings persist the keys', async () => {
    const r = await post('/api/companion', { action: 'settings', enabled: true, variant: 'orb' })
    assert.deepEqual(await r.json(), { available: false, enabled: true, variant: 'orb', mode: 'companion' })
    const text = fs.readFileSync(configFile, 'utf8')
    assert.match(text, /^COMPANION_ENABLED=.?true/m); assert.match(text, /^COMPANION_VARIANT=.?orb/m)
  })
  await test('route without electron: bad variant 400', async () => assert.equal((await post('/api/companion', { action: 'settings', variant: 'x' })).status, 400))
  await test('route without electron: open after enable is 503, not a window', async () => assert.equal((await post('/api/companion', { action: 'open' })).status, 503))
  await test('mode plus enabled rejected; TTS-only mode persists without companion', async () => {
    assert.equal((await post('/api/companion', { action: 'settings', mode: 'off', enabled: true })).status, 400)
    const response = await post('/api/companion', { action: 'settings', mode: 'voice' })
    assert.equal((await response.json()).mode, 'voice')
    assert.match(fs.readFileSync(configFile, 'utf8'), /^TTS_ENABLED=.?true/m)
  })
  await test('legacy TTS disable revokes persisted and runtime call consent', async () => {
    let stopped = 0
    stub = { setCallEnabled: enabled => { assert.equal(enabled, false); stopped++ } }
    fs.appendFileSync(configFile, '\nCALL_ENABLED=true\nTTS_ENABLED=true\n')
    const response = await post('/api/tts/settings', { enabled: false })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).enabled, false)
    assert.equal(stopped, 1)
    const contents = fs.readFileSync(configFile, 'utf8')
    assert.match(contents, /^CALL_ENABLED=.?false/m)
    assert.doesNotMatch(contents, /^CALL_ENABLED=.?true/m)
    stub = null
  })
  await test('route: unknown action 400', async () => assert.equal((await post('/api/companion', { action: 'execute' })).status, 400))
} finally {
  ctl.dispose()
  server.closeAllConnections(); await new Promise(r => server.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`${count} companion settings checks passed`)
