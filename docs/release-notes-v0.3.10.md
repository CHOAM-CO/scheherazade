# v0.3.10

New ChatGPT models without an app rebuild.

- GPT 6.1 Sol is available now, with its 272,000-token context window.
- The model pickers discover future ChatGPT models from your Codex cache
  and live account, and remember them for offline launches. Previously
  removed choices stay out of the picker.
- Newly discovered models use their provider-reported context windows in
  the lane and context gauge.
- The ChatGPT proxy uses the newest client version reported by your installed
  Codex CLI or model cache, so new models are not rejected because the
  bundled proxy identifies as an older client.
