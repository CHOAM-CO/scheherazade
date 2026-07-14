# Scheherazade v0.0.6 — release notes (2026-07-14)

One DMG carrying everything since v0.0.3 (roadmap #7/#9/#10 complete).

## New since v0.0.3

- **Autonomous cycle (v0.0.6)**: opt-in consent (never inherited from other
  settings), real token budget cap measured from the CLI's own transcripts
  (cannot fail open), morning brief that cannot be silently skipped, consent
  withdrawal that actually stops a live cycle.
- **Journal layer (v0.0.5)**: the agent writes its own days first-person,
  append-only with visible timestamp seams; deletion is human-only; the
  memory page shows the journal above the fact tables. Boot restore now
  READS the journal back (last 3 days) — the shutdown letter has a reader.
- **Calendar (v0.0.4 g)**: EventKit reader + MCP tool. Requires Calendars
  full access; a lesser grant (write-only) is refused loudly instead of
  reporting an empty day. Local timezone with explicit offset.
- **v0.0.4 set**: denial guard (negation-check), subagent definitions,
  zero-auth claude-cli provider (reuses your existing login in place),
  pointer index over other tools' local memory, mute-strike ledger with
  one-click model revert, graceful shutdown (quit flushes agent state).
- **Packaging fix**: autonomy/ and calendar/ are physically present in the
  built app (a prior build config would have shipped neither); guarded by a
  test that scans runtime entrypoints, not a hardcoded list.
- Portability: image temp dir now uses the OS temp location.

## Upgrading from an existing install

1. Replace the app (drag the new one over).
2. Restart the agent once (any settings change that re-spawns it, e.g. an
   effort toggle) so the MCP tool list refreshes.
3. Nothing else: CLAUDE.md/harness files re-render automatically at boot,
   no re-onboarding.

## Verified inside the built artifact (not just in the repo)

- `app.asar.unpacked/autonomy/{budget,cycle,tick}.cjs` and
  `calendar/{read.cjs,server.mjs}` present as real files.
- Bundled CLAUDE.md carries the journal boot-reader step.
- Unpacked channel.mjs carries the temp-dir fix.
- `claude-cli/claude` is a real arm64 Mach-O.
