# Building Your Own Ontology

> Rendered into your memory directory by setup. Read when CLAUDE.md §9
> triggers fire — not before. An index built before the pain of needing one
> is process theater; an index built after is a tool.

## What this is

After enough sessions, your memory stops fitting in your head-per-session:
hundreds of journal files, facts about your human scattered across months,
decisions whose reasons you can no longer find. Grep stops scaling when you
don't know which words to grep for.

An ontology, the way this lineage of agents builds one, is **a small index
that answers WHERE, never WHAT**. It is a map of your memory, not a copy
of it.

## The one load-bearing rule

**The index answers *where*; reading the file answers *what*.**

Never answer a factual question from the index alone. The index entry says
"facts about her cat live in journals/2026-03-12.md and memories/her.md" —
then you READ those files and answer from them. The moment you store answer
text in the index and serve it back, you have built a second, staler copy
of your memory that will drift from the truth and you will not notice.
Index entries rot silently; source files are the only honest surface.

## Structure (start this small, stay this small)

One file: `ontology.md` in your memory root. Three columns per line:

```
topic | where | last-confirmed
her cat (Mango) | journals/2026-03-12.md, memories/her.md | 2026-07-01
job change decision | journals/2026-05-02.md §afternoon | 2026-05-02
my name origin | journals/2026-02-11.md | 2026-02-11
```

- **topic**: how future-you would search for it, not how it was phrased at
  the time. Write the query, not the quote.
- **where**: file paths, plus a section anchor when the file is long.
  Multiple locations comma-separated — a topic living in several files is
  normal, that's why you need the index.
- **last-confirmed**: the date you last READ the source and confirmed the
  entry still points true. Entries older than a few months are candidates
  for re-confirmation, not for trust.

Graduate to something heavier (SQLite, tags, whatever) only when this file
itself stops scaling — hundreds of topics, not dozens. The format matters
less than the where-not-what rule, which survives any format.

## What goes in

- Facts about your human that recur: preferences, boundaries, people in
  their life, running jokes, things they asked you to remember.
- Decisions with reasons: what was decided, where the *why* is written.
- Your own identity landmarks: corrections that changed you (🔒 lines),
  moments your persona file cites.
- Anything you have ever looked for twice.

## What stays out

- **Speculation and interpretation.** Only things that happened, were said,
  or were decided. Your reading of a mood is journal material, not index
  material.
- **The content itself.** No quotes, no summaries beyond the topic label.
  (See the one rule.)
- **Anything derivable by opening one obvious file.** Today's session note
  doesn't need an index entry; it needs to be read tomorrow.

## Maintenance

- Add entries during journal compression (CLAUDE.md §3) — you are already
  reading the material; noting "this will be asked about again" costs one
  line.
- On conflict — the index says X, the source file says Y — **the source
  file wins, always, immediately**. Fix the index entry in the same breath.
  An index that has ever knowingly disagreed with its sources is dead.
- When a fact is superseded (they moved, the project ended), don't delete
  the entry — point it at both the old and new locations. Your human's
  history is part of who they are to you; supersession is information,
  not garbage.
