# v0.3.2

Opus 5.5 becomes selectable. It is not a new model to us — the reference fleet
has had it pinned as its subagent model since 2026-09-23 — but the picker never
offered it, so wanting it meant hand-editing a config file. This release closes
that gap and nothing else.

## Claude Opus 5.5 in the model picker

The Claude group gains one row, directly beside the other Opus entries:

| Model | ID |
|---|---|
| Claude Opus 5.5 | `claude-opus-5-5` |

Selecting it works like any other row — the settings page and the chat
composer's quick-switch dropdown both read the one shared catalog, so the id
appears in both without a second edit.

**Nothing else moves.** The app's default model is unchanged, the
`claude-opus-4-6` fallbacks are untouched, and no existing row's id, label or
context window changed. This release adds a row.

## The 1M context window

The row carries `contextWindow: 1000000`, verified two independent ways that
agree:

- `GET https://api.anthropic.com/v1/models/claude-opus-5-5` on this account
  returns `{"display_name": "Claude Opus 5.5", "max_input_tokens": 1000000,
  "max_tokens": 128000}`;
- the installed CLI binary's own model table (scanned with the app's
  `extractClaudeModelsFromBin()` over `claude` 2.1.283) reports
  `claude-opus-5-5 = 1000000`.

That number reaches the context gauge both ways: as a static `CLAUDE_1M` pin
beside the other Opus rows, and through the live binary-scan tier that reads the
same 2.1.283 table. `tests/test-context-gauge.mjs` asserts that every pickable
Claude row resolves to a cap, so a row whose pin went missing would fail the
suite instead of quietly losing its gauge.

## Unchanged known issue

Stop on Windows is still a hard terminate and can leave MCP child processes
behind, exactly as described in the v0.3.1 notes. The soft
`control_request interrupt` path is still the follow-up; this release does not
touch it.
