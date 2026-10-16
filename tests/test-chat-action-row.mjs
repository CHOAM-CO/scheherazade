import assert from 'node:assert/strict'
import fs from 'node:fs'
const read = f => fs.readFileSync(new URL('../onboarding/public/' + f, import.meta.url), 'utf8')
const tts = read('js/tts.js'), stt = read('js/stt.js'), chat = read('js/chat.js'), call = read('js/call.js')
assert.doesNotMatch(tts, /mountStop|tts-stop|appendChild\(stopBtn/)
assert.match(tts, /SeraSTT\?\.setReading/)
assert.match(stt, /reading \? stopVoiceIcon : micIcon/)
assert.match(stt, /if \(reading\) return window.SeraTTS\?\.stop\(\)/)
assert.match(stt, /btn.hidden = false/)
assert.match(stt, /secondary icon-button stt-mic/)
assert.match(chat, /sendBtn.hidden = st.inFlight/)
assert.match(call, /getElementById\('ct-quickbar'\)\?\.appendChild\(button\)/)
assert.match(call, /enabled \? 'End call' : 'Call mode'/)
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
