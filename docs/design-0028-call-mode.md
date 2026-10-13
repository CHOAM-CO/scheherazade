# design-0028 — Call mode

Default off (`CALL_ENABLED`), gated by Read aloud and Voice input. States:
off → opening microphone → listening → endpoint auto-send → thinking → speaking
→ listening. Companion owns capture/playback when enabled; otherwise chat owns
both. Settings changes broadcast off immediately; one-second reconciliation
also handles prerequisite or ownership changes. Off cancels the STT session,
closes tracks and clears the TTS queue, with generation guards for late results.

Endpointing uses the existing sherpa OnlineRecognizer enableEndpoint/isEndpoint
and stream reset. Its non-empty finals become chat turns; whitespace is dropped.
Current rule2 trailing silence is 1.2 seconds (not a renderer silence heuristic).
Audio chunks ~100 ms; chat draft poll 250 ms; first complete sentence queues
immediately. Actual synthesis/model startup latency depends on hardware.

Playback suppresses microphone frames (echo safety), rather than claiming acoustic
barge-in. First non-empty partial stops queued audio between sentences. Continuous
full-duplex interruption during a sentence is not supported. Existing non-call
voice dictation remains manual. Non-streaming lanes cannot speak before completion.
Sentence punctuation includes Korean endings with punctuation, Japanese 。 and
ellipsis/newline. Decimal/abbreviation boundaries are currently simplistic.

No model or download changes; no new dependencies. Windows microphone permissions,
audio/orb interaction and speaker loopback require physical-device rehearsal.
