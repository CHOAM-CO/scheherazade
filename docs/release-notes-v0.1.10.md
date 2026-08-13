# v0.1.10

## Web search that works on every backend

Claude Code's built-in WebSearch is an Anthropic server-side tool: on any
other model backend (ollama, deepseek, ...) it silently returns empty results.
This release bundles [chromux](https://github.com/modakbul-gongbang/chromux)
(zero-dependency Chrome-over-CDP CLI, MIT) as the backend-independent search
path:

- chromux ships as an app resource and syncs into the agent's data home
  (`bin/chromux-portable/`) on every boot, with `chromux` / `chromux.cmd`
  wrappers so the agent needs no PATH setup.
- A new `websearch` skill teaches the agent the flow (headless Chrome →
  Google results page → structured snapshot) and honest fallbacks (Chrome
  not installed → say so + WebFetch; CAPTCHA → report, don't loop).
- chromux's own bundled skills (`chromux`, `chromux-work`) are seeded for
  general browser automation.

Requires Google Chrome on the user's machine for the search path; everything
else degrades gracefully when it is absent.

## Chat activity feed actually works on Windows

Two stacked bugs kept the chat's "what am I doing" fold empty:

- On native Windows the shell tool is named `PowerShell`, not `Bash` — the
  activity hook's matcher never fired there at all, since the feature shipped.
- The 0.1.9 widening of the tool set (WebSearch/WebFetch/subagents) only
  reached fresh installs; existing installs kept their old matcher.

The hook now covers PowerShell, and the harness pins the activity matcher to
the current tool set on every boot, so existing installs are retrofitted by
this and every future update.
