# v0.1.6 — silence is now illegal

Every fix in this release is about the same disease: the agent failing
WITHOUT TELLING YOU. Four separate silent-death mechanisms were found, live-
reproduced, and each one now either fails loud or reports itself.

## Silent-death fixes

- **Bad model tag fails at boot, loudly.** A model name the provider doesn't
  have used to make `claude -p` exit 0 with no error event — no breaker, no
  banner, just eternal silence. The lane now probes the provider with the
  exact model before spawning; a definitive not-found writes the error
  banner and refuses to boot. (Auth errors / timeouts still fail open.)
- **Rate-limit retry storms are visible.** On a provider 429 the CLI silently
  retries up to 10× at 60s intervals — up to ten minutes of dead air whose
  only trace was a stream event the lane dropped (and which reset the
  turn watchdog, disarming the net built for exactly this). Every retry now
  logs (`retry n/10 — the turn is WAITING, not dead`) and from the second
  consecutive retry the error banner names the quota wall.
- **Mutes announce themselves in the messenger.** When the model does the
  work but never calls the reply tool, the stop guard already convicted it
  and the panel showed a banner — but the messenger, where you actually
  live, showed nothing. The channel backend now posts a direct system line
  ("답장이 만들어지고도 전송되지 않았어, n회차") to the conversation the
  moment the strike ledger rises. Not model-mediated: a muted model cannot
  suppress its own obituary.
- **The turn transcript log actually logs.** The 0.1.4 log-ring feature
  (one line per tool call / reply preview in panel Logs) shipped as dead
  code — an unreachable duplicate branch. Fixed; panel Logs now shows what
  the agent DID during a turn, which is how half the bugs above were
  diagnosed.

## Model catalog

- **Claude Opus 5 is in the picker** (1M context, verified against the CLI's
  own model table).
- **Dynamic Claude model list**: the app now scans the installed claude CLI
  binary's model table at runtime and merges anything new into the picker —
  with working context gauges. New Claude models appear when the CLI
  updates, no app release needed.
- **Ollama defaults expanded 3 → 7**: Qwen 3.5 (397B), MiniMax M3,
  GPT-OSS (120B), Mistral Large 3 (675B) join GLM 5.2 / DeepSeek V4 Flash /
  Kimi 2.7 Code. Every id verified against the live ollama.com catalog AND
  live tool-call-probed through the Anthropic-compat lane the same day.
  (Rejected with receipts: kimi-k3 = paywalled, nemotron-super = 72s first
  token, nemotron-nano = never calls tools.)
- Vision gate fix: gpt-oss was misclassified as vision-capable by a `^gpt`
  pattern; one image would have poisoned its transcript. Now correctly
  vision-less.

## Usage gauge

- **Claude usage no longer wedges on HTTP 429.** Failures now arm a cooldown
  (honoring Retry-After) instead of re-hitting the rate-limited endpoint on
  every refresh, and an app-token refusal of ANY kind falls back to the
  machine's CLI login before giving up.
