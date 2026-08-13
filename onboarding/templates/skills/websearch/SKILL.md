---
name: websearch
description: Web search that works on every model backend. Use whenever you need to search the web — especially when the WebSearch tool is unavailable or keeps returning empty results (it is an Anthropic server-side tool and silently returns nothing on non-Anthropic backends like ollama/deepseek). Drives a real headless Chrome via the bundled chromux CLI.
version: 0.1.0
---

# Web search via chromux

The built-in WebSearch tool only works when your model backend is Anthropic.
On any other backend it returns empty results without an error — if you see
that, or you don't know your backend, use this path instead. It opens a real
headless Chrome on a Google results page and reads the page structure
directly, so it works regardless of backend and needs no API key.

## Resolving the command

The app syncs chromux into your data home (the directory with your CLAUDE.md,
session_notes, logs). Resolve ONCE per session, then inline the resolved
command literally in every call (shell variables do not persist across tool
calls):

- Windows: `<data-home>\bin\chromux.cmd`
- macOS/Linux: `<data-home>/bin/chromux` (or plain `chromux` if on PATH)

If the wrapper is missing, `node <data-home>/bin/chromux-portable/chromux.mjs`
is the same thing. If that directory does not exist at all, say so honestly —
the app version predates chromux bundling — and fall back to WebFetch on URLs
you already know.

## Search flow

Use a session id unique to this task (e.g. `ws-3f2a`). URL-encode the query.

```
chromux open ws-3f2a "https://www.google.com/search?q=<url-encoded+query>"
chromux snapshot ws-3f2a
```

The snapshot is an accessibility-tree text dump. Organic results appear as:

```
@23 link "Result title / Site name / displayed-url" -> https://real-url...
```

Read titles and URLs straight off those lines. Ignore google-internal links
(google.com, accounts.google.com, support.google.com paths).

To read one of the results, open it in the SAME session and snapshot again:

```
chromux open ws-3f2a "https://the-result-url"
chromux snapshot ws-3f2a
```

For a full flow reference (forms, extraction snippets, multi-tab), the
`chromux` skill covers the whole CLI; `chromux help` is the syntax source of
truth.

## Always close

When the task is done (success or failure):

```
chromux close ws-3f2a
```

## Failure modes — be honest, don't loop

- **First `open` is slow**: the first call auto-launches a headless Chrome
  profile; a few extra seconds is normal, not a hang.
- **Chrome not installed**: chromux errors mentioning it cannot find Chrome.
  Tell the user plainly that web search needs Google Chrome installed, and
  fall back to WebFetch for any URL you already have. Do not retry in a loop.
- **Bot-check / CAPTCHA page in the snapshot**: report it and try once more
  with a different phrasing; if it persists, stop and say search is blocked
  right now.
- **Node missing**: the wrappers run via `node`, which the agent harness
  already requires; if `node` itself is missing, report that the install is
  broken rather than improvising.
