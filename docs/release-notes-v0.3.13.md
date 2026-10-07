# v0.3.13

Your companion now uses what it remembers.

- On startup it reads what it knows about you (facts, preferences, unfinished threads), not only its notes and checkpoint.
- Every message you send gets a small, bounded memory context attached: open threads, facts relevant to what you just said plus a few stable basics about you, recent corrections, and preferences. It is capped so conversations do not get heavier.
- Relevance first: facts are ranked by overlap with your message (Korean and English), so an old but relevant fact surfaces ahead of a newer unrelated one. Long facts are never cut mid-row.
- The same memory context reaches the DeepSeek (DSH) lane, which previously got none.
- Editing or deleting a fact, preference or correction refreshes the topic index right away.
- New always-on rule: use remembered facts naturally, never recite them as a list, and lightly re-confirm old facts when it matters.
- Effort picker gains `xhigh` with short hints per level.

Browse with me (live Chrome)
- New setting with a one-time "Pair extension" step (unpacked extension from the chromux folder, Developer mode).
- Say "on this page / the tab I am looking at" and the companion reads that tab directly.
- While it is on, the companion acts on pages without asking; there is no per-action confirmation. The eye button in the chat quick bar turns it on and off.

Boot follow-up
- On a new session the companion picks one recent promise or open thread from its notes ("you said you'd check the report yesterday, did you?") and opens with it instead of a generic greeting. Records older than 7 days are ignored.

Import memories from another assistant
- Memory page: pick ChatGPT / Claude / other and a .txt, .md or .json export. Candidates are staged (duplicates skipped, 200 max), never stored as facts on their own.
- Accept or reject each one; accepted lines become facts with confidence 0.8 and their origin recorded.
- In conversation the companion may also offer up to three pending candidates, one at a time, and treats none of them as true until you confirm.

One seed, then an oath
- New companions start from one root drive you pick (curiosity, care, mischief, or a line of your own) instead of a list of quirks; the weekly persona growth happens around that seed and never rewrites it.
- Existing companions get a one-time "pick a seed" card in Settings; nothing changes until you pick.
- When you are ready, take the oath in Settings: both names, a date, and the seed is locked. Only an explicit revoke can change it afterwards; the companion acknowledges the oath once, in its own words.

Chat quick bar
- Five icon buttons in the chat header, left of the model chip. Hover shows what each does; pressing one makes the companion speak, it does not open a panel.
- ! What's new: reads these notes, says whether an update exists, and runs through what it has piled up for you. The dot lights when any of that is waiting.
- Brush, Look back: goes through recent notes and persona changes with you, live; nothing is written until you confirm.
- Eye, See with the companion: browse-live on/off; opens the pairing popover when the extension is not paired yet.
- Moon, Dream: tells one of its dreams; untold ones first.
- Calendar, Today: a short rundown of today's calendar and what it remembers is due.

Chat composer
- The box grows with long text up to about 40% of the window, then scrolls inside.
- Attached images show as thumbnails above the text, with a remove button; other files stay as chips.

Providers and usage
- Claude (subscription login): an expired Claude Code login is refreshed with its refresh token before the companion starts, and the rotated token is written back, so a terminal `claude` run is no longer needed after expiry.
- Ollama usage: ollama.com now reports 7-day spend and request counts instead of a quota fraction; the gauge shows spend, today, and a daily strip.
- Ollama cloud and other OpenAI-compatible servers: the leading instruction message is sent as `system` (OpenAI's `developer` role was rejected by Mistral models on ollama.com with a 400).
- A failed model call now shows its reason in the chat as a one-line divider and in the top banner, instead of only `turn end (error: ...)` in the log.
- DeepSeek lane: when a tool call fails to schedule mid-step, the pending calls get error results and the conversation continues instead of stalling (upstream fix #4595, applied as a patch on the pinned engine).

Fixes
- The daily-note reminder had been silently crashing every few minutes since it shipped; it runs again.
- Browse live now ships the Chrome extension it asks you to load (Pair pointed at a folder that did not exist).
- Boot follow-up picks a real open item from the checkpoint, not a lesson line from its tail.

Verified live on 2026-10-06 with a DeepSeek-lane companion: version, user taste and a channel id were answered from memory without opening files.
