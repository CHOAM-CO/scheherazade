# P1 — Chat Surface Redesign (design, pre-implementation)

2026-08-05 night. Maps design-research-2026-08.md P1 items onto the REAL
chat surface (onboarding/public/js/chat.js, 603 lines, poll-based
transcript renderer) — several research items assume a streaming
architecture we don't have; this doc records what transfers, what
adapts, and what dies on contact with reality.

## Reality check (what chat.js actually is)

- Poll loop, whole messages land at once. There is NO token streaming
  in the UI — the agent lane streams internally, but the transcript
  endpoint delivers complete messages.
- Render kinds: message bubbles (`chat-msg chat-user|chat-agent`),
  single activity line (`chat-activity`, latest-label-wins, retired
  when the reply lands or awaiting clears), typing dots (capped by
  TYPING_SHOW_MAX_MS), read label, reaction badges, gap markers.
- Injection posture: NO innerHTML anywhere; renderMarkdown +
  createTextNode. Any new node type must keep this.
- Client cap: MAX_CLIENT_MSGS with head eviction; bubbles Map keyed by
  seq. New per-turn wrappers must not break eviction bookkeeping.

## What transfers as-is

1. **Full-width flat turns** (research: "bubbles read messenger,
   full-width reads workspace tool"). Pure CSS: `.chat-msg` loses
   bubble background/radius; agent turns get a barely-different
   surface tint (`rgba(255,255,255,0.02)`-ish over the seeded bg),
   user turns stay distinct via the fg/label treatment, not a colored
   bubble. Alignment: both roles left-aligned full-width (Warp/Claude
   convention), role communicated by a small label/avatar slot, not by
   left/right float.
2. **Hairline turn separators** (Warp): `border-top: 1px solid
   var(--border)` between turns, no full card borders. Composes with
   the 0.0.64 token grammar for free.
3. **Auto-scroll threshold + jump-to-latest pill** (ChatGPT/Claude
   convention). Current `atBottom()` threshold is 8px — brutal; any
   upward wheel breaks stick and there's no way back but manual
   scroll. Change to ~100px, and when the user is scrolled up while
   new content lands, show a floating pill (`chat-jump-pill`) that
   scrolls to bottom + clears. This is the highest-value few-line
   change on the page.
4. **Empty state → example-prompt checklist** (Notion). `showEmpty()`
   currently renders one gray sentence. Replace with 2-3 clickable
   example prompts that fill the composer (NOT auto-send — user keeps
   the trigger). Copy lives in copy.js like everything else.

## What adapts (streaming-shaped research → poll-shaped app)

5. **"Thinking disclosure" → activity line evolution.** Research
   pattern (details/summary, open while streaming, collapses to
   "Thought for Ns") assumes streamed thinking text. We have
   activity labels (tool names), not thinking text. Adaptation:
   - Keep the ONE-line live activity (Granola: internal steps stay
     quiet — current design is already right).
   - When the reply lands, instead of deleting the activity history,
     fold the labels seen during the wait into a collapsed
     `<details>` ABOVE the agent message: summary "N steps · Xs"
     (tabular-nums), body = the label sequence, gray, demoted.
     Requires chat.js to ACCUMULATE labels during a wait (today it
     overwrites; keep overwrite for display, append to an array for
     the fold). No server change needed.
6. **Streaming caret → typing dots keep the job.** No token stream =
   no caret. The existing typing indicator + activity line already
   cover "working"; do not fake a caret (calm-AI rule: no theatrical
   processing).
7. **Failure left-rail (Warp)**: transcript has no error-kind yet.
   Adopt the VISUAL now as CSS (`.chat-msg.chat-error` = 2px red
   left-rail + faint tint, no red card) and wire it when an error
   kind exists in the feed. Don't invent an error taxonomy in the UI
   ahead of the data.

## What dies on contact

- Per-turn action buttons (Cursor "Apply/Insert"): our agent turns
  already carry react/copy hover bars; there is no applyable artifact
  in chat today. Revisit when file/diff cards exist.
- Block-level bookmarking/sharing (Warp): no anchor-linking need in a
  single-user DM surface. Skip.

## Implementation order (each independently shippable)

| # | Change | Files | Risk |
|---|---|---|---|
| 1 | scroll threshold 100px + jump pill | chat.js, app.css, copy.js | low |
| 2 | flat full-width turns + hairline separators | app.css (mostly), chat.js class tweaks | medium (visual identity change — screenshot before/after for Mino) |
| 3 | empty-state prompt checklist | chat.js, copy.js, app.css | low |
| 4 | activity fold (details/summary post-turn) | chat.js, app.css, copy.js | medium (state bookkeeping around eviction) |
| 5 | error left-rail CSS (dormant until data) | app.css | trivial |

Constraints carried from the codebase: no innerHTML (createTextNode
path only), eviction bookkeeping (bubbles Map + msgCount) must count
any new wrapper correctly, activity/typing/read elements re-append to
stay at the tail — new tail elements (jump pill is FIXED overlay, not
in-flow, to avoid this dance).

Gate: #2 changes the app's face — build it behind a before/after
screenshot pair (win eye loop) and let Mino call it before it ships
as default. #1/#3/#5 are unambiguous improvements, ship freely.
