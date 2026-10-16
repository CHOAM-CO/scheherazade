# Scheherazade 0.5.3

A follow-up to 0.5.2 for two things that were patched over instead of built in: the companion and voice control in the chat header, and formatting in the memory table.

## What changed
- Chat header: the companion and voice control is now one icon button in the quick-action row, like the five next to it. It lights up when a mode is on; hover shows "Companion & voice: Off/Voice/Companion/Companion + voice". Clicking it opens a small panel with the four modes and a one-line description each, the voice status, and "Set up voice" when the voice model is not installed yet. The text label, the dropdown with the white border and the "Voice idle" text are gone from the header.
- Settings (Companion, Voice, Call) keeps a labelled field with a dropdown styled like the other settings fields.
- Memory: values in About you (facts, preferences, corrections, open threads) render their markdown like journals do; the timeline previews stay as written.
- The panel that the browse eye opens and the new companion panel are the same component; Escape, outside click and focus return behave the same in both.

## What you need to do
- Nothing. Settings and memory carry over.

## Known issues
- Voice download progress is visible only while the companion panel is open.
- Native tray has no End call / Stop voice yet.
- There is no language selector yet; the UI is English.
- A true cold start on Windows still takes about 30 seconds (see 0.5.2 notes).

## Unchanged
- Models, voices, speech-to-text downloads and profiles from 0.5.2 are unchanged.
- The four companion/voice modes and what they do are unchanged from 0.5.2.

## For developers
- 7d47bb6: onboarding/public/js/quickbar-popover.js (shared open/close/position/outside-click/Escape/focus-return; used by the browse popover in chat.js and by companion-mode-control.js), companion-mode-control.js renders the header icon + radio popover and the Settings field row from one state/refresh/POST core; header select CSS removed from app.css.
- 34b7442: memory.js table row values through markdown.js (text-node-only renderer) with `entry-value markdown-body`; timeline literal.
- 1404bab (review fixes): radios stay focusable during an in-flight POST (aria-busy), refresh sequence counter rejects stale polls, accessible name "Companion & voice: <Mode>", duplicate browse ARIA removed, unused classes dropped; behavioural tests for the real popover and a rendered markdown row test.
- Review: one Opus pass, P2 items fixed.
- Suite at 1404bab: 161 passed, 0 failed, 5 skipped.
