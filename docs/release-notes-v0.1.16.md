# v0.1.16

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
