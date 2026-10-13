import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const ids = new Map()
class Element {
  set id(v) { ids.set(v, this) }
  append() {} appendChild() {} setAttribute() {}
}
ids.set('set-about', new Element()); ids.set('set-companion-voice', new Element())
let fail = false
let server = { enabled: false, voice: 'default', voices: [{ id: 'default', builtin: true }, { id: 'custom', name: 'Custom' }], download: { state: 'idle' }, modelsPresent: true }
const api = async (_url, opts) => {
  if (fail && opts) throw Error('offline')
  if (opts) server = { ...server, ...JSON.parse(opts.body) }
  return { ...server }
}
vm.runInNewContext(fs.readFileSync(new URL('../onboarding/public/js/tts.js', import.meta.url), 'utf8'), {
  window: { api }, document: { documentElement: { lang: 'ko' }, getElementById: id => ids.get(id), createElement: () => new Element() }, clearTimeout() {}, setTimeout() {},
})
await new Promise(resolve => setImmediate(resolve))
const box = ids.get('set-tts-enabled'), voice = ids.get('set-tts-voice'), status = ids.get('set-tts-state')
fail = true; box.checked = true; await box.onchange()
assert.equal(box.checked, false); assert.match(status.textContent, /오류: offline/); assert.equal(box.disabled, false)
voice.value = 'custom'; await voice.onchange()
assert.equal(voice.value, 'default'); assert.match(status.textContent, /오류: offline/); assert.equal(voice.disabled, false)
fail = false; box.checked = true; await box.onchange()
assert.equal(box.checked, true); assert.equal(status.textContent, '준비됨')
voice.value = 'custom'; await voice.onchange()
assert.equal(voice.value, 'custom'); assert.equal(voice.disabled, false)
console.log('TTS enable/voice failure, rollback, error visibility and retry passed')
