# 0.5.0-beta.2 — Voice (private rehearsal)

Builds on 0.5.0-beta.1 (desktop companion). Everything below is off by default.

- **Read aloud** (Settings): Sera reads replies in Korean on-device with Pocket-TTS
  Korean 100M (int8 ONNX, ~226 MB fetched on first enable). Add a voice from a
  short wav; product names the model misreads in Latin are spoken in Hangul.
- **Voice input** (Settings): mic button next to the chat input. Korean streaming
  recognition on-device (sherpa-onnx zipformer 72M int8, ~58 MB fetched on first
  enable). Partials show as ghost text; the final lands in the input, never auto-sent.
- **Companion** (Settings): now default off, with two looks: face (beta.1) and
  sound only, a ring that moves with Sera's voice; hover shows off / stop / mic.
  When the companion is on it owns playback, so a reply is spoken once.

Known: the chat window rechecks the companion toggle every 15 s, so a reply right
after flipping it can play twice or not at all. Windows mic and orb hit area untested.
