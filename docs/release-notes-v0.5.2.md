# Scheherazade 0.5.2

A small follow-up to 0.5.1: voice and companion are one control you can find, the chat header lines up, the model chip tells the truth about image support, and memory pages render their formatting.

## What changed
- Voice and companion are one control. In the chat header, in Settings (Companion, Voice, Call) and in the tray menu you pick one of four: Off, Voice, Companion, Companion + voice. Voice means read-aloud and calls without the face or orb. Picking a mode without voice also ends any call and will not reopen the microphone when you switch back; you start a call yourself.
- If you had voice on and the companion off in 0.5.1, you now see Voice and nothing changes for you.
- Setting up the voice model is an explicit "Set up voice" action next to the control, with download progress and errors shown there; it no longer starts quietly when a setting is saved.
- Chat header: the tab pill, the quick-action icons, the model chip and New conversation share one left edge, one spacing and one height, on Windows too.
- The model chip now says "image vision" for models that have it. muse-spark-open was shown as "no image vision" because the chat window kept its own outdated list; chat and server now read one list.
- Memory: journals and documents render their markdown (bold, lists, links open in your browser). Table values and the timeline stay as written.
- Start-up log lines now carry which process wrote them and how long that process had been running, so a slow first start can be read from the log.

## What you need to do
- Nothing. Settings and memory carry over. Your previous voice/companion choice is shown as one of the four modes.

## Known issues
- A true cold start on Windows (first launch after a reboot) still takes about 30 seconds; later starts take about 5. The time goes to Windows reading and scanning the app's files for the first time, not to the app itself. Restructuring the install to fewer files would shorten it; that work is not in this release.
- The quick-action icons still have no first-use explanation; hover shows the name.
- Native tray has no End call / Stop voice yet.
- There is no language selector yet; the UI is English.

## Unchanged
- Models, voices, speech-to-text downloads and profiles from 0.5.1 are unchanged.
- Stop, the tool budget and the boot phases from 0.5.1 are unchanged.

## For developers
- f757174 boot: engine-bootstrap.cjs preload (optional V8 compile cache under the DSH home, scoped to engine + MCP children, never to tool processes; spawn instrumentation restored after the configured MCP count or a 30 s timeout; SCHZ_BOOT_TRACE=1 loader accounting), boot-progress.cjs lines now end with `pid=… process_ms=…` after the unchanged `elapsed_ms=`, tools/measure-engine-imports.mjs, tests/test-engine-bootstrap.mjs. Mac measurement: process start to memory mark 288 ms; the Windows 18 s cold gap is OS page cache + Defender first scan of ~27k unpacked files (Defender total during a warm restart 2.5 s, so exclusions are not the lever).
- 8ee7706 ui: onboarding/public/js/companion-mode.cjs (mode derived from COMPANION_ENABLED + TTS_ENABLED; silent modes write CALL_ENABLED=false), companion-mode-control.js (shared selector, refresh on change/focus/BroadcastChannel, 5 s background poll), companion/controller.cjs (single call-off broadcast on active to inactive, tray refresh), routes/companion.cjs rejects mode+enabled together, routes/tts.cjs legacy enabled:false follows the same rule; app.css header tokens + scrollbar-gutter stable; model-vision.cjs shared by chat.js and http-server.cjs; memory.js uses markdown.js for journal/document bodies only; companion-quick-toggle.js removed. Tests: test-companion-mode-vision.mjs (TTS-only upgrade keeps speaking; positive STT control then zero restarts across a silent round trip), test-companion-settings.mjs, geometry tests updated.
- Review: two Opus passes on the working tree; all P1/P2 findings fixed, P3 fixed except visual Windows check.
- Suite at 8ee7706: 161 passed, 0 failed, 5 skipped.
