import assert from 'node:assert/strict'
import fs from 'node:fs'
const read = f => fs.readFileSync(new URL('../onboarding/public/' + f, import.meta.url), 'utf8')
const tts = read('js/tts.js'), stt = read('js/stt.js'), chat = read('js/chat.js'), call = read('js/call.js')
assert.doesNotMatch(tts, /mountStop|tts-stop|appendChild\(stopBtn/)
assert.match(tts, /SeraSTT\?\.setReading/)
assert.match(stt, /stoppingVoice \? stopVoiceIcon : micIcon/)
assert.match(stt, /if \(reading\) return window.SeraTTS\?\.stop\(\)/)
assert.match(stt, /btn.hidden = !micEnabled && !reading/)
assert.match(stt, /secondary icon-button stt-mic/)
assert.match(chat, /sendBtn.hidden = st.inFlight/)
assert.match(call, /getElementById\('ct-quickbar'\)\?\.appendChild\(button\)/)
assert.match(call, /enabled \? V.endCall : V.callMode/)
assert.match(read('chat.html'), /class="button-row chat-composer-bar"/)
console.log('Single Send/Stop and microphone/Stop voice slots; Call quickbar placement passed')

const { runInNewContext } = await import('node:vm')
const swap = chat.slice(chat.indexOf('      const focusedSlot ='), chat.indexOf('      // The gone state'))
for (const inFlight of [false, true]) {
  const sendBtn = {}, stopBtn = {}, outside = {}
  for (const focused of [inFlight ? sendBtn : stopBtn, outside]) {
    let focuses = 0
    runInNewContext(swap, { st: { inFlight }, sendBtn, stopBtn, document: { activeElement: focused }, input: { focus() { focuses++ } } })
    assert.equal(focuses, focused === outside ? 0 : 1, 'focus leaves a disappearing slot but never steals unrelated focus')
    assert.equal(sendBtn.hidden, inFlight)
    assert.equal(stopBtn.hidden, !inFlight)
  }
}
console.log('Composer action swap preserves keyboard focus passed')

const paint = stt.slice(stt.indexOf('  function paintMic()'), stt.indexOf('  let cap =')) + '\npaintMic()'
for (const [micEnabled, reading, mode, hidden, title] of [
  [false, false, 'idle', true, 'Voice input'],
  [true, false, 'idle', false, 'Voice input'],
  [false, true, 'idle', false, 'Stop voice'],
  [true, false, 'listening', false, 'Listening'],
  [true, false, 'processing', false, 'Processing'],
  [true, true, 'listening', false, 'Listening'],
]) {
  const btn = { setAttribute() {} }
  runInNewContext(paint, { V: { stopVoice: 'Stop voice' }, btn, reading, mode, micEnabled, micAvailable: micEnabled, micIcon: 'mic', stopVoiceIcon: 'stop', T: { mic: 'Voice input', listening: 'Listening', processing: 'Processing' }, window: {} })
  assert.equal(btn.hidden, hidden); assert.equal(btn.title, title)
  assert.equal(btn.innerHTML, reading && mode !== 'listening' ? 'stop' : 'mic')
}
const click = stt.match(/    btn.onclick = (.*)/)[1]
let captureStops = 0, voiceStops = 0
const btn = {}
runInNewContext('btn.onclick = ' + click + '; btn.onclick()', { btn, mode: 'listening', reading: true, stop() { captureStops++ }, window: { SeraTTS: { stop() { voiceStops++ } } } })
assert.equal(captureStops, 1); assert.equal(voiceStops, 0)
console.log('Microphone visibility, mode labels, and listening priority passed')
