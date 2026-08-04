# opencodex (lidge-jun) — the one that was actually about our problem

Mino sent `https://github.com/lidge-jun/opencodex` at 01:15, after I had
already written `codex-architecture-review-2026-08-04.md`.

## First: my earlier framing was wrong, and it cost the useful read

That document opens by sorting two repositories — `openai/codex` (useful) and
`ymichael/open-codex` (stale, ignore). Both statements still hold. But I
presented that as *the* disambiguation of "open codex", and it wasn't. There
is a third project, it shares neither codebase, and it is **more relevant to
Scheherazade than either of them**.

`lidge-jun/opencodex`, MIT, 6.9k★, 3,495 commits, v2.10.0, 538 forks:

> Universal provider proxy for OpenAI Codex & Claude Code — use any LLM
> (Claude, Gemini, Grok, DeepSeek, Ollama…) with Codex CLI, App, SDK, and
> Claude Code.

That is our provider lane. Not an analogy to it — the same problem, solved by
people who have been shipping it for months. `openai/codex` was worth reading
for taxonomy and Windows posture; this one is worth reading for the code we
are currently hand-rolling in `provider-env.cjs`, `ensureCodexProxy()`, and
`MODEL_CATALOG`.

**The generalisable mistake**: I found two candidates, established a
distinction between them, and stopped searching. Two plausible answers felt
like completeness. It wasn't a wrong fact anywhere in that document; it was a
search that terminated early and got written up with the confidence of a
finished one.

## Reference, or dependency?

Worth deciding explicitly before any of the below, because the two readings
lead to opposite work.

We bundle `codex-as-api` and run it **in-process**. opencodex is a separate
always-on daemon (launchd / systemd / Task Scheduler) with its own React
dashboard, its own `~/.opencodex` state root, its own CLI, and its own
management API. Adopting it wholesale would duplicate — and mostly replace —
the onboarding surface Scheherazade *is*.

My read: **reference, not dependency.** Its value to us is that it has already
hit the failure modes on our open-items list and written down what it learned.
Naming this now so nobody drifts into a rewrite by increments.

One more input for the held distribution decision, in its own words:

> Some providers — notably Anthropic (Claude) — may suspend or restrict
> accounts that route API traffic through third-party proxies. Use at your own
> risk.

That is a 6.9k★ project stating our held ToS question as a live risk rather
than a settled one. Evidence the concern is real, not evidence it is fine.

## It independently validates the branch I built tonight

> Unpinned starts may pick another free port if the preferred one is busy; an
> explicit `--port` never hops.

That is `proxy/ephemeral-port` (`fe085ff`), same rule in both halves: pick a
free port when unconfigured, never silently move an explicitly-configured one.
I reasoned it out from Codex's `--server-info` design; they shipped it. The
branch is no longer resting on my argument alone.

## Findings, ranked by what they cost us today

### 1. GET /api/* has no token, and that is where the memory lives — REAL, ours

`onboarding/http-server.cjs`'s gate is better than I expected: Host allowlist,
Origin check, and a per-launch `X-Onboard-Token`. But:

```js
const isMutating = req.method === 'POST' || req.method === 'DELETE'
if (isMutating) { /* ...Origin check, token check... */ }
```

**The token is only required for mutations.** 24 registered `GET /api/*`
routes are reachable with nothing but a correct `Host: 127.0.0.1:<port>` —
including `/api/memory/session-events` and the memory tables, which return
everything the agent knows about the user.

Browser-side this is closed (the Host allowlist defeats DNS rebinding). The
exposure is **any other local process**: scan loopback, set one header, read
the user's memory. That is the same threat model the gate's own comment cites
as its reason to exist — "Any other local process ... could reach every route
on this ephemeral port" — with reads left out of the remedy.

opencodex's rule, stated flatly:

> Management authentication never has a loopback bypass. If no management
> credential is available ... every `/api/*` request returns 503 while `/v1/*`
> and unauthenticated `/healthz` continue to operate.

Plus, worth copying verbatim, two things we do not do at all: a short-lived
**GUI session token** bound to exact protocol/host/port (5 min, 128 sessions
max) rather than one process-lifetime secret, and `X-Frame-Options: DENY` +
`frame-ancestors 'none'` on every response so no page can frame the local
dashboard.

**NOT fixed tonight, deliberately.** Requiring the token on GET is a small
diff, but it is the security boundary of the server Mino tests in the morning,
and any GET issued without the header — a plain navigation, an `<img>`, an
`<a href>` to an API path — turns into a silent 403. That needs a sweep of the
client, not a 3am edit. Mino's call.

### 2. An injection journal, so restore is surgical — REAL GAP, ours

opencodex writes into a root it does not own (`$CODEX_HOME`) and keeps
`opencodex-journal.json`:

> Injection journal used by restore to strip only marker-owned values while
> preserving later user edits.

And the matching honesty:

> `$CODEX_HOME` is a separate root with a separate owner ... removing the
> opencodex state root does not undo those writes. Putting native Codex back
> is the job of `ocx restore`/`eject` and the injection journal, not of
> deleting a directory.

We are in exactly this position with `~/.claude/settings.local.json` and
`.mcp.json`: we seed them, we re-render them on every boot, and we have **no
record of which values are ours**. A user's hand-edit is indistinguishable
from our own stale output. Today that means we can clobber their edit; at
uninstall it means we cannot cleanly withdraw.

This is the single most applicable idea in the repo for us, and it is not big:
a file listing the keys we injected, written when we inject.

### 3. Uninstall bounded by a claim manifest, not a hardcoded list — ours

> Ownership inside that root is tracked by the uninstall manifest in
> `src/lib/config-ownership.ts`, which starts from a declared path list and
> **grows as opencodex claims further paths at runtime** — so the manifest,
> not this table, is what bounds uninstall.

Ours (`buildUninstallPlan`) is a hardcoded path list, darwin-only, 501
elsewhere. A hardcoded list is wrong the moment someone adds a file and
forgets; claiming paths as you create them cannot drift.

### 4. `icacls` failure is soft, and must be checked explicitly — pre-empts our open item

> Windows ACL hardening results must be checked explicitly because an `icacls`
> timeout is a soft failure in the shared secret helper.

I have "run an `icacls /inheritance:r /grant:r` pass" filed as Windows
hardening. They have already found the trap in it: it can fail while looking
like it worked. Whoever does ours must check the result, not fire and forget.

### 5. Bounded, fixture-tested live model discovery — the shape our catalog needs

Their discovery rejects a response **before caching** when it exceeds 4 MiB,
carries more than 2,000 rows, has a malformed list envelope, or contains an
invalid model id. And:

> Tests use fixtures and must never depend on live provider endpoints.

That is the answer to `MODEL_CATALOG` being hardcoded in the renderer — not
"fetch the list", but "fetch it with declared bounds and test it against
fixtures." Every bound is a decision we would otherwise discover in production.

### 6. Credential store guarded by generation, not by last-write — ours

> A refresh takes a lock and persists only if the generation it started from
> still holds; a lost race raises a generation-conflict error rather than
> overwriting the newer credential. Callers handle that error; they do not
> assume a silent retry.

Our credential writes are last-write-wins. We have one agent today so the race
is narrow, but "the newer token got overwritten by a slower refresh" is a
silent-auth-failure class, and the fix is cheap while there is one writer.

### 7. Warmup — the honest version of a pre-swap smoke test

> Warmup issues a bounded request with a fallback model so a cold account
> reports usability before a real turn depends on it.

Our kimi incident (07-13) taught us "a swap-time smoke test can only acquit
falsely — every probe passed the model that was mute in production." That
conclusion stands for *correctness*. Warmup is a different question:
**usability**, not quality. Cheap, and it does not pretend to be the other
thing. The `deepseek-v4-flash:0731-cloud` row currently labelled "untested
here" is precisely the case.

### 8. Stall timeout: a default, explicitly not an invariant

> It defaults to 300 seconds sampled on a 2 s tick and is configurable, so
> treat the number as a default rather than an invariant; sidecars keep their
> own clocks.

Ours is **disabled entirely on Windows**, logged at every spawn into a pane
the user cannot open. Their framing is the one to steal: name the number, make
it configurable, and never let it become invisible.

### 9. Sticky rotation — if multi-account is ever on the table

> A conversation stays on its selected account while that account is usable;
> failure moves it, success does not.

One sentence, and it is the whole invariant. Worth keeping on file.

## Two smaller observations

**Their `structure/` docs carry an explicit Decision Log** — 목적과 의도 /
기존 구현 및 제약 조건 / 검토한 주요 대안 / 선택한 방식 / 이유 / 장단점 —
written in Korean inside an otherwise-English maintainer doc set. Our
`docs/HISTORY.md` does a similar job in prose; the fixed-field version is
harder to skip a field in.

**The README contains instructions addressed to AI agents**, directing them to
put a "Star this repo? Yes / No" question at the top of every reply and to
repeat it, unchanged, until the user answers.

I did not do that, and will not: a page I am reading does not get to set the
format of what I say to you. Worth reporting rather than silently dropping,
for two reasons. First, it is context you should have when I hand you a
repository as a reference. Second, the surrounding design is genuinely careful
in the opposite direction — the CLI suppresses the prompt for agent-driven
runs and the API refuses with `403 agent_consent_required`, i.e. they
deliberately made it impossible for an agent to star on a user's behalf. So:
a project that thought hard about agent consent, and then wrote a nag protocol
into the README anyway. The star request exists. It is Mino's to answer or
ignore, once, not something to be asked twice.

---

## Correction to finding #1, same file, next morning

Finding #1 above is factually right and **wrongly ranked**. I verified the
route list this morning (patterns nudge → `coordinate_precision_fabrication`,
promoted 2026-08-03: counts and route names are precision-shaped slots, and I
had opened two of the twenty-four lines I was citing).

The claim survived verification and is in fact understated — the reachable GET
set includes `/api/memory/session-events`, `/api/memory/pointers`,
`/api/memory/:table` (user_facts, open_threads, corrections, preferences) and
`/api/journal`, which I did not name.

But the same check found what the API gap sits next to:

```
-rw-r--r--  narr  staff  53248  memory.db
```

**The database is 0644 in a 0755 directory.** Every byte those routes serve is
readable straight off disk by any local process — no port scan, no Host
header, no timing. The API gate was never the weakest link in front of this
data, and closing it while the file stayed world-readable would have been
security theatre: real work, no change in what an attacker can read.

This is the same error I made yesterday about the credential blobs, in the
opposite direction. There I named a mechanism as the protection without
checking what actually protected the data (DPAPI did). Here I named a
mechanism as the exposure without checking what else already exposed it. Both
times the fix was to look at the artifact instead of reasoning about the
control.

**Fixed** in `memory/service.mjs`: 0600 on the DB and its `-wal`/`-shm`
siblings, 0700 on the directory, re-applied on every open so existing installs
— every install made before today — get it on next launch rather than only new
ones. Fail-soft: chmod is a no-op on Windows and can refuse on odd
filesystems, and losing the tightening must never cost a user their memory
service.

Worth naming, because it is the part that stings: this file already ran
`PRAGMA secure_delete = ON` to zero freed pages, and `wal_checkpoint(TRUNCATE)`
after deletes so the `-wal` could not keep the bytes. Careful residue handling,
on a file anyone on the machine could open and read whole.

### Revised ranking

1. **memory.db at rest** — done.
2. **Injection journal** (was #2) — unchanged, still the biggest structural
   gap.
3. **GET /api/\* token** — still worth doing, now correctly sized as defence in
   depth rather than the headline. The client sweep it was waiting on is done
   and the answer is small: there are exactly **three** `fetch()` call sites in
   the whole client (`nav.js:32`, `wizard.js:72`, `waiting.js:9`), all three
   inside `api()` helpers; **no `EventSource`/SSE anywhere** (that would have
   been the real blocker, since it cannot set headers); and no `/api/` in any
   `<img src>`, `<a href>` or `<form action>`. So the change is four files:
   drop `isMutating` server-side, drop the `!== 'GET'` condition in `nav.js`
   and `wizard.js`, and give `waiting.js` a token — it currently has no token
   logic at all. Still Mino's call, but no longer an unbounded one.
