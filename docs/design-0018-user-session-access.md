# Design 0018 — User-session access ("the agent gets hands in my logged-in world")

Status: OPTIONS DRAFT 2026-07-30, for a design round with Mino BEFORE any
code (backlog D, product-direction-2026-08.md). Research: web sweep
2026-07-30, load-bearing claims spot-checked (Chrome 136 change read at
developer.chrome.com/blog/remote-debugging-port directly).

## The kick, restated

Mino (07-30 16:12): Aside's kick is not browser automation — it is making
the USER'S SESSIONS reachable by the agent. This is the first-5-minutes
utility that no web chat and no messenger bot can offer: "읽어봐, 내 메일"
works only if the agent can stand where the user is already logged in.

## The landscape (what the sweep found, condensed)

| Approach | Verdict for a non-programmer macOS product |
|---|---|
| CDP-attach to the user's real Chrome | **DEAD.** Chrome 136 (2025-03) ignores --remote-debugging-port on the default profile — read at the primary source; Google names cookie-theft malware as the reason. Not coming back. |
| Cookie import (read the browser's store) | **DEAD.** Chrome App-Bound Encryption arms race; Safari needs Full Disk Access (reads as malware); no mainstream product ships this. |
| Extension relay into the user's real browser | Supplement, not foundation. MV3 walls, permanent "started debugging this browser" banner (unsolved even for Anthropic's own Claude-for-Chrome), and the scariest injection surface: Anthropic's red team measured 23.6% attack success unprotected → 1.4% after layered mitigations. |
| OS automation (AX/AppleScript) | Supplement. TCC dialogs multiply per target app; fine for Finder/Calendar-class tasks, wrong as the web-session foundation. |
| **Agent-owned persistent browser profile** | **Where the whole market converged**: OpenClaw's default managed profile, OpenAI Atlas, Perplexity Comet, Genspark, Fellou — and Aside itself (standalone Chromium + extension bridge = this plus a relay supplement). Survives Chrome 136 (own user-data-dir), zero TCC, onboarding = "log in once inside the app" — the one step a non-programmer reliably gets right. |

## Proposed shape (to argue about, not decided)

**A Scheherazade-owned persistent browser profile — "the agent's own copy
of your logged-in world" — as the foundation**, with supplements later if
ever needed.

- Honest trust boundary: the user does not hand over their browser; they
  log the agent into a place they can SEE (open the window, watch it),
  and revoke per-site the way they already know how (log out, change
  password). No TCC grants, no cookie theft shape, no debugger banner.
- One normal new-device 2FA per site at first login — the cost, once.
- We already run this exact pattern in-house (MAGI's Aside deployment:
  read-autonomous, write-per-case) — the operational lessons are ours
  already, including the covenant shape: **reads autonomous, writes gated**.
- Precedent for the gate UX: Atlas ships logged-OUT agent sessions by
  default with opt-in logged-in mode; Claude-for-Chrome ships a per-SITE
  allowlist. Both are popup-free permission models that fit our
  "judgment is the brake" principle: site-level standing grants +
  fail-loud asks for writes, not per-action dialogs.

## What OpenClaw's casebook teaches (the part we must not skip)

Their browser architecture is actually sound on paper (loopback-only
control API, bearer token, isolated profile, risk-flagged extension
mode) — and they still bled: one-click RCE via an unvalidated URL param
(CVE-2026-25253, 40k exposed instances), then four chained sandbox flaws.
The lesson is not "their design was wrong", it is "the control surface
around the browser is the attack surface". For us: the profile's control
API never leaves loopback, carries a per-run token (we already do exactly
this in channel-local.mjs), and the agent treats page content as DATA —
the injection rule already in our shipped system prompt. Anthropic's
23.6%→1.4% number says mitigations work but the load-bearing one is
scope: what the agent CAN reach when injected matters more than whether
it can be injected.

## Open questions for the design round (Mino's eye needed)

1. **Which first?** The profile is infrastructure; the DEMO is what sells
   ("첫 5분"). Which first-5-minutes task do we design around — mail
   read+summarize? calendar? shopping price watch? The task picks the
   sites, the sites pick the trust UX.
2. **Write gating UX.** Reads autonomous / writes gated is our in-house
   covenant. In-product, what does the gate look like for a
   non-programmer — the agent ASKING in chat ("결제 눌러도 돼?") with
   standing per-site grants ("이 사이트는 앞으로 알아서 해")?
3. **Visibility.** Is the agent's browser window visible-by-default
   (trust through watchability) or headless-by-default (less noise)?
   Watchability is a trust feature the field underuses.
4. **Engine choice.** Bundled Chromium via Playwright persistent context
   vs driving an installed Chrome with our own user-data-dir (OpenClaw
   style, lighter dmg) — packaging weight vs update/bot-detection
   surface. Needs a spike, not an opinion.
5. **Aside relationship.** Aside is macOS-only, YC F25, unaudited
   marketing claims — do we treat it as inspiration only, or is there an
   integration/licensing conversation worth having? (Mino knows the
   product; his call entirely.)
