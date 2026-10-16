import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const read = f => fs.readFileSync(new URL('../onboarding/public/' + f, import.meta.url), 'utf8')
const tts = read('js/tts.js')
const mount = tts.match(/  function mountStop\(\) \{[\s\S]*?\n  \}/)[0]
let inserted, stopped = false
const anchor = {}, bar = { insertBefore: (button, before) => { assert.equal(before, anchor); inserted = button } }
vm.runInNewContext(`let stopBtn = null; const T = {stop:'Stop voice'}, ko = false, queue = {stop(){ markStopped() }}; ${mount}; mountStop(); mountStop()`, {
  markStopped: () => stopped = true,
  document: { querySelector: selector => { assert.equal(selector, '.chat-composer-bar'); return bar }, getElementById: () => anchor, createElement: () => ({}) },
})
assert.equal(inserted.textContent, 'Stop voice')
assert.equal(inserted.title, 'Stop speaking the reply aloud')
assert.equal(inserted.hidden, true)
assert.equal(inserted.style, undefined)
inserted.onclick(); assert.equal(stopped, true)
assert.match(read('chat.html'), /class="button-row chat-composer-bar"/)
assert.match(read('chat.html'), /class="button-row chat-quickbar"/)
assert.match(read('js/stt.js'), /secondary icon-button stt-mic/)
console.log('TTS shared action-row mounting, stop action, tooltip and shared icon classes passed')
