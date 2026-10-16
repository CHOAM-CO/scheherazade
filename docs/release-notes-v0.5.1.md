# Scheherazade 0.5.1

A cleanup release: Stop really stops, runaway tool loops are capped, the boot shows what it is doing, and the chat and settings screens line up and speak one language.

## What changed
- Stop now stops everything at once. The model request is cut, any command Sera was running is killed, and queued messages are dropped; the button stays pressed until that is confirmed. Esc in the chat window does the same.
- A turn can no longer call tools forever. After 60 tool calls (12 during the boot greeting) Sera stops the turn and says so in the chat. Models that never decide to finish on their own, like muse-spark-open, are contained by this.
- The "[system] agent session started" line is no longer posted to Slack, Discord or Telegram when Sera starts; the app window already shows her state.
- While starting, the chat shows which phase is running (memory, channels, engine) instead of a blank wait. A slow cold start no longer fails at 45 seconds; the limit is 90. A model switch made during startup is applied once the engine is ready instead of being lost.
- Model list: muse-spark-open (Meta, Ollama cloud) is available and recognised as an image-capable model.
- Chat screen: the tab pill, the quick-action icons and the composer share one left edge and one spacing. The composer shows only attach, microphone and Send; while Sera is answering, Send becomes Stop; while she is reading aloud, the microphone becomes Stop voice. Call mode moved to a phone icon at the end of the quick-action row and turns into a red End call during a call.
- Starting a call opens the sound orb right away, even if companion mode is off, and puts things back the way they were when the call ends.
- During a call Sera is told that you are speaking, that the text she gets is a transcription that may contain recognition errors, and that her reply will be read aloud, so she answers in short spoken sentences without markdown, symbols or links.
- Settings: every page is in English with one layout for cards, field rows and buttons; the co-browse card says in words whether Chrome is connected, with paths behind "Show details"; Companion, Voice and Call have their own entries in the settings rail; the companion page explains what it is, how to switch to sound-only and how to talk to it.
- Companion and profiles pages are in English like the rest of the app (Korean copy is kept for a future language option).
- Accessibility and polish from the 2026-10-13 audit: onboarding Back and focus, labelled inputs, readable faint text (contrast 5.66:1), plain error messages instead of raw strings, disabled models show a reason, effort picker keeps a value that is not in the list, orb works from the keyboard and respects reduced motion.

## What you need to do
- Nothing. Settings and memory carry over.
- If you relied on the "agent session started" line in a channel to know Sera is up, check the app window instead.

## Known issues
- Stop kills the running command immediately; a half-finished file edit or shell command stays half-finished.
- The quick-action icons still have no first-use explanation; hover shows the name.
- Native tray has no End call / Stop voice yet.
- There is no language selector yet; the UI is English.

## Unchanged
- Models, voices, speech-to-text downloads and profiles from 0.5.0 are unchanged.
- The boot greeting still arrives in the chat; only the separate system line is gone.

## For developers
- Stop/budget: dsh-lane.mjs /interrupt awaited with owned tool-tree kill, FIFO + engine inbox + wake drain, cancellation generation; gateway patch patches/@deepseek-ai+dsh-host-apiproxy (patch-package postinstall). Tool budget 60/12 configurable. tests/test-dsh-stop-budget.mjs.
- Boot: elapsed logs at each boot boundary, phases in the status endpoint, engine announce timeout 90 s, model-select retry (tests/test-boot-progress.mjs), per-boot journal-author migration scan removed (memory/service.mjs).
- Channels: boot announce removed (channel-runtime.mjs), 244 channel tests incl. no-system-line assertion.
- UI: commits 0d73e5f 519dcaa 971b8b3 788abe7 6ee4272 66c3d5e 6388d3e d69196f; new tests test-companion-language, test-chat-action-row, test-appearance-load-guard, test-ui-settings-polish.
- Catalog: f60b4f3 muse-spark-open row + VISION_YES_MODELS; 2da93f2 profiles.html lang en.
- Review fixes: f436666 Stop recovery + async win32 enumeration/root-only kill + 25 s proxy timeout; bf86681 lazy MCP protection, prompt-bound boot budget, reply-tool exclusion, 80% warning; dd848b0 serialized model select; 6099210 predist guard tools/assert-dsh-cancel-patch.mjs; 1e219d6 author backfill; 2a02319 Esc IME/popover guard + COPY; 3ec624e; 51789bb.
- Composer/call: aae7a53 shared composer slots + temporary call orb (companion/controller.cjs); 2314a0f call start/off notices via /system-turn (onboarding/call-context.cjs) + origin voice; 8f0e4e8 lane carries origin voice as a model-only "[voice transcription]" prefix.
- Second pass: f46f5c6 budget warning non-promoting + localized; 43257d0 MCP transport descendants protected, exact argv match; d592365 win32 process listing maxBuffer 32 MB; 0ab02f4 call notes deferred into the next user turn meta (no agent turn opened); 8caabaa headless lane voice marker; 49e612c call error to chat toast; d595454 focus to input on slot swap; 4d58924 Escape priority (running turn, then call); 00ec747 mic button rules; f031f7e orb restored at start while a call is on; 2c439eb persisted companion prefs separate from the call override; f552dd0 call labels in COPY, one source onboarding/public/js/call-copy.cjs.
- Third pass: e8b505d Stop protects everything that already existed at turn start (pid + start time snapshot), only processes spawned during the turn are tools; 842ed5f command-line fallback decodes cross-spawn escaped Windows wrappers and spaced POSIX paths, lazy MCP transports protected; 481ecff deferred call note claimed before delivery (no double delivery on overlapping sends); 8366532 one effective-call predicate (call + STT + TTS) for startup restore and /api/call, stale call flag cleared at boot.
- eb72c48 turn-start enumeration async, protected = matched transports or processes older than the turn timestamp minus 1.5 s.
- 1263a8e descendants protected only under matched transports, one 20 s Stop deadline.
- Suite at 1263a8e: 159 passed, 0 failed, 5 skipped.
