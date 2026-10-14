# Scheherazade 0.5.0-beta.9

Call mode reply latency.

- Call-mode endpoint trailing silence 1.8 s -> 0.8 s (`onboarding/stt/endpoint.cjs`, rule2; dictation stays 1.2 s).
- Utterance aggregation window 1.2 s -> 0.3 s (`onboarding/public/js/call-core.cjs`).
- Net: text leaves ~1.1 s after speech ends instead of ~3.0 s (Mino 2026-10-14 11:30 "3초는 너무 느리고 1초?").
- Trade-off: a pause longer than ~1.1 s inside one sentence now splits it; the pending-turn merge still joins the pieces while the agent is busy.
