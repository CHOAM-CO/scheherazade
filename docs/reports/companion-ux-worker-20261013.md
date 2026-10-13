# Companion UX worker report (2026-10-13, written by the parent from the worker's final summary)

Worker: gpt-6-astra via :18095 -> :18085, worktree /Users/narr/Desktop/scheherazade-ux, branch companion-ux off main 0c5ace2
(before the call-mode commits). The worker refused to write this file itself ("worker instruction prohibits Markdown report
files"); the parent wrote it from the summary.

## Commit
- e25d58e companion: unify settings and anchor conversational bubbles to the orb (23 files, +233 / -49). package-lock.json unchanged.

## What changed (worker's account)
- Settings: one COMPANION group (master switch, variant face / sound only, voice picker + read aloud, microphone, inline
  model states not installed / downloading / ready). Existing keys and off defaults kept. "통화 모드 · 준비 중" placeholder
  (call-mode key did not exist on main at branch time; now it does, reconcile on merge).
- Chat header: always-reachable companion quick toggle.
- Bubble: 320 px translucent surface, no title bar, no X, Enter submits (arrow glyph inside the input), input only when a
  reply is expected, approval-only "open in app" link, STT ghost text shares the bubble. Measured in Electron: 12 px gap to
  the ring on either side, no overlap with the hover control row; canvas 200 px, wrapper 200 x 252.
- Tests: 132 passed / 0 failed / 4 skipped; geometry, quick-toggle and mocked macOS forwarded click-through regressions added.
- Screenshots: docs/reports/companion-ux-20261013/*.png (ten Electron fixture captures). Parent looked at orb-left,
  settings-ready, chat-quick-toggle: matches the brief.

## Not verified
- Live microphone, OS-level click-through on Windows.

## Merge notes for the parent
- Shared files with call mode (companion.js / stt.js / tts.js / settings.html): rebase companion-ux onto main after the Sol
  fix round, resolve, then replace the 통화 모드 placeholder with the real toggle row.
