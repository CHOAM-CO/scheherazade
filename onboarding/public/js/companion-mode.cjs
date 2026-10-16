// Lossless persisted modes: Off=false/false, Voice=false/true,
// Companion=true/false, Companion + voice=true/true (companion/TTS).
// Disabling TTS revokes CALL consent; re-enabling voice never reopens the mic.
;(function (root) {
  const modes = ['off', 'voice', 'companion', 'companion-voice']
  function modeOf(config) { return config.COMPANION_ENABLED === 'true' ? (config.TTS_ENABLED === 'true' ? 'companion-voice' : 'companion') : (config.TTS_ENABLED === 'true' ? 'voice' : 'off') }
  function modeFields(mode) {
    if (!modes.includes(mode)) { const e = new Error('invalid companion mode'); e.code = 'BAD_COMMAND'; throw e }
    const tts = mode === 'voice' || mode === 'companion-voice'
    return { COMPANION_ENABLED: String(mode === 'companion' || mode === 'companion-voice'), TTS_ENABLED: String(tts), ...(!tts ? { CALL_ENABLED: 'false' } : {}) }
  }
  const api = { modes, modeOf, modeFields }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.SeraCompanionMode = api
})(typeof window !== 'undefined' ? window : globalThis)
