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
- Any change on the page (click, type, navigate, submit) is asked first in your channel; it runs once only after you answer yes, and expires after two minutes.

Boot follow-up
- On a new session the companion picks one recent promise or open thread from its notes ("you said you'd check the report yesterday, did you?") and opens with it instead of a generic greeting. Records older than 7 days are ignored.

Verified live on 2026-10-06 with a DeepSeek-lane companion: version, user taste and a channel id were answered from memory without opening files.
