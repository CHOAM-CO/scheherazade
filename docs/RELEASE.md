# Release runbook

First written 2026-08-11 alongside the auto-update wiring (0.1.5). Before this
file the process lived in IDEA's session notes; the auto-updater made two steps
load-bearing enough (latest.yml, blockmap) that forgetting them silently breaks
every installed Windows copy's update check — so it gets a checked-in runbook.

## 0. Preflight

- [ ] `package.json` version bumped (single source of truth for the tag).
- [ ] `onboarding/templates/user-changes.md` gained a `## <version>` section
      (one or two user-facing Korean lines — the agent briefs these in-chat
      after the update lands; a missing section briefs as a bare version bump).
- [ ] Full suite green: `npm test` (`tools/run-tests.mjs` — 86 programs,
      exits non-zero if anything FAILed; per-test logs in `release/test-logs/`).
      The loop that used to live on this line echoed "FAIL <file>" and then
      exited 0, so a red suite read as a green one.
      `test-packaging.mjs`'s ARTIFACT lane is skipped in that run — it checks
      the require graph against a freshly built artifact, which does not exist
      yet at preflight. Step 1 covers it: predist/postdist run the same file
      fail-closed, and postdist must be green.
- [ ] Every SKIP the run prints is "could not run here", never a pass. Read
      them. After the build, `npm test -- --live` re-runs the artifact lane
      against the real dmg plus the Calendar (TCC) and tmux lanes.
- [ ] Release notes drafted (`docs/release-notes-v<version>.md` when it's more
      than a patch; the gh release body otherwise).

## 1. Build — macOS (this machine)

```sh
npm run dist          # electron-builder --mac dmg --publish never
```

- pre/postdist run `tools/test-packaging.mjs`; postdist must be green now.
- Artifact: `release/Scheherazade-<version>-arm64.dmg`.

## 2. Build — Windows (magi-win over ssh)

```sh
# sync exactly what git knows about (no working-tree strays):
git archive HEAD | ssh -o ServerAliveInterval=15 magi-win "cd C:/Users/minom/sch-build && tar -xf -"
ssh -o ServerAliveInterval=15 magi-win "cd C:/Users/minom/sch-build && npm install && npm run dist:win"
scp magi-win:C:/Users/minom/sch-build/release/Scheherazade-Setup-<version>.exe dist/
scp "magi-win:C:/Users/minom/sch-build/release/latest.yml" dist/
scp "magi-win:C:/Users/minom/sch-build/release/Scheherazade-Setup-<version>.exe.blockmap" dist/
```

Gotchas learned in the field:
- `ServerAliveInterval=15` or the long `npm install` kills the ssh session
  silently (exit 255, no output).
- The Windows test-suite output goes to STDERR — `2>/dev/null` makes a healthy
  run look hung.

## 3. Publish

**Push the release commit FIRST.** `gh release create` with no `--target` tags
the remote default branch's CURRENT head — so an unpushed version bump lands the
tag on the PREVIOUS release's commit. The artifacts are still correct (they
build from your working tree), but `git checkout v<version>` on the canonical
repo then gives the wrong source. Caught live on 0.1.9 (Idea); the fix was a
`git push` + delete-and-recreate of the canonical release. Do the push here:

```sh
git push origin master
```

Two repos get the release, one gets the update feed:

```sh
# canonical (private, code + provenance):
gh release create v<version> --repo CHOAM-CO/scheherazade \
  release/Scheherazade-<version>-arm64.dmg release/Scheherazade-Setup-<version>.exe \
  --title "v<version>" --notes-file <notes>

# distribution + UPDATE FEED (public — this is what installed apps poll):
gh release create v<version> --repo Mino-is-me/scheherazade-releases \
  release/Scheherazade-<version>-arm64.dmg release/Scheherazade-Setup-<version>.exe \
  release/latest.yml "release/Scheherazade-Setup-<version>.exe.blockmap" \
  --title "v<version>" --notes-file <notes>
```

**latest.yml + .exe.blockmap are NOT optional.** electron-updater on every
installed Windows copy resolves the newest release of
`Mino-is-me/scheherazade-releases` and fetches `latest.yml` from its assets:

- release without `latest.yml` → every update check errors (log-only, users
  stay stranded on their version, silently).
- `latest.yml` without the `.blockmap` → full-size download instead of a
  differential one (works, but slow) — ship both.
- macOS copies only compare the release TAG (vX.Y.Z) via the GitHub API and
  link to the download page (unsigned build — no auto-install; see
  updater.cjs's header comment), so the tag format matters: always `v<semver>`.

## 4. Post-ship verification

- [ ] `gh release view v<version> --repo Mino-is-me/scheherazade-releases --json assets -q '.assets[].name'`
      lists dmg, exe, latest.yml, blockmap.
- [ ] `latest.yml`'s `version:` line matches the tag.
- [ ] Receipt to Mino: version, what changed, both release URLs.

## History

- 0.1.5: auto-update lands. Until 0.1.4 every fix was hand-delivered
  (build → send file → ask user to reinstall); from the first post-0.1.5
  release onward, Windows installs pull updates themselves and macOS installs
  get a notify-with-link. NOTE: users ON 0.1.4 or older still need one last
  manual install to get onto the update train.
