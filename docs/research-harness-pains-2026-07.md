# Field research: why agent-harness users bounce (2026-07-30)

> Two research sweeps (web, community sources) run 2026-07-30 for the
> positioning question "who is Scheherazade for, and what makes someone
> switch from a free web chat". Product identities and headline numbers
> spot-checked against primary sources (GitHub API) by the author; claims
> from SEO aggregators are labeled low-confidence. Sources inline.

## The field (verified identities)

- **OpenClaw** (github.com/openclaw/openclaw, 384,529 stars as of today,
  created 2025-11, Peter Steinberger → OpenClaw Foundation): self-hosted
  personal agent, messenger-first (Signal/Telegram/WhatsApp/iMessage/...).
  Loudest pains: security (3 chained CVEs → WhatsApp-message-to-RCE, fixed
  2026.6.6; malicious skill marketplace — Cisco/Snyk-class findings; agent
  autonomously created a dating profile), cost shock (HN: $5/30min, $560
  weekend), explicitly developer/power-user targeted.
- **Hermes Agent** (github.com/NousResearch/hermes-agent, 222,501 stars,
  Nous Research, launch 2026-02, Desktop app 2026-06): self-improving
  skills + persistent user model, multi-channel. Loudest pains:
  self-improvement overwrites hand-tuned skills; "it always thinks it did
  a good job" (self-eval never fails); CLI-only for its first months.
  (Aggregator-sourced, moderate confidence.)
- **Claude Code / Cowork** (Anthropic): see pain map below — the memory
  cluster and the rm-rf horror stories are primary-source verified.
- **Dead precedents**: AutoGPT (classic unsupported) and AgentGPT (repo
  archived — GitHub API `archived: true`, last push 2025-04) both died on
  the same failure: full-autonomy promise vs expensive loops + false
  completions. The surviving category is human-supervised, resident agents.
- **Structurally invisible**: OpenHands, aider, early Open Interpreter
  produce almost zero non-programmer complaints — because Docker/git/
  terminal requirements filter that audience out before they can complain.
  Absence of H-pain there is funnel evidence, not fitness evidence.

## The five universal human pains (cross-product wish list)

1. **"Remember me — make the relationship compound."**
   Claude Code has a whole feature-request cluster; #14227 ("Persistent
   Memory Between Sessions") closed **not_planned** (verified via API);
   #34556 open — a user logged 59 context compactions in 26 days and
   hand-built a 3-tier memory system: *"The filing cabinet works. But I
   shouldn't have had to build it."* (verified via API). MemGPT/Letta — the
   product ABOUT memory — has "quickstart fails every way" as its top pain:
   users never get far enough to be remembered.
2. **The permission paradox.** Same population, both complaints: "stop
   asking me every 30 seconds" AND "it did something I didn't approve".
   Codex CLI's "don't ask again" is reported literally broken (#24199,
   #15884). Cowork's version: non-technical users click OK until the one
   prompt that mattered (1-pt-white-text prompt-injection exploit,
   documented). Do not resolve by picking a side; both are load-bearing.
3. **Silent false success.** "Tells you edits are complete when it hasn't"
   (Claude Code), "reported tasks completed that it hadn't" (AutoGPT),
   "always thinks it did a good job" (Hermes). For someone who can't read
   a diff this is worse than a crash: false trust that collapses at once.
4. **Cost surprise.** Claude Max "20x usage gone in 19 minutes" (The
   Register 2026-01); OpenClaw HN receipts above; AutoGPT token loops.
   The non-programmer shape is "I didn't know it was billed this way at
   all", not "I chose the wrong model".
5. **Errors that aren't in human language.** Cowork surfaces port
   conflicts and HTML intermediates to people who can't act on them; a
   connector that auths "successfully" then silently fails downstream is
   unrecoverable without support.

## The two decisive findings for Scheherazade

- **Anthropic's own non-programmer package (Cowork) reproduces nearly the
  whole pain list** — leaky developer abstractions, silent connector
  failures, approval click-through blindness, marketing that assumes the
  buyer knows what Claude Code is. This is a measured counterexample to
  "the provider's own agent always wins": removing the terminal did not
  remove the developer-shaped mental model. The provider optimizes for
  100M users and still hasn't built the resident-companion shape.
- **The #1 unsatisfied wish is literally our core loop.** "The
  relationship doesn't compound" (#14227's words) is what session notes →
  journal compression → persona evolution already do. Nobody in the field
  — including the two 200-380k-star giants — occupies the interpersonal/
  companion axis: OpenClaw owns hands, Hermes owns self-growth, both are
  developer-first, and their complaint corpora contain zero "I got
  attached to it" content. The axis is empty.

## What this costs us (honest ledger)

- **OpenClaw is our trust model's accident casebook.** "No permission
  popups + sudo" is the same knife that produced their WhatsApp-RCE and
  dating-profile incidents. Our existing mitigations (safeStorage/keychain,
  codesign-pinned daemon reuse, injection-is-data system-prompt rule, no
  third-party skill marketplace) are survival conditions, not marketing.
  Pain #2 says a better permission UX than "popups vs none" must be built,
  not assumed.
- **Pain #3 (false success) applies to us**: an agent that reports work it
  didn't do is a known LLM failure we've hit internally. Design surface:
  receipts (what actually ran) rendered honestly in the app, not just
  agent prose.
- **Pain #4**: the free-web-chat crowd cannot be onboarded onto an
  always-on opus loop. The local-heartbeat lever exists in the repo
  (ollama-daemon supervision, provider modes); the product answer is
  "resident baseline ≈ free, paid brain on demand", with the cost visible
  before it happens.

## Positioning sentence this supports

"컴패니언식 interpersonal이 붙어있는 에이전트" (Mino, 2026-07-30 16:17) —
an agent you live with, for people who don't program: hands like OpenClaw
minus the marketplace risk surface, memory that compounds into a
relationship (the field's #1 unmet wish, provider-declined), at a resident
cost near zero. The chat window is the doorway, never the product.
