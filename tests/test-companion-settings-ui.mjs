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
elements.enabled.checked = true; await elements.enabled.onchange()
assert.equal(elements.interval.value, '75'); assert.equal(elements.sound.checked, true)
radios[1].checked = true; await radios[1].onchange()
assert.equal(elements.interval.value, '75'); assert.equal(elements.sound.checked, true)
fail = true; elements.enabled.checked = false; await elements.enabled.onchange()
assert.equal(elements.enabled.checked, true); assert.match(elements.status.textContent, /Could not save/)
radios[0].checked = true; await radios[0].onchange()
assert.equal(radios[0].checked, false); assert.equal(radios[1].checked, true)
assert.equal(elements.save.disabled, false)
fail = false
let release; pending = new Promise(resolve => { release = resolve })
const saving = elements.save.onclick()
assert.equal(elements.enabled.disabled, true); assert.equal(radios[0].disabled, true)
release(); await saving; pending = null
assert.equal(server.intervalMinutes, 75); assert.equal(server.sound, true)
assert.equal(elements.save.disabled, false)
console.log('Companion draft preservation, rollback, retry and serialization passed')
