# v0.0.3 — silence is no longer an option

Patch release, all items from Mino's live click-test round 2 (2026-07-13 evening).

## What's in

1. **stop-reply-guard hook** — the "돌연사" fix. The agent composed reply text
   in its transcript twice but never called the reply tool, so from Discord it
   was indistinguishable from a hang. A Stop hook now blocks any turn that was
   triggered by a Discord message from ending without an actual
   `reply`/`send_file_to_discord` call to that channel (explicit
   silence-requests exempt, retry cap 1, fail-open). Port of the MAGI fleet's
   `check-discord-reply.mjs`, live on 3 agents since April.
2. **Existing installs get the hook too** — `settings.local.json` is
   seed-if-absent (never clobbers your edits), so new template hooks used to
   reach only fresh installs. A boot-time additive migration now appends the
   reply-guard hook + the `send_file_to_discord` permission to live configs.
   Appends only; your own edits are never rewritten.
3. **persona-reflux single-file parse fix** — `grep -HnE`: with only one
   note/journal file present, grep omitted the filename prefix and the
   `file:line:content` parse shifted one field left, corrupting `.reflux-seen`
   dedup keys and the proposals Source line. Found, reproduced, and fix
   proposed by the Scheherazade agent itself (its second boot-test catch).
4. **Memory-write rules in the harness (CLAUDE.md §10)** — root cause of the
   empty memory page: nothing ever parsed transcripts into the DB, and the
   agent was never instructed to write memory. Same-turn write triggers for
   user_facts / corrections / open_threads / preferences, plus restraint
   rules. Harness files also re-render at every app boot now, so this reaches
   existing installs.
5. **App icon** — new flat two-tone logo (grape-vine girl, profile-in-circle),
   picked by Mino from codex-i2i candidates, on a macOS rounded-rect plate.

## Upgrade notes

- Replace the app; your agent, config, and memory in `~/Documents/Scheherazade`
  are untouched.
- **Restart the agent once after updating** (Settings → change effort or
  model, or stop/start). The MCP tool list is fixed at agent start, so a
  still-running old agent keeps the old tool surface even after the app
  bundle updates — this is exactly the "half-update" confusion from the
  v0.0.2 round.
- Still unsigned: right-click → Open on first launch.

## Known caveats

- The reply-guard reads the last 500KB / 80 entries of the transcript — a
  pathologically long single turn could push the trigger out of the window
  (inherited from the MAGI original, acceptable for v1).
- Boot migration is additive-only by design; it will not repair a
  hand-broken settings.local.json (invalid JSON = loud skip).
