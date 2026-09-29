// model-catalog.cjs — the ONE model catalog: ids, labels, groups, providers
// AND context windows, read by both sides of the app from this single file.
//
// Dual-environment on purpose, the same contract appearance-model.cjs has
// held since 0.2.6: the browser loads it as a plain classic <script> (it
// publishes window.SCHZ_MODEL_CATALOG / SCHZ_EFFORT_LEVELS /
// SCHZ_EFFORT_DEFAULT, the exact globals chat.js and connectors.js already
// read) and node require()s the SAME BYTES for the lane side. The extension
// is .cjs because package.json declares "type":"module", so a .js here would
// be ESM to node and unrequirable; http-server.cjs's MIME table already
// serves .cjs as text/javascript for exactly this pattern.
//
// WHY not a generated browser artifact (0.3 P4 decision): a generated copy is
// a second file that is correct only while someone remembers to regenerate
// it, which is the same failure mode as the hand-copied lists this file
// replaces — one file read two ways cannot drift, a generated one can and
// eventually does.
//
// WHAT THIS FILE IS NOT: it is not the context-gauge's cap table.
// onboarding/http-server.cjs's contextCapForModel() still owns the number the
// gauge divides by, because it also answers for ids that are NOT in this
// picker (claude-haiku-4-5, gpt-5.4/5.5, an older id still in a user's
// config) and it has a live tier that reads the installed CLI binary's own
// table. tests/test-context-gauge.mjs cross-checks the two, so a number that
// moves in one and not the other goes red instead of quiet.
//
// Row provenance. The KEEP-LIST is the owner's instruction of 2026-09-28 (the
// picker should offer only what we actually run). The IDS below are not the
// names he typed: each was verified per provider before its row was written,
// because a picker row naming an id no provider serves is a dead option that
// looks alive. Receipts, one per provider:
//   (a) CLAUDE — `GET https://api.anthropic.com/v1/models/<id>` with this
//       account's own OAuth credential returns 200 with display_name
//       "Claude Fable 5.1" for `claude-fable-5-1`, while a control id
//       (`claude-fable-9-nope`) returns 404 — so a 200 means the id exists,
//       not merely that the route answers. Cross-checked against the installed
//       CLI binary's own model table (extractClaudeModelsFromBin), which agrees
//       on 1000000. Hence claude-cli-table for every Claude row.
//   (b) CODEX — the backend's `~/.codex/models_cache.json` lists gpt-6-astra,
//       gpt-6-sol, gpt-6-luna and gpt-daybreak-blue-latest, all at ctx 272000,
//       and the proxy's own live usage log `codex-as-api-usage.jsonl` shows all
//       four actually served through :18085 (9559 gpt-6-sol, 7922 gpt-6-luna,
//       6951 gpt-6-astra, 222 daybreak). The retired gpt-5.6-* rows were last
//       served 2026-09-23, and gpt-5.6-terra never appears in that log at all.
//   (c) OLLAMA — ollama.com /library/<name>/tags carries a single `:cloud` tag
//       each for kimi-k3, deepseek-v4.1-flash, glm-5.3 and glm-5.3-flash.
// WHAT LEFT, AND WHY (one line per ID GROUP; the long per-id histories are in
// this file's git blame before the 2026-09-28 prune, not reproduced here):
//   Claude — claude-fable-5, claude-opus-5, claude-opus-4-8: superseded
//     in-family by the fable-5-1 / opus-5-5 rows above, which are what the
//     reference fleet boots today.
//   GPT — gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna: replaced by the gpt-6
//     family (last served 2026-09-23; terra never served). All GPT rows share
//     ONE pro weekly meter (usage-API receipt 2026-09-16 via the fleet's
//     scripts/codex-usage-poll.sh: `limit_reached=True
//     buckets[GPT-5.3-Codex-Spark=0%]`), so picking a row changes the model,
//     never the quota. GPT-5.3-Codex-Spark is still NOT offered: no proxy
//     /health advertises it, so a row would have no receipt to pin.
//   Ollama — kimi-k2.7-code (Kimi provider-wide drop 07-14 after raw
//     <|tool_call|> leakage on the local lane; hooks/stop-reply-guard.mjs's
//     mute-strike ledger stays as backstop), the bare `glm-5.2` ollama row
//     (the DSH `glm-5.2:cloud` row below is a DIFFERENT lane and stays —
//     the lane's patch pins that exact tag), `qwen3.5:397b`, `minimax-m3`,
//     `gpt-oss:120b`, `mistral-large-3:675b`. The 08-13 and 09-16 ollama pick
//     lists these came off are superseded; only the four cloud tags in receipt
//     (c) survive.
// - DSH rows (0.2.1 harness swap): ids the lane's own patch layer serves.
//   provider-env.cjs's DSH_LANE_MODELS is still a hand-typed copy of these
//   two ids; it should read them from here (see the P4 report).
;(function (root) {
  'use strict'

  const CLAUDE_PROVIDERS = ['claude', 'claude-cli', 'claude-subscription']

  // The dsh lane declares a contextWindow for every hand-declared model row
  // it emits (dsh-lane.mjs buildPatch). Before 0.3 P4 that number was one
  // blanket 131072 for whatever model was configured, which is right for the
  // ollama tags we have no better receipt for and WRONG for the codex route:
  // codex-as-api 0.6.5 advertises 272000 for every gpt-5.x slug, so the
  // engine was compacting a ChatGPT lane against a window less than half the
  // real one. 131072 stays as the floor for a model this catalog does not
  // know (a custom-proxy id, an ollama tag picked by URL) — it is the value
  // that shipped, so an unknown model behaves exactly as it did.
  const DSH_DECLARED_CONTEXT_FLOOR = 131072

  // contextWindowSource is carried per row, not inferred, because the three
  // tiers mean genuinely different things and a reader deciding whether to
  // trust a number needs to know which one it is:
  //   claude-cli-table    the installed CLI binary's own model table — what
  //                       the CLI actually budgets autocompact against.
  //   codex-as-api-table  the proxy's model table, confirmed live against
  //                       its /health (tests/test-codex-proxy-model.mjs
  //                       re-proves this on every run).
  //   dsh-lane-declared   no third-party receipt exists for this id; the
  //                       number is the one OUR patch layer declares to the
  //                       engine. Honest about being ours rather than
  //                       dressed up as the vendor's.
  const MODELS = [
    // Claude: the four ids the picker offers, all 1M / claude-cli-table
    // (receipt (a) above). Order is the owner's keep-list.
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    // GPT: 200000 for all four, MEASURED not assumed (2026-09-28) by booting
    // the proxy in-process with an EMPTY CODEX_HOME — the number a fresh
    // install gets, which is the one we ship. Raw /health, one line per id
    // (auto_compact_token_limit = 0.8 x window):
    //   {"id":"gpt-6-astra","context_window":200000,"auto_compact_token_limit":160000}
    //   {"id":"gpt-6-luna","context_window":200000,"auto_compact_token_limit":160000}
    //   {"id":"gpt-6-sol","context_window":200000,"auto_compact_token_limit":160000}
    //   {"id":"gpt-daybreak-blue-latest","context_window":200000,"auto_compact_token_limit":160000}
    // With CODEX_HOME UNSET on this dev box all four instead read
    // 372000/334800 — that is this machine's ~/.codex/config.toml
    // `model_context_window = 372000` leaking into /health, not a vendor
    // number, which is exactly why the pin is the empty-home reading (the
    // gpt-6 family is absent from the proxy's model_capabilities_default, so
    // an unconfigured install gets the package default 2e5).
    // tests/test-codex-proxy-model.mjs re-proves all four on every run.
    { id: 'gpt-6-astra', label: 'GPT 6 Astra', group: 'GPT', providers: ['chatgpt'], contextWindow: 200000, contextWindowSource: 'codex-as-api-table' },
    { id: 'gpt-6-luna', label: 'GPT 6 Luna', group: 'GPT', providers: ['chatgpt'], contextWindow: 200000, contextWindowSource: 'codex-as-api-table' },
    { id: 'gpt-6-sol', label: 'GPT 6 Sol', group: 'GPT', providers: ['chatgpt'], contextWindow: 200000, contextWindowSource: 'codex-as-api-table' },
    { id: 'gpt-daybreak-blue-latest', label: 'GPT Daybreak Blue', group: 'GPT', providers: ['chatgpt'], contextWindow: 200000, contextWindowSource: 'codex-as-api-table' },
    // Ollama: the four cloud tags with a live ollama.com receipt (receipt (c)
    // above). No third-party window receipt exists for them, so the number is
    // OUR declared floor rather than a vendor figure we would be guessing at.
    { id: 'kimi-k3', label: 'Kimi K3', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'glm-5.3', label: 'GLM 5.3', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    // DSH rows: `glm-5.2:cloud` stays even though the bare ollama glm-5.2 row
    // left on 2026-09-28 — the lane's patch pins this exact tag (see the DSH
    // note in the header).
    { id: 'glm-5.2:cloud', label: 'GLM 5.2 (dsh)', group: 'DSH', providers: ['dsh'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'qwen3.5:cloud', label: 'Qwen 3.5 (dsh · vision)', group: 'DSH', providers: ['dsh'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
  ]

  // Effort ladder (the owner 07-13 click-test item 2). 'high' is run.sh's own
  // `${EFFORT_LEVEL:-high}` default; labels say so rather than pre-selecting
  // silently.
  const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
  const EFFORT_DEFAULT = 'high'

  // The reasoningEfforts map dsh-lane.mjs declares on every hand-declared
  // model row. It is NOT the same list as EFFORT_LEVELS above and the two are
  // kept separate on purpose rather than reconciled here: the lane declares
  // 'off' (which no picker offers) and does NOT declare 'medium' (which the
  // picker does offer, and which provider-env.cjs passes through verbatim as
  // DSH_EFFORT). Making them one list would silently either add an undeclared
  // effort to the lane or remove a level from the UI; both are decisions with
  // a live-behaviour blast radius, so they belong to whoever verifies against
  // a running engine, not to a refactor. Written down side by side here so
  // the gap is visible in one file instead of two.
  const DSH_REASONING_EFFORTS = ['off', 'low', 'high', 'max']

  const BY_ID = new Map(MODELS.map((m) => [m.id, m]))
  function byId(id) {
    return BY_ID.get(String(id || '')) || null
  }

  // The lane's question: "what window do I declare for this model id?" An id
  // the catalog does not carry (custom proxy, ollama-by-URL pick, a
  // hand-edited config) keeps the pre-0.3 blanket value, so nothing that
  // works today starts declaring a different number.
  function dshContextWindowFor(id) {
    const row = byId(id)
    return row && Number.isInteger(row.contextWindow) && row.contextWindow > 0
      ? row.contextWindow
      : DSH_DECLARED_CONTEXT_FLOOR
  }

  const catalog = {
    MODELS,
    EFFORT_LEVELS,
    EFFORT_DEFAULT,
    DSH_REASONING_EFFORTS,
    DSH_DECLARED_CONTEXT_FLOOR,
    byId,
    dshContextWindowFor,
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = catalog
  } else {
    // Browser globals keep their pre-0.3 names and shapes: chat.js and
    // connectors.js read window.SCHZ_MODEL_CATALOG as a plain array and the
    // two effort globals as before, so the page code needed no change when
    // the data moved into this file.
    root.SCHZ_MODEL_CATALOG = MODELS
    root.SCHZ_EFFORT_LEVELS = EFFORT_LEVELS
    root.SCHZ_EFFORT_DEFAULT = EFFORT_DEFAULT
    root.SCHZ_CATALOG = catalog
  }
})(typeof window !== 'undefined' ? window : globalThis)
