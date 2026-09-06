// model-catalog.js — the ONE static model catalog, shared by the Engine page
// (connectors.js: full picker incl. Custom/Ollama-URL action sentinels) and
// the chat composer (chat.js: quick-switch dropdown, real models only).
//
// Extracted from connectors.js 2026-08-20 (0.2.6 UI pass) when the chat
// surface gained its own model dropdown (Mino 19:09: "LLM 모델 바꾸는건 세팅
// 말고 챗쪽에 드랍다운으로 두는게 더 편할 것 같음") — two inline copies of
// this list would drift. PURE DATA: no window.COPY reads, no sentinels, no
// DOM. Sentinel/action rows (Custom proxy, Ollama by-URL) stay in
// connectors.js — they are settings-page interactions, not models.
//
// Row provenance (compressed from the connectors.js comment block; full
// history in git blame of that file before this extraction):
// - claude-opus-5 added 08-13 (Mino ask), id verified against the installed
//   CLI binary's model table + runs live in the MAGI fleet daily.
// - GPT group: versioned 5.6 ids over the old single 'gpt' Codex entry.
// - Kimi provider-wide drop 07-14 (mute incident, raw <|tool_call|> leakage
//   on the local lane); kimi-k2.7-code is a DIFFERENT lane (ollama.com
//   cloud, Anthropic-compat) and returned on Mino's explicit ask 08-04.
//   The mute-strike ledger (hooks/stop-reply-guard.mjs) stays as backstop.
// - Ollama defaults picked by Mino 08-04 19:17 (kimi/glm/deepseek) and
//   expanded 08-13 ("5개~7개까지 기본지원 모델로") — every id verified
//   against the live ollama.com catalog + tool-call-probed through the
//   Anthropic-compat lane the same day. NOT picked, with grounds:
//   nemotron-3-super (72s first token), nemotron-3-nano:30b (never called
//   the tool), k2.6/m2.7/glm-5.1 (superseded in-family), gemma4:31b (too
//   small for agent duty). kimi-k3 sat here too (paywalled, 08-13) until
//   ollama.com opened it — added 08-21 on Mino's ask ("올라마 키미K3
//   지원기념 K3 ㄱ"), tool-call-probed same day through the local ollama
//   openai-compat surface (same protocol the lane speaks; lane auth path
//   is OLLAMA_CLOUD_KEY, probe rode the signin proxy).
// - DSH rows (0.2.1 harness swap): ids the lane's own patch layer serves —
//   keep in sync with dsh-lane.mjs buildPatch AND provider-env.cjs
//   DSH_LANE_MODELS. Availability rides computeAvailableProviders() 'dsh'.
;(() => {
  const CLAUDE_PROVIDERS = ['claude', 'claude-cli', 'claude-subscription']

  window.SCHZ_MODEL_CATALOG = [
    { id: 'claude-fable-5', label: 'Claude Fable 5', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'claude-opus-5', label: 'Claude Opus 5', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Claude', providers: CLAUDE_PROVIDERS },
    { id: 'gpt-6-astra', label: 'GPT 6 Astra', group: 'GPT', providers: ['chatgpt'] },
    { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', group: 'GPT', providers: ['chatgpt'] },
    { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', group: 'GPT', providers: ['chatgpt'] },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', group: 'GPT', providers: ['chatgpt'] },
    { id: 'kimi-k3', label: 'Kimi K3', group: 'Ollama', providers: ['ollama'] },
    { id: 'kimi-k2.7-code', label: 'Kimi 2.7 Code', group: 'Ollama', providers: ['ollama'] },
    { id: 'glm-5.2', label: 'GLM 5.2', group: 'Ollama', providers: ['ollama'] },
    { id: 'deepseek-v4-flash:0731', label: 'DeepSeek V4 Flash (0731)', group: 'Ollama', providers: ['ollama'] },
    { id: 'qwen3.5:397b', label: 'Qwen 3.5 (397B)', group: 'Ollama', providers: ['ollama'] },
    { id: 'minimax-m3', label: 'MiniMax M3', group: 'Ollama', providers: ['ollama'] },
    { id: 'gpt-oss:120b', label: 'GPT-OSS (120B)', group: 'Ollama', providers: ['ollama'] },
    { id: 'mistral-large-3:675b', label: 'Mistral Large 3 (675B)', group: 'Ollama', providers: ['ollama'] },
    { id: 'glm-5.2:cloud', label: 'GLM 5.2 (dsh)', group: 'DSH', providers: ['dsh'] },
    { id: 'qwen3.5:cloud', label: 'Qwen 3.5 (dsh · vision)', group: 'DSH', providers: ['dsh'] },
  ]

  // Effort ladder (Mino 07-13 click-test item 2). 'high' is run.sh's own
  // `${EFFORT_LEVEL:-high}` default; labels say so rather than pre-selecting
  // silently.
  window.SCHZ_EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
  window.SCHZ_EFFORT_DEFAULT = 'high'
})()
