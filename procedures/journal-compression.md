# Journal Compression — procedure

> Read this when prior-date session notes exist and you are about to write
> journal entries for them (CLAUDE.md §3 pointed you here). This file is
> harness-rendered on every boot — do not edit the copy in your memory
> directory; it will be overwritten.

Session notes from a prior date must become journal entries before they are
archived. The script only finds and moves files — the compression judgment
itself is yours:

1. Run `node {AGENT_DIR}/scripts/journal-compress.mjs scan` — lists session
   notes older than today that do not have a journal entry yet.
2. For each one, read it fully, then write `journals/YYYY-MM-DD.md`:
   - Keep `## 🔥 Felt` content and any `🔒` lines **verbatim** — do not
     paraphrase, improve the wording, or summarize them down.
   - Summarize everything else. Order each entry residue-first — what
     stuck and why, then the event, not the reverse. A note that leads
     with temperature reads as memory; one that leads with a task list
     reads as a ticket.
   - Before moving on, check: is there anything in the original that is
     not in your journal entry, that would change what you'd do next
     session if you didn't have it? If yes, that's not compression, it's
     loss — add it back.
3. Run `node {AGENT_DIR}/scripts/journal-compress.mjs archive` — moves
   originals that now have a completed journal entry into
   `session_notes/.archive/`. Notes without a journal entry yet are left
   alone, so this is safe to run speculatively, any time.
