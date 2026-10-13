# 0.5.0-beta.4 — Call mode (private rehearsal)

- Optional Call mode in Settings and the companion hover row, default off.
- Requires Read aloud and Voice input. Endpointed speech sends automatically.
- Streaming replies are read sentence by sentence; off closes the microphone
  and clears speech immediately across open windows.

Known: recognition pauses during audible playback for echo safety, so interruption
works only between sentences. Non-streaming lanes speak only on completion.
Windows microphone/audio and orb interaction remain untested on real hardware.
