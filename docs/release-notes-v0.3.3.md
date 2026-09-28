# v0.3.3

The model list is now a curated list rather than a growing one. Every group
was cut to the models the owner actually uses, and every id in it was checked
against the provider that serves it before it went in — the names in the
request were not taken at face value, and two of them did not match what the
catalogs contained.

| Group | Kept | Added | Removed |
|---|---|---|---|
| Claude | Opus 5.5, Opus 4.6, Sonnet 5 | Fable 5.1 | Fable 5, Opus 5, Opus 4.8 |
| GPT | Astra | Sol 6, Luna 6, Daybreak Blue | Sol 5.6, Terra 5.6, Luna 5.6 |
| Ollama | Kimi K3, DeepSeek V4.1 Flash, GLM 5.3, GLM 5.3 Flash | — | Kimi 2.7 Code, GLM 5.2, Qwen 3.5 (397B), MiniMax M3, GPT-OSS 120B, Mistral Large 3 |
| DSH | GLM 5.2 (dsh), Qwen 3.5 (dsh · vision) | — | — |

## The two names that did not resolve as typed

**"Fable 5.1" is a different model from the Fable 5 already in the list.**
`claude-fable-5-1` exists and is what the id resolves to; the row that was
there, `claude-fable-5`, is Fable 5 (created 2026-06-07 against 5.1's
2026-08-28). So this release swaps rather than keeps — the list does not carry
both.

**"Luna6" and "Sol6" are the `gpt-6-*` ids, not the `gpt-5.6-*` ids the catalog
carried.** The 5.6 rows were last served on 2026-09-23; the 6-family rows are
served continuously (9,559 Sol, 7,922 Luna and 6,951 Astra calls on the
reference fleet's proxy, all through 2026-09-28). There is no `gpt-6-terra` —
the 6-family is astra/sol/luna only — so Terra leaves the GPT group with no
replacement.

## How each id was verified

- **Claude** — `GET https://api.anthropic.com/v1/models/<id>` on the owner's
  account (the list endpoint costs no quota) returns 200 with the right display
  name for all four, and a deliberately bogus id (`claude-fable-9-nope`)
  returns 404, so the 200s discriminate. Cross-checked against the installed
  CLI binary's own model table, which agrees on all four at 1,000,000 tokens.
- **GPT** — the account's backend model list (`~/.codex/models_cache.json`,
  refetched 2026-09-28) carries all four, and the proxy's own usage log shows
  each one actually served, not merely offered.
- **Ollama** — the public `library/<name>/tags` pages, read directly, show a
  single `:cloud` tag for each of the four, with the same 1M context.

## Context windows

The GPT rows are pinned to the number the proxy itself reports, measured by
booting codex-as-api in-process with an empty `CODEX_HOME` so a machine's own
`config.toml` cannot skew the reading. All four measure the same there:
`{"context_window":200000,"auto_compact_token_limit":160000}`, which is the
proxy's unknown-model default — it still does not carry the 6-family in its
capability table, so the same 200,000 Astra has been pinned at since 0.2.20
holds for Sol, Luna and Daybreak too. A dev machine's own
`model_context_window` override shows up as 372,000 on `/health` and is not
the number to pin.

`tests/test-codex-proxy-model.mjs` re-proves this equality on every run for
every chatgpt row the catalog offers, and fails the suite if a pin drifts from
the live proxy. `Daybreak Blue` had no cap branch at all before this release,
which would have left its gauge rendering without a percentage; it has one now.

`Fable 5.1` joins the 1M pin set, and the retired Claude ids stay in that
table: a config saved before this release can still name one, and a pickable or
saved model with no cap silently loses its gauge.

## What this does not do

- **The Engine page can still list models outside this table.** That page
  re-reads the installed CLI's model table and the live Ollama tags at startup
  and shows anything it finds that the catalog lacks, so a model removed here
  can reappear there. That behaviour is deliberate — it is how a newly shipped
  model becomes pickable without an app update — and it was left alone. The
  chat composer's dropdown reads this catalog only, so it shows exactly the
  table above.
- **A config saved against a removed id keeps working, but declares less.** The
  lane reads its context window from the catalog, so an id that is no longer
  there falls back to the 131072 floor even when the proxy in front of it
  serves 272000. Picking one of the rows above restores the full number.

## Unchanged known issue

Stop on Windows is still a hard terminate and can leave MCP child processes
behind, exactly as described in the v0.3.1 notes. The soft
`control_request interrupt` path is still the follow-up; this release does not
touch it.
