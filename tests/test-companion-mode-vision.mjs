import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const { modeOf, modeFields } = require('../onboarding/public/js/companion-mode.cjs')
const { laneVision } = require('../onboarding/public/js/model-vision.cjs')
for (const mode of ['off', 'voice', 'companion', 'companion-voice']) {
  const config = { CALL_ENABLED: 'true', STT_ENABLED: 'true', ...modeFields(mode) }
  assert.equal(modeOf(config), mode)
  assert.equal(config.CALL_ENABLED, ['voice', 'companion-voice'].includes(mode) ? 'true' : 'false'); assert.equal(config.STT_ENABLED, 'true')
}
assert.equal(modeOf({ TTS_ENABLED: 'true' }), 'voice', 'legacy TTS-only remains voice without opting in to companion')
assert.throws(() => modeFields('unknown'))
const browser = { window: {} }
vm.runInNewContext(fs.readFileSync(new URL('../onboarding/public/js/model-vision.cjs', import.meta.url), 'utf8'), browser)
for (const model of ['muse-spark-open', 'muse-spark-open:cloud', 'ollama-cloud/muse-spark-open', 'ollama/muse-spark-open:cloud', 'OLLAMA-CLOUD/MUSE-SPARK-OPEN', 'custom/MUSE-SPARK-OPEN']) {
  for (const spawn of [{ provider: 'ollama', model }, { provider: 'ollama', model: 'unknown', live: { model } }]) {
    assert.equal(laneVision(spawn), 'yes'); assert.equal(browser.window.SeraModelVision.laneVision(spawn), 'yes')
  }
}
assert.equal(laneVision({ provider: 'ollama', model: 'unknown' }), 'no')
assert.equal(laneVision(null), 'no')
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
assert.match(read('onboarding/public/js/chat.js'), /SeraModelVision.laneVision\(spawn\)/)
assert.match(read('onboarding/http-server.cjs'), /require\('\.\/public\/js\/model-vision.cjs'\)/)
assert.doesNotMatch(read('onboarding/public/js/chat.js'), /const VISION_YES/)
assert.match(read('onboarding/public/chat.html'), /data-companion-mode/)
assert.match(read('onboarding/public/js/companion-mode-control.js'), /Companion & voice/)
assert.doesNotMatch(read('onboarding/public/js/tts.js'), /box\.onchange|set-tts-enabled/)
assert.match(read('onboarding/public/js/memory.js'), /renderMarkdown\(value, formatted.value\)/)
assert.match(read('onboarding/public/js/memory.js'), /renderMarkdown\(prose, row.body\)/)
console.log('Unified persisted modes, browser/server vision parity, discoverable voice and memory renderer call sites passed')

const { isCallEnabled } = require('../onboarding/call-state.cjs')
let config = { COMPANION_ENABLED: 'true', TTS_ENABLED: 'true', CALL_ENABLED: 'true', STT_ENABLED: 'true' }
assert.equal(isCallEnabled(config), true)
for (const mode of ['off', 'companion-voice']) { config = { ...config, ...modeFields(mode) }; assert.equal(isCallEnabled(config), false, 'voice restoration must not restore microphone consent') }
assert.equal(config.CALL_ENABLED, 'false')

// Run the real chat read-aloud entry point with a 0.5.1 TTS-only preference.
const spoken = []
const speechWindow = {
  api: async route => route === '/api/tts/status' ? { enabled: true, modelsPresent: true } : { available: true, enabled: false, mode: 'voice' },
  addEventListener() {},
  SeraTTSCore: { cleanForSpeech: text => text, createSpeechQueue: () => ({ enqueue: text => spoken.push(text) }) },
}
vm.runInNewContext(read('onboarding/public/js/tts.js'), {
  window: speechWindow, document: { documentElement: { lang: 'en' }, getElementById: () => null, addEventListener() {} }, setInterval() {},
})
await new Promise(resolve => setImmediate(resolve))
speechWindow.SeraTTS.onReply('Upgrade keeps chat read-aloud')
assert.deepEqual(spoken, ['Upgrade keeps chat read-aloud'])
console.log('TTS-only upgrade keeps speaking; silent-mode round trip never restores call consent')
// Execute call.js's actual sync entry after each mode change, not a copy of
// its decision: restoring voice must never invoke SeraSTT.start().
const callSource = read('onboarding/public/js/call.js')
const syncSource = callSource.slice(callSource.indexOf('  async function sync() {'), callSource.indexOf("  button[settings ? 'onchange'"))
let starts = 0
config = { COMPANION_ENABLED: 'false', TTS_ENABLED: 'true', CALL_ENABLED: 'true', STT_ENABLED: 'true' }
async function runCallSync() {
  const context = {
    syncing: false, enabled: false, voiceMuted: false, micMuted: false,
    settings: false, companion: false, active: false, opening: false,
    button: { setAttribute() {} }, hint: {}, renderState() {}, off() {}, console,
    session: { start() {} }, utterance: { setBlocked() {} }, ttsRetry: { reset() {} },
    core: { micHealth: () => 'healthy' }, document: { getElementById: () => null },
    window: { api: async route => route === '/api/companion' ? { available: true, enabled: false } : { enabled: isCallEnabled(config), allowed: true }, SeraSTT: { start() { starts++ }, cancel() {} } },
  }
  await vm.runInNewContext(syncSource + '\nsync()', context)
}
await runCallSync()
assert.ok(starts > 0, 'positive control: enabled call starts STT')
starts = 0
for (const mode of ['off', 'companion-voice']) {
  config = { ...config, ...modeFields(mode) }
  await runCallSync()
}
assert.equal(starts, 0, 'Off -> Companion + voice must not reopen the microphone')
