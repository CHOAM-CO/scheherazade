# Release runbook

First written 2026-08-11 alongside the auto-update wiring (0.1.5), as prose a
human executed by hand. Rewritten 2026-09-07 (design-0023 P2) around
`tools/release-all.mjs`, because prose could not catch what prose let ship:
v0.2.20's `Scheherazade-0.2.20-x86_64.AppImage` was built on the arm64 Mac, so
`file` on its AppRun said **aarch64** and its bundled natives were
`@koromix/koffi-darwin-arm64`, `@img/sharp-darwin-arm64`,
`@vscode/ripgrep-darwin-arm64` — an "x86_64"-named artifact that no x86_64
Linux can execute at all. It was published, and it was caught days later by a
human running `file` on a hunch.

So the runbook is a program now. This document is what you need to know to run
it, and what it refuses to do for you.

---

## 0. Preflight

- [ ] `package.json` version bumped. **Single source of truth for the tag** —
      the driver refuses any `--tag` that disagrees, and that check is never
      waived: the version is baked into every artifact filename and into the
      `package.json` inside the staged asar.
- [ ] `onboarding/templates/user-changes.md` gained a `## <version>` section
      (one or two user-facing Korean lines — the agent briefs these in-chat
      after the update lands; a missing section briefs as a bare version bump).
- [ ] Full suite green: `npm test` (`tools/run-tests.mjs` — 86 programs, exits
      non-zero if anything FAILed; per-test logs in `release/test-logs/`).
      The loop that used to live on this line echoed "FAIL <file>" and then
      exited 0, so a red suite read as a green one.
- [ ] Every SKIP the run prints is "could not run here", never a pass. Read
      them. `test-packaging`'s ARTIFACT lanes (asar closure, natives, payload)
      skip in a plain `npm test` because nothing has been built yet; they run
      fail-closed inside `npm run dist`'s predist/postdist, and again under
      `npm test -- --live` after a build.
- [ ] Release notes drafted: `docs/release-notes-v<version>.md`. `--publish`
      requires a notes file — a release nobody can read is not a release.
- [ ] Commit pushed **and the tag pushed**. `gh release create` with no
      `--target` tags the remote default branch's CURRENT head, so an unpushed
      tag lands on the previous release's commit (caught live on 0.1.9). The
      driver checks `git ls-remote --tags origin` for exactly this.

```sh
git push origin main
git tag -a v<version> -m "v<version>" && git push origin v<version>
```

---

## 1. The driver

```sh
node tools/release-all.mjs --tag v<version>
```

Builds all three platforms from HEAD, pulls every artifact into `release/`,
opens each one and verifies it, then **prints the `gh` command and stops**.
Nothing is published without `--publish`.

| flag | what it does |
|---|---|
| `--tag vX.Y.Z` | default `v` + package.json version; must equal it |
| `--only mac\|win\|linux` | repeatable; default all three |
| `--dry-run` | print every build / ssh / scp / gh command, run nothing |
| `--allow-dirty` | rehearsal: branch / clean-tree / tag checks become warnings. Refuses `--publish`, and refuses to touch the shared box |
| `--rehearse-remote` | with `--allow-dirty` only: run the win/linux legs **for real** on the box, into rehearsal locations |
| `--verify-only` | build nothing; open what `release/` already holds and check it. This is how a leg someone else ran gets checked here |
| `--publish` | actually create the release on `Mino-is-me/scheherazade-releases` |
| `--clobber` | the release already exists: `gh release upload --clobber` instead of refusing |
| `--notes <file>` | release notes; required by `--publish` |
| `--keep-remote` | leave the remote build directory in place |

Everything the run says — including npm's, electron-builder's and the remote
builds' own output — is tee'd to `release/release-all-<tag>.log`.

### Packaged content (0.3.5)

v0.3.4 shipped without anyone opening the app.asar inside an artifact. Now each
lane writes `BUILD_INFO.json` (tag, git HEAD, a per-run id) into its build tree
right before packaging (`build.files` ships it; it is gitignored), and after the
build `tools/release-check.mjs` reads `package.json` and `BUILD_INFO.json` back
out of the asar. Rows: asar opens, packaged version == tag, stamp tag == tag,
stamp head == the preflight HEAD, stamp run id == this run.

| lane | what gets opened | limit |
|---|---|---|
| mac | the dmg itself (`hdiutil attach -readonly`), right after `npm run dist` | none known |
| win | `release\win-unpacked\resources\app.asar` on the box, inside `build.cmd`, before cleanup | the NSIS `.exe` payload is not opened (needs a full 7-Zip); this is the staging tree it was packed from in the same run |
| linux | the AppImage itself via `--appimage-extract resources/app.asar` in WSL | if extraction fails it falls back to `linux-unpacked` and says so in the log |

win/linux write `release/content-check-<lane>.json` back to this Mac. A
mismatch fails the leg; any failed row blocks `--publish`. Under
`--verify-only` there is no run id to match, so that row is reported as not
checked and win/linux need the JSON from the box.

### Rehearsing

```sh
node tools/release-all.mjs --dry-run --tag v<version>   # every command, nothing run
node tools/release-all.mjs --only mac --allow-dirty     # a real mac build off a dirty tree
```

`--allow-dirty` alone never touches the shared Windows box: the win and linux
legs are dropped from the run and it says so. That is the right default — a
half-finished branch should not be able to leave a build directory on a machine
someone else is using.

To rehearse those two legs against the real boxes before a release is cut, ask
for it explicitly:

```sh
node tools/release-all.mjs --allow-dirty --rehearse-remote --only win --only linux
```

`--rehearse-remote` is valid **only** with `--allow-dirty`, and it prints a
one-line banner saying so. The legs then run for real — same generated scripts,
same `npm ci`, same `dist:win` / `dist:linux` — but into rehearsal locations
derived from one slug, so nothing can collide with or overwrite a real run:

| | release run | rehearsal |
|---|---|---|
| Windows build dir | `C:\Users\magi\sch-build\<tag>\` | `…\rehearsal-<tag>\` |
| WSL branch | `<tag>` | `rehearsal-<tag>` |
| bundle / script on the box | `schz-<tag>.*` | `schz-rehearsal-<tag>.*` |

Artifacts still land in `release/` and get the **same** verification rows, so a
rehearsal answers the only question worth asking beforehand: do the two remote
legs actually complete on those boxes, and is what comes back a real x86-64
installer and a real x86-64 AppImage. `--publish` stays refused under
`--allow-dirty`, rehearsal or not — these artifacts are not releasable.
Cleanup removes the rehearsal directory unless you pass `--keep-remote`.

---

## 2. What each leg does, and the traps it is written around

### mac — this machine (darwin/arm64)

`npm test`, then `npm run dist`. `predist` asserts the host before
`test-packaging` runs (npm executes pre-scripts first, so before 0.3 P2
`npm run dist:win` on this Mac ran the whole mac-lane packaging test and only
*then* refused). `postdist` mounts the freshly built exact-version dmg and
verifies the require graph, the natives, and the payload gate against it.

Artifacts: `Scheherazade-<version>-arm64.dmg`, `.dmg.blockmap`,
`latest-mac.yml`. arm64 only. Unsigned (`identity: "-"`), so mac updater mode
is **notify**: installed copies compare the release TAG and link to the
download page. Tag format is therefore load-bearing — always `v<semver>`.

### win — ON the Windows box, never cross-built

`git archive HEAD` → scp to `C:\Users\magi\sch-build\<tag>\src.tar.gz` → a
generated `build.cmd` → `npm ci` → `npm run dist:win` → scp back.
Prereqs on that box: node ≥ 24 (24.20 today), npm 11.19.0, `tar` (ships with
Windows 10+), the `magi-win` ssh alias reachable from this Mac.

Traps the generated script exists to survive — each one produces **exit 0 with
no build**, which is worse than a failure:

- **`call npm`, always.** In a `.cmd`, cmd.exe *transfers* control to another
  batch file instead of calling it, and `npm` on Windows is `npm.cmd`. A bare
  `npm ci` ends the script there and every line after it silently never runs.
- **Never pipe on the remote side.** A `| tail` inside the ssh command string
  is interpreted by the remote cmd.exe, not by your shell. On 2026-09-02 that
  exited 0 with `npm ci` never having run.
- **Nothing in the background.** Anything backgrounded dies when the ssh
  session ends. Every remote step runs in the foreground.
- **`ServerAliveInterval=15`.** `npm ci` goes silent for minutes and used to
  drop the connection with exit 255, no output.
- Windows test output goes to **STDERR** — `2>/dev/null` makes a healthy run
  look hung.

Artifacts: `Scheherazade-Setup-<version>.exe`, `.exe.blockmap`, `latest.yml`.
x64 only, unsigned NSIS (SmartScreen "More info → Run anyway" is accepted).
Windows updater mode is **auto**, which is why `latest.yml` and the blockmap
are not optional (see §4).

> The installer's `file` header reads `PE32 executable (GUI) Intel 80386 …
> Nullsoft Installer self-extracting archive`. That is **correct**: the NSIS
> stub is 32-bit by design whatever the payload is. Do not "fix" it. The
> payload's x64-ness is guaranteed one level in, by `tools/assert-platform.mjs`
> (wrong host) plus `test-packaging`'s NATIVES gate (wrong contents), both of
> which run inside the Windows build itself.

### linux — WSL2 (Ubuntu) on the same Windows box, `/root/schz`

`git bundle HEAD` → scp to `C:\Users\magi\` → a generated bash script, also
scp'd there, run as
`ssh magi-win "wsl -d Ubuntu -u root -- bash /mnt/c/Users/magi/<script>.sh"`.
Locked call (2026-09-07): Linux stays a WSL build on that box. No Linux CI.

Traps:

- **The script's first line is `exec </dev/null`, and it is run BY PATH.**
  Never feed a script over stdin — `ssh box "wsl … bash" < script` hands git
  and npm the same stdin and they eat it.
- **That tree has no GitHub credentials.** Source travels as a single `git
  bundle` file, fetched from `/mnt/c/Users/magi/<bundle>`, never cloned.
- **`git checkout -- package-lock.json` first.** `npm install` there leaves the
  lockfile dirty and a dirty lockfile blocks the next checkout.
- **Detach before the fetch.** The run ends with that tree checked out ON the
  tag branch, and git refuses to fetch into a branch that is checked out. The
  second release of a tag this tree already carried died there — one exit-128,
  `fatal: refusing to fetch into branch 'refs/heads/v0.3.2' checked out at
  '/root/schz'`, which aborted the linux lane and blocked `--publish`; it was
  cured by a hand `git checkout --detach HEAD` on the box. The script now
  detaches itself, immediately before the fetch (`git checkout --detach HEAD
  2>/dev/null || true`), so what meets the fetch is a detached HEAD, which is
  not a branch at all. A fresh tree has no commit to detach from — hence the
  `|| true`: a first run on a tree with no branch yet still starts.
- **scp cannot reach into the WSL filesystem.** Artifacts are `cp`'d to
  `/mnt/c/Users/magi/` and scp'd from the Windows side.

Artifacts: `Scheherazade-<version>-x86_64.AppImage`, `latest-linux.yml`. No
blockmap — electron-builder emits none for AppImage. Linux updater mode is
**notify**, same as mac, deliberately.

---

## 3. Verification (the driver does this; know what it is claiming)

For every artifact it collected:

- it **exists**, with its size printed;
- `file`'s header: AppImage must be `ELF … x86-64` (the row that would have
  caught v0.2.20), the exe must be a Windows PE NSIS installer;
- the matching `latest*.yml` parses, its `version:` equals the tag, it lists
  the artifact, and its `size` and `sha512` match the bytes on disk.
  A yml written for a different build is not cosmetic: electron-updater
  rejects the download, so the update fails for every installed copy with no
  visible cause;
- blockmaps present for dmg and exe.

Any failure blocks `--publish`.

### The both-box E2E rule (standing, 2026-08-19)

`release-all` verifies **artifacts**. It does not verify that the app *runs*.
Before any release, the D-73 rule still stands: an E2E on **both** boxes.

- **mac**: install the dmg → drive the packaged wizard over CDP
  (`--remote-debugging-port`) → provider found-login card → lane up → one small
  task turn (file written, reply delivered, `turn end (completed)`).
- **win**: NSIS silent install as a scheduled task (Interactive principal, or
  the `schztest` rig in session 0) → app with
  `--remote-debugging-port=9222 --disable-gpu --no-sandbox` → `ssh -L 19222`
  tunnel → CDP wizard → lane up → task turn. Graceful close via an Interactive
  task (`taskkill /IM`, no `/F`) — minutes, not seconds. Log-poll regexes need
  `-Raw` strings.
- **linux**: xvfb boot smoke in WSL — the AppImage launches and reaches the
  onboarding server. That is the whole Linux bar today; Secret Service keyring
  and bwrap sandboxing remain "unsupported with honest UI".

Clean up the rig afterwards: scheduled tasks, tunnels, test installs.

The magi-win rig's `schz-e2e-install` task does not name a version: its action is
`powershell ... -File E:\schz-e2e\install-latest.ps1`, which reads
`releases/latest/download/latest.yml` from the public feed, downloads that
installer, checks its sha512 and runs it `/S`, logging to
`E:\schz-e2e\install-latest.log`. Source: `tools/e2e/schz-e2e-install-latest.ps1`
(scp it over the deployed copy after editing). `schz-e2e-app` runs the
installed `Scheherazade.exe` and was never version-pinned.

---

## 4. Publish

```sh
node tools/release-all.mjs --tag v<version> --publish --notes docs/release-notes-v<version>.md
```

Publishing is a human's call, every time. Without `--publish` the driver prints
the exact command and the asset list and stops.

The eight assets:

| | |
|---|---|
| mac | `Scheherazade-<v>-arm64.dmg`, `.dmg.blockmap`, `latest-mac.yml` |
| win | `Scheherazade-Setup-<v>.exe`, `.exe.blockmap`, `latest.yml` |
| linux | `Scheherazade-<v>-x86_64.AppImage`, `latest-linux.yml` |

**The yml files are not optional.** electron-updater on every installed Windows
copy resolves the newest release of `Mino-is-me/scheherazade-releases` and
fetches `latest.yml` from its assets:

- release without `latest.yml` → every update check errors (log-only; users
  stay stranded on their version, silently);
- `latest.yml` without the `.blockmap` → full download instead of a
  differential one (works, but slow) — ship both;
- mac and Linux copies compare the release TAG via the GitHub API and link to
  the download page (unsigned build, no auto-install — see `updater.cjs`).

The public feed is `Mino-is-me/scheherazade-releases` (`build.publish`,
`updater.cjs`'s `UPDATE_OWNER`/`UPDATE_RELEASES_REPO`). The canonical private
repo `CHOAM-CO/scheherazade` holds code and provenance; publishing there is a
separate, manual `gh release create` and is not what installed apps poll.

---

## 5. Post-ship

- [ ] `gh release view v<version> --repo Mino-is-me/scheherazade-releases --json assets -q '.assets[].name'`
      lists all eight.
- [ ] Each `latest*.yml`'s `version:` matches the tag
      (`--verify-only` re-checks this locally against what you uploaded).
- [ ] Receipt to the owner: version, what changed, the release URL.
- [ ] `release/release-all-<tag>.log` kept with the run.

---

## History

- **0.1.5**: auto-update lands. Until 0.1.4 every fix was hand-delivered
  (build → send file → ask user to reinstall). Users on 0.1.4 or older still
  need one manual install to get onto the update train.
- **0.2.9**: the update feed unified back onto the public repo. Installs from
  0.2.1–0.2.8 (which pointed at the private repo and got 404s) need one manual
  reinstall.
- **0.2.19–0.2.20**: Linux AppImage joins the asset set. 0.2.20's was
  cross-built on the Mac and republished from WSL on 2026-09-07; the pair of
  gates that makes that impossible to repeat — `tools/assert-platform.mjs` and
  `test-packaging`'s NATIVES lane — landed the same day.
- **0.3.0 (design-0023 P2)**: this driver. The old §2's
  `C:/Users/minom/sch-build` path and `npm install` step were already stale
  when they were the runbook; the build rig moved to `C:\Users\magi\sch-build`
  after the 2026-08-28 ACL cutover and the step is `npm ci`.
