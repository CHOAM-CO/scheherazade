# Memory Consolidation — procedure

> Read this when a nightly schedule turn says to (`memory-consolidation` in
> `schedules.json`, fired inside its 03:00-06:00 window by the generic
> Schedules cadence). This file is harness-rendered on every boot — do not
> edit the copy in your memory directory; it will be overwritten.

Sleep is not idle time for a brain — it is when the day's raw stream gets
sorted into what stays. This is that pass over your own memory: any backlog
gets cleared first, the last week gets reread, and `memory-summary.md` — the
file the app shows the user under "What I remember" — gets rewritten
honestly from what is actually there.

1. **Clear the backlog first.** Run `node {AGENT_DIR}/scripts/journal-compress.mjs
   scan`. If anything is pending, do not skip it and do not synthesize from
   raw session notes as a shortcut — follow `procedures/journal-compression.md`
   fully before continuing. A consolidation built on an uncompressed week is
   built on the wrong material.
2. **Read the last ~7 days.** `journal_read` over the past week, plus
   `memory_query` over `user_facts`, `preferences`, `corrections`, and
   `open_threads`. This is the entire source material — nothing in the
   summary you write next may come from anywhere else, including what you
   "remember" from the conversation itself but never wrote down.
3. **Rewrite `memory-summary.md` in full** — a full rewrite, not an append,
   titled "What I remember." Sections, in this order:
   - **About the user** — durable facts, sourced from `user_facts` and
     journal lines.
   - **Our relationship** — how things actually are, not how you'd like
     them to read.
   - **Current threads** — open_threads that are genuinely live; dormant
     ones (step 4) belong here too, marked dormant, never silently dropped.
   - **Preferences & corrections to honor** — the standing rules you are
     already supposed to be following.
   - **Things I'm unsure about** — real hedges, not padding. A guess that
     reads confident is worse than no line at all.

   Two rules hold for every line in the file: **no fabrication** — every
   claim traces to a journal line or a memory row, or it does not go in —
   and **unsure goes in the unsure section, or it is left out** — never
   smoothed into a confident sentence to make the page read better. Keep
   the whole file under ~150 lines. It is user-visible and written in your
   own voice: not a report to the user and not a table dump, the thing you
   would actually say if asked "what do you remember about me."
4. **Check stale `open_threads`.** Anything untouched more than 14 days:
   either it is actually done — close it with `memory_confirm` / `memory_delete`
   to match reality — or it is still real but stalled, in which case it goes
   under Current threads as dormant rather than being carried forward
   forever unexamined.
5. **One line to the journal.** `journal_write` noting that consolidation
   ran and what materially changed — a fact added, a thread closed, a
   correction resurfaced — not "ran consolidation," which tells no one
   anything.
