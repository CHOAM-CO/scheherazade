---
name: chromux
description: Real Chrome browser automation through the chromux CLI. Use when an agent needs to open, inspect, interact with, scrape, test, or verify web pages using isolated Chrome profiles and raw CDP.
version: 0.1.0
platforms: [macos, linux, windows]
metadata:
  hermes:
    tags: [browser, chrome, cdp, automation]
    category: browser
---

# chromux

Direct control of a real Chrome profile through the `chromux` CLI: tab work,
multi-step JavaScript, raw CDP, screenshots, diagnostics. One daemon per
profile; sessions are isolated tabs. Requires Node.js >= 22 and Chrome Stable
(macOS, Linux, native Windows). `chromux help` is the source of truth for
syntax. Setup problems: read the repo's `install.md`. Multi-step orchestration
(profile choice, parallel subagents, cleanup): use the `chromux-work` skill.

## First Rule

Resolve the chromux command once, then inline the resolved command and a unique
session ID (e.g. `exp-ab12`) literally in every shell call — shell variables do
not persist across agent tool calls.

```bash
command -v chromux || echo MISSING   # if missing, read install.md
```

## Pick The Shape Of The Task First

Most tasks are one of these four shapes. Choosing the right one saves most of
the turns and tokens:

**Fill and submit a form — one call.** Do not fill field-by-field. `open`
inlines small pages' interactive elements with `@refs`; feed those refs (or
CSS selectors) straight into the builtin snippet. It fills inputs and native
selects, submits, waits for `readyText`, and returns the confirmation text —
open + one run is the whole flow:

```bash
chromux open exp-ab12 <url>   # elements: @1 textbox "Name" / @2 combobox "Plan" / @3 button
chromux run exp-ab12 --file snippets/_builtin/form-flow.js \
  --arg fields='{"@1":"Jane Doe","@2":"Team"}' --arg submit='@3' \
  --arg readyText='Thanks'   # success text you expect on this page;
                             # if unknown, use --arg readySelector='.toast'
# result includes report: the text of the element containing readyText
```

**Find something on a big page — grep, don't dump.**
`chromux snapshot <s> --grep "pattern"` returns only matching lines (plus their
ancestors for context) instead of the whole tree. The pattern is tried as a
case-insensitive regex, then literally if the regex matches nothing; when the
literal reading would match lines the regex result misses, the header says so
(NOTE) — escape metacharacters if you meant the literal string. Grep for
the label, value, or row you need; take a full `snapshot` only when you truly
need the whole structure.

**Count or aggregate over many elements — one `run`, one JSON.** Compute every
part of a multi-part question in a single `run` call that returns one object —
two questions is not two runs, and sanity checks belong inside the same call:

```bash
chromux run exp-ab12 - <<'JS'
return await js(`(() => {
  const ratings = [...document.querySelectorAll('[data-rating]')].map(el => Number(el.dataset.rating));
  return { total: ratings.length, highRated: ratings.filter(r => r >= 4.5).length, max: Math.max(...ratings) };
})()`);
JS
```

**A known multi-step sequence — one `run` script.** `run` executes async JS
with `cdp`, `js`, `sleep`, `waitLoad`, `page(expr?)`, `waitFor(...)`,
`assertPage(...)`, and `args` helpers, so navigate→wait→read loops collapse
into one command:

```bash
chromux run exp-ab12 - <<'JS'
const out = [];
for (const path of ['/pricing', '/changelog']) {
  await cdp('Page.navigate', { url: new URL(path, await js('location.href')).href });
  await waitLoad();
  out.push(await page('({url:location.href,title:document.title,h1:document.querySelector("h1")?.textContent})'));
}
return out;
JS
```

**Actions verify themselves.** `click`/`fill`/`type`/`press` responses carry a
`changed` field: the post-action diff (new elements, confirmations, revealed
text). Read it instead of taking another snapshot — it is the proof of what
the action did. `--verify MS` tunes the settle wait (default 300ms; raise it
for slow UIs), `--no-verify` skips it. For manual checks,
`snapshot <s> --diff` prints only lines added/removed since your previous
snapshot. Navigation resets refs; in-page changes keep them stable.

## Core Workflow

### External CDP view

To control a browser view owned by another local tool, attach it in place:

```bash
chromux open herdr-view --cdp-url http://127.0.0.1:PORT --tab active
```

The endpoint returned as `cdp_http_url` by Herdr's `connect --view <view_id>` command is the expected input.
Then use the normal `snapshot`, `click`, `fill`, `run`, and `screenshot` commands with `herdr-view`.
The endpoint must be loopback-only (`localhost`, `127.0.0.1`, or `::1`) and plain `http` without credentials, query, or fragment.
`close` detaches only - it never closes that external tab, and Chromux cleanup or `kill` never terminates the externally owned browser.
If more than one page is exposed, choose `--tab active`, a target id, or a URL/title substring.

1. `chromux open exp-ab12 <url>` — response includes an `interactive` count,
   and small pages inline their interactive elements (with `@ref` handles) in
   an `elements` field: when present, act on those refs directly instead of
   taking a separate snapshot. Otherwise follow the `next` snapshot command
   before guessing selectors.
2. `chromux snapshot exp-ab12` — accessibility tree with stable `@ref` handles.
   `--interactive` returns only actionable elements; `--grep` filters by
   pattern. Lines show live state: input values, selected option, `[checkbox
   checked]`, `(disabled)`. Snapshots pierce same-origin iframes and open
   shadow DOM. Cross-origin frames expose a redacted origin-only opaque ref
   and CSS rect. Re-open with `--oopif` only when child DOM/ref access is
   required; its refs are namespaced (for example `@f1g1:2`). Pages built from
   bare clickable `div`s are detected and marked `clickable` with `@refs`;
   the automatic trigger fires on nearly-dead pages and on SPAs whose
   viewport mixes a standard nav with div-based controls. If a snapshot still
   looks emptier than the page (e.g. controls far below the fold), pass
   `--clickable` explicitly. Note: value masking covers `type=password` and
   fields that look sensitive by autocomplete/name/id (card numbers, CVCs,
   one-time codes, SSNs); values in other plain text fields appear as-is.
3. Act by ref: `click exp-ab12 @<N>`, `fill exp-ab12 @<N> "text"`,
   `type exp-ab12 "text"` (focused field), `press exp-ab12 Enter` (also Tab,
   Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown — arrows
   drive dropdowns). Refs inside same-origin iframes and open shadow DOM work
   like any other ref. `fill` on a native `<select>` matches an option by
   value or label and fires `change`; never `type` into a select. Custom
   dropdowns (divs styled as comboboxes) are not `<select>` — use `click` +
   arrow keys. Autocomplete: `fill exp-ab12 @<N> "seo" --pick "Seoul"` types
   and chooses the matching suggestion in one call; the response's `picked`
   is the chosen label and `pickEffect` says what was observed (treat
   "unconfirmed" as needing a check, not success). Stale refs after a SPA
   re-render: `click exp-ab12 --text "로그인"` targets by visible label
   (ambiguity fails with a candidate list). File inputs:
   `fill exp-ab12 @<N> --file /path/report.pdf`. Downloads:
   `download exp-ab12 @<N> --to DIR` waits for the completed file and
   returns its path.
   On a standards-based contenteditable root, `fill` replaces all text through browser input events and returns observed text; `type` inserts at the current selection.
   Mentions, slash commands, IME composition, and editor-specific nested markup need flow-specific verification.
   Geometry workflows use `hover exp-ab12 --xy X Y`,
   `click exp-ab12 --xy X Y`, and
   `drag exp-ab12 --xy X1 Y1 --to-xy X2 Y2 --drag-mode pointer`.
   Coordinates are CSS viewport units by default. Add `--space image` when
   values come from the screenshot PNG; the response's measured
   `coordinateSpace` handles DPR and visual viewport scale. Its top-level
   `image` describes the returned full screenshot or crop, and image-space
   actions use that session's most recent screenshot mapping.
4. Verify: read the `changed` diff in the action's own response; for slower
   UIs use `--verify 1000`, or `wait-for-text exp-ab12 "Saved"` /
   `wait-for-selector exp-ab12 ".toast"` for readiness
   (`wait-for-selector ... --gone` waits for disappearance; in `run`,
   `waitFor(null, {kind: 'network-idle'})` waits out XHR bursts). If a click
   opened a new tab, the response's `newSession` names the adopted session —
   continue there. If a JS dialog fired, the response's `dialog` field says
   what it asked and how it was auto-handled (`open ... --dialog accept` to
   change the policy).
5. `chromux close exp-ab12` when done — batch it with your last command
   (`chromux run … && chromux close exp-ab12`) so cleanup does not cost an
   extra round-trip. Batch any commands that don't need each other's output.

A successful `open` means navigation happened, not task readiness; a successful
action response means the action was dispatched, not accepted. Always verify
with `--diff`, a wait, or a `run` assertion before reporting success.

## run Details

- `run <s> --file F --arg k=v` passes parameters to run code as `args.k`
  (repeatable; JSON values like `--arg fields='{...}'` arrive parsed). All
  builtin snippets accept `--arg` overrides.
- For page code longer than a one-liner, prefer `--page-file F` — file contents
  reach the page with no shell escaping, so quotes/regexes/newlines survive.
- `js(...)` runs page code in an isolated function scope (lexical declarations
  don't leak between calls). `run` executes in the runner context, not the
  page; `run` has no Node `import`/`require`.
- `waitFor` accepts an array of fallback selector/text candidates — first match
  wins, returned as `matched`.
- Add `--schema contract.json` when extracting structured data — the result is
  validated against a JSON-schema subset with per-path errors.
- Add `--receipt PATH` for a redacted local timing/evidence receipt (no raw
  code, typed text, cookies, or secrets).
- `--timeout MS` applies to the run and becomes the default CDP timeout for
  helper calls.

Once a flow works, save it: `chromux script save <host>/<name> --file f.js`,
replay with `run <s> --script <host>/<name>` — zero model calls. `open`
responses list saved scripts for the page's host; a failed replay points back
at the script file so you can fix and re-save it.

Replays are scored: each `run --script` records success or failure, so `open`
ranks the most reliable flow first, adds `scriptStats` (confirmed/contradicted
per script), and sets `replayNote` when the top flow recently broke. Prefer the
first listed script, and heed `replayNote` before trusting a flaky one.

## Builtin Snippets

Check `snippets/_builtin/` before recreating common loops (paths also work
relative to the repo/skill directory):

- `form-flow.js` — whole-form fill + submit + readiness (`--arg fields=...`,
  `--arg submit=...`, `--arg readyText=...`)
- `table-extract.js` — table → `{headers, rows}` (`--arg table=...`)
- `paginate-collect.js` — items across paginated pages (`--arg item=...`,
  `--arg next=...`, `--arg fields=...`)
- `wizard-flow.js` — multi-step wizard with per-step readiness proof
  (`--arg steps=[...]`)
- `search-and-pick.js` — type → pick suggestion → submit → report
- `scroll-until.js` — scroll until selector count reaches a target
  (`--arg selector=...`, `--arg count=N`)
- `page-extract.js` — structured page metadata without dumping HTML
- `page-assert.js` — selector/text/DOM assertions (`--arg selector=...`)
- `network-errors.js` — browser-observable broken-resource diagnostics

Deeper guides load on demand — `chromux skill` lists topics.
`chromux skill forms|extraction|recovery|visual` prints the guide for autocomplete patterns, pagination/table extraction, dialog/popup recovery, DPR-safe canvas/frame workflows, and the pause → open --foreground → wait → resume human login handoff.

## Crawling And Batches

For read-only collection use crawl mode and the built-in queue:

```bash
CHROMUX_MODE=crawl CHROMUX_PROFILE=work chromux batch --file urls.txt \
  --workers 10 --retries 1 --host-backoff-ms 250 --out results.jsonl
```

Crawl mode adds resource guardrails (resource blocking, session caps, idle
cleanup); reuse 3-5 stable session names as a worker pool instead of new
sessions per URL. Tuning env vars: see `chromux help`. `pause`/`resume`
hard-stop or resume a profile's tab work.

## Profiles: Use `default`

A profile is a real Chrome user-data-dir of a few hundred MB, not a scratch
namespace. Sessions, not profiles, are what you create per task — one profile
holds many isolated tabs. So run everything on `default` unless the task needs
its own logins or real isolation from an untrusted site.

chromux will not create a profile for you: an unknown `--profile` /
`CHROMUX_PROFILE` name aborts with a hint instead of silently making a
directory. Creating one is the user's call — ask, then run `chromux profile
new <name>` (or pass `--new-profile`) once they agree. `default` and `live`
always work.

```bash
chromux profile list     # known profiles, last use, disk usage
chromux profile prune    # idle profiles worth deleting (add --yes to delete)
```

## Live Mode: The User's Real Chrome

Two routes reach a browser: isolated profiles (the "agent's browser", default)
and the reserved `live` profile (the "user's browser", via the chromux
extension). Choose `live` only when the task needs the user's own logged-in
session (SSO, 2FA, an already-open page) or the user says "do this on the page
I'm looking at". Otherwise use an isolated profile.

- Setup is one-time: the user loads the unpacked extension once, then
  `chromux pair` starts the bridge and the extension connects on its own — no
  token, and it reconnects automatically after browser or daemon restarts. If
  `CHROMUX_PROFILE=live` commands error with "extension not connected", tell
  the user to run `chromux pair` (and load/reload the extension) rather than
  retrying blindly.
- Same command surface, different profile: `CHROMUX_PROFILE=live chromux open
  <s> <url>` creates a visible new tab in the user's Chrome; add `--tab
  active|<tabId>|<url-or-title-match>` to attach an existing tab instead. Use
  `chromux tabs` to see the user's tabs and their ids.
- Safety semantics differ: `close` on an attached user tab detaches (never
  closes the user's tab); `kill live` stops the bridge without touching the
  Chrome process. `show`, `launch --headless`, and `chrome://`/Web Store pages
  are unsupported and return a clear `live unsupported` error — do not retry
  them, switch to an isolated profile if you truly need them.
- Attached tabs are visibly badged: they sit in a green "chromux" tab group
  while an agent drives them and return to their previous group on detach.
  If the user asks "which tab are you on", that group is the answer; browsers
  without tab-group APIs skip the badge.
- Everything runs on the user's real session, so treat destructive actions with
  extra care and prefer new tabs over reusing the user's tabs unless asked.

## Diagnostics And Evidence

- `chromux watch <s> console` / `watch <s> network --all` capture logs and
  failed requests; report passing UI actions with new console errors as
  suspicious, not silent success.
- `screenshot <s> [path]` for visual evidence; add `--ref @N|selector` or
  `--region X Y WIDTH HEIGHT` for a bounded crop. The response includes PNG
  dimensions, CSS/visual viewport metadata, and measured image conversion.
  A crop's image coordinates start at its own `[0,0]`; image-space actions use
  the most recent screenshot mapping until another screenshot replaces it or
  open, raw CDP, or scroll invalidates it.
  For canvas, save the PNG under the current work directory, inspect it, then
  use image-space `hover`, `click`, or `drag`. For an HTML range slider,
  locate the visible thumb and move it with pointer `drag`; `fill` is not a
  range-control action. `show <s>` opens DevTools.
- Local activity events land in `~/.chromux/activity/events.jsonl`
  (`fill`/`type` text and inline code are never stored raw). `chromux app`
  serves the local profile/activity dashboard. Set `CHROMUX_TASK=<label>`
  (short, non-secret) to group related commands into a Task timeline.
- `record <s> start` / `record <s> stop [path] [--discard]` capture the whole
  session as evidence for a bug report or PR — a single mp4 beats a
  screenshot sequence for showing what was clicked, in what order, and when.
  Requires `ffmpeg` on `PATH` or `ffmpegPath` in `~/.chromux/config.json`.
  Recording starts at the first action after `start`, not the `start` call
  itself, so open with `record start` before the real work rather than
  timing it around a specific step. It auto-stops if forgotten (idle-timeout,
  default 60s) and salvages whatever was captured if ffmpeg crashes. One
  active recording per session — `stop` before starting another.

## Site Knowledge

`open` responses may surface host notes from `~/.chromux/skills/<host>/*.md`
(parent domains included) — read `hints` before inventing an approach. Each
hint is headed by the note's real path, so you can open the file directly.
Write durable, non-secret knowledge back after sessions that taught you
something:

```bash
chromux note <host>                    # review existing notes first
chromux note <host> --add "stable selector / quirk / wait behavior"
```

Saving is not optional cleanup — it is how the second visit gets cheaper. When
a host has no durable knowledge yet or one of its files has gone stale, the
`open` and `close` responses carry a `learnNext` field. Treat it as a required
checkpoint: before ending a session that revealed something reusable, land it
as a note (a durable fact) or a replay script (a proven flow). Well-covered,
fresh hosts stay quiet.

**When a hint is wrong, fix the file — do not append a correction.** Notes are
plain markdown and scripts are plain JavaScript; edit them with your normal
file tools at the path in the hint header. `note --add` only appends, so using
it to correct something leaves both the wrong claim and its rebuttal in the
response, and the next agent believes whichever it reads first. A note that
says "the default profile is logged in" when it no longer is will send the
next session into a login wall, so deleting or rewriting that line is the
repair. `learnNext` names the oldest file for the host precisely so you know
where to look; touching a sibling file does not silence it.

Good: stable selectors, URL patterns, framework quirks, hidden waits. Bad:
credentials, cookies, pixel coordinates, one-off task narration, stale facts.

## Secret Store (Opt-in Add-on)

If the user has set up the [Bitwarden-backed secret
store](../../install.md#secret-store-setup-optional-bitwarden-add-on), a
login wall may be passable without a human, via `fill --secret` instead of a
literal typed value:

```bash
chromux fill <session> @<ref> --secret github.com:password
chromux fill <session> @<ref> --secret github.com:username
chromux fill <session> @<ref> --secret github.com:totp
```

Try it when a snapshot shows a login form on a host you have no other reason
to think is unregistered. A failure is always a structured, non-crashing
response — treat it exactly like any other login wall and hand off:

```json
{ "ok": false, "secret": "locked", "next": "run `chromux secret unlock` in a terminal, then retry" }
```

`secret: "locked"` means the vault needs a human to run `chromux secret
unlock` in a terminal; `"not-found"` means no credential is registered for
that host (fall through to the normal manual-login handoff below);
`"unsupported-tier"` means the account's Bitwarden tier can't produce a TOTP
code (hand the 2FA screen to the user). Never register, view, or guess at
credentials yourself — `secret set`/`secret rm`/`secret unlock` are
human-only by design and will refuse if you try to run them.

## Gotchas

- Prefer `@ref` interactions over CSS selectors; `click` scrolls the target
  into view and fails on stale/hidden/covered targets. `click <s> --xy X Y`
  clicks viewport coordinates when visual geometry is the right tool.
- New tabs open in the background by default; use `open --foreground` only when
  activation is intentional.
- Auth walls are user-owned: if a site redirects to login without a usable
  saved profile, try `fill --secret <host>:password` first (see Secret Store
  above) when the add-on is set up; otherwise stop and ask the user to log
  in manually.
- Always close sessions you open; `chromux ps` / `chromux kill <profile>` for
  profile cleanup (also clears stale singleton locks). chromux does back you
  up — tabs idle 30 minutes are closed and an auto-launched browser shuts down
  15 minutes after its last session — but until those timers fire every tab you
  abandon holds a renderer. `chromux ps` shows `UPTIME`/`RENDER`, and
  `chromux kill --idle <minutes>` sweeps a machine that has accumulated
  leftovers.
- Older aliases (`eval`, `scroll`, `wait`, `console`, `network`, `scroll-until`)
  exist for compatibility; prefer `run`, `cdp`, and `watch`.
- Known reach limits (report these instead of retrying blindly): opaque cross-origin geometry is available by default, but reliable DOM/text action inside a site-isolated OOPIF requires an explicit `open ... --oopif` session.
  That opt-in attaches child targets, adds namespaced snapshot refs, and routes click/fill/waits; navigation, detach, or renderer crash invalidates the child namespace.
  `list` reports crash cleanup, and `close` reports drained child-routing and CDP transport state.
  Keep it off when origin-only frame geometry is enough because it adds payload and target attachment surface.
  Closed shadow roots remain unreachable. Verify diffs may
  show a newly revealed listener-only element as text without a clickable
  `@ref`; take a snapshot to get its ref.
