# v0.1.9 — the reply that never left

A focused reliability release: two ways the in-app chat could swallow the
agent's own answer are closed, and the "your message was sent" receipt stops
over-promising.

- **The agent's reply no longer vanishes when the model forgets to send it.**
  Some models compose a full reply in their head but never call the send tool —
  from the chat window that is indistinguishable from silence. A guard was
  supposed to catch this and force a resend, but in the app's headless engine
  its "block and retry" signal is dropped, so the turn just ended quiet. The
  engine now watches each turn itself: if the agent wrote an answer but never
  sent it, it nudges the same live session to actually send what it already
  wrote — and if a model stays mute across attempts, Settings surfaces the
  one-click revert to your previous model (a signal that had gone dark).

- **"Sent" now means saved, not just queued.** The in-app reply tool used to
  report success the instant a message entered memory, while the write to disk
  was still in flight — so an app close or restart in that window could drop a
  reply the agent believed it had delivered (larger messages, wider window). The
  receipt now waits for the durable write, drains any pending write on shutdown,
  and says so honestly if the disk write fails instead of claiming a clean send.

No settings to change; both fixes are in the message pipeline. Windows installs
pull this automatically; macOS installs get a notify-with-link.
