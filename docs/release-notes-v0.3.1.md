# v0.3.1

Stop, and steer without stopping. Until now a running turn was a turn you
waited out: the only way to change course was to let it finish, and anything
you typed meanwhile queued up behind it.

## Stop ends the running turn

The chat surface has a Stop button, live only while a turn is actually
running. It clears the pending message queue first, then ends the turn — so
nothing you had waiting gets delivered into the wreckage — and the lane comes
back with `--resume`, on the same session, ready for the next message. The
interrupted message is dropped, not silently re-sent later.

`POST /interrupt` is the one entry point, on both lanes. The dsh lane cancels
in place through the gateway's own `session.cancel`: no process is killed
there at all.

## Steering merges into the live turn

The input box stays open beside Stop. A message sent while a turn is running
is merged into that turn rather than queued after it, and the UI labels it as
steering so it is clear which of the two you are doing.

## Known issue: Stop on Windows

Windows has no deliverable interrupt signal, so Stop there is a hard
terminate. That ends the turn, but it can leave MCP child processes behind.
The soft `control_request interrupt` path is the follow-up.
