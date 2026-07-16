# v0.0.17 — 0.0.16 hotfix: broken boot (packaging) + DM-only boot ping

v0.0.16 is BROKEN on install: `cadence/` was in neither `build.files` nor
`build.asarUnpack`, so channel.mjs's `require()` of the note-cadence rule
threw synchronously inside the ClientReady handler and killed the whole
Discord bridge — app stuck on "starting", then the restart ladder surfaced
FAIL. Repo-side tests were all green because tests run from the repo and
the repo has the files; `scripts/test-packaging.mjs` existed to catch
exactly this and was not run before the cut. Found live by Mino 14:05,
root-caused 14:0x by asar listing (no `/cadence` entries).

## Fixes

- Packaging: `cadence/**/*` added to `build.files` AND `cadence/**` to
  `build.asarUnpack` (channel.mjs is spawned as plain node, which cannot
  read inside app.asar). `test-packaging.mjs` now 31/0 — its runtime-
  require scan flags this class automatically; it is part of the release
  checklist from now on.
- Bridge survival: `startNoteCadenceWatcher()` call is wrapped — a broken
  optional feature degrades to a loud log line, never takes the bridge
  down with it again.
- DM-only boot ping (Mino's real setup, 14:06: home channel deleted,
  DM-only): last conversation channel is now persisted across restarts
  (`.last-channel`, write-on-change), and the boot announce falls back
  HOME → persisted-last → loud abort. The greeting inject's meta now
  carries the channel the direct line actually landed on instead of a
  hardcoded HOME id, so the guard-enforced greeting reply can't aim at a
  dead channel.

## Verification

- test-packaging 31/0 (the new assertion fails on the 0.0.16 tree),
  boot-announce 13/13, note-cadence 18/18, supervisor 125/0, liveness
  24/0, outbound-channel 14/0, node --check.
- Post-build artifact check this time: `app.asar.unpacked/cadence/`
  present in the built .app (packaged-state verification, not repo-state).

v0.0.16 release is marked broken; do not install it.
