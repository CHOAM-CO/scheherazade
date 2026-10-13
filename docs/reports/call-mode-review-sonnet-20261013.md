# Call mode review (28fc9a3, c7e83e6) - Sonnet, read-only, 2026-10-13

`npm test`: 132 passed, 0 failed, 4 skipped of 136 in 88.4s (skips are live/tmux/calendar/tts-model/packaging, not passes).
Static review only; nothing exercised in a real renderer. Items marked "unverified" depend on channel server behaviour not in these commits.

## Blockers

### B1. Barge-in is undone one poll later: draft keeps enqueuing the rest of the reply
call.js:72-75 (partial -> queue.stop()), call.js:79-91 (poll/speak).
`partial()` calls `queue.stop()` (clears pending), but `spoken` / `draft` are untouched and the 250 ms poll keeps calling `speak(r.draft)`, which enqueues the next complete sentence of the same reply. Scenario: reply streaming, user speaks between sentences, queue cleared, 250 ms later sentence N+1 is enqueued and read, and the recognizer (muted while speaking) never gets to finish the utterance. The design says "first partial stops queued audio", but it only does so for one tick.
Fix: on interruption mark the current reply as muted (set `spoken = text.length`/a `muteUntilNextMessage` flag, reset when a new non-draft message item arrives), and flush nothing for it.

### B2. Mic can die permanently and nothing reopens it (active=true, STT idle)
call.js:56-62 (sync only starts STT when `!active`), stt.js:150-156 (start failure -> `setMode('idle')`, toast only), stt.js:160-172 (manual mic click / `stop()`), routes/stt.cjs:110-111 (404 for unknown sid).
Scenarios: (a) mic permission denied or `/api/stt/start` fails once: `active` stays true, `SeraSTT.start()` is never retried, UI claims call is on. (b) user presses the mic button during a call: `stop()` ends the session, finals go to the input box, call stays "active" with no mic. (c) audio POST gets 404 (session swept/engine restart): only `console.warn`, loop continues forever with a dead sid.
Fix: in `sync()`, when `active && SeraSTT.mode === 'idle'` call `SeraSTT.start()` again (with backoff and toast on repeated failure); on 404 in `pump` drop sid and restart; hide/disable the manual mic during a call.

### B3. Playback end can be missed -> mic muted forever (deadlock)
call.js:15-22, stt.js onFrame guard.
`play` resolves only on `ended`/`error`/`play().catch`. A stalled/paused-externally audio element (media key, OS audio-route change, decode stall without error) fires none of them: `speaking` stays true, every mic frame is dropped, the queue's `running` never clears, call is dead until toggle-off. No watchdog exists.
Fix: add `onpause`/`onstalled` handling plus a watchdog (`duration*1.5 + 5 s` timeout -> `finish`), and clear `speaking` in `queue.stop()` unconditionally (currently only if `audio` is non-null).

## Should-fix

### S1. Sentence splitter breaks decimals, filenames, URLs and code (unfixed, documented only as "simplistic")
call-core.cjs:3. `/[。.!?…\n]+/` splits on every `.`: "버전 3.5" streamed as "버전 3." then "5입니다" (separate TTS calls: audible fragment, and the digit-only fragment "5" is dropped by cleanForSpeech as unpronounceable), "example.com", "app.js", "e.g.". Streaming makes it worse: draft "3." at a chunk boundary is already consumed before "5" arrives.
Fix: require `.` to be followed by whitespace/end (and not preceded by a digit-then-digit), and hold back a trailing `.` at end-of-draft until one more char arrives when not flushing.

### S2. Fenced code is read aloud when split across sentences
call.js:12 (cleanForSpeech applied per sentence) + call-core split. A ``` block is cut at its first `.`/newline; each fragment lacks both fences so the ```[\s\S]*?(```|$) strip only removes the opening fragment, later lines of code are spoken. Newline is a split point so multi-line code always breaks.
Fix: make the splitter fence-aware (treat text from ``` to closing ``` as a single skipped segment; if unclosed, hold it back until flush).

### S3. Mic is live in the gaps between sentences (echo -> self-interruption)
call.js:15-22: `speaking` is set only while an Audio element plays. During synth of sentence N+1 (hundreds of ms), `speaking=false`; speaker tail/room echo enters the recognizer, produces a partial -> `stopSpeech` kills the remainder (B1 aside) and may endpoint into an auto-sent "final" of the assistant's own voice.
Fix: derive `speaking` from `queue.running` (or `queue.size>0`) plus a ~300 ms tail after the last end.

### S4. Re-speak risk when final message text differs from the cumulative draft
call.js:73. If the stored final text differs from the streamed draft (markdown trimming, whitespace) `startsWith(draft.slice(0,spoken))` fails -> `spoken=0` -> the whole message is spoken again after sentences already played. Unverified against the channel's draft vs final text; guard anyway: when a final item arrives, speak only the suffix after the longest common prefix, never reset to 0 mid-reply.

### S5. Call start drops whatever is streaming; first poll primes cursor only
call.js:82-84. Anything arriving between enabling and the first poll is skipped, and a draft in flight at that time is later spoken from offset 0 including already-visible text. Acceptable for "from now on" semantics but should be stated, or `draft` captured at prime time as already-spoken.

### S6. Empty/pure-symbol sentences still hit /api/tts
call.js:11. `cleanForSpeech` may return '' (e.g. "..." , "5.") and the code POSTs it anyway -> 400 -> `TTS 400` swallowed as queue error. Skip when clean is empty.

### S7. Pause path leaves the Audio element detached from the AnalyserNode / orb
call.js:15 uses `new Audio` with no AnalyserNode connection. In companion mode the orb gets `state()==='speaking'` via `SeraCall.speaking` but `getAnalyser` returns the companion's analyser which is idle, so no lipsync/level; also `b-stop` with call speech only works through `stopSpeech`. Nothing is stuck (stopPlayback pauses and resolves), but visual state is wrong. Fix: route call audio through the companion's analyser or document.

### S8. No dedupe / ordering guard for finals
stt.js pump (the `.then` that loops `SeraCall.final`) and call-core.cjs:20. `final()` checks only on/generation/non-empty. The server drains finals once, so normal duplicates are unlikely, but nothing prevents a manual Enter in the composer racing an endpoint (typed message and spoken final both go out; call-core has no "turn in flight" gate, so a final that arrives while the agent is still replying is sent mid-reply). Fix: drop identical consecutive finals within ~2 s and optionally hold finals while a typed send is in flight.

## Nits

- N1. Mic close on toggle-off relies on a 1 s `setInterval(sync)` (call.js:92) plus BroadcastChannel; hidden/throttled windows may lag several seconds. The chat window's 15 s `syncEnabled` in stt.js is NOT in the path (it only toggles the button), so the 15 s recheck cannot leave the mic open; but Settings-off is up to 1 s in a foreground window and unbounded if the chat window is occluded/throttled. `off()` itself is correct: epoch++ stops capture, posts cancel, `queue.stop()`.
- N2. App quit: `pagehide -> off()` fires the cancel POST asynchronously; it may be dropped. Tracks die with the renderer; the server session lingers until the next `/api/stt/start` sweep (routes/stt.cjs:95, only swept on start). Add a sweep timer or `sendBeacon`.
- N3. Companion power-off calls `SeraCall.stop()` (companion.js) but `CALL_ENABLED` stays true; chat window then takes ownership on its next sync (by design? clarify).
- N4. Settings: unchecking TTS/STT posts CALL off, but `change` listener runs `setTimeout(sync,300)` for every change event on the page.
- N5. Hand-edited HTML: script tags appended with mismatched indentation and the `</body>` moved (chat/companion/settings.html).
- N6. Key/IPC consistency checked: `CALL_ENABLED`, `/api/call` (GET/POST), `sera-call-settings` channel, `SeraCall`, `SeraCompanionSpeechStop` are used consistently across call.js, companion.js, tts.js, stt.js, routes/stt.cjs. No Electron IPC names added. `/api/call` GET reports enabled=false when prerequisites are off but leaves the stored CALL_ENABLED true (self-heals only via POST).

## Tests (finding 7)

tests/test-call-core.mjs covers the pure `split` and `createSession` only (13 lines). It does not touch call.js, stt.js epoch/cancel, the queue/audio element, suppression, poll/draft logic, or the route (`/api/call` validation). No test with decimals, code fences, Korean 다/요 without punctuation, interrupted queue, or missed `ended`. The one `split` test with `\n` and `…` passes; "3.5" would fail. The "session" test uses spy closures, so it proves call bookkeeping, not that a mic closes. Add DOM-less tests for the speak()/poll logic (extract it into call-core) and a route test for `/api/call` 400/409.

## package-lock.json (finding 8)

c7e83e6 touches exactly two lines (root and package version 0.5.0-beta.3 -> beta.4). Nothing else.

## Verdict

FIX FIRST: B1 (barge-in re-enqueues rest of reply), B2 (mic dead with call still "on", no retry), B3 (missed playback-end deadlocks mic).
