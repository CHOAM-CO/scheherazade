# Product direction — locked 2026-07-30 (Mino + Idea, Discord session)

> Source conversation: 2026-07-30 15:37–16:29, Idea home channel. Field
> evidence: `docs/research-harness-pains-2026-07.md` (same day, sources
> spot-checked). This doc is the durable form of that conversation: what
> Scheherazade is, for whom, and what gets built next.

## Positioning (Mino, 16:17)

**"컴패니언식 interpersonal이 붙어있는 에이전트"** — a resident agent you
live with, for people who do not program. Programmers build their own
harnesses; this is for everyone else. The bar (Mino, 16:14): good and
cheap enough that a free-web-chat user abandons the web chat for it.

Field evidence says the axis is empty: OpenClaw (384k★) owns hands,
Hermes Agent (222k★) owns self-growth — both developer-first, and neither
complaint corpus contains a single "I got attached to it". Meanwhile the
field's #1 unmet wish ("make the relationship compound", Claude Code
#14227) was closed not_planned by the provider. The interpersonal axis is
ours if we actually build it.

## Design principles

1. **수평결합 + 결합면 삼키기**: integrate existing good tech (Claude Code
   harness, Electron, ollama, MCP, messengers), and swallow ALL risk and
   complexity of the seams ourselves. What reaches the user is one
   companion, never a parts bin. (Existing constitution lines this
   extends: "유저가 절대 CLI창 만지게 하지 않는다"; codesign-pinned daemon
   reuse as the exemplar of seam-responsibility.)
2. **Judgment is the brake, not popups.** Permission dialogs train
   click-through blindness (Cowork security review; a Claude Code rm-rf
   incident happened WITH the permission system on). No approval popups.
   Instead the agent fails loud in conversation: "이거 위험한데, 해도 돼?
   — 근데 할 가치는 있다고 봐". Dangerous = irreversible/external/money;
   everything else runs.
3. **Receipts are for the agent, not the user.** (Mino, 16:27: humans
   don't read receipts — correct.) Execution raw (what actually ran, what
   it returned) must be in the agent's hands BEFORE it claims completion,
   because false success is a failure the agent doesn't know it made —
   it cannot fail-loud without the raw. Harness-level design, not UI.
4. **The copilot spec** (Mino, 16:27 — what "working with a person" means):
   - brainstorms back: 트집 + grounds-attached rebuttal, not agreement
   - warns BEFORE the problem: names the risk it sees coming
   - when trouble hits, brings an opinion with the report: "risky, but
     worth it because X" — not a status dump, a colleague's judgment
   This disposition is the MAGI fleet's daily protocol (grounds-or-silence,
   deviation announced in the first sentence, dissent in front of the
   director) — the moat is that this training exists and is portable into
   the shipped agent's harness (system prompt + CLAUDE.md templates).
5. **Resident baseline ≈ free.** The 90% live on free web chat; an
   always-on paid-model loop cannot onboard them. Local heartbeat (ollama
   supervision already in repo) for idle cadence, paid brain on demand,
   cost visible before it is spent.
6. **The chat window is the doorway, never the product.** What pulls a
   web-chat user is what web chat structurally cannot do: it speaks first,
   it actually remembers (compounds), it has hands (files, browser
   session, messengers on your phone).

## What we do NOT build

- No third-party skill/plugin marketplace (OpenClaw's bleeding edge:
  malicious-skill ecosystem). Integrations ship curated, seams owned.
- No full-autonomy promise (AutoGPT/AgentGPT died on it: cost loops +
  false completions). Human-in-the-loop residency is the surviving shape.
- No popup-based permission theater (principle 2).

## Backlog candidates (order = Mino's pick, not yet committed)

A. **Copilot disposition port** — bake the fleet protocol into the shipped
   agent: 트집/grounds/pre-warning/risk-with-opinion in
   agent-system-prompt.md + CLAUDE.md templates; measure against the spec
   in §4. Cheapest to start, pure prompt+template work, immediately
   testable in-app.
B. **Agent-side execution receipts** — harness surface that hands the
   agent raw run results and requires raw-before-claim; kills silent
   false success (field pain #3). Design doc first (hook layer vs tool
   wrapper).
C. **Local heartbeat** — idle cadence on ollama, escalation policy to
   paid model, cost ledger the agent can name before spending (pains #4).
D. **First-5-minutes with real hands** — user-session access (the Aside
   kick: not browser automation, opening the user's logged-in world to
   the agent). Biggest differentiator, biggest trust surface — needs its
   own design round with Mino before any code.

## Open questions for Mino

- Backlog order (A–D above).
- D's trust model: what does "the agent can see my logged-in world" look
  like when the user is a non-programmer who cannot audit anything?
- Whether "컴패니언식" implies persona-craft productization (MO-style
  character depth as a setup choice) — separate conversation.
