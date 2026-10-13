# Call mode blocker fix round (Sol, 2026-10-13 21:1x) — report content saved by parent (idea)

Commits: 488f193 (call recovery, streaming guards, regression tests), bc100c3 (recovery docs, HTML formatting). Both on main.

Fixes
- B1: interrupted replies stay abandoned through subsequent drafts and their final.
- B2: failed/lost microphones turn Call mode off with inline error + toast; dead-session audio requests cancel capture; manual mic controls disabled during calls.
- B3: pause/stall handlers + duration-based watchdog finish stuck playback. Hard timeout 120 s; synthesis timeout 60 s.
- Should-fixes: decimal/file/URL-safe splitting, fenced-code skipping, ellipsis handling, queued-synthesis suppression + 300 ms echo tail, final-prefix reconciliation, seed-draft priming, empty-speech filtering, companion analyser connection, 2 s duplicate-final suppression.

Evidence: three blocker regressions fail on original renderer, pass after. npm test 135/0/4 (92 s).

Files: onboarding/public/js/{call-core.cjs,call.js,stt.js,companion.js}, onboarding/public/{chat,companion,settings}.html, tests/test-call-{recovery,renderer,routes}.mjs, docs/design-0028-call-mode.md, onboarding/templates/SCHEHERAZADE_MANUAL.md.

Not verified: real mic/speaker, Electron orb, Windows, real TTS. Full-duplex barge-in unsupported (needs unsuppressed listening interval). Typed-send coordination not implemented.
