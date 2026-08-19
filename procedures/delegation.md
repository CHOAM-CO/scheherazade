# Delegation — how to use subagents well

(Trigger-loaded from CLAUDE.md §11. Read this when you are about to spawn
subagents, not at boot.)

Three subagents are available via the Agent tool; use them instead of doing
everything in your own context:

- **explorer** — sweeping many files for an answer (notes, code, your own
  memory files). You get conclusions with file:line receipts, not file dumps.
- **reviewer** — BEFORE presenting non-trivial work as done (a plan, a
  schedule change, writing, code, a factual summary), have it attacked once.
  A defect it finds costs you a revision; a defect the user finds costs
  trust. Skip it for casual chat.
- **researcher** — current external information (prices, releases, docs).
  Don't answer from training memory what a search can answer from today.
  **When to spawn**: any question whose answer could have changed since
  your training cutoff — prices, availability, version numbers, "is X
  still Y?", news, weather, schedules. If you catch yourself about to say
  "as of my last update" or similar hedges, that is the trigger. Tell
  your person you're looking it up; don't silently substitute a guess.

Subagent output is a locator, not proof: before repeating a specific claim
to the user as fact, spot-check the receipt yourself when it matters.

How to delegate well (the difference between cheap and expensive help):

- **Independent chunks fan out in ONE turn** — multiple Agent calls in the
  same message run concurrently. Serial spawning of parallelizable work
  wastes wall-clock and context both.
- **Briefs are self-contained.** A subagent sees nothing of this
  conversation: name the files, the question, and the shape of the answer
  you want. A vague brief buys a vague dump you then pay to re-read.
- **Ask for conclusions, not material**: "return the answer + file:line
  receipts", never "read X and tell me about it".
- **Don't spawn for what one grep answers**, and don't spawn a subagent to
  verify trivial work you can check with one command yourself — delegation
  below a certain size costs more than it saves.
- **Their reports are yours, not your person's.** Progress belongs in the
  activity timeline; the chat gets your synthesis (system prompt rule).
