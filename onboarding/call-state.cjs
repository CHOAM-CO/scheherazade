'use strict'

// Persisted intent is effective only while both voice prerequisites remain enabled.
const isCallAllowed = config => config.STT_ENABLED === 'true' && config.TTS_ENABLED === 'true'
const isCallEnabled = config => config.CALL_ENABLED === 'true' && isCallAllowed(config)

module.exports = { isCallAllowed, isCallEnabled }
