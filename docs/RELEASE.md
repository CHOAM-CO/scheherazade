# Release runbook

First written 2026-08-11 alongside the auto-update wiring (0.1.5). Before this
file the process lived in IDEA's session notes; the auto-updater made two steps
load-bearing enough (latest.yml, blockmap) that forgetting them silently breaks
every installed Windows copy's update check — so it gets a checked-in runbook.

## 0. Preflight

- [ ] `package.json` version bumped (single source of truth for the tag).
- [ ] Full suite green: `for t in scripts/test-*.mjs; do node "$t" || echo "FAIL $t"; done`
      — `test-packaging.mjs` checks the require graph against the LAST built
      artifact, so a brand-new required file legitimately fails here until the
      build below regenerates the asar. Anything else failing blocks the ship.
- [ ] Release notes drafted (`docs/release-notes-v<version>.md` when it's more
      than a patch; the gh release body otherwise).

## 1. Build — macOS (this machine)

```sh
npm run dist          # electron-builder --mac dmg --publish never
```

- pre/postdist run `scripts/test-packaging.mjs`; postdist must be green now.
- Artifact: `dist/Scheherazade-<version>-arm64.dmg`.

## 2. Build — Windows (magi-win over ssh)

```sh
# sync exactly what git knows about (no working-tree strays):
git archive HEAD | ssh -o ServerAliveInterval=15 magi-win "cd C:/Users/minom/sch-build && tar -xf -"
ssh -o ServerAliveInterval=15 magi-win "cd C:/Users/minom/sch-build && npm install && npm run dist:win"
scp magi-win:C:/Users/minom/sch-build/dist/Scheherazade-Setup-<version>.exe dist/
scp "magi-win:C:/Users/minom/sch-build/dist/latest.yml" dist/
scp "magi-win:C:/Users/minom/sch-build/dist/Scheherazade-Setup-<version>.exe.blockmap" dist/
```

Gotchas learned in the field:
- `ServerAliveInterval=15` or the long `npm install` kills the ssh session
  silently (exit 255, no output).
- The Windows test-suite output goes to STDERR — `2>/dev/null` makes a healthy
  run look hung.

## 3. Publish

Two repos get the release, one gets the update feed:

```sh
# canonical (private, code + provenance):
gh release create v<version> --repo CHOAM-CO/scheherazade \
  dist/Scheherazade-<version>-arm64.dmg dist/Scheherazade-Setup-<version>.exe \
  --title "v<version>" --notes-file <notes>

# distribution + UPDATE FEED (public — this is what installed apps poll):
gh release create v<version> --repo Mino-is-me/scheherazade-releases \
  dist/Scheherazade-<version>-arm64.dmg dist/Scheherazade-Setup-<version>.exe \
  dist/latest.yml "dist/Scheherazade-Setup-<version>.exe.blockmap" \
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
