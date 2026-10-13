# design-0027 — Sound-only companion (voice orb) + companion merge

Status: SPEC, 2026-10-13. Owner: Idea (spec + review). Builder: one astra worker.
Decided by Mino 2026-10-13 12:50-12:54 (idea home). Builds on design-0026.
Mock (feel reference, not shipped code): `scratchpad/voice-orb/index.html` (canvas orb, 
analyser-driven ring, hover control row).

## What it is

Companion mode (0026) merges from branch `companion-mode` into main behind a
Settings toggle, default OFF. When ON the user picks a display variant:

- **face**: the 0026 behaviour unchanged (round avatar top-right, bubble, approval/reply).
- **sound only**: no face. A circular ring/orb in the companion window that
  moves with Sera's voice. Reference feel: Siri / ChatGPT voice screen. Elegant,
  not a music visualizer.

Dictation (STT) is an upcoming add-on that shares the orb's "listening" state.

## Goals / non-goals

Goals:
- Ship companion mode to main, off by default, no regression of the main window.
- Orb reacts to the real TTS audio in real time without decoding it twice.
- Same window, same bubble, same approval/reply path as 0026; only the presenter changes.
- Push-to-talk dictation that lands text in the chat composer.

Non-goals:
- No avatar/face in sound-only. No music-player features (seek, playlists, EQ bars).
- No wake word, no always-on mic, no auto-send of dictated text by default.
- No new TTS engine, no cloud STT.
- No change to the proactive-bubble rules of 0026.

## States

| State | Trigger | Visual |
|---|---|---|
| off | Power off, or companion disabled for the session | Dim static outline (~25% alpha), no animation |
| idle | On, nothing playing, mic closed | Slow breathing glow (~1.1 rad/s), ring radius +-2.5% |
| speaking | TTS `<audio>` playing | Ring deforms from time-domain samples; amplitude -> radius, stroke width, glow; low band (bins ~1-20) -> inner ring radius/alpha; high band (bins ~60-200) -> hue shift (base ~235, up to +70) |
| listening | STT push-to-talk held / mic toggled | 8 dots orbiting inside the ring, hue 170-215; ring stays calm |
| thinking (optional) | Turn in flight, no audio yet | Idle breathing at 2x speed; skip if it looks noisy |

All values are lerped (0.1-0.3 per frame) so state changes cross-fade, never snap.
Canvas runs at 60 fps via `requestAnimationFrame`, DPR capped at 2. Under
`prefers-reduced-motion` the loop is replaced by a static pulse (CSS opacity
only, no deformation, no orbiting dots; listening = steady brighter ring).
When the window is hidden or the state is off, the rAF loop stops.

## Size

~220 px orb on desktop (`min(220px, 86vw)`), scales down on small screens.
Window size is an open question (below); the orb must fit with its glow
(glow radius ~1.9x ring radius) and the control row.

## Interaction and timings

- Hover over the orb area: control row appears within 150 ms.
  Leave: row fades out after 400 ms. Keyboard focus inside the row keeps it visible.
- Controls: power, stop, mic, face/sound-only switch. 40 px round buttons,
  icon-only, with tooltips.
- Touch (`hover: none`): row always shown at ~80% opacity.
- Space = play/pause when the companion window is focused (preventDefault;
  ignored while typing in the bubble reply input). Click on the orb = same.
- Stop = pause and rewind the queue head and clear the TTS queue.
- Power off pauses audio, dims the orb, and ignores Space/click until powered on.
- Click-through follows 0026: only the orb, control row and bubble capture
  the mouse; the transparent remainder passes clicks.
- Bubble text (0026) may show below the orb. Setting "Show bubble text", default on.

## Data flow

```
 Sera turn --> chat.js --> tts.js --> tts-core.cjs queue
                                         | exposes getPlayback() -> { audioEl, audioCtx }
                                         v
                              <audio> --> MediaElementSource --> AnalyserNode --> destination
                                                                        |
                       companion.js (orb presenter) <-------------------+
                          | getByteTimeDomainData / getByteFrequencyData -> canvas 60 fps
                          v
                       bubble (below orb) <-- partials / reply text

 STT (upcoming)
 mic button (hold) -> renderer getUserMedia -> AudioWorklet -> 16 kHz Float32 chunks
   -> IPC (companion:stt-audio) -> main.cjs -> child process: sherpa-onnx-node
        (Korean streaming zipformer, 72m, int8)
   <- partial/final text IPC <- child
 partials -> bubble/composer preview; release -> final text -> chat composer (no auto-send)
```

Notes:
- `createMediaElementSource` may be called once per element. `tts-core.cjs` owns
  the single AudioContext and source node and exposes them (plus a
  `playback` event: start/pause/end); the orb only adds an AnalyserNode.
  If the TTS path switches to an AudioBuffer source later, the same getter
  returns a node to tap. No second decode.
- The companion window is a separate renderer from the chat window. The TTS
  queue lives in the chat renderer today. Open question 4 covers who plays audio.
- STT runs out of process so a model crash or load stall cannot block the UI.

## Settings

Persisted in agent config next to the existing TTS settings (not in
`companion.json`, which keeps window positions only):

- Companion: `off | face | sound only` (default off).
- Show bubble text under the orb (default on).
- Read aloud: toggle + voice (existing TTS settings, moved into this group view).
- Dictation: toggle + model download state (not installed / downloading n% /
  ready / error), download button, model size shown. Dictation stays disabled
  until the model is ready.
- The face/sound-only switch on the hover row writes the same setting.

## File map

From branch `companion-mode` (merge as is, rebase first; the branch diff vs main
also shows unrelated deletions because it is behind main, take only companion files):
- `companion/controller.cjs`, `companion/model.cjs`, `companion/fullscreen.cjs`
- `onboarding/routes/companion.cjs`, `onboarding/public/companion.html`,
  `onboarding/public/css/companion.css`, `onboarding/public/js/companion.js`,
  `onboarding/public/js/companion-settings.js`
- `tests/test-companion-{controller,model,routes}.mjs`, `docs/design-0026-companion-mode.md`
- small edits: `main.cjs`, `onboarding/http-server.cjs`, `onboarding/public/settings.html`,
  `onboarding/public/js/chat.js`

New / changed on main by this spec:
- `onboarding/public/js/tts-core.cjs`: expose `getPlayback()` + playback events.
- `onboarding/public/js/tts.js`: wire events; stop/clear API for the control row.
- `onboarding/public/js/companion-orb.js` (new): canvas presenter and state machine;
  pure helpers (band energy, lerp, reduced-motion) in a testable module.
- `onboarding/public/css/companion.css`: orb, control row, reduced-motion rules.
- `onboarding/public/js/companion.js`: choose presenter by variant (face | orb).
- `onboarding/public/settings.html`, `companion-settings.js`, `js/settings.js`: Companion select, dictation group.
- `companion/model.cjs`: `variant` field and defaults.
- STT (later, separate PR): `stt/worklet.js`, `stt/child.cjs`, `stt/model-download.cjs`,
  IPC in `main.cjs`, `package.json` dep `sherpa-onnx-node`, asset packaging for the native module.
- Tests: `tests/test-companion-orb.mjs` (band math, lerp, state transitions, reduced-motion),
  tts-core playback getter test, settings persistence test.
- Release notes entry; bump version when Mino decides.

## Open questions

1. Window size: fixed ~320x360 (orb + row + bubble) vs resize per state. Bigger
   window means a larger click-through-sensitive region; the glow also needs room.
2. Multi-monitor: per-display position memory exists in 0026; should the orb
   follow the active display, and what happens on DPI change when dragged across?
3. Fullscreen games: 0026 hides the companion; should sound only keep playing
   audio with no visual, or pause? (Default proposal: keep audio, hide orb, tray cue.)
4. Which renderer owns TTS playback when only the companion is visible (main
   window closed or minimized)? Moving the queue to a hidden shared renderer vs
   playing in the companion window.
5. Windows transparency: frameless transparent windows with canvas glow and
   native hit regions (see the 0026 Windows fix) on 200% DPI; performance of
   `shadowBlur` there. May need a pre-rendered glow sprite.
6. sherpa-onnx-node packaging: native module size, per-OS binaries, model
   download host and checksum, mic permission prompts on macOS and Windows.
7. Does STT need echo handling while Sera is speaking (mute TTS on PTT press)?

## Acceptance checks

- Setting off (default): no companion window created, no AnalyserNode, no rAF; main window unchanged.
- Setting face: behaviour identical to 0026 tests.
- Setting sound only: no avatar request; orb visible at ~220 px; idle breathes.
- Playing a TTS clip: ring deforms in sync (visually within ~100 ms); inner ring
  tracks low band; hue shifts on sibilants; pausing returns to idle within ~1 s.
- Audio is decoded once: TTS output still audible, no doubled sound, CPU for orb under ~5% of one core.
- Hover row appears within 150 ms, hides 400 ms after leave; touch shows it at reduced opacity.
- Space toggles play/pause only when companion is focused and not typing.
- `prefers-reduced-motion`: no deformation or orbiting; static pulse only.
- Switching face <-> sound only from the row takes effect without restart and persists.
- Off state: dim static outline, controls except power inert.
- Power/stop/mic work; stop clears the TTS queue.
- Dictation (when shipped): hold mic -> partials appear; release -> text in composer, not sent;
  model missing -> toggle disabled with download prompt; no mic access outside held state.
- `npm test` green with the new tests; Windows rehearsal on magi-win (per 0026 deliverable 4)
  with screenshots of idle, speaking, hover row.
