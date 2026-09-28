# v0.3.4

This release is the chat surface. Her face and the name you gave her finally
arrive in the conversation, a small mark above the input lets her bring up
what has piled up instead of waiting to be asked, and the pane now says what
the turn underneath it is actually doing. A release built from this same
source was installed and exercised on Windows before it was published.

## The face and the name

The picture is yours to upload — this release ships no face of its own, only
the slot. Settings grew a picture row: choose a file and a square crop step
opens, where the image can be dragged and zoomed (1x to 4x) inside the frame,
with the result saved as a 256x256 PNG. That framing step is the point: the
old path stored whatever was picked and centre-cropped it at display time, so
an off-centre face was cut with no way to correct it. The chat row shows the
picture at 32px, Settings previews it at 96px, and one slot is kept per data
home, so it survives a rename. The picker accepts files up to 25MB now (it was
2MB); the size the app stores is still capped on the server side.

The name is the one you typed. That was the defect being fixed: the chat
printed the literal word `Agent` on any message row that was replayed before
the status probe answered, and rows already on screen were never relabelled
when the real name arrived. Now no name is invented while the name is unknown,
and every row on screen is repainted the moment the probe answers.

## The "!" above the chat

When things have piled up that she has not been told about, a small mark
appears next to the composer. Clicking it does not open a list to work
through: it hands her one short message saying what is waiting, and she opens
the conversation herself, in her own voice, saying what is there and what she
would change. Acting on any of it stays the existing per-item flow, and
skipping the rest is a legitimate outcome that nothing records.

Three sources feed it, each read fresh at the moment you click, with no
background job anywhere:

- corrections that are still active in the memory database
- reflux proposals still marked `PENDING` in `.review/reflux-proposals.md`
- dream fragments in `dreams/`

What "piled up" means is *what grew since she last recited it*: a mark that
has been told once stays dark until its pile grows again, and a source that
cannot be read contributes zero rather than an error, so a fresh install
never shows a phantom mark. The memory gaps he asked about are not measured
by anything — the recital asks her to name those herself, from what she
already knows, in chat.

Two conditions are worth knowing before you go looking for the mark. Dreams
only form when autonomy is on, and the reflux pass has no shipped schedule,
so it only produces proposals when something runs it. Reflux and dreams were
both empty on the machine this was tested on, which left the mark mirroring
the corrections count. If nothing is piled up at all, the mark is simply not
there.

## The mark on answers that came from memory

A reply that came out of a memory read now carries a small mark on its sender
row. The honest limits: it covers the memory tools reached through MCP, not a
plain file read of a journal; it fires on the call rather than the result, so
a refused read still marks; a subagent's read arms the parent's next reply;
and turning the activity feed off silences it along with the rest of that
feed. It is deliberately faint and carries no label, because it is not a role
marker.

## What the turn is doing

Every in-flight signal in the pane used to be fed by the message poll alone,
so a turn that died mid-tool was indistinguishable from one still working:
the dots came back, the fold stayed open, and Stop re-armed as if nothing had
happened. The pane now derives one state from both the poll and the lane's own
liveness — idle, working, stalled, linking, gone, stopping — and the elapsed
chip stays visible past the old cap. A failing poll moves the pane to
`Reconnecting…` and then to an honest line about the session having ended
while waiting on a tool result. Stop now leaves a persisted record in the
transcript, so the derivation stops re-arming Stop and Read on a turn that is
already dead, and a stop that ran long enough to measure says so.

## One model list

The Engine page and the chat composer now read the same catalog. The Engine
page previously re-read the installed CLI's model table and the live Ollama
tags and spliced anything extra into its list, which is why a model removed
from the catalog could reappear there. That merge is gone; the list on both
surfaces is the table the catalog carries, which is still the curated
per-provider list from v0.3.3.

## What this does not do

- **No task queue, no editor, no dismissal ledger.** The "!" makes her speak;
  it never asks you to work an item, and ignoring a suggestion leaves no
  trace and no nag. Nothing is scheduled: the only thing that runs is what a
  click starts, and the click costs no model call of its own.
- **No new write to her persona file.** Corrections still change it only
  through the reflux cycle, with your approval per item, exactly as before.
- **The recital's divider line is Korean** inside an otherwise English pane,
  which matches the existing boot line rather than fixing it here.

## Unchanged known issue

Stop on Windows is still a hard terminate and can leave MCP child processes
behind, exactly as described in the v0.3.1 notes. The soft
`control_request interrupt` path remains the follow-up; this release does not
touch it.
