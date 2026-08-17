# v0.1.15

## Schedules: background behavior from one JSON entry

The app now has a generic scheduling layer: drop an entry into
`schedules.json` and it becomes a recurring background prompt — no code, no
per-feature wiring. Entries carry an author: **user**, **system**, or
**agent**. The agent can register schedules for herself, but agent-authored
entries only fire once you enable autonomy for them — she can propose a
routine, not grant herself one. The schedule watcher is wired at the
channel-local layer, so it runs in the packaged app, not just the Discord
backend.

## Nightly memory consolidation ("dreaming")

Between 3 and 6 AM the agent reads the past week of journals and memories
and rewrites a "What I remember" page — visible to you directly in the
memory screen. The pass is bound by two rules: nothing may be invented, and
anything uncertain goes into an explicit uncertainty section instead of
being stated as fact. You get a standing, human-readable answer to "what
does she actually remember about me" that no longer depends on asking her.

## Entity index over existing memory

Memory search is now connected at the person/name level: an entity index is
built mechanically over the existing SQLite memory store, with **zero model
calls** — it costs no tokens to build or maintain. Searching for a name
pulls the memories that mention that person, not just fuzzy text matches.

## Credential exfiltration auto-block

Reads of AWS/SSH keys, the macOS keychain, and browser password stores are
now blocked outright — the agent is never even asked whether she wants to
read them, and no permission prompt is shown that could be misclicked into
a yes. This extends the existing tool-home guard to the common
credential-store paths.
