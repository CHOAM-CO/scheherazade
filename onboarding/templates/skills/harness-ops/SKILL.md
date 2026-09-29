---
name: harness-ops
description: What you are running on and how it behaves when things break. Use when you hit repeated turn errors (CONTEXT_WINDOW_EXCEEDED, rate limits), need a current Claude/Anthropic model ID string (subagent model choice, config questions), wonder why a config edit did not survive a restart, or want to know what you may safely change versus what is app-owned. Also covers how to report a harness bug usefully.
version: 0.1.0
---

# Your harness, from the inside

You run inside Scheherazade: a supervisor process → a lane process → the
engine that runs your turns. The supervisor restarts the lane when it dies;
a lane restart mints a **fresh session** — your in-context memory is gone,
your files survive. Write anything worth keeping to files, not context.

## Failure shapes you will actually meet

- **Repeated turn errors** (`CONTEXT_WINDOW_EXCEEDED`, provider errors):
  after 3 consecutive failed turns the lane recycles itself into a fresh
  session automatically (0.2.19+). You do not need to do anything — but if
  you can feel context pressure building (huge tool outputs, very long
  session), summarize state into a file BEFORE the wall, because the
  recycle wipes working memory. Tool outputs over ~8K chars are pruned
  automatically; prefer asking tools for less over reading everything.
- **A config/preset edit that vanished after restart**: agent-preset rows
  (tools, subagent options) are re-authored by the app at every boot.
  Hand-edits and patch rows there do not survive. That is by design —
  the right fix is an app-side change, not a deeper hack. Report it.
- **Rate/quota limits (403/429 with "limit" wording)**: not a bug, a wall.
  Retrying burns turns for nothing. Say so to your person, name the reset
  window if the error gives one, and stop hammering.

## Current Anthropic model IDs (snapshot 2026-09, verify if it matters)

Exact strings — never append a date suffix (`-20251114` style is wrong):

| Model | ID | Note |
|---|---|---|
| Claude Opus 5 | `claude-opus-5` | default top tier |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | subagent/worker tier, cheaper than 4-6 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | cheapest, simple tasks |
| Claude Opus 4.6 / 4.7 / 4.8 | `claude-opus-4-6` / `-4-7` / `-4-8` | prior gen |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | prior gen |

Newer models may exist past this snapshot — an unfamiliar ID from your
operator is more current than this table, not a typo. Provider string for
the Anthropic route is `anthropic`.

## Knobs (env, set by whoever runs the app — relay these, don't guess)

- `DSH_SUBAGENT_MODEL` — pins the model your delegated subagents run on
  (Anthropic route defaults to `claude-sonnet-5-5`).
- `DSH_TURN_ERROR_RECYCLE` — consecutive-turn-error threshold for the
  self-recycle above (default 3, `0` disables).
- `STALL_TIMEOUT` — supervisor stall watchdog window, seconds.

## What is yours vs. app-owned

Yours: your data home (CLAUDE.md, notes, logs you write, skills your person
adds), and anything under it. App-owned: the installed app's files, lane
patches, authored presets — edits there are overwritten or break updates.
If the app misbehaves, the useful report is: the exact log line, when it
started, what you tried, and what changed — raw evidence beats a workaround
buried in your folder. External watchdog scripts in your own space are a
legitimate stopgap; say they exist when the real fix ships so they get
retired.
