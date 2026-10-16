import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createCompanion } = require('../companion/controller.cjs')
const root = new URL('../', import.meta.url)
const read = name => fs.readFileSync(new URL(name, root), 'utf8')
let count = 0
async function test(name, fn) { await fn(); console.log(`ok ${++count} - ${name}`) }
const flush = () => new Promise(resolve => setImmediate(resolve))
await test('shared mode selector reads state, writes one mode and refreshes', async () => {
  const calls = [], controls = []
  const slot = { replaceChildren() {} }
  let state = { available: true, mode: 'voice' }, tick, focus
  const window = { api: async (route, options) => {
    calls.push([route, options])
    if (options && route === '/api/companion') state.mode = JSON.parse(options.body).mode
    return state
  }, dispatchEvent() {}, addEventListener: (type, cb) => { if (type === 'focus') focus = cb } }
  vm.runInNewContext(read('onboarding/public/js/companion-mode-control.js'), {
    window, Event: class {}, BroadcastChannel: class { postMessage() {} }, document: { querySelectorAll: () => [slot], createElement: tag => {
      const el = { dataset: {}, setAttribute() {}, append() {} }; if (tag === 'select') controls.push(el); return el
    } }, setInterval: (cb, ms) => { assert.equal(ms, 5000); tick = cb },
  })
  const select = controls[0]
  await flush(); assert.equal(select.value, 'voice')
  select.value = 'voice'; await select.onchange()
  assert.deepEqual(JSON.parse(calls.find(c => c[1])[1].body), { action: 'settings', mode: 'voice' })
  assert.ok(calls.filter(([, options]) => options).every(([route]) => route === '/api/companion'), 'one preference write owns the mode')
  state.mode = 'companion'; await focus(); assert.equal(select.value, 'companion')
  state.available = false; await tick(); assert.equal(select.disabled, false, 'browser-only Voice remains usable')
})
await test('one settings group hosts voice and mic without introducing a call-mode key', () => {
  const html = read('onboarding/public/settings.html')
  const group = html.slice(html.indexOf('id="set-companion"'), html.indexOf('id="set-autonomy"'))
  for (const id of ['set-companion-voice', 'set-companion-mic']) assert.ok(group.includes(`id="${id}"`))
  assert.match(group, /id="set-companion-call"/)
  assert.equal((group.match(/data-companion-mode/g) || []).length, 1)
  assert.doesNotMatch(group, /id="set-companion-enabled"/)
  for (const name of ['tts', 'stt']) assert.match(read(`onboarding/public/js/${name}.js`), /Math\.round\(d.done \/ d.total \* 100\)/)
})
await test('bubble has no notification chrome and keeps conversational approval endpoints', () => {
  const html = read('onboarding/public/companion.html'), js = read('onboarding/public/js/companion.js')
  assert.doesNotMatch(html, /id="close"|<header>|>보내기</)
  assert.match(html, /id="ghost"/)
  assert.match(html, /id="send"[^>]*aria-label=/)
  assert.match(js, /\$\('main'\).hidden = b.kind !== 'approval-reply'/)
  assert.match(js, /command\('reply', \{ text \}\)/)
  assert.match(js, /e.key === 'Escape'/)
})
await test('companion error presenter expands Face and renders a text-only alert', async () => {
  const elements = new Map(), commands = []
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, style: {}, dataset: {}, value: '', classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, addEventListener() {}, getBoundingClientRect: () => ({ height: 140 }) })
    return elements.get(id)
  }
  let state = { variant: 'face', bubble: null, ring: 'idle', connected: true }
  const window = { getOnboardToken: () => 'test' }
  vm.runInNewContext(read('onboarding/public/js/companion.js'), {
    window, document: { getElementById: element, body: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] },
    Audio: class {}, ResizeObserver: class { observe() {} }, setTimeout() {}, setInterval() {}, AbortSignal, URL, console,
    fetch: async (route, opts) => {
      if (route === '/api/companion' && opts.body) {
        const body = JSON.parse(opts.body); commands.push(body)
        if (body.action === 'call-error') state = { ...state, bubble: { id: 'error-1', kind: 'error', text: body.message } }
      }
      return { ok: true, json: async () => route === '/api/companion' ? state : {}, blob: async () => new Blob() }
    },
  })
  await flush()
  assert.equal(element('bubble').hidden, true)
  await window.SeraCompanionError('<img onerror=unsafe> TTS 실패')
  assert.equal(element('bubble').hidden, false)
  assert.equal(element('failure').hidden, false)
  assert.equal(element('failure').textContent, '<img onerror=unsafe> TTS 실패')
  assert.ok(commands.some(c => c.action === 'call-error'))
  assert.ok(commands.some(c => c.action === 'shape' && c.height === 140))
})
await test('macOS pointer enter/leave retains forwarded click-through and dynamic shape anchoring', async () => {
  const calls = [], windows = []
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {} }
    setIgnoreMouseEvents(ignore, opts) { calls.push({ ignore, ...opts }) }
    isDestroyed() { return false } setBounds(bounds) { this.bounds = bounds }
    setVisibleOnAllWorkspaces() {} loadURL() { return Promise.resolve() }
    showInactive() {} hide() {} destroy() {} isVisible() { return true }
  }
  // Existing fixture convention, with no persistent app configuration touched.
  const os = require('node:os'), path = require('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-ux-'))
  const screen = new EventEmitter(), display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }
  Object.assign(screen, { getAllDisplays: () => [display], getPrimaryDisplay: () => display })
  const ctl = createCompanion({ electron: { app: new EventEmitter(), BrowserWindow: Window, screen }, home,
    url: 'http://127.0.0.1:9', bootPathFor: () => '/?t=test', openMain() {}, log() {}, autoPoll: false,
    platform: 'darwin', probeOverride: () => ({ fullscreen: false, known: true }) })
  try {
    await ctl.command({ action: 'settings', enabled: true, variant: 'orb' })
    assert.deepEqual(calls.at(-1), { ignore: true, forward: true })
    await ctl.command({ action: 'pointer', inside: true })
    assert.deepEqual(calls.at(-1), { ignore: false, forward: true })
    await ctl.command({ action: 'pointer', inside: false })
    assert.deepEqual(calls.at(-1), { ignore: true, forward: true })
    await ctl.command({ action: 'open' }); await ctl.command({ action: 'shape', height: 80 })
    const g = ctl.snapshot().geometry
    assert.equal(g.face.x + 40 - (g.bubbleLeft + 320), 12)
    assert.equal(g.bubbleTop, 60)
    await ctl.command({ action: 'dismiss' })
    assert.deepEqual(calls.at(-1), { ignore: true, forward: true })
  } finally {
    ctl.dispose()
    for (const file of fs.readdirSync(home)) fs.unlinkSync(path.join(home, file))
    fs.rmdirSync(home)
  }
})
console.log(`${count} companion UX checks passed`)
