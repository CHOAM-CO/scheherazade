import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const read = name => fs.readFileSync(new URL(`../onboarding/public/js/${name}.js`, import.meta.url), 'utf8')
const listeners = new Map()
const document = { activeElement: null, addEventListener: (k, fn) => listeners.set(k, fn), removeEventListener: k => listeners.delete(k) }
const make = () => ({ isConnected: true, tabIndex: 0, focus() { document.activeElement = this }, getClientRects: () => [1] })
const opener = make(), cancelBtn = make(), confirmBtn = make(), text = {}
const attrs = {}, box = { ...make(), setAttribute: (k, v) => { attrs[k] = v }, querySelectorAll: () => [cancelBtn, confirmBtn], contains: el => [box, cancelBtn, confirmBtn].includes(el) }
let hidden = true
const dialog = { querySelector: () => box, classList: { remove: () => { hidden = false }, add: () => { hidden = true } } }
// Run the actual shared helper without initializing unrelated shell network polls.
const source = read('nav')
const window = {}
vm.runInNewContext(source.slice(source.indexOf('  let closeActiveDialog'), source.indexOf('  let dialogEl')), { window, document })
const open = () => window.openConfirmDialog({ dialog, text, confirmBtn, cancelBtn, message: 'Delete memory?', confirmText: 'Delete', cancelText: 'Cancel' })
function key(key, shiftKey = false) { let prevented = false; listeners.get('keydown')({ key, shiftKey, preventDefault() { prevented = true }, stopPropagation() {} }); assert.equal(prevented, true) }
opener.focus()
let result = open()
assert.equal(hidden, false); assert.equal(attrs.role, 'dialog'); assert.equal(attrs['aria-modal'], 'true'); assert.equal(attrs['aria-label'], 'Delete memory?')
assert.equal(document.activeElement, cancelBtn)
key('Tab', true); assert.equal(document.activeElement, confirmBtn)
key('Tab'); assert.equal(document.activeElement, cancelBtn)
key('Tab'); assert.equal(document.activeElement, confirmBtn)
key('Tab'); assert.equal(document.activeElement, cancelBtn)
opener.focus(); listeners.get('focusin')({ target: opener }); assert.equal(document.activeElement, cancelBtn)
key('Escape'); assert.equal(await result, false); assert.equal(hidden, true); assert.equal(document.activeElement, opener); assert.equal(listeners.size, 0)
result = open(); confirmBtn.onclick(); assert.equal(await result, true); assert.equal(document.activeElement, opener)
result = open(); cancelBtn.onclick(); assert.equal(await result, false)
const first = open(), second = open(); assert.equal(await first, false); cancelBtn.onclick(); assert.equal(await second, false)
for (const name of ['memory', 'nav']) assert.match(read(name), /return window\.openConfirmDialog\(/)
console.log('Shared dialogs: semantics, focus entry/trap/restore, Escape, confirm/cancel and reentry passed')
