# Chat quick bar (left) — spec, 2026-10-07

Mino (idea home 13:56-14:12): the Chat tab gets a game-style quick menu on the LEFT.
The model pill and "New conversation" stay on the right. The current `!` button
(`#ct-pending`, "she has something piled up") moves into the bar and grows into
three buttons. Each button is icon-only, with a hover label; pressing one makes
Sera SPEAK in the chat (a system turn), it does not open a panel, except the
co-browse button which needs a small popover for pairing.

Paths relative to the repo root. `PUB` = `onboarding/public`. Structure map
(file:line) is in the 14:1x Explore report, summarized inline below.

## Layout

- New element `<nav class="chat-quickbar" id="ct-quickbar">` as the first child
  of the chat layout, vertical, ~44px wide, buttons 36x36, 8px gap, top-aligned
  under the tab strip. Same surface tokens as `.chat-new-convo` (app.css ~1326)
  so it reads as part of the existing chrome; no new palette.
- Remove `#ct-pending` from the header (`PUB/chat.html:26`); its signal becomes
  the dot on button 1. Keep `#ct-new-convo` and the lane chip where they are.
- Tooltip: `title` attribute plus a small custom tooltip to the right of the
  button (so it does not get clipped), text from `copy.js` (ko + en keys, same
  pattern as `pendingSignalLabel`).
- Each button: `<button class="qb" id="qb-<name>" type="button" aria-label=...>`
  with an inline SVG icon (24px, stroke 1.5, currentColor). States via
  `data-state` attribute, see each button. A `.qb-dot` badge (8px, accent) on
  button 1.
- Phone-width is not a target (Electron window), but the bar must not overlap
  the transcript at 900px wide.

## Button 1 — `!` — "What's new?" (업데이트 소식)

Dot lit when ANY of: an update is available, the user has not yet heard the
notes of the CURRENT version, or the pile signal is > 0.

- `GET /api/quickbar/whats-new/status` -> `{ ok, current, latest, hasUpdate,
  unseenNotes, pending: { total, sources } }`.
  - `current` = `APP_VERSION` (`http-server.cjs:3179`), `latest/hasUpdate` from
    `checkForUpdate()` (`http-server.cjs:3660`, cached; do NOT force).
  - `unseenNotes` = `lastSeenVersion !== current`, stamp in
    `DATA_HOME/.gates/whats-new.json` `{ lastSeenVersion, seenAtISO }`.
  - `pending` = the same counts GET `/api/pending-signal` returns (reuse the
    counting function from `routes/pending-signal.cjs`, do not duplicate).
- `POST /api/quickbar/whats-new` -> builds ONE system turn via the existing
  `postSystemTurn(ep, content)` seam (`routes/pending-signal.cjs` ~295) with:
  1. the current version's notes: `docs/release-notes-v<current>.md`, resolved
     from the app resources the same way other docs are served (check how
     `/api/settings/browse-live/install` finds `install.md`; packaged asar path
     matters). If the file is missing, say so in the turn, do not invent notes.
  2. update line: `hasUpdate ? "a newer version <latest> exists, url" : "up to date"`.
  3. the pile recital text, built by the same builder `POST /api/pending-signal/recite`
     uses (refactor that builder into a function both routes call; keep the
     old route working, the old stamp semantics unchanged).
  4. an instruction to the agent: tell the user in her own voice, short, what
     changed in this version, whether an update exists, and what she has piled
     up; no bullet dump of the raw notes, no version-number recital beyond the
     one number.
  - After posting, write the stamp `lastSeenVersion = current`.
  - Response `{ ok: true }`; errors `{ ok:false, reason }` with 5xx, never a
    half-posted turn.
- Renderer (`PUB/js/chat.js`): replace `initPendingSignal/refreshPending/
  recitePending` with `initQuickbar()`: poll status every `PENDING_MS` (same
  constant), set `data-state="lit|idle"` and the dot, click -> POST, busy guard
  like `pendingBusy`, re-read after.

## Button 2 — brush — "Look back" (돌아보기)

A conversation, not a one-click consolidation. Sera opens with what piled up
and asks; nothing is written until the user says so in the chat.

- `POST /api/quickbar/look-back` -> `postSystemTurn` with a prompt that:
  - points the agent at `procedures/memory-consolidation.md` (the nightly
    procedure the schedule in `cadence/schedule-tick.cjs:267` runs) and says:
    this time do it WITH the user, live.
  - step 1: read what the procedure reads (persona, recent episodic/session
    notes, `.review/reflux-proposals.md` if present) and open with the 2-3
    things that changed or piled up since the last pass, in her own words.
  - step 2: ask which to keep, merge, or drop. Wait.
  - step 3: apply only what the user confirmed, through the same writes the
    procedure uses; then say in one line what was written where.
  - no schedule stamp, no AUTONOMY gate (user pressed it), no dream-talk.
- Renderer: click -> POST, busy guard, `data-state="busy"` while the 202 is in
  flight; no polling, no dot.

## Button 3 — eye — "See with <agent name>" (같이 보기)

The icon IS the state. The Settings card "Browse with me (live Chrome)"
(`PUB/settings.html:218-228`, `settings.js` ~955-995) moves here; in Settings
leave one line: "같이 보기는 채팅 왼쪽 눈 아이콘에서" linking to the chat tab.

- `GET /api/quickbar/browse/status` -> `{ ok, enabled, paired, sessionConsent,
  extensionPath, agentName }`.
  - `enabled` = `BROWSE_LIVE` from `.agent-config` (reuse
    `routes/settings.cjs:219-255` readers).
  - `paired`: there is no status route today. Find how the vendored chromux
    (`vendor/chromux`, synced by `harness-render.cjs:1591`) records a pairing
    (a token/pairing file under its profile dir, or a `status`/`ping`
    subcommand of `chromux.mjs`) and read THAT. If chromux only knows by
    trying, call its cheapest no-op through the live profile with a 3s
    timeout and cache the result 60s. Document which in a comment.
  - `sessionConsent` = a valid session consent file exists (below).
  - `agentName` = the display name the lane chip shows (same source).
- `data-state`: `off` (not enabled or not paired: dim icon), `ask` (paired,
  per-action confirm: outline), `free` (session consent on: lit).
- Hover label: `see with <agentName> · <state line>`: off -> "연결 안 됨",
  ask -> "페이지마다 물어봄", free -> "이번 세션은 알아서".
- Click:
  - `off` -> popover anchored to the button: enable toggle (POST
    `/api/settings/browse-live`), extension path with a Copy button, link to
    the install doc (existing route), Pair button (existing
    `/api/settings/browse-live/pair`, 60s), status line. Close on outside
    click / Esc. Re-read status after pair.
  - `ask` -> `POST /api/quickbar/browse/session-consent { on: true }` -> state
    `free`. `free` -> `{ on: false }` -> `ask`.
- Session consent, backend:
  - `onboarding/chromux-live-consent.cjs`: today consent is a single-use file
    per exact argv + channel (`location(home, channel, argv)`, `TTL`). Add a
    session file `DATA_HOME/consent/session-<key(channel)>.json`
    `{ grantedAtISO, expiresAtISO }` that satisfies ANY write action for that
    channel while valid. Validity: 8h or until the app restarts (write the
    app boot id into the file and compare), whichever first.
  - `chromux-live-gate.cjs`: check the session file before the per-action
    one; still exit 4 when `BROWSE_LIVE` is off; `--ask` still works for
    channels without session consent.
  - The chat channel key: whatever `SCHZ_CHANNEL_ID` is for the local chat
    lane; the route derives it the same way the gate does.
  - Granting/revoking writes/deletes the file; revoking also deletes pending
    per-action files for that channel.
- Settings tab: remove the card body, keep the one-line pointer.

## Copy (ko first, en mirror) — add to `copy.js`

- qbWhatsNew: "새 소식" / "What's new?"
- qbLookBack: "돌아보기" / "Look back"
- qbSeeWith: "{name}랑 같이 보기" / "See with {name}"  (use the existing
  Korean particle helper if there is one; otherwise "{name}와(과)" is NOT ok,
  pick the plain form "{name} 같이 보기")
- qbSeeState off/ask/free as above.
- popover strings: enable, extension path, copy, copied, install guide, pair,
  pairing..., paired, pair failed.

## Tests (follow `tests/test-*.mjs` plain assert pattern)

- whats-new status: unseen vs seen stamp; pending counts pass-through;
  missing notes file -> turn says so.
- recital builder refactor: `/api/pending-signal/recite` output unchanged
  (snapshot the text for one fixture).
- session consent: gate accepts a write with a valid session file; rejects
  after expiry; rejects when boot id differs; revoke removes pending files.
- settings route: browse-live GET/POST untouched.

## Out of scope today

- Screenshots and the magi-win build: the caller does those (Idea), not the
  worker. Do not run Electron.
- Any change to the per-action `--ask` wording or to chromux itself.
- Version bump / release notes entry: caller.

## Done means

- `npm test` green (test-headless-lane is known to flake once; rerun it).
- No raw `'claude-cli'` literal added to `main.cjs` (packaging guard).
- A short list in the final report: files touched, routes added, the one
  comment that says how `paired` is detected, and anything the spec left open
  that you decided yourself.
