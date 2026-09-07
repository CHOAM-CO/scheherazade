# v0.3.0

One release, three platforms. 0.3.0 is the cross-platform refactor planned in
docs/design-0023-cross-platform-0.3.md: macOS, Windows and Linux (AppImage)
are now built from one tree by one driver, tested by one suite that passes on
all three hosts (mac 88/0, Windows 87/0, WSL Linux 88/0, every skip printed
with its host reason), and described to the agent by one capability table
instead of "is this a Mac?" checks scattered through the code.

## One platform table

`onboarding/platform.cjs` is the single place that says what a host can do:
managed install (darwin AND arm64, not "not Windows"), which skills seed,
which permission probes run, which uninstall plan applies, which window
material the page can draw, whether the attach lane exists. The onboarding
server asks the table and serves it to the page; the page gates on named
capabilities. Everything that used to be an `else` branch for "the other
platform" is now a real third row.

## The runtime lane is the same everywhere

`supervisor.mjs` is the only lane; `run.sh` is gone. Process control
(`proc.cjs`), data-home resolution (`data-home.cjs`) and the local calendar
day (`local-date.cjs`, `AGENT_TZ`, default Asia/Seoul) each have one
implementation where there were three to five hand copies. Stop semantics and
parent-death exit are per platform inside the supervisor, so an agent's
lifetime no longer depends on which OS spawned it. The default lane needs no
`claude` binary on PATH and has a real watchdog.

## What was wrong and is now fixed

- The ChatGPT lane declared half its context window (131K while the proxy
  served 272K). Five copies of the model catalog collapsed into one, and a
  test now checks the catalog against the live proxy.
- `AGENT_TOPOLOGY=attach` was documented as user-settable and taken at its
  word on every platform; on Windows/Linux it tried to start a lane that only
  exists on macOS. It is now gated on the platform having the lane, and falls
  through to spawn with a logged reason instead of refusing to boot.
- The Linux `windowshot` lane, written on a Mac, reported an empty desktop
  as a broken tool and a Weston/WSLg session as a missing package. Verified
  on real WSLg.
- The manual, `procedures/machine.md`, `autonomy-and-paths.md` and the
  harness CLAUDE.md were written for a Mac and rendered onto every platform
  (Keychain vault, `sudo -A`). They now render per platform, and the default
  skill list is derived from the seeding table instead of being retyped.
- Two path builders took a `platform` argument and then joined with the
  running host's path module; fixed to use the target platform's dialect.

## Packaging and release

`tools/release-all.mjs` builds all three lanes from one commit (mac locally,
Windows and WSL Linux over ssh), opens every artifact it collects and refuses
to publish a set it has not verified — the v0.2.20 "x86_64" AppImage that was
actually arm64 is the defect it is written around. The shipped payload is
trimmed to the runtime set and gated (dead `main-v2.cjs`, `setup.sh`,
`run-cli.sh`, the `claude-code` dep and top-level `node-pty` are gone; fleet
identities are scrubbed). `npm test` is a hermetic runner (`tools/run-tests.mjs`)
with PASS/FAIL/SKIP and a non-zero exit on FAIL.

## Not in this release

Linux keyring (Secret Service) and sandboxing (bwrap) remain unsupported and
say so in the UI. The attach topology stays macOS-only.
