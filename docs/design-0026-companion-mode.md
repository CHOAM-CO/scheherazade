# design-0026 — Companion mode (0.5.0)

Status: SPEC, 2026-10-12. Owner: Idea (spec + review). Builder: one astra worker.
Decided by Mino 2026-10-12 14:32–14:35 (idea home): "작업표시줄 우상단에 HUD처럼 떠서
컴패니언마냥 말풍선으로 말걸기 모드… AOD처럼", "프사는 세라에 이미 있는 프사 동그랗게
빼서", "coucou + 컴패니언 앱들 시중에 나와있는거 참고해서".

## Beta implementation decisions (2026-10-12)

- Surveyed Coucou, Shimeji, Discord overlay, Steamworks overlay, Windows
  notification guidance, and notch-app conventions before implementation.
  Keep passive presence, explicit dismissal, a draggable face, opt-in sound,
  and quiet startup. Do not inject into games: Discord/Steam overlays are not
  evidence that a transparent Electron window can cover exclusive fullscreen.
- Windows rehearsal exposed missing mousemove forwarding while ignored: an
  initially ignored face could not be entered or clicked. Windows/Linux use
  native `setShape` rounded hit regions instead; transparent pixels pass
  clicks through without polling or tracking the cursor. macOS retains the
  renderer-enter/leave `setIgnoreMouseEvents` path. At a bottom-left edge the
  bubble goes above, rather than overlap its own face or leave the work area.
- No structured tool approval queue or allow/deny endpoint exists in this
  revision. Beta can answer conversational approval questions through the
  existing `/api/chat/in` endpoint, explicitly labeled as chat replies, NOT
  permission grants. Actual tool authorization remains outside this surface.
- The pending signal is accumulated material for a user-triggered recital,
  not a permission request. Do not auto-recite it or change design-0024.
- Windows checks foreground bounds against native monitor bounds at 1 Hz,
  including borderless fullscreen conservatively. macOS/Linux cannot safely
  infer another app's fullscreen state using Electron alone; proactive turns
  stay disabled there rather than claim a false all-clear.
- Questions are detected conservatively from new chat text; the current chat
  protocol carries no structured question or originating-turn identifier.
  Only local-channel messages are available; external-channel approvals are
  not mirrored. Proactive turns use the existing SYSTEM-turn path, never
  pretend to be user messages, and cool down even after failed injection.
- The shell can dismiss a focused bubble on blur. Outside clicks while the
  companion has never taken focus need platform verification; a visible close
  button and Escape remain available without global input hooks.
- The survey did not establish a current Windows Copilot-specific toast
  contract. Use Microsoft's documented Windows banner/inline-reply/Do Not
  Disturb conventions, not an assumed Copilot API. NotchNook's landing page
  was unavailable; notch hover conventions are secondary-source evidence.

Reference pages read through Aside, read-only, 2026-10-12:
[Coucou](https://louis-cfm.github.io/coucou/),
[Shimeji](https://shimejis.xyz/),
[Discord](https://support.discord.com/hc/en-us/articles/217659737-Game-Overlay-101),
[Steamworks](https://partner.steamgames.com/doc/features/overlay),
[Windows notifications](https://support.microsoft.com/en-us/windows/experience/notifications-and-do-not-disturb-in-windows).
None establishes per-display position persistence or transparent hit testing;
those remain Sera design decisions. No competitor assets were reused.

## What it is

A second, tiny Electron window: Sera's face (the existing agent avatar, cropped
to a circle) floating always-on-top in the top-right corner of the screen, like
an always-on display. When Sera has something to say, a speech bubble opens
next to the face. The user can answer inline from the bubble. The main
Scheherazade window stays as it is; companion mode is an extra surface, off by
default, toggled from Settings.

Reference competitor: Coucou / Mochi (louis-cfm/coucou, MIT code, character
assets copyrighted — do NOT copy any Mochi art, name, sounds, or animation
frames). Research note: `~/Documents/MAGI_Memory/choam/research/coucou_20261012.md`.
Before building, survey what desktop companion apps on the market do (Coucou,
Shimeji-style desktop mascots, Windows Copilot's notification toast, Discord's
overlay, Steam overlay, macOS notch apps) — collect the conventions for: idle
presence, how a bubble grabs attention without stealing focus, how to dismiss,
click-through, position memory. Write the survey into
`docs/research-companion-apps-2026-10.md` (one page, English) and let it change
this spec where it disagrees; note each deviation at the top of this file.

## Platform priority

Windows first (Mino 14:27 "윈도우 친화로 가자"), macOS second, Linux best effort.
Test box: magi-win (Windows 11, 5120x2880 desktop, 200% DPI, Mino's `minom`
profile). The main window must not regress on any platform.

## Surface

- Frameless, transparent, always-on-top BrowserWindow, `skipTaskbar: true`,
  no focus steal on show (`showInactive`), `setVisibleOnAllWorkspaces` on mac.
- Default position: top-right of the primary display's work area, inset ~12px.
  Draggable by the avatar; the position is remembered per display id in
  `DATA_HOME/companion.json` (`{ enabled, positions: { [displayId]: {x,y} } }`).
  If the remembered display is gone, fall back to the default.
- Collapsed state: the round avatar only (64px at 1x; scale with DPI). Served
  from the existing agent avatar slot (`GET /api/settings/avatar`, see
  `onboarding/routes/settings.cjs` AVATAR_SLOTS, fallback
  `public/img/agent-avatar.png`). Circle crop is CSS (`border-radius: 50%`,
  `object-fit: cover`) — no new upload path, no new picture slot. A thin ring
  shows state: idle / thinking (animated) / needs attention.
- Expanded state: a speech bubble to the left of (or below, when there is no
  room) the avatar, max ~320px wide, with the message text, an optional
  one-line reply input, and for approval asks two buttons (allow / deny) that
  hit the same endpoints the main window uses.
- Click-through: the transparent area around the avatar and bubble passes
  clicks to whatever is underneath (`setIgnoreMouseEvents(true, {forward:true})`
  toggled from renderer mouseenter/mouseleave on the avatar/bubble elements).
- Loads over the existing local http server, same origin as the main window,
  same `contextIsolation/sandbox` web preferences; no new privileges in the
  renderer. All state comes from the existing routes (chat, pending-signal,
  agent-status). Add one small SSE or poll endpoint only if nothing existing
  can push "new message / needs attention" to the companion.

## When the bubble speaks (the core rules)

The bubble is the whole feature; a face that never speaks is a sticker, a face
that nags is uninstalled. Rules:

1. Agent needs the user: a permission/approval ask, a question in the chat, a
   turn error (e.g. the "Claude login expired" marker from 0.4.3). Bubble opens
   at once, ring goes "needs attention", stays open until acted on or dismissed.
2. Agent finished something the user asked for from the companion (reply to a
   bubble): the answer comes back into the bubble.
3. Proactive lines ("good morning", "did that fix land?") — at most one every
   N minutes (default 45, configurable), never while the user is in an
   exclusive-fullscreen app, never during the first 2 minutes after boot,
   auto-collapse after 20s if not touched. Source of these lines: the agent's
   own chat turn with a system nudge, not canned strings, so Sera says them in
   her own voice; if the provider is unreachable, say nothing.
4. Anything else stays in the main window. Quiet by default.

Collapse: click outside the bubble, Esc while the bubble has focus, or the
timeout. Dismissed proactive lines are not repeated.

## Limits (say them in the UI copy, do not fight them)

- Exclusive-fullscreen games cover always-on-top windows. While a fullscreen
  app is detected (Windows: `GetForegroundWindow` size == monitor size via a
  cheap native check, or simply a 1-Hz `screen` + `BrowserWindow.getFocusedWindow`
  heuristic), hide the companion and fall back to the tray icon + a short
  sound; show again when the fullscreen app goes away.
- On macOS the menu bar/notch area is not ours; sit under it.
- No mouse tracking, no eye-following in v1. Idle = still face + ring.

## Settings

Settings > Appearance (or a new "Companion" group): toggle "Show Sera as a
desktop companion", slider/number for proactive interval, checkbox "sound
when hidden by a fullscreen app". The avatar picked in Settings > Agent is the
companion face; a note there says so.

## Deliverables for 0.5.0-beta

1. Branch `companion-mode` off main; small commits; `npm test` green and new
   tests for: companion.json read/write, bubble rate limiting, fullscreen
   hide/show decision (pure functions in a `companion/` module, testable
   without electron, same pattern as `window-glass.cjs` + `tests/test-window-glass.mjs`).
2. `docs/research-companion-apps-2026-10.md` + deviations noted here.
3. Bump version to `0.5.0-beta.1`, release notes `docs/release-notes-v0.5.0-beta.1.md`.
4. Windows rehearsal build: `node tools/release-all.mjs --allow-dirty --rehearse-remote --only win`
   (see docs/RELEASE.md "Rehearsing"); install on magi-win **in Mino's desktop
   session** with `~/Desktop/MAGI/scripts/qa-driver/win-driver.sh launch '<Setup.exe path on the box>' /S`,
   then WAIT for the Setup process to exit by itself (3–4 min; killing it early
   leaves a half install, lock 2026-10-07), then launch
   `C:\Users\minom\AppData\Local\Programs\scheherazade\Scheherazade.exe`,
   enable companion mode in Settings, and take `win-driver.sh shot` screenshots of:
   collapsed face top-right, an open bubble with an approval ask, the reply
   input. Save them under `~/Documents/MAGI_Memory/scheherazade/qa/0.5.0-beta/`.
   Run QA only when Mino is not using that desktop (ping first; if he is
   active, stop and say so in the report).
5. Report (English, `docs/companion-mode-beta-report-2026-10.md`): what works,
   what does not, screenshots list, open questions for Mino.

Do not publish (no `--publish`, no tag). Do not touch the main window layout.
Do not add a tray-only mode beyond the fullscreen fallback. Do not copy Coucou assets.
