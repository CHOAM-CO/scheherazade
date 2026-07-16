# v0.0.20 — Session log viewer (/logs)

> Commission: Mino 2026-07-16 17:23 ("앱에다가 로그 터미널 띄우는 창…
> 버튼 어딘가에 짱박아놓고 누르면 현재 에이전트 세션 확인… 지금 너무
> 깜깜이라"). Direct product of the 0.0.19 live-debug loop: the app had no
> user-visible log surface at all, so every failure had to be relayed by
> hand.

## What changed

### Why the app was blind
In the packaged app, main.cjs's console output goes nowhere a user can see
(no terminal). The agent supervisor's stdout/stderr are piped INTO main.cjs
and only re-echoed to that same invisible console — run.sh's own
`$MEM/logs/agent.log` is written ONLY by its standalone `start` path, which
the app never uses (it spawns `__loop` directly with piped stdio). Verified
before building: the tap point had to be main.cjs itself.

### 로그 tab (new, LAST in the nav — deliberately low-key)
- `/logs` page: terminal-register dark pane, 1s cursor polling, appends only
  new entries (no per-poll re-render).
- Follow mode: pinned to bottom while the checkbox is on; scrolling up
  auto-pauses, returning to the bottom resumes.
- **전체 복사** button — the whole point of the commission: one click puts
  the visible session log on the clipboard for pasting into Discord.
- Stream coloring: main-process lines dim, agent stdout normal, any stderr/
  fatal red. Ring-overflow gaps render an explicit marker instead of faking
  continuity.
- Footer shows the on-disk full-history file path.

### Data layer (onboarding/log-buffer.cjs, new)
- In-memory ring buffer (3000 entries) + disk sink `DATA_HOME/logs/app.log`
  (5MB rotation, one `.1` generation, session-start separators).
- Tap points in main.cjs: `log()`, `fatal()`, agent child stdout/stderr,
  child spawn error. GET `/api/logs?since=N` serves the cursor feed.
- **Token redaction at append time**: discord bot / slack xoxb+xapp /
  telegram bot / sk-* provider keys / Bearer headers are stripped BEFORE
  buffer or disk. Agent stdout is arbitrary text — a child echoing its env
  must not turn the viewer into a token leak. Best-effort defense in depth;
  the UI copy says "가려집니다" (mechanism), never "안전합니다" (guarantee).
- Sink failure is loud-once and nonfatal — a broken log sink must not take
  down the app it exists to debug. No sink (tests) = buffer-only.
- No require cycle: http-server.cjs requires log-buffer (read side); the
  sink dir is handed in by main.cjs at init (write side).

## Test receipts
- scripts/test-log-buffer.mjs — 33/33 (redaction per credential class,
  cursor semantics incl. dropped flag + catch-up drain, ring cap, sink
  rotation, buffer-only no-throw).
- Regressions: test-channel-connect 19/19, test-packaging repo-half 36/36
  (new files ride the existing `onboarding/**/*` glob — verified by gate,
  not assumed).

## Known limits (named, not hidden)
- The viewer starts at app launch: lines from BEFORE the current app session
  are in `app.log` on disk, not in the pane.
- Redaction covers known credential shapes; novel secrets echoed by the
  agent are not covered. Treat copied logs as internal.
- Slack/Telegram live-test status unchanged from 0.0.19 (this release is
  the observability tool FOR that test, not a fix).
