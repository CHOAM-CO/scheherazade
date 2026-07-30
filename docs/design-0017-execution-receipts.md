# Design 0017 — Execution receipts: raw-before-claim at the harness level

Status: designed 2026-07-30 (backlog B, product-direction-2026-08.md §3).
Implements: "receipts are for the agent, not the user" (Mino, 07-30 16:27).

## Problem

Silent false success — the agent reports work it didn't verify — is the
field's #3 universal pain (research-harness-pains-2026-07.md: Claude Code
"tells you edits are complete when it hasn't", AutoGPT false completions,
Hermes "always thinks it did a good job"). For a non-programmer it is
worse than a crash: false trust that collapses later, with no diff-reading
skill to catch it earlier.

The shipped product already has HALF of the answer: the rumination gate
(pre-reply-rumination-gate.mjs) bounces completion-CLAIM text once. But it
is claim-triggered — it fires on wording ("보냈어요/확인했어요"), knows
nothing about what actually ran, and cannot catch the smoother failure
mode: a reply that glosses over a failed command without any claim word
at all.

## Mechanism

Two pieces, ONE blocking gate (the rumination gate's own header warns that
a second blocking gate on the reply tool breaks its synchronous
marker-consume design — so we extend it, never add a sibling).

1. **Turn ledger** — `hooks/post-bash-receipt-ledger.mjs`, new PostToolUse
   (Bash) hook. Advisory, fail-open (pack convention). Appends one JSONL
   row per Bash result to `DATA_HOME/.gates/receipt-ledger.jsonl`:
   `{ts, cmd(≤120ch), failed, tail(≤200ch when failed)}`.
   Failure detection is textual BY NECESSITY: the PostToolUse payload has
   no structured exit-code field (docs check, code.claude.com/docs/en/
   hooks.md — `tool_response` carries output text, not rc). Discriminator:
   the harness's own `Exit code N` marker plus `interrupted`. If the
   marker format ever changes, the ledger degrades to all-success —
   fail-open, never fail-wrong.
2. **Evidence branch in the existing gate** —
   pre-reply-rumination-gate.mjs grows a second trigger: unconsumed ledger
   rows with `failed:true` block the reply ONCE with the SPECIFIC receipt
   ("이번 턴 실행 N개 중 M개 실패: `cmd` — 답장에 반영됐는지 확인"),
   sharing the existing bounce-marker/consume machinery. Claim-trigger and
   evidence-trigger consume the same one-bounce budget: worst case one
   extra roundtrip per turn, never two.
   Consume semantics: allowing a reply (bounce consumed or nothing to
   flag) stamps a ledger cursor (`receipt-ledger.cursor`) so rows are
   judged once per reply, not forever.

## Rollout to existing installs

settings.local.json is seeded first-run-only, so the new PostToolUse
wiring needs an additive migration in harness-render.cjs — same lane as
the GAUGE_HOOK additive migration, with its own source-text pin test
(house rule: migration regex + pin test land in the same commit).

## Deliberately NOT built

- No user-facing receipt UI (Mino: humans don't read receipts).
- No NLP on reply text beyond the existing claim regexes — the evidence
  branch is purely mechanical (ledger rows), no text matching.
- No PostToolUse coverage of Edit/Write v1 — file edits fail loudly at
  the tool layer already; Bash is where silent failure lives.
- Kill switch: reuses SCHEHERAZADE_RUMINATION_GATE=0 for the gate; ledger
  writer gets SCHEHERAZADE_RECEIPT_LEDGER=0.

## Test plan

- Unit: ledger hook parses success/failure/interrupted payload shapes
  (string and object tool_response); gate blocks once on failed rows,
  passes retry, cursor advances, marker interplay with claim-trigger.
- Mutation: drop ledger append / drop evidence branch / mistag failed —
  each must fail a test.
- Pin: additive-migration regex pinned like test-context-gauge.mjs.
