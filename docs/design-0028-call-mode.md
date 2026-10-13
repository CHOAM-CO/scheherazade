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

Playback, queued synthesis and a 300 ms speaker tail suppress microphone frames
(echo safety), rather than claiming acoustic barge-in. A non-empty partial while
listening abandons the current streamed reply, including its eventual final.
Full-duplex interruption during speech or queued synthesis is not supported. Existing non-call
voice dictation remains manual. Non-streaming lanes cannot speak before completion.
Sentence punctuation includes Korean endings with punctuation, Japanese 。 and
ellipsis/newline. Periods inside decimals, filenames and URLs do not split; a
trailing draft period waits for lookahead. Fenced code is skipped across chunks.
Common abbreviations are guarded, but unusual abbreviations may still split.
The first poll primes both transcript cursor and draft: existing text is not read.
Final formatting corrections use the normalized consumed prefix, never restart
from zero. Identical consecutive STT finals within two seconds are dropped.

Mic-open failure, capture loss or dead-session audio POST turns Call mode off
and shows an inline failure and toast; the user can re-enable after checking
permissions. Manual mic buttons are disabled during a call; Escape turns it off.
Audio pause/stall terminates the clip. A 250 ms watchdog uses duration × 1.5 +
5 seconds (hard cap 120 seconds); synthesis has a 60-second timeout and stalled
queues have a 120-second suppression escape. Call audio feeds the companion
analyser. These conservative bounds may truncate very long or stalled clips.

No model or download changes; no new dependencies. Windows microphone permissions,
audio/orb interaction and speaker loopback require physical-device rehearsal.
