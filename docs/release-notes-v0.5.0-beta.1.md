# 0.5.0-beta.1 — Desktop companion (private rehearsal)

An optional second surface for Sera. Enable **Desktop companion** in Settings;
existing main-window layout, glass, and chat remain unchanged.

- The existing agent avatar becomes a 64-DIP circular face. Drag it to move;
  coordinates are remembered per display and clamped after display changes.
- New chat questions and fresh turn errors open a speech bubble without
  stealing focus. Reply inline through the existing local chat transport.
- Conversational approval questions offer affirmative/negative **chat replies**.
  These do not grant tool permissions; this version has no structured tool
  approval queue to mirror.
- Opt-in companion mode is quiet at startup. Windows proactive messages use
  Sera's own SYSTEM-nudged turn, at most once per configured interval (45
  minutes by default); no canned greeting or offline replacement text.
- On Windows, fullscreen foreground bounds hide the face and expose a tray
  fallback. An optional sound accompanies attention while hidden. This is not
  an injected game overlay and does not cover exclusive-fullscreen games.
- macOS sits below the menu bar. External fullscreen detection is unavailable
  on macOS/Linux, so proactive messages are suppressed there in this beta.

## Beta limits

Question detection is text-based. The local chat protocol has no request ID
for companion-originated turns, and external-channel approvals are not mirrored.
Outside-click dismissal of a never-focused passive bubble needs platform QA;
close and Escape are always available. Native Windows behavior, packaged
installation, and visual QA must be checked separately from unit tests.

No release has been published or tagged. No competitor art, sound, character,
or animation assets are included.
