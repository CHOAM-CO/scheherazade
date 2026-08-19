# v0.1.18

Four features from one live tasking session (Mino, 2026-08-19 morning):
"같이 보기", both-ways file transfer in chat, a recently-touched-files
panel, and an honest permissions page.

## 같이보기 — the agent can look at one of your windows

Say "지금 나 디코중인거 같이 보자" and the agent screenshots that one app
window (not the whole screen), reads it, and talks about what it sees.
Works on macOS (CoreGraphics enumeration + `screencapture -l`) and Windows
(EnumWindows + `PrintWindow`, live-verified on the Win11 box — including
the discovery that `$pid` is a reserved PowerShell variable and that remote
sessions can't see the interactive desktop, both now handled/documented).

Deliberately read-only: it takes pictures, it does not click. The chromux
"live mode" route (an extension bridging the user's real Chrome) was
evaluated the same morning and kept OUT of the bundle — the bundled skills
now say so explicitly, ending a failure mode where the agent instructed
users to run a `chromux pair` that could never complete (the extension was
never vendored).

Requires the Screen Recording permission — which leads to:

## Permissions page tells the truth about sudo, and says what things are for

The Admin-commands row read "Denied" on machines where onboarding had
already collected and stored the admin password — the probe only knew
about passwordless `sudo -n`. It now recognizes the app's askpass lane
(Granted "stored key") and grows a Check button that actually runs
`sudo -k -A true` through the askpass helper on click — the one honest
test of the stored password, never run on a status poll (a wrong password
would PAM-fail into the system log every tick). The Screen Recording row
now says it exists for 같이보기.

## In-app chat: files and media, both directions

The agent's file-send tool used to enqueue a bare path as text — the user
saw prose, not a file. It now copies the file into the chat-uploads store
and emits the standard attachment marker, so images render inline and
other files render as a download chip (25MB cap, honest errors instead of
silent path-as-text). Uploads from the user side gained media and archives
(mp3/m4a/wav/mp4/mov/webm/zip) with a new binary-safe marker kind, and the
serve route learned their content types. `[file attached:]` / `[PDF
attached:]` lines — both directions — now render as chips instead of raw
paths.

## Memory page: files the agent touched recently

A new PostToolUse ledger hook records every Write/Edit/MultiEdit/
NotebookEdit target (fail-open, kill-switchable, size-rotated keeping a
history window). The memory page lists them deduped with touch counts —
failed writes dimmed, never hidden — and clicking a row opens the file
with the OS default app, guarded so only ledger-listed paths can ever be
opened. Existing installs get the hook through the additive settings
migration.

## Plumbing

- First-party agent helpers now ship unpacked as `agent-tools/`
  (extraResources — the agent child is plain node and cannot read inside
  app.asar), synced every boot to `DATA_HOME/bin` with wrappers that bake
  the data-home path in. Packaging test pins the extraResource.
- New suites: agent-tools sync (16), file ledger (23), send_file transfer
  block (+8), sudo tier matrix (+9). ARCHITECTURE.md hook tables updated
  under the lifecycle-doc suite's enforcement (18 commands / 16 files).
