'use strict'
// Rule 1 permits empty output; rule 2 requires decoded speech. Rule 3 is an
// utterance LENGTH limit, not a trailing-silence setting in sherpa's JS API.
// Separate recognizers keep a simultaneous dictation session unchanged.
function endpointConfig(callMode = false) {
  return {
    rule1MinTrailingSilence: callMode === true ? 3.6 : 2.4,
    rule2MinTrailingSilence: callMode === true ? 0.8 : 1.2,
    rule3MinUtteranceLength: callMode === true ? 12 : 20,
  }
}
module.exports = { endpointConfig }
