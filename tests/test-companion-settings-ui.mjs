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

// Execute both real renderers: the header must never contain native select chrome.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {} }
  setAttribute(k, v) { this.attrs[k] = v }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  querySelector(selector) { return this.children.find(n => n.className === selector.slice(1)) }
}
const header = new Node('span'); header.id = 'qb-companion'
const settings = new Node('div')
let panel, posted
const modeWindow = {
  api: async (url, opts) => {
    if (opts) posted = JSON.parse(opts.body)
    return url === '/api/companion' ? { mode: posted?.mode || 'voice' } : { modelsPresent: false }
  },
  createQuickbarPopover: () => ({ open(p) { panel = p }, close() {} }),
  addEventListener() {}, dispatchEvent() {},
}
vm.runInNewContext(fs.readFileSync(new URL('../onboarding/public/js/companion-mode-control.js', import.meta.url), 'utf8'), {
  window: modeWindow, document: { querySelectorAll: () => [header, settings], createElement: tag => new Node(tag) },
  BroadcastChannel: class {}, setInterval() {}, Event: class {},
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(header.children.length, 1)
const icon = header.children[0]
assert.equal(icon.tag, 'button'); assert.equal(icon.className, 'qb secondary icon-button')
assert.equal(icon.dataset.state, 'on'); assert.equal(icon.title, 'Voice')
assert(!header.children.some(n => n.tag === 'select'))
assert.equal(settings.children[1].tag, 'select')
icon.onclick()
const modeRadios = panel.children[0].children.map(label => label.children[0])
assert.equal(modeRadios.length, 4); assert.equal(modeRadios[1].checked, true)
await modeRadios[2].onchange()
assert.deepEqual(posted, { action: 'settings', mode: 'companion' })
assert.equal(settings.children[1].value, 'companion')
console.log('Header icon/radio popover and Settings select share persisted mode passed')
