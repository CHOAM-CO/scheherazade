<p align="center">
  <img src="assets/hero/chromux-hero.png" alt="chromux - the only browser tool your agent needs" width="900">
</p>

<p align="center">
  <b>The only browser tool your agent needs.</b><br>
  Real Chrome, in your agent's hands - its own private browsers, a headless crawl fleet,<br>
  or the tab you're looking at right now. Every action verified. Every site remembered.
</p>

<p align="center">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen">
  <img alt="dependencies" src="https://img.shields.io/badge/runtime_deps-0-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-black">
</p>

## Try it in one paste

Paste this to any coding agent with shell access:

> Follow install.md in https://github.com/modakbul-gongbang/chromux to install
> chromux, then find the best AirPods Pro price: google it, then check Amazon,
> eBay, Walmart, and Newegg in parallel - one tab each - and report each price.

One real Chrome, five stores priced at once, zero collisions (live values):

```json
{ "google":  "$129 - $249",
  "amazon":  "$169.99",
  "ebay":    "$179.95",
  "walmart": "$199.99",
  "newegg":  "$179.99" }
```

Five tabs that never collide - that parallel isolation across sites is chromux's
core. Prefer to run it yourself? See [Quick Start](#quick-start).

## What it looks like

```bash
git clone https://github.com/modakbul-gongbang/chromux && cd chromux && npm install -g .

# The agent's browser: three agents, one logged-in profile, zero collisions
chromux open inbox    https://mail.example.com &
chromux open research https://news.ycombinator.com &
chromux open docs     https://developer.mozilla.org &
wait

chromux snapshot inbox --interactive    # page structure with @refs, ~36 tokens
chromux click inbox @3                  # act on a ref…
chromux snapshot inbox --diff           # …verify what changed for ~47 tokens

# Your browser: the same commands on the Chrome you are using right now
chromux pair                                          # one-time: the companion Chrome extension pairs itself
CHROMUX_PROFILE=live chromux open helper --tab active # "do this on the page I'm looking at"

# An external view: attach to the local CDP endpoint returned by Herdr connect
chromux open herdr-view --cdp-url http://127.0.0.1:PORT --tab active

# The fleet: point 10 worker tabs at a URL queue
chromux batch --file urls.txt --workers 10 --out results.jsonl

# Freeze a working flow once - every later run replays it with zero model calls
chromux script save mail.example.com/triage --file triage.js
chromux run inbox --script mail.example.com/triage
```

## One CLI, three browsers

### External CDP view attachment

When another local tool owns the browser, attach Chromux to that existing view instead of launching a profile.

```bash
# Herdr returns this endpoint as cdp_http_url from its connect command.
chromux open herdr-view --cdp-url http://127.0.0.1:PORT --tab active
chromux snapshot herdr-view --interactive
chromux click herdr-view @1
chromux fill herdr-view @2 "text"
chromux run herdr-view 'return await js("document.title")'
chromux screenshot herdr-view /tmp/herdr-view.png
chromux close herdr-view
```

`--cdp-url` accepts only plain loopback `http://localhost`, `http://127.0.0.1`, or `http://[::1]` endpoints, with no credentials, query, or fragment.
The external browser and tab remain owned by the caller: `close` detaches, idle cleanup only drops Chromux's CDP connection, and `kill` never terminates the external browser.
Use `--tab active`, a CDP target id, or a URL/title substring when the endpoint exposes multiple page targets.

Browser work for agents comes in three shapes, and until now each shape needed a different tool.
chromux covers the whole spectrum with one zero-dependency CLI, and the commands are identical across all three - only the profile changes.

| Route | The job | How chromux does it |
|---|---|---|
| **The fleet** | Crawl thousands of URLs with disposable identity | `crawl` mode: `batch` worker-tab pools, resource guards, `pause`/`resume` as the wave kill switch |
| **The agent's browser** | Logged-in, persistent, parallel automation | Isolated profiles: real Chrome user-data-dirs, a daemon per profile, N agents in N tabs that never collide |
| **Your browser** | SSO, 2FA, "the page I'm looking at right now" | [`live` mode](#live-mode-your-real-chrome): an extension bridges your real, running Chrome, with safety semantics built in |

Log in once and a profile stays logged in forever - or skip logging in entirely and borrow the session you already have open.
Everything runs anywhere a shell runs: macOS, Linux, native Windows, WSL, servers, and CI.

## Four pillars

Most AI browser tools give your agent **a browser**.
chromux gives it **judgment**: every answer it hands back is a decision the agent would otherwise have to guess - *did that work, am I stuck, can I trust this, have I been here before*.
Four design pillars carry that.

### 1. Coverage - every browser, the whole page

The three routes above are one pillar, not three products: the same `open`/`snapshot`/`click`/`run` verbs drive a headless crawl worker, a logged-in automation profile, and your own live Chrome.
Page reach matches that breadth.
Snapshots pierce open shadow DOM and same-origin iframes; cross-origin OOPIFs attach on demand.
Where the accessibility tree ends, real pixels and pointers begin: canvas targets, `hover`, bounded `drag`, native dialogs, popup adoption, upload, and download.
Nothing on a page is "out of scope for the tool you picked".

### 2. Economics - tokens buy judgment, not scenery

Agents pay for every byte they read back, so observation payload size is a first-class metric with its own benchmark.
Verifying an action costs ~47 tokens (`snapshot --diff`), finding one item on a 200-story page costs ~59 (`snapshot --grep`), and a shaped extraction costs ~27 - roughly constant no matter how large the page grows.
A flow that works gets frozen as a script and replays with **zero model calls**.
Measured head-to-head against @playwright/cli and agent-browser, chromux was the only tool to pass all 35 sessions and had the lowest tokens, wall time, and cost - including the Google bot check both competitors failed ([full tables below](#how-it-compares)).

### 3. Memory - it gets cheaper every run

Most browser tools restart from zero each session.
chromux remembers every site it touches: durable facts land in per-host site notes (`chromux note`), proven flows land in per-host replay scripts (`chromux script`), and both surface automatically in the next `open` response for that host.
Replay stats grade those memories by what still works, so trust compounds and dead flows fade.
The second visit to a site is cheaper than the first, and the tenth can be nearly free.

### 4. Trust - deterministic, local, zero dependencies

chromux has no brain of its own, by design: it is the deterministic hand, and your coding agent is the brain.
No agent loop, no bundled LLM, no per-step token bill, no vendor lock-in, and nothing leaves your machine.
The runtime is one file on Node >= 22 with zero dependencies - no Playwright, no Chromium download.
Every action answers back with what actually changed, extractions can be held to a `--schema` contract so drift fails loudly, receipts redact typed text and secrets, and sensitive fields mask themselves in snapshots.
In live mode the safety semantics are explicit: `close` detaches instead of closing your tab, `kill live` never touches your Chrome process, and the extension popup has a kill switch.

## How it compares

Measured head-to-head (2026-07-13, one fixed model doing identical browser missions with each CLI, each tool introduced by its own official skill; full methodology and tables in [docs/benchmark-2026-07.md](docs/benchmark-2026-07.md)):

| | @playwright/cli 0.1.17 | agent-browser 0.31.1 | chromux 0.18.0 |
|---|---|---|---|
| Browser | Bundled Chromium | Chrome / Chrome for Testing | **Real Chrome, real profiles** |
| Agent task success (20 tasks, 35 sessions) | 97% (34/35) | 94% (33/35) | **100% (35/35)** |
| Agent tokens, whole suite | 5.34M | 5.21M | **4.24M** |
| Agent wall time, whole suite | 26.4min | 20.3min | **18.2min** |
| Agent cost, whole suite | $5.65 | $8.08 | **$4.72** |
| Google under bot check | failed, 439.5s / 19 turns / 451K tokens | failed, 96.2s / 9 turns / 193K tokens | **passed, 27.1s / 8 turns / 137K** |
| Verify one action on a 200-story page | ~28.4K tokens | ~10.9K tokens | **~37 tokens** (`snapshot --diff`) |
| Find one item on that page | ~163 tokens (`find`) | ~10.9K (no find command) | **~59 tokens** (`snapshot --grep`) |
| Warm command latency | slowest (nav p50 883ms) | **fastest (48-95ms)** | 163-218ms |
| Parallel sessions | yes | yes | yes, plus per-profile daemons + `batch` pools |
| Dependencies | playwright + Chromium download | Rust binary via npm | **none (one file, Node ≥ 22)** |
| Logged-in real profiles | no | via `--profile` handoff | **first-class, persistent** |

Honest summary: the current official comparison is one 20-task, three-tool run using the reduced 2/1 repetition profile.
chromux was the only tool to pass all 35 sessions and had the lowest aggregate wall time, turns, tokens, and cost.
All three tools passed every deterministic local and [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) session, while task-level speed remained mixed.
The largest separation was Google: chromux completed the task in real Chrome while both competitor browsers failed to return the expected result.
These head-to-head numbers are from the 0.18.0-era run; 0.19.0 has since added cross-origin OOPIF routing, `drag`/`hover`, and DPR-correct visual pixel clicks (pillar 1 above), and 0.20.0 added live mode, which are not yet reflected in the comparison table.
The historical v1/v2 tables, perception-upgrade loop disclosure, raw task cells, live-site caveats, and a Sonnet 5 cross-model check are in [docs/benchmark-2026-07.md](docs/benchmark-2026-07.md).
The design rationale against the 2026 agent-browser landscape is in `docs/competitive-analysis-2026-07.md`.

## Prerequisites

- **Node.js >= 22** (for built-in `WebSocket`)
- **Google Chrome** installed
- CLI support: macOS, Linux, and native Windows. The native AppKit status bar
  wrapper is macOS-only.

## Agent Skills

To use chromux as agent browser skills, install the CLI and register the two
repo-local skills with Codex, Claude Code, or Hermes:

- [`install.md`](install.md) — CLI install, skill registration, and smoke test
- [`skills/chromux/SKILL.md`](skills/chromux/SKILL.md) — day-to-day chromux CLI usage
- [`skills/chromux-work/SKILL.md`](skills/chromux-work/SKILL.md) — profile selection, recon, parallel browser work, cleanup, and domain notes
- [`AGENTS.md`](AGENTS.md) — repo guidance for coding agents

## Quick Start

### Fastest: let your agent set it up

In Claude Code, Codex, or any agent with shell access:

1. **Install** — paste this to your agent:
   > Follow install.md in https://github.com/modakbul-gongbang/chromux to install
   > chromux and register the `chromux` and `chromux-work` skills.

   install.md handles the clone, `npm install -g .`, skill registration, and a
   smoke test end to end.
2. **Load the skill** — in a fresh session, invoke the `chromux` skill
   (`/chromux` in Claude Code), or just ask for browser work and let it trigger.
3. **First task** — give it a real search to run through a real browser:
   > Using chromux, google "zero-dependency CDP CLI", open the most relevant
   > result, and summarize what the project does.

The agent launches its own isolated Chrome profile, runs the search, snapshots
the results into token-cheap @refs, clicks through, and verifies each step —
the same loop it will use on your actual work.

### By hand: price one product across five sites

Install the CLI, then open one real Chrome and price a product across Google plus
four stores at once:

```bash
git clone https://github.com/modakbul-gongbang/chromux && cd chromux && npm install -g .

chromux launch shop                    # real Chrome window (headed, so stores serve real pages)
CHROMUX_PROFILE=shop chromux open az https://www.amazon.com/   # warm up Amazon (heavy JS) first
CHROMUX_PROFILE=shop chromux wait-for-text az "Amazon" 8000

CHROMUX_PROFILE=shop chromux open g  "https://www.google.com/search?q=airpods+pro+price" &
CHROMUX_PROFILE=shop chromux open az "https://www.amazon.com/s?k=airpods+pro" &
CHROMUX_PROFILE=shop chromux open eb "https://www.ebay.com/sch/i.html?_nkw=airpods+pro" &
CHROMUX_PROFILE=shop chromux open wm "https://www.walmart.com/search?q=airpods+pro" &
CHROMUX_PROFILE=shop chromux open ne "https://www.newegg.com/p/pl?d=airpods+pro" &
wait
CHROMUX_PROFILE=shop chromux list                   # five independent tabs, no collision
CHROMUX_PROFILE=shop chromux snapshot wm --grep '\$' # Walmart prices as token-cheap @refs
chromux kill shop                                   # clean up: stop Chrome + daemon
```

`list` returns five sessions, one per store, each on its results. Amazon is a heavy
JS page, so warming its home and a `wait-for-*` before extracting is the discipline
chromux is built for - a successful `open` is not proof the page is ready. (Fresh
`--headless` profiles can also trip store bot checks; headed real Chrome does not.)
`snapshot wm --grep '\$'` then hands back Walmart's price lines as clickable `@refs`.

### More commands, by hand

```bash
# Launch Chrome with an isolated profile (auto-finds Chrome, auto-assigns port)
chromux launch
chromux launch work

# First taste: a Google search through a real browser
chromux open search "https://www.google.com/search?q=zero+dependency+cdp+cli"
chromux snapshot search --interactive   # results as @refs, ready to click

# Open tabs for two agents
chromux open agent-a https://news.ycombinator.com
chromux open agent-b https://reddit.com/r/programming

# New tabs are background by default so headed Chrome does not steal focus
chromux open agent-c https://example.com

# Label related work for the local activity timeline
CHROMUX_TASK=research-pass chromux open agent-d https://example.com

# Open the local profile/activity companion app
chromux app --open

# Build and install the native macOS app into /Applications (macOS only),
# so Spotlight and Launchpad can find it
./apps/macos-status-bar/install-app.sh

# Each operates independently
chromux snapshot agent-a
chromux click agent-a @3
chromux wait-for-text agent-a "expected text"
chromux run agent-b "return await js('document.title')"
chromux cdp agent-b Runtime.evaluate '{"expression":"location.href","returnByValue":true}'
chromux screenshot agent-a /tmp/hn.png

# Clean up
chromux close agent-a
chromux close agent-b
chromux kill default
```

## Modes

chromux defaults to the compatibility-oriented `default` mode. It preserves the
legacy browser behavior and is the right choice for QA, visual checks, login
flows, and tasks where the page should behave as much like a normal human-driven
Chrome tab as possible.

For crawling, use `crawl` mode:

```bash
CHROMUX_MODE=crawl chromux launch crawl-news --headless
CHROMUX_MODE=crawl CHROMUX_PROFILE=crawl-news chromux open worker-1 https://news.ycombinator.com
CHROMUX_MODE=crawl CHROMUX_PROFILE=crawl-news chromux open worker-1 https://example.com
CHROMUX_MODE=crawl CHROMUX_PROFILE=crawl-news chromux close worker-1
```

For URL batches, use the same crawl mode with `batch`:

```bash
CHROMUX_MODE=crawl CHROMUX_PROFILE=crawl-news \
  chromux batch --file urls.txt --workers 10 --retries 1 --host-backoff-ms 250 --out results.jsonl
```

`batch` reads plain URL lines or JSONL rows with `url`, `source_url`, or `href`,
reuses a worker-tab pool, writes one JSON result per URL, and closes worker
sessions when done.
Each row includes worker/session identity, attempts, duration, final URL/title,
text/html lengths, and a failure kind such as `timeout`, `resource_guard`,
`queue_full`, `session_unresponsive`, `navigation`, `http_or_page`, or
`unknown`.
The summary includes p50/p95 timings, retry count, failure-kind totals, host
backoff settings, and touched host state.

`crawl` mode keeps the public command surface the same, but changes the profile
daemon policy:

- caps expensive profile operations (`CHROMUX_MAX_CONCURRENT_OPS_PER_PROFILE`,
  default `4`)
- caps active sessions (`CHROMUX_MAX_SESSIONS_PER_PROFILE`, default `12`)
- blocks common heavy media, font, and analytics resources
- uses shorter navigation waits (`CHROMUX_NAVIGATION_WAIT_MS`, default `5000`)
- closes idle/stale sessions
- closes CDP-unresponsive sessions so a worker tab can continue with later URLs
- closes initial blank/new-tab targets created during crawl-mode launch
- rejects new work when queue or resource guards are exceeded
- supports `chromux pause` / `chromux resume` as a profile hard-stop
- can optionally recycle long-lived worker tabs after a bounded number of
  navigations
- can optionally compact renderer growth for iframe-heavy crawl pages

For best crawling throughput, use a small worker-tab pool instead of one tab per
URL. For example, process 20 URLs through 3 to 5 stable session names and
repeatedly call `open` on those sessions. Reusing a session navigates the same
tab instead of creating another renderer.

If an orchestrator needs to stop a wave, pause the profile. Existing `close`,
`list`, and `stop` still work, but new browser work is rejected until resumed:

```bash
CHROMUX_PROFILE=crawl-news chromux pause
CHROMUX_PROFILE=crawl-news chromux resume
```

## Profile Management

Each profile is an isolated Chrome instance with its own user-data-dir, logins, cookies, and extensions.

`default` is the profile you should normally use. Parallelism comes from
sessions (isolated tabs inside one profile), not from profiles — a profile is a
real Chrome user-data-dir of a few hundred MB that nothing garbage-collects.
Reach for a second profile only when a task needs separate logins or isolation
from a site you would not point your cookies at.

**chromux never creates a profile on its own.** An unknown `--profile` /
`CHROMUX_PROFILE` name aborts with a hint, or prompts when you are on a
terminal. This keeps an agent from minting a throwaway profile per task and
turns creation into a decision you make:

```bash
chromux --profile work open t https://example.com   # → aborts: profile "work" does not exist
chromux profile new work                            # explicit creation
chromux --profile work --new-profile open t https://example.com   # create inline
CHROMUX_ALLOW_NEW_PROFILE=1 chromux --profile work open t https://...  # for trusted scripts
```

`default` and `live` are always allowed. Profile names must start with a letter
or digit, so a forgotten flag value (`--profile --headless`) is rejected instead
of becoming a profile called `--headless`.

```bash
# Launch named profiles
chromux launch work
chromux launch personal

# See what's running
chromux ps
# PROFILE             PORT    PID       STATUS      TABS
# work                9300    12345     running     3
# personal            9301    12346     running     1

# Machine-readable diagnosis for agents and dashboards
chromux ps --json

# Known profiles with last use and disk usage
chromux profile list

# Find idle profiles worth deleting (dry run; --yes actually deletes)
chromux profile prune
chromux profile prune --days 60 --yes

# Use a specific profile for tab commands
chromux --profile work open my-tab https://...
CHROMUX_PROFILE=personal chromux open other-tab https://...

# Auto-launch headed Chrome, then keep new tabs in the background by default
CHROMUX_LAUNCH_MODE=headed chromux open bg-tab https://...

# Default profile is "default" — used when no --profile specified
chromux open my-tab https://...  # → uses "default" profile (auto-launches if needed)

# Stop a profile
chromux kill work
```

`profile prune` reports each candidate's idle days and disk usage and skips
anything running, `default`, `live`, and profiles holding cookie data (use
`--include-logged-in` to override). It also surfaces directories with names
chromux no longer accepts, which are otherwise invisible to every command.

### Resource lifetime

Browsers used to outlive the work that started them. `open` auto-launches
Chrome, but nothing ever shut it down again, so an unattended machine
accumulated browsers that ran for weeks — one observed instance had been up 42
days with 140 renderers. Telling callers to "always close your sessions" does
not fix this: cleanup is the last step, it is skipped whenever an agent crashes
or is interrupted, and skipping it is invisible.

So chromux cleans up after itself:

- A session nobody has touched for **30 minutes** is closed (`CHROMUX_IDLE_TTL_MS`).
- Once a profile has held **zero sessions for 15 minutes**, the browser chromux
  auto-launched for it is shut down and its daemon exits
  (`CHROMUX_BROWSER_IDLE_SHUTDOWN_MS`).

Only auto-launched browsers are retired. A browser you started yourself with
`chromux launch` stays up until you kill it, and the `live` profile is never
touched — it is your own Chrome. Set either variable to `0` to opt out.

`chromux ps` shows `UPTIME` and `RENDER`, so a browser quietly running for
weeks is visible long before it becomes a problem:

```
PROFILE             PORT    PID       STATUS      DAEMON  TABS  UPTIME    RENDER
default             9301    20382     running     ok      0     8h9m      0
modakbul            9300    10088     running     ok      0     2d15h     0
```

For unattended machines, sweep whatever is left on a timer. This stops every
running profile that no browser command has touched in the given window, and
never touches `live`:

```bash
chromux kill --idle 60
```

Only browser commands count as use, so a monitoring cron that runs `chromux ps`
cannot keep alive the very browsers it is meant to reap.

On macOS, chromux may be invoked from agent runtimes that set `HOME` to a
synthetic profile directory. Chrome's `--user-data-dir` still controls browser
profile isolation, but the Chrome child process is launched with the real macOS
account home so Chrome can initialize its per-user framework services and expose
the DevTools/CDP port reliably.

## Live mode: your real Chrome

There are two ways to reach a browser. Isolated profiles above are the
"agent's browser" — the default. The reserved `live` profile is "your
browser": a Chrome extension bridges your real, logged-in Chrome so an agent
can work alongside you in the session you are already using. Pick `live` when
the task needs your own login (SSO, 2FA, an already-open page); pick a profile
for isolated or parallel work. The CLI is identical for both — only the profile
changes.

```bash
# One-time setup: load the unpacked extension once at chrome://extensions
# (Developer mode → Load unpacked → select extension/), then run:
chromux pair
# This starts the bridge and waits for the extension to attach. There is no
# token: the extension connects automatically whenever both sides are up,
# including after browser or daemon restarts.

# List your Chrome's tabs
chromux tabs

# Work in a new tab in your real Chrome (visible; a debugging bar shows while attached)
CHROMUX_PROFILE=live chromux open work https://example.com

# "Do this on the page I'm looking at" — attach the active tab (or by tab id / URL match)
CHROMUX_PROFILE=live chromux open work --tab active

# Stop the bridge (detaches every tab; your Chrome process stays open)
CHROMUX_PROFILE=live chromux kill live
```

Live mode uses `chrome.debugger`, so it is a CDP subset with deliberate safety
semantics: `close` on a tab you attached detaches it rather than closing your
tab, `kill live` never terminates your Chrome, and `show`, `launch --headless`,
and `chrome://` pages are unsupported (each returns a clear error). While a tab
is attached it sits in a green "chromux" tab group, so the tab strip always
shows which tabs an agent is driving; on detach the tab returns to its previous
group (or no group). Chromium-based browsers without tab-group APIs simply skip
this badge. There is no
pairing token: the bridge binds `127.0.0.1` and trusts local processes (the
same model as Chrome's own remote-debugging port), while every request that
carries a web `Origin` header is rejected so web pages cannot reach the bridge.
The extension popup shows the attached tabs and a kill switch. Distribution is
the unpacked extension shipped in this repo — there is no Web Store listing.

## Commands

chromux intentionally keeps the visible command surface small. When a new browser
operation is needed, express it with `run` or `cdp` before adding another verb.
The convenience commands below are for common human-like verification loops:
snapshot, act on fresh refs, wait for observable state, then snapshot or
screenshot again. A successful `open`, `click`, `fill`, `type`, or `press`
response is not proof that the page reached the intended state.

### Core Commands

| Command | Description |
|---------|-------------|
| `open <session> <url>` | Create or navigate a tab |
| `open --background <session> <url>` | Explicitly create a new tab without activating it |
| `open <session> <url> --oopif` | Opt into cross-origin child-target attachment and namespaced refs for this session |
| `run <session> <code\|--file PATH\|->` | Run multi-step async JS with `cdp`, `js`, `sleep`, `waitLoad`, `page`, `waitFor`, and `assertPage` helpers |
| `run <session> --page-file PATH` | Run a JS file directly in the page context, bypassing all shell/string escaping |
| `run <session> --script <host>/<name>` | Replay a saved action script deterministically (no model calls) |
| `run <session> ... --schema PATH` | Validate the run result against a JSON-schema subset; mismatches fail with per-path errors |
| `run <session> ... --receipt PATH` | Write a redacted local JSON receipt without storing raw inline code or typed text |
| `script [save\|show\|rm] [<host>/<name>]` | List, save, show, or remove per-host replay scripts |
| `batch --file urls.txt --workers N --retries N --host-backoff-ms MS --out results.jsonl` | Crawl URLs through a worker-tab pool with bounded retry and host backoff |
| `cdp <session> <Method> <params-json>` | Send one raw CDP method to a session |
| `note [host] [--add "text"]` | List, show, or append durable site notes surfaced on `open` |

In default mode, `open` responses include an `interactive` element count and a
`next` field pointing at the snapshot command — inspect page structure first
rather than guessing selectors:

```json
{ "session": "s", "url": "…", "title": "…", "interactive": 359,
  "next": "chromux snapshot s --interactive" }
```

When a host has no saved notes or replay scripts yet, or its newest one has
gone stale (older than 30 days), `open` and `close` responses also carry a
`learnNext` field naming the exact `chromux note` / `chromux script save`
commands to run — the write-side nudge that keeps the memory loop filling.
Well-covered, freshly-updated hosts omit it, so it stays quiet where knowledge
already exists.

`run --page-file` is the escape-proof path for page scripts. The file contents
are JSON-encoded end to end, so regexes, quotes, and newlines never meet shell
quoting. Write natural statements and `return` a value:

```bash
cat > extract.js <<'EOF'
const rows = [...document.querySelectorAll('a[href]')]
  .map(a => ({ title: a.innerText.trim().split('\n')[0], url: a.href }))
  .filter(r => r.title.length > 8 && /^https?:/.test(r.url));
return rows.slice(0, 10);
EOF
chromux run s --page-file extract.js
```

`run` scripts execute in an async function context:

```bash
chromux run s - <<'JS'
await cdp('Page.navigate', { url: 'https://example.com' });
await waitLoad();
return await js('document.title');
JS
```

`run` executes in the runner context, not directly inside the page. Use `js(...)`
for page expressions or `page(...)` for common page metadata:

```bash
chromux run s - <<'JS'
return await page('({url:location.href,title:document.title,textLength:document.body.innerText.length})');
JS
```

`js(...)` runs page code in an isolated function scope, so lexical declarations
such as `const input = ...` do not leak into later `js(...)` calls for the same
tab. When `chromux run --timeout MS` is provided, that timeout is also used as
the default CDP timeout for `js(...)`, `cdp(...)`, and `page(...)` helper calls
unless the helper call passes its own timeout.

Use `waitFor(...)` and `assertPage(...)` inside `run` when a flow needs
observable readiness proof without extra CLI round trips:

```bash
chromux run s - <<'JS'
await waitFor('#email', { kind: 'selector', timeoutMs: 5000 });
await js("document.querySelector('#email').value='agent@example.com'");
await assertPage('document.readyState === "complete" || document.readyState === "interactive"');
return await page('({url:location.href,title:document.title})');
JS
```

`waitFor` also accepts an **array of fallback candidates** for selector and
text waits — the first candidate that matches wins and is reported back as
`matched`, so saved scripts can carry several locator strategies and survive a
single site change:

```bash
chromux run s - <<'JS'
const found = await waitFor(['#search', 'input[name="q"]', '[role="searchbox"]'], { kind: 'selector', timeoutMs: 5000 });
await js(`document.querySelector(${JSON.stringify(found.matched)}).value = 'chromux'`);
return found;
JS
```

Use `--receipt` when a browser operation should leave replay/debug evidence:

```bash
chromux run s --receipt /tmp/chromux-run-receipt.json - <<'JS'
const ready = await waitFor('Saved', { kind: 'text', timeoutMs: 5000 });
return { ready, page: await page('({url:location.href,title:document.title})') };
JS
```

Receipts store timing, profile/session/mode, code source, result shape, failure
kind, and redaction metadata.
They do not store raw inline code, raw typed text, cookies, authorization
headers, tokens, or secrets.

`cdp` is a thin passthrough:

```bash
chromux cdp s Runtime.evaluate '{"expression":"navigator.userAgent","returnByValue":true}'
```

### Lifecycle

| Command | Description |
|---------|-------------|
| `launch [name]` | Launch Chrome with isolated profile (default: "default") |
| `launch <name> --port N` | Launch with specific port |
| `ps` | List running profiles |
| `ps --json` | List profiles, daemon state, paused state, and resource telemetry as JSON |
| `app [--port N] [--open]` | Serve the local profile/activity companion app |
| `pause [name]` | Hard-stop new browser work for a profile |
| `resume [name]` | Allow browser work again for a paused profile |
| `kill <name>` | Stop profile (Chrome + daemon) |
| `close <session>` | Close tab |
| `list` | List active sessions in current profile |
| `stop` | Stop daemon while keeping Chrome running |

### Convenience Shortcuts

| Command | Description |
|---------|-------------|
| `snapshot <session>` | Accessibility tree with `@ref` numbers (refs stay stable within a document) |
| `snapshot <session> --interactive` | Only interactive elements (smaller payload) |
| `snapshot <session> --diff` | Only lines added/removed since the previous snapshot of this session |
| `snapshot <session> --grep "pattern"` | Only lines matching a case-insensitive regex (literal fallback), plus their ancestor lines for context |
| `snapshot <session> --clickable` | Force behavior-based clickable detection (`cursor:pointer`/`onclick` divs get `@refs`); auto-enabled on pages with almost no standard interactive elements, or when behaviorally-clickable candidates are dense relative to the standard controls in the viewport (div-heavy SPAs behind a standard nav) |
| `click <session> @<ref>` | Click element by ref. Actions verify by default: the response's `changed` field carries the post-action diff (`--verify MS` tunes the settle wait, `--no-verify` skips; also on `fill`/`type`/`press`; crawl mode skips automatically). A click that opens a popup/new tab adopts it automatically and reports it as `newSession` |
| `click <session> "selector"` | Click by CSS selector |
| `click <session> --text "label"` | Click by visible label when refs went stale after a re-render; ambiguous text fails and lists the candidates |
| `click <session> --xy X Y` | Click validated CSS viewport coordinates via CDP mouse events; add `--space image` for screenshot pixels |
| `hover <session> (@ref\|selector\|--xy X Y) [--space css\|image]` | Move the real pointer and verify the resulting page diff |
| `drag <session> (@ref\|selector\|--xy X Y) (--to @ref\|selector\|--to-xy X Y)` | Drag with bounded movement; `--drag-mode pointer` handles sliders/sortables and `html5` handles native drag/drop |
| `fill <session> @<ref> "text"` | Fill input, textarea, native select, or standards-based contenteditable; contenteditable replacement uses browser input events |
| `fill <session> @<ref> "se" --pick "Seoul"` | Type, wait for the autocomplete popup, and choose the matching suggestion in one call. Only suggestions that appeared after typing count; the response's `picked` is the chosen label and `pickEffect` reports the observed effect (an "unconfirmed" pick needs a follow-up check) |
| `fill <session> @<ref> --file PATH` | Set a file input for upload via `DOM.setFileInputFiles` (repeat `--file` for multiple files) |
| `type <session> "text"` | Insert text into the focused field |
| `press <session> <key>` | Press a supported special key: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown |
| `download <session> (@ref\|selector\|--url URL) [--to DIR]` | Trigger a download and wait for the completed file; returns the saved path |
| `wait-for-text <session> "text" [timeout-ms]` | Wait until page text appears (same-origin frame text included) |
| `wait-for-selector <session> "selector" [timeout-ms]` | Wait until a selector is visible; add `--gone` to wait until it disappears |
| `screenshot <session> [path]` | Take a PNG and return measured CSS viewport, visual viewport, image dimensions, and conversion metadata |
| `screenshot <session> [path] --region X Y W H [--space css\|image]` | Crop a bounded visible region |
| `screenshot <session> [path] --ref @N\|selector` | Crop a reachable visible element |
| `show <session>` | Open DevTools in browser (inspect live tab, even headless) |

Snapshots, clicks, fills, and waits pierce same-origin iframes and open shadow DOM.
Elements inside them get normal `@refs` and are clicked at their true top-viewport coordinates.
By default, a cross-origin frame stays opaque but exposes a stable frame ref, its origin without path or query data, and its CSS viewport rect.
Use that geometry for visible pointer actions.
Reliable DOM or text actions inside a site-isolated OOPIF require reopening the session with `open <session> <url> --oopif`.
The opt-in snapshot adds namespaced child refs such as `@f1g1:2`, and click, fill, text/selector waits, and snapshots route to the child target.
Child navigation, detach, or renderer crash invalidates that namespace, so take a fresh snapshot instead of retrying a stale child ref.
Session diagnostics report `crashedTotal`, and closing an opted-in session returns child-routing and CDP transport cleanup with zero attached frames, pending calls, waiters, and listeners.
The opt-in uses `Target.setAutoAttach`, adds payload and browser attachment surface, and remains off by default.
Closed shadow roots stay invisible.
Native JS dialogs (`alert`/`confirm`/`prompt`) are
auto-handled per session policy (`open <s> <url> --dialog accept|dismiss`,
default dismiss, `beforeunload` always accepted) and reported in the next
action response's `dialog` field, so a stray alert can no longer brick a
session. In `run`, `waitFor` additionally supports `{kind: 'gone'}` (element
disappeared) and `{kind: 'network-idle', idleMs: 500}` (no in-flight page
requests) for deterministic waits without `sleep()`.

Snapshot `@ref` numbers are stable within a document: re-snapshotting the same
page keeps existing refs and only assigns new numbers to new elements, so refs
held by an agent stay valid until navigation replaces the document. Building on
that, `snapshot --diff` prints only the lines added and removed since the
previous snapshot of that session (any action in between), with a one-line
summary of how many unchanged lines were omitted — after several actions on a
large page this is a fraction of a full snapshot. The first `--diff` call, or
one after a navigation, falls back to a full snapshot and says why.

`snapshot --grep "pattern"` answers "where is X on this page" without paying
for the whole tree: it keeps only the lines matching the pattern plus each
match's ancestor lines, so the agent still sees which form or section a match
lives in. On a 200-story feed a targeted grep is typically a few dozen tokens
instead of ~14K.

`click` brings the tab forward before acting. Ref/selector clicks scroll the
target into view and fail when the element is hidden, zero-size, stale, outside
the viewport after scroll, or covered by another element at the click point.
Coordinate actions interpret `X,Y` as CSS viewport units by default and reject points outside the current viewport.
When coordinates came from a screenshot PNG, pass `--space image` and use the response's measured `coordinateSpace.cssToImage` or `imageToCss` mapping.
The top-level `coordinateSpace.image` always describes the returned PNG, so a region or ref crop uses crop-local image coordinates with `[0,0]` at that PNG's top-left corner.
Image-space hover, click, and drag use the session's most recent screenshot mapping; taking another screenshot replaces it, while open, raw CDP, and scroll invalidate it.
Do not derive the mapping from DPR alone because browser zoom, visual viewport scale, and clipping can change the relationship.
`fill` updates ordinary fields through native setters and framework-visible events.
For a standards-based contenteditable root, `fill` selects and replaces its contents through browser input events, while `type` preserves insertion semantics at the current selection.
The command fails if the editor cancels insertion or the observed text does not equal the requested replacement.
Mentions, slash commands, IME composition, and editor-specific nested markup remain conditional and require flow-specific verification.

Canvas and other visual-only surfaces do not gain DOM refs for their internal objects.
Take a full or bounded screenshot, inspect the visible target, then use `hover`, `click`, or pointer `drag` with CSS coordinates or crop-local `--space image` coordinates.
For a range slider, drag the visible thumb rather than using `fill`.
Use `--drag-mode html5` only for a native draggable/drop target; chromux does not report JavaScript synthetic fallback as success.

Known reach limits, stated so agents report instead of blind-retrying:
snapshot value display masks `type=password` inputs plus fields that look
sensitive by autocomplete/name/id heuristics (`cc-number`, `one-time-code`,
card/CVC/SSN/PIN patterns); values in other plain text fields appear as-is.
Cross-origin child DOM is unreachable without explicit `--oopif`, and closed shadow roots remain unreachable.
Default opaque frame output is origin-only and never includes child paths, queries, or field values.
Opted-in namespaced OOPIF snapshots expose child labels and roles, but field values remain redacted and link destinations are reduced to origins.
Clickable auto-detection
evaluates the current viewport — controls far below the fold may need a
scroll (or `--clickable`) before they get refs. Verify diffs skip the
per-element CDP listener re-scan: an element revealed by an action whose only
click affordance is a JS listener (no cursor style, no `onclick`) shows up as
text without a clickable `@ref` — take a snapshot to get its ref.

### Watch / Debug

| Command | Description |
|---------|-------------|
| `watch <session> console` | Capture console logs, enabling capture on first call |
| `watch <session> console --off` | Disable console capture |
| `watch <session> network` | Capture failed requests |
| `watch <session> network --all` | Capture all requests |
| `watch <session> network --off` | Disable network capture |

### Screen Recording

`chromux record` captures a session's tab content as agent/QA evidence — bug
repro, PR verification, regression proof. It requires `ffmpeg` as a system binary
(set `chromePath`-style via `ffmpegPath` in `~/.chromux/config.json` if it is
not on `PATH`); like Chrome, it is never an npm dependency.

| Command | Description |
|---------|-------------|
| `record <session> start [--fps N] [--quality N]` | Start capturing the tab to mp4 |
| `record <session> stop [path] [--discard]` | Finalize to mp4, or cancel with `--discard` |

```bash
chromux record s1 start
chromux click s1 @1
chromux record s1 stop            # -> ~/.chromux/recordings/<profile>/chromux-record-s1-<ts>.mp4
```

- A cursor/click overlay is injected while recording: a dot + ripple track
  click/hover/drag, a border flash marks fill/type/press targets, and
  scroll/wait get no overlay — the finished video shows what was clicked, not
  just what changed.
- The video starts at the first tracked action after `start`, not the `start`
  call itself, so a lead-in before the agent's first real action never
  appears in the output; idle time *between* actions is left untouched.
- A forgotten recording auto-stops: idle-timeout (default 60s,
  `--idle-timeout MS`) fires once no command is in flight on the session, and
  an absolute `--max-duration` cap (default 30min) fires regardless of
  activity.
- If ffmpeg crashes or disk fills mid-recording, `stop` still salvages
  whatever was captured into a valid, playable mp4 rather than discarding it.
- One active recording per session; a second `start` returns a clear
  "already recording" error instead of stacking.
- `~/.chromux/recordings/<profile>/` has no auto-cleanup — recordings are
  larger than screenshots/downloads and can accumulate; clean up manually.

### Compatibility Aliases

The older `eval`, `scroll`, `wait`, `console`, `network`, and `scroll-until`
commands remain available for existing automation and do not print deprecation
warnings. They are intentionally hidden from the main help surface.

`scroll-until` is now documented as runner material in
`snippets/_builtin/scroll-until.js`; copy or adapt that file when a task needs the
pattern.

### Builtin Runner Snippets

The checked-in snippets under `snippets/_builtin/` are reusable `chromux run`
scripts, not public commands.
They cover common fast paths:

- `scroll-until.js`: infinite scroll and result growth loops.
- `page-extract.js`: structured page metadata extraction without full body text
  or HTML dumps.
- `form-flow.js`: whole-form fill (inputs and native selects), submit, and
  readiness proof in one call.
- `table-extract.js`: a table as `{headers, rows}` without dumping HTML.
- `paginate-collect.js`: collect items across paginated pages with per-page
  field extraction.
- `wizard-flow.js`: multi-step wizards with per-step readiness proof.
- `search-and-pick.js`: type → pick suggestion → submit → report.
- `network-errors.js`: browser-observable broken resource diagnostics.
- `page-assert.js`: selector, text, and DOM assertion proof.

Deeper task-type guides load on demand so the per-turn skill text stays small.
`chromux skill` lists topics; `chromux skill forms|extraction|recovery|visual` prints the guide for autocomplete `--pick`, pagination/table extraction, dialog/popup recovery, DPR-safe canvas/frame workflows, and the pause → `open --foreground` → wait → resume human login handoff.

Run them with `--file`, passing parameters as repeatable `--arg key=value`
flags — values that parse as JSON arrive structured, everything else stays a
string, and run code reads them from the `args` object:

```bash
chromux run s --file snippets/_builtin/form-flow.js \
  --arg fields='{"#email":"a@b.c","#country":"US"}' \
  --arg submit='#submit' --arg readyText='Order confirmed'
chromux run s --file snippets/_builtin/page-assert.js --arg selector='#done'
```

### Local Benchmarks

The deterministic benchmark harness starts a local fixture server and exercises
real Chrome through the CLI:

```bash
CHROMUX_HOME="$(mktemp -d /tmp/chromux-bench-XXXXXX)" \
  node benchmarks/chromux-benchmark.mjs --smoke --out /tmp/chromux-benchmark.json
```

It reports cold launch, warm `ps --json`, `open`, `run`, full snapshot,
interactive snapshot, screenshot, click/fill/wait style interaction, and
`batch` p50/p95 timings.
Use it before and after automation changes when performance or scheduler
behavior matters.

### Token Footprint

Agents pay for every byte they read back, so observation payload size is a
first-class metric. The deterministic token benchmark measures the
agent-visible stdout of common observation commands on local fixture pages
(bytes are exact; tokens are estimated as chars/4):

```bash
CHROMUX_HOME="$(mktemp -d /tmp/chromux-tokens-XXXXXX)" \
  node benchmarks/chromux-token-benchmark.mjs --out /tmp/chromux-tokens.json
```

Representative run (real Chrome, deterministic fixtures; the feed page has
200 stories with ~600 interactive elements):

| command | article page | form page | 200-item feed | shop page |
|---|---|---|---|---|
| full page HTML (`run` outerHTML) | ~815 tok | ~347 tok | ~25,108 tok | ~1,731 tok |
| `snapshot` (full) | ~775 tok | ~69 tok | ~14,252 tok | ~818 tok |
| `snapshot --interactive` | ~41 tok | ~40 tok | ~7,153 tok | ~580 tok |
| `snapshot --diff` after one action | ~36 tok | ~39 tok | **~45 tok** | **~45 tok** |
| `snapshot --grep` (find one item) | n/a | n/a | **~59 tok** | **~52 tok** |
| structured extract (`run` + shaped `page(...)`) | ~25 tok | ~27 tok | ~27 tok | ~26 tok |

Browser-reach payload rows measure the JSON/text response only.
The PNG remains a separate visual artifact read by the agent when needed.

| reach surface | response size | budget |
|---|---|---|
| full canvas screenshot metadata | ~245 tok | 300 tok |
| bounded canvas crop metadata | ~323 tok | 400 tok |
| default opaque-frame open / snapshot | ~89 / ~47 tok | 500 / 250 tok |
| `open --oopif` / namespaced snapshot | ~236 / ~161 tok | 650 / 400 tok |
| measured OOPIF attach overhead over default open | ~147 tok | 200 tok |

The screenshot metadata rows include the action-ready mapping for the returned full or cropped PNG.

The workflow the skills teach — inspect structure with `--interactive`, verify
each action with `--diff`, extract with a shaped `page(...)` result (optionally
enforced by `--schema`) — keeps per-step observation payloads roughly constant
even on large pages, instead of re-reading the whole tree every step.

### Cross-Tool Benchmarks

Two checked-in harnesses compare chromux, vercel-labs/agent-browser, and
@playwright/cli under identical conditions (results summarized in
[How it compares](#how-it-compares); full methodology, tables, and fairness
rules in [docs/benchmark-2026-07.md](docs/benchmark-2026-07.md)):

```bash
# Agent-in-the-loop: one fixed model does identical browser missions with each
# CLI; measures wall time, tokens, turns, and machine-graded success.
# Requires an authenticated `claude` CLI. The published reduced profile is
# 105 sessions and measured $18.45 on 2026-07-13.
node benchmarks/agent-compare-benchmark.mjs \
  --reps-local 2 --reps-external 1 \
  --out /tmp/agent-compare.json
node benchmarks/agent-compare-benchmark.mjs --smoke   # cheap harness check

# Focused browser-reach proof against a pinned Apache-2.0 WebGames commit.
# The three non-timed tasks hash-grade exact completion passwords and default to
# a $5 total guard. Visual sessions restrict built-in tools to chromux Bash calls
# and /tmp/chromux-*.png reads, then allow CLI help, screenshots, browser input,
# and lifecycle commands; snapshot, fill, eval, run, cdp, network, and watch are blocked.
node benchmarks/agent-compare-benchmark.mjs \
  --model claude-sonnet-5 --tools chromux \
  --tasks webgames-canvas-target,webgames-drag-drop,webgames-slider \
  --reps-local 1 --out /tmp/chromux-webgames-reach.json

# Deterministic (no LLM): payload bytes + warm latency for equivalent
# observation commands, plus a parallel-session isolation probe.
node benchmarks/compare-benchmark.mjs --out /tmp/compare.json
```

Competitor CLIs are installed at their latest versions into a temp prefix at
run start; nothing is added to chromux's runtime dependencies.

## Architecture

```
~/.chromux/
  config.json                    Global config (optional)
  profiles/
    default/                     Chrome user-data-dir
      .state                     PID, Chrome CDP port, daemonPort cache
    work/
      .state

Chrome instance A (port 9300, ~/.chromux/profiles/default/)
  ↑ CDP WebSocket per tab
chromux daemon (localhost TCP 127.0.0.1:9400)
  ↑ HTTP
CLI / AI agents

Chrome instance B (port 9301, ~/.chromux/profiles/work/)
  ↑ CDP WebSocket per tab
chromux daemon (localhost TCP 127.0.0.1:9401)
  ↑ HTTP
CLI / AI agents

chromux status app (local HTTP)
  ↑ reads profile state, activity logs, and site notes
~/.chromux/activity/events.jsonl
~/.chromux/activity/aggregates.json
```

- **No Playwright/Puppeteer** — raw `WebSocket` + `http` from Node.js stdlib
- **Tab CRUD** via Chrome's `/json/*` HTTP endpoints
- **Page ops** via CDP WebSocket JSON-RPC
- **Daemon per profile** keeps WebSocket connections alive across CLI invocations
- **Localhost TCP daemon transport** binds profile daemons to `127.0.0.1` on
  macOS, Linux, and Windows; `.state.port`/`.state.cdpPort` remain Chrome CDP
  ports, while `.state.daemonPort` is the daemon HTTP endpoint
- **Auto-launch** — `chromux open` auto-launches default profile if needed
- **Profile adoption** — `.state` is a cache, not the source of truth; `chromux ps`,
  `launch`, `open`, and `kill` rediscover live Chrome processes from
  `--user-data-dir` + CDP when daemon endpoint or state files drift or disappear
- **Cold-start coordination** — concurrent first `open` calls for the same profile
  share one startup lock so only one process launches Chrome and the daemon while
  the others wait for the profile daemon endpoint to become healthy.
- **macOS agent-home compatibility** — chromux state follows the invoking
  process `HOME`, while the Chrome child uses the real account home on macOS;
  `--user-data-dir` still keeps the Chrome profile isolated
- **Local activity log** — CLI commands append local JSONL events with profile,
  session, command, result, duration, Task label, and full URL/title when
  available; Chrome History files are not read
- **Companion status app** — `chromux app` serves a zero-dependency local UI for
  profile status, raw events, Task timeline, site-note links, retention,
  deletion, and redaction
- **Windows Chrome discovery** — native Windows CLI runs auto-discover Google
  Chrome Stable from normal Program Files or LocalAppData installations, while
  explicit `chromePath` remains available for custom locations
- **macOS app** — `apps/macos-status-bar` builds a native SwiftUI menu bar
  app (`MenuBarExtra` + a `Window` main window) that starts the local
  status server and manages profiles natively; native app packaging is
  macOS-only
- **macOS release package** — `apps/macos-status-bar/package-release.sh` creates
  a zipped `.app` bundle for GitHub Releases and manual downloads

## Configuration

Optional `~/.chromux/config.json`:

```json
{
  "chromePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "portRangeStart": 9300,
  "portRangeEnd": 9399,
  "daemonPortRangeStart": 9400,
  "daemonPortRangeEnd": 9499
}
```

On Windows, Chrome Stable is auto-discovered from normal Program Files or
LocalAppData install locations. Use `chromePath` only for custom locations, for
example `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`.

## Launch Modes

chromux supports two Chrome launch modes:

- `headless`: no visible Chrome window. This is the default auto-launch mode
  unless `CHROMUX_LAUNCH_MODE` is set.
- `headed`: normal visible Chrome window.

By default, `chromux open` creates new tabs in the background so a visible headed
profile does not come to the front for each new session:

```bash
chromux launch work
CHROMUX_PROFILE=work chromux open tab https://example.com
```

Per-command equivalents are available:

```bash
chromux open --background tab https://example.com
chromux open --no-focus tab https://example.com
chromux open --foreground tab https://example.com
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROMUX_PROFILE` | `default` | Active profile name |
| `CHROMUX_ALLOW_NEW_PROFILE` | `0` | Set to `1` to let commands create an unknown profile without asking (same as `--new-profile`) |
| `CHROMUX_BROWSER_IDLE_SHUTDOWN_MS` | `900000` (15m) | Shut down an auto-launched browser after this long with zero sessions; `0` disables |
| `CHROMUX_MODE` | `default` | Browser policy mode: `default` for compatibility/QA, `crawl` for efficient crawling |
| `CHROMUX_TASK` | empty | Optional Task label written to activity events and used by the status app timeline |
| `CHROMUX_HOME` | `~/.chromux` | Override chromux state root for tests or isolated runs |
| `CHROMUX_LAUNCH_MODE` | `headless` for auto-launch | Auto-launch mode used by tab commands when a profile is not running: `headless` or `headed` |
| `CHROMUX_OPEN_BACKGROUND` | `1` | New tabs are created through `Target.createTarget({ background: true })` by default. Set to `0`, `false`, `no`, or `off`, or pass `open --foreground`, to activate new tabs instead |
| `CHROMUX_MAX_CONCURRENT_OPS_PER_PROFILE` | `4` in crawl, unlimited in default | Maximum expensive daemon operations running at once |
| `CHROMUX_MAX_QUEUED_OPS_PER_PROFILE` | `16` in crawl, unlimited in default | Maximum queued expensive operations before new requests are rejected |
| `CHROMUX_MAX_SESSIONS_PER_PROFILE` | `12` in crawl, unlimited in default | Maximum active sessions before new sessions are rejected |
| `CHROMUX_IDLE_TTL_MS` | `20000` in crawl, `1800000` (30m) in default | Idle session age before the daemon closes the tab; `0` disables |
| `CHROMUX_SESSION_TTL_MS` | `300000` in crawl, disabled in default | Maximum session age before the daemon closes the tab |
| `CHROMUX_NAVIGATION_WAIT_MS` | `5000` in crawl, `30000` in default | Navigation wait budget for `open` |
| `CHROMUX_MAX_CHROME_PROCESSES_PER_PROFILE` | `60` in crawl, disabled in default | Reject new opens when profile Chrome process count reaches this value |
| `CHROMUX_MAX_RENDERERS_PER_PROFILE` | `40` in crawl, disabled in default | Reject new opens when profile renderer count reaches this value |
| `CHROMUX_MAX_RSS_MB_PER_PROFILE` | `12000` in crawl, disabled in default | Reject new opens when profile Chrome RSS reaches this value |
| `CHROMUX_BLOCK_RESOURCES` | `1` in crawl | Set to `0` to disable crawl mode media/font/analytics blocking |
| `CHROMUX_CLOSE_INITIAL_TABS` | `1` in crawl | Set to `0` to keep initial blank/new-tab targets on launch |
| `CHROMUX_MAX_NAVIGATIONS_PER_SESSION` | `0` | Recreate a worker tab after this many `open` navigations; disabled by default because it can raise short-term renderer peaks |
| `CHROMUX_COMPACT_RENDERERS` | `0` | Opt into crawl-only Chrome flags that reduce renderer growth on iframe-heavy pages; keep disabled for broad compatibility |
| `CHROMUX_RENDERER_PROCESS_LIMIT` | `8` in compact mode | Renderer process cap passed to Chrome when compact renderer mode is enabled |
| `CHROMUX_EXTRA_CHROME_ARGS` | empty | Extra Chrome launch args, split like shell words |
| `CHROMUX_CLI_TIMEOUT_MS` | `90000` in crawl, `30000` in default | Default CLI request timeout for commands such as `open` |

## Saved Action Scripts

Scripts close the observe-once, replay-forever loop: when an agent has derived
a working flow for a site (selectors, waits, extraction), it saves the flow as
a plain `run` script under `~/.chromux/scripts/<host>/<name>.js`. Later runs
replay it deterministically with zero model calls:

```bash
cat > top-links.js <<'EOF'
const ready = await waitFor('a[href]', { kind: 'selector', timeoutMs: 5000 });
return await page(`({
  title: document.title,
  links: [...document.querySelectorAll('a[href]')].slice(0, 10)
    .map(a => ({ text: a.innerText.trim(), url: a.href })),
})`);
EOF
chromux script save news.ycombinator.com/top-links --file top-links.js
chromux run s --script news.ycombinator.com/top-links
```

- `open` responses list saved scripts for the page's host (`scripts` and a
  ready-to-run `replay` command), so agents reuse proven flows instead of
  re-deriving them.
- Host matching walks parent domains like site notes: a script saved under
  `naver.com` also surfaces and resolves on `search.naver.com`.
- Record fallback locators inside scripts with `waitFor([...candidates])` —
  the wait resolves to whichever candidate matches (`matched`), so one site
  change does not break the replay.
- When a replay fails, the error names the script path and ends with a repair
  hint — the calling agent snapshots the page, fixes the flow, and
  `chromux script save`s it again. The agent is the self-healing layer; the
  CLI stays deterministic.
- Add `--schema contract.json` to any `run` to enforce an extraction contract.
  The result is validated against a JSON-schema subset (`type`, `required`,
  `properties`, `items`, `enum`, `const`, `pattern`, `min*`/`max*`,
  `additionalProperties: false`); mismatches exit non-zero with per-path
  errors and a result preview, and receipts record `failureKind:
  "schema_mismatch"`.

## Site Knowledge

chromux surfaces durable, non-secret site notes from
`~/.chromux/skills/<host>/*.md` in `open` responses (the `hints` field), and
`close` responses point at the host's note directory via `knowledgeHint`. Host
matching walks up parent domains, so notes saved under `naver.com` also
surface on `search.naver.com` pages.

The `note` command is the write side of that loop:

```bash
chromux note                                  # list hosts with notes
chromux note naver.com                        # show notes (includes parent domains)
chromux note naver.com --add "search results: snapshot --interactive shows result titles as @refs"
```

### Correcting a wrong note

`note --add` only appends. Correcting a wrong claim with it leaves both the
claim and its rebuttal in every later `open` response, and the next agent
believes whichever it reads first — a note asserting "the default profile is
logged in" after that stopped being true is worse than no note, because it
routes the next session into a login wall.

So notes are plain markdown and scripts are plain JavaScript, meant to be
edited in place. Every hint is headed by its real path:

```
# Hint: ~/.chromux/skills/linkedin.com/search.md
```

Open that file and fix or delete the wrong lines. Freshness is tracked per
file, so `learnNext` names the host's **oldest** file and keeps naming it until
that file itself is updated; writing a new note in a sibling file does not
silence it.

When a `close` or `kill` follows recent failed commands on a host that has no
notes yet, chromux prints a one-line reminder pointing at `chromux note` — the
activity log already holds the per-command errors that make such notes worth
writing.

## Secret Store (Opt-in Add-on)

chromux can auto-fill logins from one shared [Bitwarden](https://bitwarden.com)
vault across every profile — an opt-in add-on, the same shape as the planned
recording/ffmpeg integration: it requires an external tool the user installs
and owns, not a bundled dependency. chromux stays zero-dependency; it only
shells out to the user-installed `bw` CLI.

Credentials never live on this machine. They live in Bitwarden as items named
`chromux/<scope>/<host>` (`<scope>` is a profile name or `global`); chromux
itself stores only backend policy in `~/.chromux/secrets.json`, never values.
A profile-local credential overrides the global one for that same host.

The unlocked Bitwarden session key lives only in the memory of a separate
`secret-agent` process (an ssh-agent-style pattern) — nothing is ever written
to disk. The agent serves the session over a local socket (0600) for its TTL
(14 days by default), then evicts itself. A reboot, an explicit
`chromux secret lock`, or the TTL expiring all evaporate the key the same
way: the process simply stops existing.

```bash
# one-time setup
brew install bitwarden-cli   # or your platform's bw install
bw login                     # once, in a real terminal

# per session/reboot
chromux secret unlock         # bw prompts for your master password directly —
                               # chromux never sees or stores it

# register a credential (password + optional TOTP via hidden prompts)
chromux secret set github.com --user tansfil
chromux secret set github.com --user tansfil-work --profile work --totp

# check what is registered (no values ever printed by default)
chromux secret list
chromux secret get github.com

# auto-fill a login form
chromux fill <session> @<ref> --secret github.com:password
chromux fill <session> @<ref> --secret github.com:totp
```

`secret unlock`, `secret set`, and `secret rm` are human-only: without a real
terminal they refuse immediately with an instruction to run them yourself,
the same handoff pattern as any other login wall. Agents can call
`secret status`, `secret list`, `secret get` (values hidden unless run with
`--reveal` in a terminal), and `fill --secret`.

Every failure is a structured, non-crashing handoff instead of an exception:

```json
{ "ok": false, "secret": "locked", "next": "run `chromux secret unlock` in a terminal, then retry" }
```

`secret` reasons are `locked` (vault needs unlocking), `not-found` (no
credential registered for that host), and `unsupported-tier` (TOTP codes
need Bitwarden Premium or a self-hosted Vaultwarden — the free tier stores a
TOTP seed but cannot compute the code).

"Sign in with Google" and other SSO buttons need no stored secret at all:
keep the profile's browser session signed in once and every future SSO click
just works, the same way any human's browser stays signed in. Passkeys are
not automated — they are hardware-bound and `bw` cannot assert them, so
chromux hands a passkey screen off to the user like any other login wall.

## Activity Log And Status App

chromux records local activity events for CLI usage under
`~/.chromux/activity/events.jsonl`. Events include timestamp, profile, session,
command, sanitized command arguments, result, duration, optional `CHROMUX_TASK`,
and the full URL/title/host when the command result exposes page state. Input
text for `fill` and `type`, and inline code for `run` and `eval`, are not stored
as raw arguments.

The default full-URL retention is 90 days. The status app can set retention to
7, 30, 90, 365 days, or unlimited, delete all/profile/Task raw events, and
redact URL/title/host fields while preserving command aggregate counters in
`~/.chromux/activity/aggregates.json`.

Start the app locally:

```bash
chromux app
chromux app --port 9341 --open
```

The app lists known profiles, selected profile state, daemon/session counts when
available, per-profile disk usage (plus the total across profiles), active-first
profile sorting, search/status filters, bulk profile selection/deletion, raw
command events, Task-first timeline groups, fallback session windows, and site
knowledge note paths under `~/.chromux/skills/<host>/*.md`. V1 does not read
Chrome History.

On macOS, use the GitHub Release asset when you want a real menu bar app instead
of a browser tab. The release zip contains `chromux.app`; unzip it, move it to
`/Applications` if desired, and open it from Finder:

```bash
unzip chromux-macos-<version>.zip
open "chromux.app"
```

The release app still requires Node.js >= 22 on the Mac. It does not install or
update the global `chromux` CLI. It runs the bundled `chromux.mjs` and dashboard
with the local `node` binary, looking at `CHROMUX_NODE`, common Homebrew/system
paths, and then `PATH`. If macOS blocks an unsigned download on first launch,
use Control-click > Open or approve it in System Settings > Privacy & Security.

The one-pass setup in `install.md` has agents ask macOS users whether to also
install the menu bar app, then builds it from the checkout (or downloads the
latest release app without the Xcode Command Line Tools), copies it to
`/Applications/chromux.app`, and launches it. If `/Applications` is not
writable, it falls back to `~/Applications/chromux.app`.

From a repo checkout, build and install the same native wrapper into
`/Applications` so Spotlight and Launchpad can find it (requires the Xcode
Command Line Tools):

```bash
./apps/macos-status-bar/install-app.sh
```

For a quick dev loop without installing, build and launch from `dist/`:

```bash
./apps/macos-status-bar/build.sh
open "apps/macos-status-bar/dist/chromux.app"
```

To produce the GitHub Release zip on macOS:

```bash
./apps/macos-status-bar/package-release.sh
ls apps/macos-status-bar/release/
```

The wrapper adds a `cx` item to the macOS status bar, starts the same local
dashboard server, and exposes menu actions for opening the dashboard, opening it
in a browser, restarting the server, toggling Launch at Login, and quitting.
The `cx` menu also refreshes and shows currently active profiles when it opens.

## License

MIT
