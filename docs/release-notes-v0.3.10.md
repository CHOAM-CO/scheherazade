# v0.3.10

New models without an app rebuild.

- The model pickers now discover new ChatGPT models from your Codex cache
  and live account, plus Claude models with a saved credential and local
  Ollama models when using the local lane. Bundled choices stay available
  offline, and discovered choices are remembered for the next launch.
- New models use their discovered context windows in the lane and context
  gauge when the provider supplies one.
- The ChatGPT proxy uses the newest client version reported by your installed
  Codex CLI or model cache, so models such as GPT 6.1 Sol are not rejected
  because the bundled proxy identifies as an older client.
