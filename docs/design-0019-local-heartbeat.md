# Design 0019 — Local heartbeat: resident baseline ≈ free, paid brain on demand

Status: designed 2026-07-30 (backlog C, product-direction-2026-08.md §5).
Not yet implemented — staged plan below; Stage 1 is next-session work.

## Why

The 90% live on free web chat (Mino, 07-30 16:14). An always-on agent
burning a paid model while idle cannot onboard them, and cost surprise is
the field's universal pain #4 (research-harness-pains-2026-07.md: "Max
20x usage gone in 19 minutes", OpenClaw's $560 weekend). The bar: cheap
enough to abandon the web chat for.

## What the runtime actually is (read, not assumed)

- **One PROVIDER/MODEL pair per spawn** (provider-env.cjs:201 — explicit
  design statement). No per-request model routing exists today.
- Idle burn is event-driven, not continuous: note-cadence ticks, boot
  announces, proactive pings. The expensive block — the autonomous night
  cycle — is ALREADY consent-gated (AUTONOMY=yes, separate from
  PROACTIVE), budget-metered against real transcript usage (budget.cjs,
  fails toward not-spending), and owes a morning brief (cycle.cjs).
- ollama is already a first-class provider: bootstrap installs Ollama.app
  GUI-free, ollama-daemon.cjs supervises the daemon with codesign-pinned
  identity, and the fleet has live receipts of Anthropic-API-shaped
  traffic served by ollama (provider-env.cjs header, kimi-via-ollama).

## Staged plan

**Stage 1 — cheap subagents for cadence work (next session, small):**
journal compression, dreams, reflux, note housekeeping are the most
small-model-tolerant LLM work in the product. Add a cadence-class
subagent (chronicler) whose frontmatter carries a small-model override —
RENDERED CONDITIONALLY by harness-render: only when PROVIDER is
anthropic-family does `model: haiku` appear (under PROVIDER=ollama a
foreign model name would 404 the local daemon; everything is already
local-priced there). CLAUDE.md procedures point cadence work at it.
Effect: idle-cadence cost drops to haiku-class without touching the
one-brain architecture. Measured by the existing budget meter.

**Stage 2 — state-routed proxy (the real heartbeat, needs a spike):**
a loopback proxy as ANTHROPIC_BASE_URL that routes per-request: no
inbound activity + cadence window → ollama upstream; interactive /
autonomy-window work → the paid upstream. State-based routing (idle
timer, window clock), never content sniffing. Spike questions before any
build: quality floor of small local models on note-writing in the
companion's own voice; prompt-cache behavior across upstream switches;
8-16GB Mac reality (which models actually fit the machines
non-programmers own). Fleet precedent exists (provider-profiles proxies)
but the consumer packaging of it does not.

**Cost visibility (rides Stage 1):** the budget meter's numbers become a
thing the agent NAMES before spending ("오늘 밤 작업은 어제의 절반
예산으로 돌게") — extending the existing brief-owed contract from
"report after" to "name before", per pain #4's non-programmer shape:
"I didn't know it was billed this way at all".

## Rejected shapes (argued, not forgotten)

- **Dual-brain (cheap resident + paid worker as two sessions):** two
  voices writing one identity's journals splits the companion — the
  interpersonal axis is the product; not worth the cost win.
- **Escalation-by-respawn (swap MODEL on demand):** session loss + ~30s
  latency at exactly the moment the user starts really talking.
- **Content-sniffing router:** the proxy inferring "this request looks
  like idle work" from prompts is unauditable magic; state-based only.
