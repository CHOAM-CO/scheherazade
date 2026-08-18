# v0.1.17

(v0.1.16 was built but never published; this release ships its content —
everything below through "Security hardening" — plus the clean-boot fixes
at the end.)

## In-app chat: replies actually render

A backend hosts both its platform (Discord/Slack/Telegram) and the in-app
chat window, and a reply that omitted `channelId` — which the tool
descriptions encourage — always fell through to the platform resolver. So
after an in-app message, the answer posted to Discord and the chat window
showed nothing. Replies now route back to the surface the last real user
message came from, on all three platform backends. Explicit `channelId` is
still honored exactly, and SYSTEM injects (schedules, routines) can't drag
an in-app conversation to the platform. Inbound messages are also now
persisted before the request is ACKed, so a hard kill can no longer drop
the message you just sent.

## New conversation button

'새 대화' in the chat window starts a genuinely fresh session: the current
thread is forgotten (transcript cleared, no `--resume`, no handoff carried
over) while the permanent memory layer — user facts, preferences — is kept
intact. Guarded by the same destructive-action confirm dialog as the rest
of the app.

## Windows: quitting the app actually quits everything

On Windows, quitting (or a mid-session recycle) stranded live child
processes: a channel server still holding the Discord token and a memory
server still holding the SQLite handle. Process teardown now kills the
whole supervisor tree, and the MCP servers additionally self-exit when
their parent dies — so no orphan survives either path.

## Security hardening (5 red-team findings)

- Telegram bot token no longer leaks into logs on image-download failure
  (sanitized at the log site AND fixed in the log redactor).
- Crash-recovery FIFO persists the turn BEFORE delivery — a recycle in
  that window no longer silently loses a message that was already ACKed.
- Message bodies can no longer forge a `<channel>` envelope and
  impersonate another sender (body is escaped).
- Inbound message bodies are no longer logged by default (PII); opt-in
  via `SCHEHERAZADE_LOG_MESSAGE_BODY=1`.
- Scheduled user-authored prompts are labeled `[SCHEDULED TASK]` instead
  of `[SYSTEM]`.

## Clean boot after unclean shutdown

Three fixes for the reboot/force-quit path (0.1.17 additions — v0.1.16 was
never published; this release carries everything above plus these):

- **The Windows boot-time orphan sweep never actually worked.** The sweep's
  own PowerShell command line contains the search pattern, so it matched
  itself and Stop-Process killed the sweep mid-pipeline — "orphan sweep
  failed" twice on every boot, and no real orphan was ever cleaned. It now
  excludes itself ($PID) — verified on a real Windows machine including a
  planted decoy orphan getting swept.
- **Stale temp files from hard kills are cleaned at boot.** Atomic writes
  (liveness heartbeat every 60s, schedules, autonomy state) leave a
  `.tmp` file behind when the process is killed mid-write; these
  accumulated forever. All four backends now sweep them at boot (1-hour
  age gate protects in-flight writes).
- **Quit no longer waits 75s for a ghost.** The graceful-quit grace window
  exists so a live agent can flush its checkpoint before shutdown — but
  when the agent process is dead or mid-restart, nothing can ever answer,
  and the app waited the full window for nothing. It now checks the
  liveness heartbeat and skips the wait when no one is there to answer. A
  healthy idle agent still gets its flush turn.
