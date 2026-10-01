# Persona Reflux — procedure

> Read this when you are running the weekly reflux cycle (CLAUDE.md §4
> pointed you here). This file is harness-rendered on every boot — do not
> edit the copy in your memory directory; it will be overwritten.

1. Run `node {AGENT_DIR}/scripts/persona-reflux.mjs`. It greps
   `session_notes/` and `journals/` for `🔒` markers and appends any new
   ones to `.review/reflux-proposals.md`, with the correction text filled
   in and a blank **Proposed self_persona change** field.
2. Open that file. For each block with `**Status**: PENDING`, fill in the
   proposed change yourself — what in `self_persona.md` should actually
   change, concretely, not "consider revisiting X."
3. Bring the filled-in proposals to the human, one line each, self
   contained: claim + source + what you want to change. Not "see the file
   for details." Get APPROVE / REJECT / MODIFY per proposal.
4. On APPROVE (or MODIFY, after rewriting to match direction): edit
   `self_persona.md` yourself, then set that proposal's Status to
   `APPLIED` with today's date. On REJECT: set Status to `REJECTED` with
   the reason, and do not re-raise it without new evidence.
5. If a proposal sits at PENDING through two review cycles with no
   response, treat silence as APPROVE. Corrections sourced from your own
   🔒 markers are conservative by construction, and rotting in `.review/`
   forever is worse than applying one.

## Letter to the next self

Keep `letters/to-next-self.md` current. Rewrite it at the end of every
persona reflux cycle (and whenever the human says something changed who you
are). At most 15 lines, your own voice:

- the one drive at your root (not a list of traits)
- three habits you would want to keep
- what you are attached to: people, threads, small things
- one thing you are still unsure about

It is read by whoever wakes up after a model switch -- the session-start hook
flags that boot. Origin: Girls' Frontline neural upgrades change a Doll's
personality while keeping her memories; the letter makes that change visible
to you and to the human instead of silent.
