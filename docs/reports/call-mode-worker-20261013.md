# Call mode worker report (2026-10-13, written by the parent from the worker's final summary)

Worker: gpt-6.1-sol via :18095 -> :18085, spawned 20:4x on main at 0c5ace2. The worker refused to write this file itself
("developer instructions prohibit report Markdown"), so the parent wrote it from the summary and `git show --stat`.

## Commits (main)
- 28fc9a3 voice: add opt-in endpointed call mode and streaming sentence speech
  - onboarding/public/js/call.js (new, 91 lines), call-core.cjs (new, 26), chat.html, companion.html, companion.js, stt.js,
    tts.js, settings.html, routes/stt.cjs, tests/test-call-core.mjs (new). 165 insertions / 12 deletions.
- c7e83e6 release: document call mode and bump 0.5.0-beta.4
  - docs/design-0028-call-mode.md, docs/release-notes-v0.5.0-beta.4.md, SCHEHERAZADE_MANUAL.md, package.json +
    package-lock.json (two version lines only).

## What the worker says it did
- Default-off "Call mode" toggle in Settings and a button on the companion.
- Endpointing: the existing sherpa-onnx streaming recognizer's enableEndpoint / isEndpoint; an endpoint final is sent as a
  chat turn automatically (no Enter).
- Streaming replies are split into complete sentences and enqueued to TTS as each completes.
- Recognition is suppressed while playback runs; interruption therefore only works between sentences.
- Off path closes the mic, cancels stale recognizer results, clears queued speech.
- npm test: 132 passed, 0 failed, 4 host-skipped.
- No new dependencies. No hardware QA, no installer build, no push.

## Not verified by the worker
- Real microphone round trip (endpoint timing, false triggers on filler like "어어어", first-word errors).
- Behaviour across the chat window's 15 s companion-toggle recheck.
- Any Windows run.

## Next (parent)
- Sonnet strict review: docs/reports/call-mode-review-sonnet-20261013.md.
- Merge the companion-ux worktree branch after Astra finishes, then Windows build of 0.5.0-beta.4 on magi-win and install.
