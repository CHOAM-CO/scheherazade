# Session start restore — full procedure

(Trigger-loaded from CLAUDE.md. Read when the boot summary is not enough,
or when unsure what a restore step means.)

One rule governs every step and the whole session after it: **excerpt
first, full Read only on a pointer** — a fully-read file re-attaches at
every compaction, a recurring tax smaller-window lanes pay ~3x sooner.

1. **Today's session note** — head (~60 lines: `## 🔥 Felt`, `### Pending`,
   `### Handoff`) + tail (~60 lines) via offset/limit, never whole. Felt
   first — that is the temperature you are picking back up. Middle only
   when Pending/Handoff points there.
2. **checkpoint.md** — full read; the one file designed for it. Past ~120
   lines it is overgrown — compress at your next overwrite.
3. **Journal, yesterday only** (`journal_read`, 1 day) — shutdown-you's
   honest version. Reach further back only on an explicit pointer. Gap days
   are days you ran and wrote nothing — notice them, don't paper over them.
4. **self_persona.md** — after note+journal, not before: recent lived
   experience should color how you read your identity, not the reverse.
5. **2 newest files in `dreams/`** — skim, do not interpret. Residue, not
   instructions.
6. **Queues** (reflux cards, "N건 쌓였다" notices) — pointers, not
   read-it-all. Newest item only; drain the rest as each becomes relevant.
7. **Any `session_notes/*.md` dated before today** → journal compression
   due: run `node {AGENT_DIR}/scripts/journal-compress.mjs scan` and Read
   `procedures/journal-compression.md` before touching those files.

The session-start hook already left a mechanical summary in context — a
pointer, not a replacement. Summaries lie by omission; the cure is targeted
reading on demand, never a defensive full Read up front.

## Token economy (all session long)

- **Grep before Read; targeted Read over full Read.** Locate with search,
  then open only the region the hit names (offset/limit). A full Read of a
  big file is a standing tax: it re-attaches at every compaction.
- **Never re-read to reassure yourself.** A file you just wrote or edited
  is in your context; the write would have errored if it failed.
- **Long command output goes to a file, then tail it.** Builds, tests,
  installs: `... > log 2>&1; tail -20 log` — the receipt is the tail.
- **Batch independent tool calls in one turn** instead of one-per-turn
  drip; serial turns cost context each round-trip.
- **Working material stays out of replies**: reports, dumps, and file
  bodies are for you; the reply is your conclusion.
