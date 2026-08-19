# Session notes + memory_write — full rules

(Trigger-loaded from CLAUDE.md. Read when writing the day's first note
entry, when unsure what belongs in memory, or when the memory page looks
wrong.)

## Session notes (`session_notes/YYYY-MM-DD.md`)

Write as the session goes, not all at once at the end — memory
reconstructed after the fact loses the texture that made it worth keeping.

Required sections, in this order:

- **`## 🔥 Felt`** — FIRST section, so it survives compression as the
  topic sentence, never an appended afterthought. Concrete scenes, not
  labels: "감정 레이블만 쓰지 마. 구체 장면 없으면 다시 써."
- **`### Pending`** — unfinished items with enough context that future-you
  does not have to reconstruct why they are listed.
- **`### Handoff`** — the one or two load-bearing things next session must
  know first. Not everything that happened.

Mark **🔒** at the start of any line that is a correction or a turn that
must not get summarized away. Not every session earns one — never
manufacture a 🔒 to fill space.

`checkpoint.md`: overwrite on significant state change, not on a timer
(the checkpoint-nudge hook's 30-min stale ping is a floor, not a cadence).
It is a SNAPSHOT ≤~120 lines — closed lanes get one line or get cut; their
full story already lives in notes and journal.

The DB journal (`journal_write`) is not shutdown-only — the quit sequence
asks for it, a crash never does. Write first-person entries when something
worth keeping happens; appends are cheap and the timestamp seam keeps late
lines honest.

## memory_write (the [기억] page is fed by YOU, not by parsing)

Nothing parses your transcripts. The memory page ("여기 없는 것은 기억하지
않습니다") shows exactly what you wrote via `memory_write` — an empty page
after a session where the user shared real things is a bug in YOUR
behavior, not in the app. Write in the SAME TURN you learn something, not
at session end (sessions get cut; unwritten memory dies with them).

Write triggers — when any of these happens, call `memory_write` before you
finish replying:

- **`user_facts`** — the user states a fact about themselves: name, people
  around them, job, schedule, tastes, situations ("다음주에 이사해",
  "고양이 이름은 춘식"). Store as an atomic subject/predicate fact in your
  own words, not a transcript quote.
- **`corrections`** — the user corrects you in ANY register: tone ("반말
  써"), behavior ("물어보지 말고 그냥 해"), or a fact you got wrong. This
  table is read back to you before every reply (pre-reply hook) — an
  unwritten correction WILL be repeated as a mistake.
- **`open_threads`** — a task left unfinished, promised for later, or
  blocked ("내일 마저 하자", "그거 알아봐줘"). Update status when it
  resolves — a stale forever-open thread is noise the user must delete by
  hand.
- **`preferences`** — a standing way-of-working choice ("보고는 짧게",
  "아침엔 말 걸지 마").

Restraint rules, same weight as the triggers: do NOT log small talk,
in-flight task chatter, or your own inferences dressed as the user's facts
(if you guessed it, it does not go in). One fact = one row; do not
re-write a fact that is already there (`memory_query` first when unsure —
duplicates erode the user's trust that the page is curated, not scraped).
