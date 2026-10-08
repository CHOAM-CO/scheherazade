---
name: usage-budget
description: Read the user's Claude and Codex weekly / 5-hour usage percentages and reset times. Use at session start, before a large or delegating task, and whenever the user asks about quota, limits, or how much is left. Lets you budget yourself and tell the user before you slow down.
version: 0.1.0
---

# Usage budget

Run once, inline the resolved command literally:

- macOS/Linux: `<data-home>/bin/usage-budget`
- Windows: `<data-home>\bin\usage-budget.cmd`
- fallback: `node <data-home>/bin/agent-tools/usage-budget.cjs` (your cwd is the data home, so `node bin/agent-tools/usage-budget.cjs` works)

It reads `.usage-endpoint.json` in the data home (override with the
`SCHEHERAZADE_USAGE_ENDPOINT` env var) and prints one line per provider:

```
Claude 5h: 42% (resets 08 Oct, 21:30) / weekly: 80% (resets in 4d 3h)
Codex 5h: 10% (resets ...) / weekly: 31% (resets in 2d 1h)
```

If it prints `Claude usage: unknown`, the user has to run the Claude usage
login in Settings once; say so, do not guess a number.

Read only the meter of your own engine (Claude models -> Claude, GPT/Codex
models -> Codex, ollama -> none). Budget rules live in your system prompt
("Token budget"). The numbers are cached up to 60s; do not poll in a loop.
