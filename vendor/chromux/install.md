---
name: chromux-install
description: Install chromux and register its browser automation skills with Codex, Claude Code, or Hermes.
---

# chromux installation

Use this file only for chromux installation, agent-skill registration, and
browser/profile troubleshooting. For day-to-day CLI usage, read
`skills/chromux/SKILL.md`; for browser task orchestration, read
`skills/chromux-work/SKILL.md`; for current syntax, run `chromux help`.

chromux uses the user's local Google Chrome with isolated profiles under
`~/.chromux/profiles/`. It does not bundle Chromium and does not require
Playwright, Puppeteer, Python, or npm dependencies.

## Agent Install Contract

If you are an AI agent and the user asks you to install chromux from this file,
do the work end to end without asking follow-up questions unless the next step
requires a user-owned action, such as entering a password, installing Google
Chrome, or resolving uncommitted changes in an existing checkout.

One exception on macOS: after the CLI and skills are installed, ask the user
whether to also install the chromux menu bar app to `/Applications` (it adds a
`cx` status item, a Spotlight-findable app, and an optional Launch at Login
item). Install it only if the user says yes; see "macOS App (ask the user
first)" below. Do not silently skip it and do not install it unasked.

The supported CLI install targets are macOS, Linux, and native Windows. The
native status bar app is macOS-only.

## One-Pass Agent Setup (macOS/Linux shell)

Run this from any macOS/Linux shell. It installs or updates chromux from a durable
checkout, registers the Codex, Claude Code, and Hermes skills, adds lightweight
browser-work guidance without duplicating it, and verifies the CLI surface.

```bash
INSTALL_DIR="${CHROMUX_DIR:-$HOME/team-attention/chromux}"
REPO_URL="https://github.com/modakbul-gongbang/chromux"

if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "chromux checkout has uncommitted changes: $INSTALL_DIR" >&2
    git status --short >&2
    exit 2
  fi
  git pull --ff-only
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

npm install -g .
command -v chromux
chromux help

mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/chromux"
[ -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md" ] && rm "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md"
cp "$PWD/skills/chromux/SKILL.md" "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md"
[ -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux/skills" ] && rm "${CODEX_HOME:-$HOME/.codex}/skills/chromux/skills"
ln -sfn "$PWD/snippets" "${CODEX_HOME:-$HOME/.codex}/skills/chromux/snippets"
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work"
[ -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md" ] && rm "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md"
cp "$PWD/skills/chromux-work/SKILL.md" "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md"

mkdir -p "${HERMES_HOME:-$HOME/.hermes}/skills/chromux"
ln -sf "$PWD/skills/chromux/SKILL.md" "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/SKILL.md"
[ -L "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/skills" ] && rm "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/skills"
ln -sfn "$PWD/snippets" "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/snippets"
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/skills/chromux-work"
ln -sf "$PWD/skills/chromux-work/SKILL.md" "${HERMES_HOME:-$HOME/.hermes}/skills/chromux-work/SKILL.md"

mkdir -p "$HOME/.claude/skills/chromux"
ln -sf "$PWD/skills/chromux/SKILL.md" "$HOME/.claude/skills/chromux/SKILL.md"
[ -L "$HOME/.claude/skills/chromux/skills" ] && rm "$HOME/.claude/skills/chromux/skills"
ln -sfn "$PWD/snippets" "$HOME/.claude/skills/chromux/snippets"
mkdir -p "$HOME/.claude/skills/chromux-work"
ln -sf "$PWD/skills/chromux-work/SKILL.md" "$HOME/.claude/skills/chromux-work/SKILL.md"

CHROMUX_GUIDE='
<!-- chromux-browser-guide:start -->
## Browser Work

Use `chromux` for browser work when available.
<!-- chromux-browser-guide:end -->
'

touch "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
if ! grep -Fq '<!-- chromux-browser-guide:start -->' "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" &&
   ! grep -Fq 'Use `chromux` for browser work when available.' "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"; then
  printf '\n%s\n' "$CHROMUX_GUIDE" >> "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
fi

touch "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md"
if ! grep -Fq '<!-- chromux-browser-guide:start -->' "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md" &&
   ! grep -Fq 'Use `chromux` for browser work when available.' "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md"; then
  printf '\n%s\n' "$CHROMUX_GUIDE" >> "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md"
fi

mkdir -p "$HOME/.claude"
touch "$HOME/.claude/CLAUDE.md"
if ! grep -Fq '<!-- chromux-browser-guide:start -->' "$HOME/.claude/CLAUDE.md" &&
   ! grep -Fq 'Use `chromux` for browser work when available.' "$HOME/.claude/CLAUDE.md"; then
  printf '\n%s\n' "$CHROMUX_GUIDE" >> "$HOME/.claude/CLAUDE.md"
fi
```

Then, on macOS, ask about the menu bar app (next section) before running the
smoke test. New Codex, Claude Code, or Hermes sessions should now load the
chromux browser skills automatically.

## macOS App (ask the user first)

On macOS, ask the user whether to also install the chromux menu bar app, for
example: "Install the chromux menu bar app to /Applications so Spotlight can
find it? It shows running profiles and their disk usage from a cx status item."

The install scripts prompt on a terminal and skip themselves in non-interactive
shells, so an agent must collect the user's answer and pass `--yes` explicitly.
If the user says yes, run from the checkout:

```bash
if xcrun --find swift >/dev/null 2>&1; then
  ./apps/macos-status-bar/install-app.sh --yes
else
  ./apps/macos-status-bar/install-release-app.sh --yes
fi
```

If the user says no, skip this step; the CLI and dashboard (`chromux app`) work
without the native app, and the user can install it later with the same
commands.

## Recommended Setup

Clone the repo once into a durable location, then install the CLI globally from
that checkout so `chromux` works from any directory.

```bash
git clone https://github.com/modakbul-gongbang/chromux
cd chromux
npm install -g .
command -v chromux
chromux help
```

### Native Windows PowerShell Setup

Run PowerShell or cmd with Node.js 22 and Google Chrome Stable installed.
PowerShell is the preferred documented flow:

```powershell
git clone https://github.com/modakbul-gongbang/chromux "$HOME\Developer\chromux"
Set-Location "$HOME\Developer\chromux"
npm install -g .
Get-Command chromux
chromux help
chromux launch default --headless
$env:CHROMUX_PROFILE = "default"
chromux open smoke https://example.com
chromux snapshot smoke
chromux kill default
Remove-Item Env:\CHROMUX_PROFILE -ErrorAction SilentlyContinue
```

chromux auto-discovers Google Chrome Stable from normal Program Files and
LocalAppData locations on native Windows. For custom Chrome installs, set
`chromePath` in `%USERPROFILE%\.chromux\config.json`.

The local dashboard works from the CLI on Windows:

```powershell
chromux app --open
```

The native AppKit status bar wrapper and release zip are macOS-only; Windows
does not have a native tray app or installer in this release.

The optional local companion app is served by the same zero-dependency CLI:

```bash
chromux app
chromux app --port 9341 --open
```

It reads local profile state and activity files under `~/.chromux/activity/`.
It sorts active profiles first, shows per-profile disk usage, filters profiles
by name/status, and can bulk-delete selected local profile directories. The
app does not require Electron, Playwright, Puppeteer, Python, an account, or
an external service.

On macOS, install the menu bar app to `/Applications` when you want a
double-clickable app that Spotlight and Launchpad can find. From a repo
checkout with the Xcode Command Line Tools, build and install the current
sources (recommended; the GitHub Release app can lag the repo):

```bash
./apps/macos-status-bar/install-app.sh
```

The from-source installer asks before building, copies `chromux.app` to
`/Applications/chromux.app`, registers it with LaunchServices so Spotlight
indexes it immediately, and launches it.
Pass `--yes` for non-interactive installs and `--no-open` to skip the launch.

Without the Xcode Command Line Tools, install the latest GitHub Release app
instead:

```bash
./apps/macos-status-bar/install-release-app.sh
```

The installer asks before downloading the latest `chromux-macos-<version>.zip`
release asset, copying `chromux.app` to `/Applications/chromux.app`, and
launching it.
If `/Applications` is not writable, it falls back to
`~/Applications/chromux.app`.
For non-interactive installs, pass `--yes`.

The release app requires Node.js >= 22 on the Mac.
It bundles `chromux.mjs` and the dashboard UI, then runs them with the local
`node` binary.
It resolves Node from `CHROMUX_NODE`, common Homebrew/system paths, and then
`PATH`.
It does not install or update the global `chromux` CLI.
Use the checkout install above for terminal and agent usage.
If the download is unsigned and macOS blocks the first launch, use Control-click
> Open or approve it in System Settings > Privacy & Security.

For a quick dev loop without installing, build and launch the wrapper from
`dist/`:

```bash
./apps/macos-status-bar/build.sh
open "apps/macos-status-bar/dist/chromux.app"
```

The wrapper creates a `cx` menu bar item, starts the local `chromux app` server,
opens the dashboard in a WebKit window, and shows currently active profiles in
the `cx` menu when it opens. Its menu includes a "Launch at Login" toggle so
the status item is always present after login.

If you use pnpm globally, this also works:

```bash
pnpm add --global "$PWD"
command -v chromux
chromux help
```

Prefer a stable path such as `~/Developer/chromux` or
`~/team-attention/chromux`, not `/tmp`. Installing from a durable checkout keeps
the CLI, `skills/`, `install.md`, and `snippets/_builtin/` in one place.

## Register The Agent Skills

After the CLI works, register this repo's two skills with the agent runtime:

- `chromux`: direct CLI usage
- `chromux-work`: profile selection, recon, parallel work, cleanup, and domain notes

### Codex

Add both files as global skills under `$CODEX_HOME/skills/`, usually
`~/.codex/skills/`. For Codex, copy `SKILL.md` as a real file instead of
symlinking it; current Codex skill loading may omit symlinked `SKILL.md` files
from the model-visible Available skills list. Also add a lightweight
browser-work instruction to `~/.codex/AGENTS.md`; do not import the skill files
there.

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/chromux"
[ -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md" ] && rm "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md"
cp "$PWD/skills/chromux/SKILL.md" "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md"
[ -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux/skills" ] && rm "${CODEX_HOME:-$HOME/.codex}/skills/chromux/skills"
ln -sfn "$PWD/snippets" "${CODEX_HOME:-$HOME/.codex}/skills/chromux/snippets"
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work"
[ -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md" ] && rm "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md"
cp "$PWD/skills/chromux-work/SKILL.md" "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md"
CHROMUX_GUIDE='
<!-- chromux-browser-guide:start -->
## Browser Work

Use `chromux` for browser work when available.
<!-- chromux-browser-guide:end -->
'
touch "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
if ! grep -Fq '<!-- chromux-browser-guide:start -->' "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" &&
   ! grep -Fq 'Use `chromux` for browser work when available.' "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"; then
  printf '\n%s\n' "$CHROMUX_GUIDE" >> "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
fi
```

### Hermes

Add both files as Hermes skills under `$HERMES_HOME/skills/`, usually
`~/.hermes/skills/`. Hermes discovers installed skills from `~/.hermes/skills/`
and exposes them as `/chromux` and `/chromux-work` in new sessions. Also add a
lightweight browser-work instruction to `~/.hermes/AGENTS.md`.

```bash
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/skills/chromux"
ln -sf "$PWD/skills/chromux/SKILL.md" "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/SKILL.md"
[ -L "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/skills" ] && rm "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/skills"
ln -sfn "$PWD/snippets" "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/snippets"
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/skills/chromux-work"
ln -sf "$PWD/skills/chromux-work/SKILL.md" "${HERMES_HOME:-$HOME/.hermes}/skills/chromux-work/SKILL.md"
CHROMUX_GUIDE='
<!-- chromux-browser-guide:start -->
## Browser Work

Use `chromux` for browser work when available.
<!-- chromux-browser-guide:end -->
'
touch "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md"
if ! grep -Fq '<!-- chromux-browser-guide:start -->' "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md" &&
   ! grep -Fq 'Use `chromux` for browser work when available.' "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md"; then
  printf '\n%s\n' "$CHROMUX_GUIDE" >> "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md"
fi
```

### Claude Code

Add both files as Claude Code skills under `~/.claude/skills/`. Also add a
lightweight browser-work instruction to `~/.claude/CLAUDE.md`; do not import
the skill files there. Use the absolute path for your checkout:

```bash
mkdir -p "$HOME/.claude/skills/chromux"
ln -sf "$PWD/skills/chromux/SKILL.md" "$HOME/.claude/skills/chromux/SKILL.md"
[ -L "$HOME/.claude/skills/chromux/skills" ] && rm "$HOME/.claude/skills/chromux/skills"
ln -sfn "$PWD/snippets" "$HOME/.claude/skills/chromux/snippets"
mkdir -p "$HOME/.claude/skills/chromux-work"
ln -sf "$PWD/skills/chromux-work/SKILL.md" "$HOME/.claude/skills/chromux-work/SKILL.md"
CHROMUX_GUIDE='
<!-- chromux-browser-guide:start -->
## Browser Work

Use `chromux` for browser work when available.
<!-- chromux-browser-guide:end -->
'
mkdir -p "$HOME/.claude"
touch "$HOME/.claude/CLAUDE.md"
if ! grep -Fq '<!-- chromux-browser-guide:start -->' "$HOME/.claude/CLAUDE.md" &&
   ! grep -Fq 'Use `chromux` for browser work when available.' "$HOME/.claude/CLAUDE.md"; then
  printf '\n%s\n' "$CHROMUX_GUIDE" >> "$HOME/.claude/CLAUDE.md"
fi
```

If the file already has the chromux browser-work guide block, do not add a
duplicate block.

## First Smoke Test

Run a short local smoke before using chromux in a task:

```bash
chromux launch chromux-smoke --headless
CHROMUX_PROFILE=chromux-smoke chromux open smoke https://example.com
CHROMUX_PROFILE=chromux-smoke chromux wait-for-text smoke "Example Domain" 5000
CHROMUX_PROFILE=chromux-smoke chromux run smoke "return await js('document.title')"
CHROMUX_PROFILE=chromux-smoke chromux run smoke "return await page('({title:document.title,url:location.href})')"
CHROMUX_PROFILE=chromux-smoke chromux run smoke --receipt /tmp/chromux-smoke-receipt.json "return {page: await page('({title:document.title,url:location.href})'), secretToken: 'redacted'}"
CHROMUX_PROFILE=chromux-smoke chromux cdp smoke Runtime.evaluate '{"expression":"location.href","returnByValue":true}'
CHROMUX_TASK=smoke CHROMUX_PROFILE=chromux-smoke chromux snapshot smoke
CHROMUX_PROFILE=chromux-smoke chromux close smoke
chromux kill chromux-smoke
```

Expected result: `wait-for-text` reports `Example Domain`, the `run` command
prints `Example Domain`, the `cdp` command returns a `Runtime.evaluate` result
containing `https://example.com/`, the `CHROMUX_TASK=smoke` snapshot creates a
local activity event with that Task label, `/tmp/chromux-smoke-receipt.json`
exists without raw inline code or secrets, and the profile is killed at the end.

## Live Mode Setup (optional: your real Chrome)

Isolated profiles are the default. To let an agent work in your own logged-in
Chrome, install the bundled unpacked extension once:

1. In your real Chrome, open `chrome://extensions`, enable "Developer mode",
   click "Load unpacked", and select the `extension/` folder in the repo
   checkout (next to `chromux.mjs`).
2. Run `chromux pair`. It starts the live bridge and waits for the extension
   to attach. There is no token: the extension connects automatically whenever
   both sides are up, including after browser or daemon restarts. The popup
   should show "Connected" within a few seconds.

```bash
chromux pair
```

After setup, drive live mode with the reserved `live` profile:

```bash
chromux tabs                                   # list your Chrome's tabs
CHROMUX_PROFILE=live chromux open work https://example.com
CHROMUX_PROFILE=live chromux open work --tab active   # attach the tab you're on
CHROMUX_PROFILE=live chromux kill live         # detach all; your Chrome stays open
```

The bridge binds `127.0.0.1` and trusts local processes (the same model as
Chrome's own remote-debugging port); requests carrying a web `Origin` header
are rejected so web pages cannot reach it. The extension popup has a kill
switch that blocks the bridge until re-enabled. While a tab is attached it
sits in a green "chromux" tab group so you can see which tabs an agent is
driving; on detach it returns to its previous group. Browsers without
tab-group APIs skip this badge. Live mode uses
`chrome.debugger`, so `show`, `launch --headless`, and `chrome://` pages are
unsupported. Distribution is the unpacked extension in this repo; there is no
Web Store listing. If your live browser is not Google Chrome (e.g. a
Chromium-based browser like Dia or Brave), set `"liveLaunchCmd"` in
`$CHROMUX_HOME/config.json` (e.g. `"open -a Dia"`), or the
`CHROMUX_LIVE_LAUNCH_CMD` env var for a one-off override, so cold starts
launch the right browser.

## Secret Store Setup (optional: Bitwarden add-on)

An opt-in add-on that lets an agent auto-fill logins from one shared
[Bitwarden](https://bitwarden.com) vault across every chromux profile.
Nothing here is bundled or auto-installed — like live mode, it is off by
default until you set it up:

1. Install the Bitwarden CLI, e.g. `brew install bitwarden-cli` on macOS, or
   the equivalent for your platform.
2. Run `bw login` once (email + master password, plus 2FA if you use it).
3. Run `chromux secret unlock` once per session/reboot. `bw` itself prompts
   for your master password directly in that terminal — chromux never reads
   or stores it, only the resulting session key, and only in the memory of a
   separate `secret-agent` process (never on disk).

```bash
chromux secret set github.com --user tansfil     # registers a credential
chromux secret list                              # see what is registered (no values)
chromux fill <session> @<ref> --secret github.com:password
```

`secret unlock`, `secret set`, and `secret rm` require a real terminal by
design and refuse immediately with an instruction if run without one — the
same human-handoff pattern as any other login wall. TOTP codes
(`--secret <host>:totp`) need Bitwarden Premium or a self-hosted Vaultwarden;
on the free tier a TOTP-gated fill returns a structured `unsupported-tier`
handoff instead of a code. "Sign in with Google" and other SSO buttons need
no stored secret at all — keep the profile's browser session signed in once
and every future SSO click just works. Passkeys are not automated (they are
hardware-bound; `bw` cannot assert them), so a passkey screen hands off to
you like any other login wall.

On Windows, the secret-agent's local-socket transport (a named pipe instead
of a Unix socket) is code-complete but has not been smoke-tested on an
actual Windows machine yet — if you hit an issue there, please report it.

## Builtin Helper Material

Repo-local helper examples live under `snippets/_builtin/`. They are documentation
and runner material, not files that chromux automatically copies into
`~/.chromux`.

For example:

```bash
chromux run <session> --file snippets/_builtin/scroll-until.js
chromux run <session> --file snippets/_builtin/page-extract.js
chromux run <session> --file snippets/_builtin/form-flow.js
chromux run <session> --file snippets/_builtin/network-errors.js
chromux run <session> --file snippets/_builtin/page-assert.js
```

Do not overwrite user or agent edited files under `~/.chromux/skills/` during
installation. Host-specific skills in `~/.chromux/skills/<host>/` are local
knowledge and should be preserved.

## Keeping chromux Current

For an editable checkout:

```bash
cd /path/to/chromux
git pull --ff-only
npm install -g .
chromux help
```

The global `chromux` command runs the package copy installed by npm or pnpm; it
does not automatically follow local edits in the checkout until you reinstall
from that checkout.

If a running daemon appears stale after an update, stop the profile and retry:

```bash
chromux ps
chromux kill <profile>
```

If the checkout has uncommitted changes, do not overwrite them. Report the dirty
files and let the user decide whether to keep, commit, or discard them.

## Publishing

Repository CI at `.github/workflows/ci.yml` runs on pull requests, pushes, and
manual runs. It validates `node --check`, `chromux help`, skill files, built-in
snippets, `npm pack --dry-run`, the real headless Chrome `./test.sh` suite on
Linux, and a native Windows PowerShell Chrome smoke covering launch, open,
snapshot, list, ps, kill, and `chromux app --open`.

Automatic npm publishing is disabled, and `.github/workflows/npm-publish.yml` does not exist.
Merging or pushing to `main` runs validation through CI but does not publish the package.
The npm registry package is updated only through an explicit, user-requested manual release from a maintained checkout.

The macOS app release workflow at
`.github/workflows/release-macos-status-app.yml` runs on `v*` tags and manual
dispatch.
It builds `chromux.app`, uploads a workflow artifact, and attaches
`chromux-macos-<version>.zip` plus its SHA-256 file to the GitHub Release for
tag runs.

Do not publish manually from a local machine unless the user explicitly asks for
a local/manual package release.

To package the macOS app locally from a macOS checkout:

```bash
./apps/macos-status-bar/package-release.sh
ls apps/macos-status-bar/release/
```

For a publishable fix:

```bash
node chromux.mjs help
./test.sh
npm pack --dry-run
git status --short
```

For an intended package release, bump `package.json`, commit the change on a review branch, and open a pull request.
Merging the pull request still does not publish automatically.
Do not run `npm publish` unless the user explicitly requests the package release.

## Troubleshooting

### `chromux` is not found

Check that the global install location is on `PATH`:

```bash
command -v chromux
npm prefix -g
```

Then reinstall from the repo checkout with `npm install -g .` or
`pnpm add --global "$PWD"`.

### Chrome is not found

Install Google Chrome Stable. chromux searches common macOS/Linux Chrome and
Chromium paths, plus native Windows Google Chrome Stable locations under
Program Files and LocalAppData. If Chrome is installed somewhere else, set
`chromePath` in `~/.chromux/config.json` on macOS/Linux or
`%USERPROFILE%\.chromux\config.json` on Windows.

### `chromux record` says ffmpeg is not found

`chromux record` needs `ffmpeg` as a system binary (never an npm dependency),
the same way chromux needs Chrome itself. Install it:

```bash
brew install ffmpeg          # macOS
apt install ffmpeg           # Debian/Ubuntu
winget install ffmpeg        # Windows
```

If it is installed somewhere not on `PATH`, set `ffmpegPath` in
`~/.chromux/config.json`, following the same pattern as `chromePath` above.

### Chrome starts but CDP/DevTools never opens on macOS

If `chromux open` hangs or `http://127.0.0.1:<port>/json/version` refuses a
connection even though the Chrome process is alive, check whether the agent
runtime is using a synthetic `HOME` such as a Hermes profile home. chromux 0.7.4+
keeps chromux state under the invoking process `HOME` but launches the Chrome
child with the real macOS account home from `os.userInfo().homedir`; the
explicit `--user-data-dir` still provides Chrome profile isolation. Older
chromux versions may need to be updated before CDP becomes reachable in that
environment.

### Profile is locked or stale

List active profiles, then kill the specific profile:

```bash
chromux ps
chromux kill <profile>
```

chromux stores isolated profile state under `~/.chromux/profiles/<profile>/`.
The `.state` file keeps Chrome CDP `port`/`cdpPort` separate from daemon HTTP
`daemonPort`; profile startup locks live under `~/.chromux/run/`.
`chromux kill <profile>` also removes stale Chrome singleton lock files after it
has confirmed that no Chrome process is still using that isolated profile. The
cleanup can include Chrome's profile version marker when Chrome left it behind.

### Switch between default and crawl mode

`CHROMUX_MODE` is a daemon policy for a profile. Use `default` for QA/login/visual
work, and `crawl` for efficient read-only collection:

```bash
CHROMUX_MODE=crawl CHROMUX_PROFILE=work chromux open worker-1 https://example.com
```

If a profile daemon is already running in another mode, stop the daemon or kill
the profile before switching:

```bash
CHROMUX_PROFILE=work chromux stop
CHROMUX_MODE=crawl CHROMUX_PROFILE=work chromux open worker-1 https://example.com
```

For crawl throughput, reuse a small worker-tab pool instead of creating one tab
per URL. Tune limits with `CHROMUX_MAX_CONCURRENT_OPS_PER_PROFILE`,
`CHROMUX_MAX_QUEUED_OPS_PER_PROFILE`, `CHROMUX_MAX_SESSIONS_PER_PROFILE`,
`CHROMUX_IDLE_TTL_MS`, `CHROMUX_NAVIGATION_WAIT_MS`,
`CHROMUX_MAX_RENDERERS_PER_PROFILE`, `CHROMUX_MAX_CHROME_PROCESSES_PER_PROFILE`,
and `CHROMUX_MAX_RSS_MB_PER_PROFILE`.

For URL-only queues, prefer the built-in worker pool:

```bash
CHROMUX_MODE=crawl CHROMUX_PROFILE=work chromux batch --file urls.txt --workers 10 --retries 1 --host-backoff-ms 250 --out results.jsonl
```

`batch` output includes attempts, p50/p95 timings, retry count, host backoff
metadata, and failure kinds such as `timeout`, `resource_guard`, `queue_full`,
`session_unresponsive`, `navigation`, `http_or_page`, or `unknown`.

When performance or scheduler behavior is under review, run the deterministic
local benchmark:

```bash
CHROMUX_HOME="$(mktemp -d /tmp/chromux-bench-XXXXXX)" \
  node benchmarks/chromux-benchmark.mjs --smoke --out /tmp/chromux-benchmark.json
```

To stop a crawl wave without killing Chrome, pause the profile. New browser
work is rejected until resumed, while `list`, `close`, and `stop` still work:

```bash
CHROMUX_PROFILE=work chromux pause
CHROMUX_PROFILE=work chromux resume
```

### A site asks for login

Use a named profile and log in manually once:

```bash
chromux launch work
CHROMUX_PROFILE=work chromux open login https://example.com
chromux show login
```

After the user logs in, close the tab but keep or reuse the profile for later
automation.

If you want an agent to pass logins like this automatically going forward,
set up the [Secret Store](#secret-store-setup-optional-bitwarden-add-on)
add-on instead of logging in by hand every time.

### Verify the installed skills

Codex:

```bash
ls -l "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md"
test ! -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux/SKILL.md"
ls -l "${CODEX_HOME:-$HOME/.codex}/skills/chromux/snippets/_builtin"
ls -l "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md"
test ! -L "${CODEX_HOME:-$HOME/.codex}/skills/chromux-work/SKILL.md"
grep -n 'Use `chromux` for browser work when available.' "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
```

Hermes:

```bash
ls -l "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/SKILL.md"
ls -l "${HERMES_HOME:-$HOME/.hermes}/skills/chromux/snippets/_builtin"
ls -l "${HERMES_HOME:-$HOME/.hermes}/skills/chromux-work/SKILL.md"
grep -n 'Use `chromux` for browser work when available.' "${HERMES_HOME:-$HOME/.hermes}/AGENTS.md"
hermes skills list | grep chromux
```

Claude Code:

```bash
ls -l "$HOME/.claude/skills/chromux/SKILL.md"
ls -l "$HOME/.claude/skills/chromux/snippets/_builtin"
ls -l "$HOME/.claude/skills/chromux-work/SKILL.md"
grep -n 'Use `chromux` for browser work when available.' "$HOME/.claude/CLAUDE.md"
```

New agent sessions should now have chromux browser instructions and workflow
orchestration available
without copying command catalogs into every project.
