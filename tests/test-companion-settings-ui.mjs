import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const elements = Object.fromEntries(['enabled', 'interval', 'sound', 'save', 'status'].map(k => [k, { value: '', checked: false, setAttribute() {}, reportValidity: () => true }]))
const radios = [{ value: 'face' }, { value: 'orb' }]
let server = { available: true, enabled: false, variant: 'face', intervalMinutes: 30, sound: false }
let fail = false, pending
const api = async (_url, opts) => {
  if (pending) await pending
  if (fail) throw Error('offline')
  if (opts) server = { ...server, ...JSON.parse(opts.body) }
  return { ...server }
}
await vm.runInNewContext(fs.readFileSync(new URL('../onboarding/public/js/companion-settings.js', import.meta.url), 'utf8'), {
  window: { api }, navigator: { language: 'en' }, document: { getElementById: id => elements[id.replace('set-companion-', '')], querySelectorAll: () => radios },
})
elements.interval.value = '75'; elements.sound.checked = true
assert.equal(elements.interval.value, '75'); assert.equal(elements.sound.checked, true)
radios[1].checked = true; await radios[1].onchange()
assert.equal(elements.interval.value, '75'); assert.equal(elements.sound.checked, true)
fail = true
radios[0].checked = true; await radios[0].onchange()
assert.equal(radios[0].checked, false); assert.equal(radios[1].checked, true)
assert.equal(elements.save.disabled, false)
fail = false
let release; pending = new Promise(resolve => { release = resolve })
const saving = elements.save.onclick()
assert.equal(radios[0].disabled, true)
release(); await saving; pending = null
assert.equal(server.intervalMinutes, 75); assert.equal(server.sound, true)
assert.equal(elements.save.disabled, false)
console.log('Companion draft preservation, rollback, retry and serialization passed')

server = { ...server, enabled: true, variant: 'orb', callHud: true, preferences: { enabled: false, variant: 'face' } }
await elements.save.onclick()
assert.equal(radios[0].checked, true)
assert.equal(radios[1].checked, false)
assert.deepEqual(server.preferences, { enabled: false, variant: 'face' })
console.log('Settings read persisted preferences during a temporary call HUD passed')


// Execute both renderers with the real popover, including DOM focus/lifecycle.
const listeners = new Map()
const document = {
  activeElement: null,
  addEventListener(type, fn) { listeners.set(type, fn) },
  removeEventListener(type) { listeners.delete(type) },
}
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.style = {}; this.className = ''; this.classList = { add: name => { this.className += ` ${name}` } } }
  setAttribute(k, v) { this.attrs[k] = v }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n) } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  contains(n) { return n === this || this.children.some(c => c.contains(n)) }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this) }
  focus() { assert.notEqual(this.disabled, true); document.activeElement = this }
  getBoundingClientRect() { return { left: 100, bottom: 60 } }
  querySelector(selector) {
    const all = this.children.flatMap(n => [n, ...n.descendants()])
    if (selector.startsWith('.')) return all.find(n => n.className.split(' ').includes(selector.slice(1)))
    return all.find(n => n.tag === 'input' && n.checked) || all.find(n => ['input', 'button', 'select', 'a'].includes(n.tag))
  }
  descendants() { return this.children.flatMap(n => [n, ...n.descendants()]) }
}
const header = new Node('span'); header.id = 'qb-companion'
const settings = new Node('div')
document.body = new Node('body'); document.body.append(header, settings)
document.querySelectorAll = () => [header, settings]
document.createElement = tag => new Node(tag)
let posted, mode = 'voice', poll, deferRead, deferPost, deferVoice
const events = {}
const modeWindow = {
  innerWidth: 1024, innerHeight: 768,
  api: async (url, opts) => {
    if (opts) {
      posted = JSON.parse(opts.body)
      if (deferPost) await deferPost
      mode = posted.mode
    }
    if (url === '/api/companion') {
      if (!opts && deferRead) { const pending = deferRead; deferRead = null; return pending }
      return { mode }
    }
    if (deferVoice) { const pending = deferVoice; deferVoice = null; return pending }
    return { modelsPresent: false }
  },
  addEventListener(name, fn) { events[name] = fn }, removeEventListener() {}, dispatchEvent() {},
}
const context = vm.createContext({ window: modeWindow, document, BroadcastChannel: class {}, setInterval(fn) { poll = fn }, Event: class {} })
vm.runInContext(fs.readFileSync(new URL('../onboarding/public/js/quickbar-popover.js', import.meta.url), 'utf8'), context)
vm.runInContext(fs.readFileSync(new URL('../onboarding/public/js/companion-mode-control.js', import.meta.url), 'utf8'), context)
const settled = () => new Promise(resolve => setImmediate(resolve))
await settled()
assert.equal(header.children.length, 1)
const icon = header.children[0]
assert.equal(icon.tag, 'button'); assert.equal(icon.className, 'qb secondary icon-button')
assert.equal(icon.dataset.state, 'on'); assert.equal(icon.title, 'Companion & voice: Voice')
assert.equal(icon.attrs['aria-label'], icon.title)
assert(!header.descendants().some(n => n.tag === 'select'))
assert.equal(settings.children[1].tag, 'select')
assert.equal(icon.attrs['aria-expanded'], 'false')
icon.onclick()
assert.equal(icon.attrs['aria-expanded'], 'true')
const panel = document.body.children.at(-1)
const modeRadios = panel.children[0].children.map(label => label.children[0])
assert.equal(modeRadios.length, 4); assert.equal(modeRadios[1].checked, true)
assert.equal(document.activeElement, modeRadios[1])
// An old poll remains unresolved until AFTER a new mode has been persisted.
let releaseRead, releasePost
const staleRead = new Promise(resolve => { releaseRead = resolve }); deferRead = staleRead
const polling = poll()
deferPost = new Promise(resolve => { releasePost = resolve })
modeRadios[2].focus(); modeRadios[2].checked = true
const changing = modeRadios[2].onchange()
assert.equal(document.activeElement, modeRadios[2])
assert.equal(modeRadios[2].disabled, false)
assert.equal(panel.children[0].attrs['aria-busy'], 'true')
assert.equal(modeRadios[2].attrs['aria-disabled'], 'true')
assert.deepEqual(posted, { action: 'settings', mode: 'companion' })
releasePost(); await changing; deferPost = null
releaseRead({ mode: 'off' }); await polling
assert.equal(settings.children[1].value, 'companion')
assert.equal(modeRadios[2].checked, true)
assert.equal(document.activeElement, modeRadios[2])
assert.equal(panel.children[0].attrs['aria-busy'], 'false')
// Also invalidate a poll that has already reached its voice-status await.
let releaseVoice
deferVoice = new Promise(resolve => { releaseVoice = resolve })
const voicePolling = poll(); await settled()
modeRadios[3].focus(); await modeRadios[3].onchange()
releaseVoice({ modelsPresent: true }); await voicePolling
assert.equal(settings.children[1].value, 'companion-voice')
assert.equal(document.activeElement, modeRadios[3])
listeners.get('keydown')({ key: 'Escape' })
assert.equal(icon.attrs['aria-expanded'], 'false'); assert.equal(document.activeElement, icon)
assert.equal(document.body.children.length, 2)
icon.onclick(); assert.equal(icon.attrs['aria-expanded'], 'true')
icon.onclick(); assert.equal(icon.attrs['aria-expanded'], 'false')
icon.onclick(); listeners.get('pointerdown')({ target: settings })
assert.equal(icon.attrs['aria-expanded'], 'false')
console.log('Real companion popover: lifecycle, labels, focus during POST and stale mode/voice reads passed')
