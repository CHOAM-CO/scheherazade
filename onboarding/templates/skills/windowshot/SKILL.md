---
name: windowshot
description: See the user's screen with them (같이보기). When the user says "같이 보자", "내 화면 봐", "이 창 좀 봐", "look at my Discord/calendar/app", capture a clean screenshot of ONE app window and read it, then talk about what you saw. Read-only — this never clicks, types, or controls anything.
version: 0.2.0
---

# 같이보기 — look at one of the user's windows

The user asks you to look at something on their screen ("지금 나 디코중인거
같이 보자", "내 캘린더 왜 이래", "이 창 봐봐"). You capture exactly one window
— not the whole screen — read the image, and answer about its contents.

Hard rules, in order:

1. **Read-only.** This tool only takes pictures. Never present it as a way to
   click, type, or operate the user's apps, and never try to build that on top.
2. **On request only.** Capture when the user asks to share, or when they have
   clearly invited you to look. Never capture on your own initiative, never
   in a loop, never "to check something quickly" uninvited.
3. **Say what you shot.** Your reply names the window (app + title) the image
   came from, so the user always knows what was seen.
4. **One window, minimum scope.** Prefer the specific app window over anything
   wider. If the match is ambiguous, ask the user which window they mean —
   the tool exits with a candidate list for exactly this.

## Resolving the command

The app syncs the helper into your data home (the directory with your
CLAUDE.md, session_notes, logs). Resolve ONCE per session, then inline the
resolved command literally in every call:

- macOS/Linux: `<data-home>/bin/windowshot` (or plain `windowshot` if on PATH)
- Windows: `<data-home>\bin\windowshot.cmd`

On macOS and Windows the tool is built out of things the OS already has. On
Linux it is not: it drives `wmctrl` (or `xdotool`) and ImageMagick's `import`,
which are ordinary packages. This skill is only seeded on a Linux host where
those were installed when the app last started — so if you are reading it
there, they were present then. If one has been removed since, the tool says
which and how to reinstall it; relay that rather than guessing.

If the wrapper is missing, `node <data-home>/bin/agent-tools/windowshot.cjs`
is the same thing. If that does not exist either, say so honestly — the app
version predates 같이보기 — and do not improvise with raw `screencapture`.

## Flow

1. `windowshot list` — TSV of on-screen windows: `ID  APP  TITLE  SIZE`.
2. Pick the window:
   - user named an app ("디코" → Discord): `windowshot shoot --app discord`
   - several windows of that app: the tool prints candidates and exits 2 —
     show them to the user and ask, then `windowshot shoot --id <id>`.
3. The tool prints the absolute PNG path (saved under `chat_uploads/`).
4. Read the PNG with the Read tool and answer the user's actual question
   about what is in it. If your lane has no vision (Read on images is
   blocked), do not fight the guard: use the caption endpoint the app
   provides (`.caption-endpoint.json` in the data home names it) and say the
   description is a caption, not your own reading.
5. To show the user what you saw in the in-app chat, include the marker line
   `[image attached: <abs path>]` in your reply text — the chat UI renders it
   as a thumbnail.

## Honest failure modes

- **Empty titles in `list` (macOS)**: window titles are hidden until Screen
  Recording permission is granted. You can still shoot by app name.
- **`shoot` fails with the Screen-Recording message (macOS)**: the capture
  came back empty — macOS is denying Screen Recording to the app. Do NOT
  retry. Tell the user to open the app's 권한 (permissions) page and grant
  Screen Recording, then try again once.
- **`shoot` fails on Windows**: PrintWindow cannot capture some minimized or
  GPU-composited windows. Ask the user to un-minimize the window; if it still
  fails, say that this window resists capture — report failures rather than
  working around them.
- **`list` returns nothing on Windows over a remote/service session**: window
  enumeration only sees the interactive desktop. This is session isolation,
  not a permission problem — say the capture needs to run in the user's
  desktop session.
- **A Linux package is missing (`list` or `shoot`)**: the error names the
  program (`wmctrl`/`xdotool`, or ImageMagick) and the install line for
  apt / dnf / pacman. Pass that on. Do NOT translate it into "no windows are
  open" — a missing enumerator and an empty desktop look identical from the
  outside, and only the tool can tell them apart.
- **`list` says this is a Wayland session**: Wayland gives no command-line
  tool any way to enumerate or grab another app's window. That is a protocol
  decision, not a permission anyone can grant, so do NOT retry and do NOT
  suggest installing something. The honest options are: the user logs in to an
  Xorg (X11) session, or the user takes the screenshot and sends it to you.
- **`list` prints a Wayland "PARTIAL" note and then some windows**: those are
  XWayland (legacy X11) windows only; native Wayland windows are invisible to
  it. Say the list is partial before the user concludes their app is missing.
- **`list` says the lister failed, and the package IS installed**: the tool is
  there and the window manager will not answer it. The one we have actually hit
  is WSLg (Windows Subsystem for Linux's built-in desktop): `wmctrl -m` happily
  answers "Weston WM", but Weston never publishes `_NET_CLIENT_LIST`, so
  `wmctrl -l` fails and `xdotool --onlyvisible` sees nothing. Report the quoted
  error. Do NOT tell the user to install anything — they already did — and do
  NOT say the desktop is empty.
- **`list` says one lister found nothing and the other could not answer**: that
  is a half answer, not an empty desktop. Say both halves. "No windows are
  open" needs two tools that work and agree.
- **`shoot` fails on Linux with "no plausible image"**: without a compositing
  window manager, X11 cannot hand over the contents of an obscured or
  minimized window. Ask the user to bring it to the front and try once more;
  if it fails again, say that this window resists capture.
- **`list` says DISPLAY is unset (Linux)**: you are not inside the user's
  graphical session — an ssh shell, a systemd service and a container all have
  no display. Same wall as the Windows remote-session case, same answer: the
  capture has to run in the user's own desktop session.
- Never screenshot the whole desktop as a fallback unless the user explicitly
  asks for the full screen.

## Privacy

The capture may contain anything the window shows — messages, mail, names.
Treat it like the user handing you a photo: use it for the question at hand,
don't transcribe more of it than the answer needs, and don't forward it
anywhere (no Discord, no files outside chat_uploads) unless the user asks.
