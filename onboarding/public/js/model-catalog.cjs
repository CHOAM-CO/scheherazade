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
// Row provenance (compressed from the connectors.js comment block; full
// history in git blame of that file before the 0.2.6 extraction):
// - claude-opus-5 added 08-13 (the owner ask), id verified against the installed
//   CLI binary's model table + runs live in the the reference fleet daily.
// - claude-opus-5-5 added 2026-09-28 (the owner ask: the picker must offer the
//   model the reference fleet already runs — run-agent.sh:405 has pinned
//   CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5 since 09-23, so a picker without
//   it offers strictly less than the fleet's own workers). contextWindow
//   1000000 verified TWO ways, both agreeing: (1) GET
//   https://api.anthropic.com/v1/models/claude-opus-5-5 with this account's own
//   OAuth credential -> {display_name:"Claude Opus 5.5",
//   max_input_tokens:1000000, max_tokens:128000, created_at:2026-09-21}; (2) the
//   installed CLI binary's own table — extractClaudeModelsFromBin() over
//   ~/.local/share/claude/versions/2.1.283 -> claude-opus-5-5 = 1000000. Hence
//   claude-cli-table, like its opus neighbours.
//   ⚠️ An `ANTHROPIC_API_KEY=`-less `claude -p` probe is NOT a usable receipt on
//   this box and was not used as one: the shell carries
//   ANTHROPIC_BASE_URL=http://localhost:11434 (a local ollama), whose
//   404 model_not_found for any claude-* id is a property of that lane, not
//   evidence of absence; and pointed at the real endpoint the probe returns 429
//   "You've hit your weekly limit" for EVERY model, claude-haiku-4-5 included,
//   so it cannot discriminate one id from another. /v1/models does not consume
//   inference quota, which is why it is the receipt here.
// - GPT group: versioned 5.6 ids over the old single 'gpt' Codex entry.
// - Kimi provider-wide drop 07-14 (mute incident, raw <|tool_call|> leakage
//   on the local lane); kimi-k2.7-code is a DIFFERENT lane (ollama.com
//   cloud, Anthropic-compat) and returned on the owner's explicit ask 08-04.
//   The mute-strike ledger (hooks/stop-reply-guard.mjs) stays as backstop.
// - Ollama defaults picked by the owner 08-04 19:17 (kimi/glm/deepseek) and
//   expanded 08-13 ("5개~7개까지 기본지원 모델로") — every id verified
//   against the live ollama.com catalog + tool-call-probed through the
//   Anthropic-compat lane the same day. NOT picked, with grounds:
//   nemotron-3-super (72s first token), nemotron-3-nano:30b (never called
//   the tool), k2.6/m2.7/glm-5.1 (superseded in-family), gemma4:31b (too
//   small for agent duty). kimi-k3 sat here too (paywalled, 08-13) until
//   ollama.com opened it — added 08-21 on the owner's ask ("올라마 키미K3
//   지원기념 K3 ㄱ"), tool-call-probed same day through the local ollama
//   openai-compat surface (same protocol the lane speaks; lane auth path
//   is OLLAMA_CLOUD_KEY, probe rode the signin proxy).
// - 2026-09-16 Ollama catalog refresh (the owner ask: "올라마 최신 리스트 다시
//   긁기"). Scraped live the same day with `aside repl`: ollama.com/search?c=cloud
//   plus each candidate's /library/<name>/tags page. EVERY Ollama id below was
//   re-found in that scrape AND tool-call-probed against
//   https://ollama.com/v1/chat/completions (one get_weather function, key from
//   the ollama credential in the reference fleet's env) — each returned a real
//   tool_calls entry, not prose.
//   REPLACED: deepseek-v4-flash:0731 -> deepseek-v4.1-flash. The 0731 tag still
//   resolves and still calls tools, but its library page is a month stale
//   (tags: :cloud and :0731-cloud, same digest) while deepseek-v4.1-flash
//   landed 6 days ago (vision + tools + thinking, 1M context, single :cloud
//   tag) and is the model the reference fleet runs on two agents right now.
//   ADDED: glm-5.3 (2 weeks old, tools + thinking, 1M context, Z.ai's flagship
//   coding / long-horizon-agentic model). glm-5.2 STAYS beside it: the DSH lane's
//   patch pins glm-5.2:cloud, so dropping it would break a shipped lane.
//   ADDED on owner override (2026-09-17 00:08, verbatim "GLM5.3 flash는 다시
//   넣어줘"): glm-5.3-flash. This one goes IN over the 08-13 agent-duty size
//   bar, not through it — 18B active params is below where gemma4:31b was
//   rejected, and the owner picked it anyway. What IS verified: 3 weeks old,
//   vision + tools + thinking pills, single :cloud tag, and it returned a real
//   tool_calls entry on the same 2026-09-16 get_weather probe as the rest.
//   NOT ADDED, with grounds:
//   deepseek-v4-pro, glm-5.1, kimi-k2.6, minimax-m2.7 (superseded in-family, the
//   same rule that kept k2.6/m2.7/glm-5.1 out on 08-13); nemotron-3-ultra (the
//   nemotron family failed this list's probe bar on 08-13 and nothing re-tested
//   it); gemma4 and the small qwen3.5 tags (too small for agent duty).
//   KEPT DELIBERATELY: `qwen3.5:397b` is published on ollama.com only as
//   `qwen3.5:397b-cloud`, but the bare tag probes fine and must stay bare —
//   provider-env.cjs's normalizeOllamaCloudModel() strips any tag containing
//   'cloud', so `qwen3.5:397b-cloud` would collapse to a plain `qwen3.5` and
//   silently pick a different (much smaller) model.
// - GPT group, weekly-meter rule (2026-09-16, the owner ask). Source: the
//   ChatGPT usage API read through the reference fleet's
//   scripts/codex-usage-poll.sh, measured today:
//   `CODEX pro weekly 100% reset 2026-09-19 17:48 KST limit_reached=True
//   buckets[GPT-5.3-Codex-Spark=0%]`. gpt-5.6-sol / -terra / -luna AND
//   gpt-6-astra all draw from ONE pro weekly meter — picking a different row in
//   this group changes the model, never the quota. The only id with a bucket of
//   its own is GPT-5.3-Codex-Spark, which no row here offers (see the astra row
//   comment for why it is not added). This corrects the earlier assumption,
//   carried in this file and in the fleet, that luna was a separate cheaper lane.
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
    { id: 'claude-fable-5', label: 'Claude Fable 5', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-opus-5', label: 'Claude Opus 5', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Claude', providers: CLAUDE_PROVIDERS, contextWindow: 1000000, contextWindowSource: 'claude-cli-table' },
    // gpt-6-astra is 372K as a model, but codex-as-api 0.6.5 does not know
    // the gpt-6 family and serves its unknown-model default of 200000, which
    // is the window the lane in front of the user actually gets. The number
    // that matters is the one the thing we ship enforces, so 200000 it is —
    // re-raise when the proxy learns the family (same re-verify checklist
    // http-server.cjs's cap table carries).
    // RE-CHECKED 2026-09-16 and 200000 STANDS. The reference fleet's live
    // proxies report 372000 (/health on :18085 :18080 :18083 all return
    // {"context_window":372000,"auto_compact_token_limit":334800}), which reads
    // like the pin is stale — it is not. That box's ~/.codex*/config.toml files
    // each carry a hand-written `model_context_window = 372000`, and
    // codex-as-api 0.6.5's getContextWindow() returns the config value
    // whenever capabilityForModel(model).maxContextWindow is null, which it is
    // because gpt-6-astra is STILL absent from the package's
    // model_capabilities_default (grep: the table ends at gpt-5.2 plus
    // gpt-5.3-codex-spark). A user with no such config line gets
    // DEFAULT_CONTEXT_WINDOW = 2e5. So 372000 is the fleet's own override
    // leaking into /health, not a vendor number, and pinning it here would
    // under-report compaction for every normal install.
    { id: 'gpt-6-astra', label: 'GPT 6 Astra', group: 'GPT', providers: ['chatgpt'], contextWindow: 200000, contextWindowSource: 'codex-as-api-table' },
    // These three and gpt-6-astra above share ONE pro weekly meter (2026-09-16
    // provenance note in the header): the pick is a model choice, not a quota
    // choice. GPT-5.3-Codex-Spark is the only separately-metered id and is not
    // offered here — no live proxy on the reference fleet serves it (checked
    // 2026-09-16: /health on :18085 :18080 :18083 each advertise their ONE
    // configured model, none of them a spark id), so there is no /health
    // receipt to pin a contextWindow against and a row would be a guess.
    { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', group: 'GPT', providers: ['chatgpt'], contextWindow: 272000, contextWindowSource: 'codex-as-api-table' },
    { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', group: 'GPT', providers: ['chatgpt'], contextWindow: 272000, contextWindowSource: 'codex-as-api-table' },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', group: 'GPT', providers: ['chatgpt'], contextWindow: 272000, contextWindowSource: 'codex-as-api-table' },
    { id: 'kimi-k3', label: 'Kimi K3', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'kimi-k2.7-code', label: 'Kimi 2.7 Code', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'glm-5.3', label: 'GLM 5.3', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'glm-5.2', label: 'GLM 5.2', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'qwen3.5:397b', label: 'Qwen 3.5 (397B)', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'minimax-m3', label: 'MiniMax M3', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'gpt-oss:120b', label: 'GPT-OSS (120B)', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
    { id: 'mistral-large-3:675b', label: 'Mistral Large 3 (675B)', group: 'Ollama', providers: ['ollama'], contextWindow: DSH_DECLARED_CONTEXT_FLOOR, contextWindowSource: 'dsh-lane-declared' },
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
