// provider-env.cjs — pure provider-env-building logic for the spawned agent
// child (main.cjs's spawnRealAgentChild()). 4-provider-mode wiring
// (2026-07-04), additive.
//
// Extracted into its OWN Electron-free module, rather than added as a
// function inside main.cjs, for exactly one reason: main.cjs calls
// `app.requestSingleInstanceLock()` (electron) at module TOP LEVEL (see its
// own header), so `require('./main.cjs')` throws immediately outside a
// running Electron main process -- there is no way to unit-test main.cjs's
// own code by requiring it directly. This file has zero Electron
// dependency (readProviderKey is INJECTED via `deps`, never required
// directly here), so scripts/test-provider-env.mjs can require it standalone
// and assert against every branch with a fake readProviderKey.
//
// Ground truth this mirrors (MAGI's OWN proven-live fleet wiring,
// ~/Desktop/MAGI/run-agent.sh):
//   - skia (gpt-5.5 via codex-as-api proxy), line ~194:
//       export ANTHROPIC_BASE_URL=http://localhost:18080
//     -- no ANTHROPIC_API_KEY set at all in that block.
//   - skia-ollama (kimi via ollama direct), lines ~202-205:
//       MODEL=kimi-k2.7-code:cloud
//       export ANTHROPIC_BASE_URL=http://localhost:11434
//       export ANTHROPIC_API_KEY=ollama
//       SKIP_MODEL_GUARD=1
//   - sirin (Gemini via antigravity-proxy, its OWN later/more-hardened
//     entry, lines ~237-241):
//       export ANTHROPIC_BASE_URL=http://localhost:18090
//       export ANTHROPIC_API_KEY=sk-proxy-passthrough
//     with the explicit comment: "Force api-key auth -> CLI does NOT send
//     ~/.claude OAuth bearer to the local proxy. Proxy holds its own Google
//     OAuth (accounts.json)... Without this, default account-1 OAuth leaks
//     to :18090."
//
// DELIBERATE DIVERGENCE from skia's literal shape, flagged here and in the
// task report: skia's own block sets NO ANTHROPIC_API_KEY, but skia runs
// under an account that already has an interactively-authenticated
// ~/.claude(.json) OAuth session from a prior manual `claude login` --
// sirin's later comment above explains that WITHOUT an explicit
// ANTHROPIC_API_KEY, the CLI falls back to sending that existing OAuth
// bearer to whatever ANTHROPIC_BASE_URL points at. scheherazade's target
// user is the OPPOSITE precondition -- a fresh Mac with NO prior `claude
// login` (that is the entire reason main.cjs's Critical-A BYOK-key-forward
// fix exists at all) -- so mirroring skia's bare shape here risks either
// (a) hanging at claude's own missing-credential prompt (no OAuth session
// AND no key), or (b) on a machine that DOES have some stray auth (e.g. a
// leftover claude-subscription token from a previous provider switch on the
// same real ~/.claude.json -- this app sets no CLAUDE_CONFIG_DIR override,
// see http-server.cjs's own ensureClaudeOnboardingDone() comment), silently
// leaking that unrelated credential to the local codex-as-api proxy exactly
// as sirin's fix describes. This module instead follows sirin's *more
// hardened* pattern for BOTH new local-proxy modes (chatgpt AND ollama):
// always set an explicit ANTHROPIC_API_KEY, and always explicitly clear
// (set `undefined`, which Node's child_process correctly treats as "omit
// this var from the child's env" -- verified empirically, see this repo's
// task report) whichever of ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL /
// CLAUDE_CODE_OAUTH_TOKEN the OTHER 3 modes use, so no stale value can leak
// across a provider switch via `...process.env` inheritance in main.cjs's
// spawn() call. UNVERIFIED end-to-end (no live spawn against a real
// codex-as-api proxy done as part of this change) -- see task report's
// gaps list.
//
// 2026-07-25 addition: a 5th mode, 'custom' (generic OpenAI-compatible
// proxy), added later/separately from the "4-provider-mode wiring" batch
// this header otherwise describes -- not folded into the history above.
// See that branch's own comment in buildProviderEnv below for its rationale.
'use strict'

const CHATGPT_PROXY_DEFAULT_PORT = '18080'
const OLLAMA_BASE_URL = 'http://localhost:11434'

// Clearly-labeled placeholder -- never a real Anthropic key, never sent
// anywhere the codex-as-api proxy doesn't itself receive it. Shaped loosely
// like an Anthropic key (sk- prefix) only so any future code that happens to
// sniff the prefix doesn't choke; scheherazade's own code does no such
// sniffing today (grepped: no `sk-ant-` / `startsWith('sk-')` check outside
// onboarding/public copy strings, which are UI hints only, not enforced).
const CHATGPT_PLACEHOLDER_KEY = 'sk-codex-proxy-passthrough-not-a-real-key'

// Same shape/reasoning as CHATGPT_PLACEHOLDER_KEY above, for the 'custom'
// provider's own OPTIONAL key case (see that branch below): a clearly-
// labeled placeholder, never a real Anthropic key, used only when the user
// did not configure a key for their proxy (plenty accept any bearer value,
// or none at all).
const CUSTOM_PLACEHOLDER_KEY = 'sk-custom-proxy-no-key-configured'

/**
 * resolveChatgptProxyPort(rawPort) -> { port } | { error }
 *
 * Single source of truth for "is this a syntactically valid chatgpt proxy
 * port", consulted at BOTH spawn-time (buildProviderEnv's 'chatgpt' branch,
 * immediately below) and validation-time (onboarding/http-server.cjs's
 * checkLocalLiveness ping, /api/byok/validate) -- extracted (Codex finding
 * #5, 2026-07-04) so the two guards can never drift apart again. Before this
 * extraction, http-server.cjs:809 interpolated `opts.proxyPort` straight
 * into a `http://localhost:${port}` liveness-ping URL with NO guard at all,
 * while this file's spawn-time branch rejected anything that wasn't
 * digits-only + in the 1-65535 TCP range -- a crafted proxyPort like
 * "18080@evil.example" would (a) make the validation ping hit a
 * NON-localhost host (userinfo@host smuggled into the URL) and (b) report
 * "reachable" for a value spawn-time would later reject outright.
 *
 * `rawPort` may be undefined/null/'' -- both call sites treat "not
 * provided" as "use the default port", not as an error, so that case
 * resolves to `{ port: CHATGPT_PROXY_DEFAULT_PORT }` here rather than
 * needing an if/else at each call site.
 *
 * Returns `{ port }` (the trimmed, validated port string) on success. On
 * failure returns `{ error: reason }` where `reason` is a plain string --
 * deliberately NOT this file's own `{ kind, reason }` error-object shape,
 * so each caller can wrap it however fits its own convention (buildProviderEnv
 * below wraps it as `{ error: { kind: 'provider_not_wired', reason } }`,
 * exactly preserving its pre-extraction shape; http-server.cjs's liveness
 * check wraps it as a non-blocking `{ ok: true, reachable: false, detail }`
 * result instead of throwing/rejecting).
 */
function resolveChatgptProxyPort(rawPort) {
  if (rawPort === undefined || rawPort === null || String(rawPort).trim() === '') {
    return { port: CHATGPT_PROXY_DEFAULT_PORT }
  }
  const p = String(rawPort).trim()
  // SSRF guard (Codex review 2026-07-04): digits-only + valid TCP range so a
  // crafted value like "18080@evil.example" can't smuggle a host into the URL
  // that Claude Code (spawn-time) or the liveness ping (validation-time)
  // would then hit.
  if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535) {
    return { error: `chatgpt proxy port "${p}" is not a valid TCP port (1-65535)` }
  }
  return { port: p }
}

/**
 * resolveCustomBaseUrl(rawUrl) -> { url } | { error }
 *
 * Single source of truth for "is this a syntactically valid custom-provider
 * base URL", consulted at BOTH spawn-time (buildProviderEnv's 'custom'
 * branch below) and validation-time (onboarding/http-server.cjs's
 * validateProviderKey 'custom' branch) -- same "extracted so the two guards
 * can never drift apart" reasoning as resolveChatgptProxyPort above, applied
 * to a full URL instead of a bare port.
 *
 * Deliberately NOT restricted to localhost (unlike resolveChatgptProxyPort's
 * SSRF guard, which exists because THAT function's input is a bare port
 * interpolated into a hardcoded `http://localhost:${port}` template): the
 * entire point of the 'custom' provider is letting the user point at any
 * OpenAI-compatible proxy, which may legitimately be a remote host. This
 * only rejects what can never be a usable ANTHROPIC_BASE_URL: empty, not a
 * parseable URL, or not http(s).
 *
 * Returns `{ url }` (the trimmed, validated URL string -- NOT re-serialized
 * via the parsed URL object, so nothing the user typed is silently changed,
 * e.g. no trailing slash added) on success. On failure returns
 * `{ error: reason }`, a plain string, same convention as
 * resolveChatgptProxyPort's error shape.
 */
function resolveCustomBaseUrl(rawUrl) {
  if (rawUrl === undefined || rawUrl === null || String(rawUrl).trim() === '') {
    return { error: 'CUSTOM_BASE_URL is required for the custom provider' }
  }
  const trimmed = String(rawUrl).trim()
  // Length gate BEFORE anything interpolates the value. Two reasons, and the
  // second is the one that bit: (a) nothing that long is a base URL anyone
  // meant to type; (b) every error below quotes it, and these errors reach a
  // one-line status element in the settings page. readJsonBody accepts 1 MB,
  // so a ~950 KB baseUrl produced a ~950 KB 400 body from BOTH
  // /api/agent/custom-provider and /api/byok/validate -- a red-team
  // measurement, and a defect the preview route's own response cap did not
  // touch because it lives in a different handler. Bounding the value here
  // fixes every caller at once instead of one route at a time. 2048 is the
  // conventional practical URL ceiling and is far past any real proxy URL.
  if (trimmed.length > 2048) {
    return { error: `custom base URL is too long (${trimmed.length} characters, limit 2048)` }
  }
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch (err) {
    return { error: `custom base URL "${trimmed}" is not a valid URL: ${err.message}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `custom base URL "${trimmed}" must use http:// or https://` }
  }
  return { url: trimmed }
}

/**
 * parseCustomProviderJson(text) -> { baseUrl, apiKey, model } | { error }
 *
 * Accepts a pasted provider definition and reduces it to the three fields
 * the 'custom' provider actually runs on. Two shapes are understood:
 *
 *   flat      { baseUrl, apiKey?, model }         (or `models: [...]`)
 *   nested    { providers: { "<id>": { baseUrl, apiKey?, api?,
 *                                      models: [{ id }, ...] } } }
 *
 * The nested shape is the one other tools in this space hand out, so a user
 * who already has one should not have to retype it into three boxes.
 *
 * WHAT THIS DELIBERATELY REFUSES, rather than accepting and quietly doing
 * less than the paste says:
 *
 *  - MORE THAN ONE PROVIDER, or more than one model. This app runs exactly
 *    one PROVIDER/MODEL pair at a time (see .agent-config). Taking the first
 *    entry of a five-provider paste would look like it worked and then run
 *    something the user did not pick. The error names the count so the fix
 *    is obvious.
 *  - AN `api` DIALECT WE CANNOT SPEAK. The spawned Claude Code CLI emits
 *    Anthropic Messages requests at ANTHROPIC_BASE_URL and nothing else;
 *    this app has no request translation layer. A proxy declaring
 *    `api: "openai-completions"` may well still work (codex-as-api and
 *    friends accept Anthropic-shaped bodies at an OpenAI-ish endpoint), but
 *    that is the PROXY's compatibility, not ours to promise -- so anything
 *    other than an explicit anthropic-messages (or no declaration at all)
 *    is refused with the reason spelled out. Silently ignoring the field
 *    would be the app claiming a capability it does not have.
 *
 * Returns plain-string `error` (same convention as resolveCustomBaseUrl
 * above), so the HTTP caller can wrap it as a 400 body verbatim.
 */
const CUSTOM_JSON_SUPPORTED_API = 'anthropic-messages'

function parseCustomProviderJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { error: 'paste a provider definition (JSON) first' }
  }
  // Shared by every check below: an explicit null means "not specified", the
  // same as omitting the field. JSON emitters write nulls for unset optional
  // fields routinely, and treating one as a value produced both a false
  // refusal (a null inside an entry "disagreeing" with a top-level value) and
  // a bogus type error (`models: null` reaching the non-empty-array check).
  const present = (v) => v !== undefined && v !== null
  // Structural equality with key order normalised. `===` is identity for
  // objects, so two byte-identical values written at both levels refused as
  // "different values" -- and the advice in that message could not be
  // followed. A plain JSON.stringify compare had the opposite bug, calling
  // two identical objects with different key order different. Both were real.
  const sameValue = (a, b) => {
    if (a === b) return true
    const norm = (v) => (Array.isArray(v)
      ? v.map(norm)
      : (v && typeof v === 'object' ? Object.keys(v).sort().map((k) => [k, norm(v[k])]) : v))
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { error: `that is not valid JSON: ${snip(err.message)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'expected a JSON object describing one provider' }
  }

  // ── the dialect declaration, wherever it appears ────────────────────────
  // Checked at the top level, on the unwrapped provider entry, and on every
  // model row. Checking only the unwrapped entry was a real hole: a file
  // saying `{"api": "openai-completions", "providers": {...}}` -- the natural
  // place for a GLOBAL dialect -- sailed straight through the gate this
  // function advertises. Not exhaustive and not claimed to be: an `api` buried
  // under some wrapper key this parser does not read (`{"options":{"api":…}}`)
  // is still ignored. Chasing arbitrary nesting costs more than it buys.
  const dialectError = (value, where) => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') {
      return `"api"${where} must be a string, but the paste has ${describeType(value)}`
    }
    if (value.trim() !== CUSTOM_JSON_SUPPORTED_API) {
      return `this app speaks ${CUSTOM_JSON_SUPPORTED_API} only (the bundled Claude Code CLI emits nothing else and there is no translation layer here), but the paste declares api "${snip(value)}"${where} -- remove the field if your endpoint accepts Anthropic-shaped requests anyway`
    }
    return null
  }

  // ── unwrap `providers`, merging top-level fields as defaults ────────────
  // A top-level field is a DEFAULT the entry may override, not a conflict:
  // `{"apiKey":"sk-1","providers":{"p":{"baseUrl":…}}}` is an ordinary shape
  // (one key, one endpoint map) and refusing it outright -- which an earlier
  // version did, on mere presence -- rejects a paste that says exactly one
  // thing. Only an actual DISAGREEMENT is ambiguous, and only that is refused.
  let entry = parsed
  if (parsed.providers !== undefined) {
    if (!parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
      return { error: '"providers" must be an object keyed by provider id' }
    }
    const topDialect = dialectError(parsed.api, ' (at the top level)')
    if (topDialect) return { error: topDialect }
    const ids = Object.keys(parsed.providers)
    if (ids.length === 0) return { error: '"providers" is empty -- nothing to configure' }
    if (ids.length > 1) {
      return { error: `this app runs one provider at a time, but the paste declares ${ids.length} (${summarizeNames(ids)}) -- keep the one you want and remove the rest` }
    }
    const inner = parsed.providers[ids[0]]
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      return { error: `provider "${snip(ids[0])}" is not an object` }
    }
    // A provider entry containing its own `providers` map is a second set of
    // providers this function would otherwise drop whole -- dialect, endpoint
    // and all. That is the same silent narrowing the >1-provider refusal
    // exists to prevent, so it gets the same treatment.
    if (inner.providers !== undefined) {
      return { error: `provider "${snip(ids[0])}" contains its own "providers" -- flatten the paste so it describes exactly one provider` }
    }
    // null counts as ABSENT here, exactly as it does at every field-level
    // check below -- an emitter writing `"apiKey": null` for an unset option
    // is the same emitter this function already accommodates, and treating
    // that null as a competing value re-created the false refusal the merge
    // was written to remove. Scalars compare by value; `models` compares by
    // identity of the resolved id list, because two byte-identical model rows
    // written in different key order are not a disagreement (a JSON.stringify
    // comparison called them one). Both were red-team catches, 2026-07-29.
    const modelIds = (v) => (Array.isArray(v)
      ? v.map((m) => (typeof m === 'string' ? m : (m && typeof m === 'object' ? m.id : null))).join(' ')
      : null)
    entry = {}
    for (const k of ['baseUrl', 'apiKey', 'model', 'models', 'api']) {
      const top = parsed[k]
      const own = inner[k]
      if (present(own) && present(top)) {
        const differs = k === 'models' ? modelIds(own) !== modelIds(top) : !sameValue(own, top)
        if (differs) {
          return { error: `the paste sets "${k}" twice with different values (top level and inside "${snip(ids[0])}") -- keep the one that describes the provider you want` }
        }
      }
      // Only a PRESENT value is carried down. Assigning an explicit null here
      // would defeat the null-as-absent rule above: `models: null` survived
      // the merge and then tripped the non-empty-array refusal.
      const chosen = present(own) ? own : top
      if (present(chosen)) entry[k] = chosen
    }
  }

  const entryDialect = dialectError(entry.api, '')
  if (entryDialect) return { error: entryDialect }
  if (Array.isArray(entry.models)) {
    for (const m of entry.models) {
      if (!m || typeof m !== 'object') continue
      const modelDialect = dialectError(m.api, ` (on model "${snip(m.id)}")`)
      if (modelDialect) return { error: modelDialect }
      // A model row carrying its OWN endpoint or key is a per-model override
      // this app cannot honour -- one PROVIDER/MODEL pair runs at a time, and
      // the row's values would be dropped whole while the paste reported
      // success. This function already walks these rows (it reads `api` and
      // `id` right here), so ignoring these two is silent narrowing at a level
      // it demonstrably reads -- not the out-of-scope deep nesting the note
      // above disclaims. (Red-team catch, 2026-07-29.)
      for (const k of ['baseUrl', 'apiKey']) {
        if (m[k] !== undefined && m[k] !== null) {
          return { error: `model "${snip(m.id)}" carries its own "${k}" -- this app runs one endpoint at a time, so move it up to the provider or remove it` }
        }
      }
    }
  }

  // ── the model id ────────────────────────────────────────────────────────
  // `model` gets the same TYPE refusal as `api` and `apiKey`. It used to be
  // read as `typeof entry.model === 'string' ? ... : ''`, so a wrongly-typed
  // one was silently dropped and `models` quietly won -- three sibling fields,
  // two of which refused a bad type and one of which did not.
  if (entry.model !== undefined && entry.model !== null && typeof entry.model !== 'string') {
    return { error: `"model" must be a string, but the paste has ${describeType(entry.model)} -- fix it or remove it` }
  }
  let model = ''
  if (present(entry.models)) {
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      return { error: '"models" must be a non-empty array' }
    }
    if (entry.models.length > 1) {
      const names = entry.models.map((m) => (m && typeof m === 'object' ? m.id : m))
      return { error: `this app runs one model at a time, but the paste declares ${entry.models.length} (${summarizeNames(names)}) -- keep the one you want and remove the rest` }
    }
    const only = entry.models[0]
    model = typeof only === 'string' ? only : (only && typeof only === 'object' && typeof only.id === 'string' ? only.id : '')
    if (!model) return { error: 'the model entry has no usable "id"' }
    // Both fields present and disagreeing: the paste states two models. An
    // agreeing duplicate is fine -- a tool emitting both is not a conflict.
    if (typeof entry.model === 'string' && entry.model.trim() && entry.model.trim() !== model.trim()) {
      return { error: `the paste has both "model" (${snip(entry.model)}) and "models" (${snip(model)}) -- keep one, so it is unambiguous which model runs` }
    }
  } else if (typeof entry.model === 'string') {
    model = entry.model
  }
  model = model.trim()
  if (!model) return { error: 'no model id in the paste' }

  const urlResult = resolveCustomBaseUrl(entry.baseUrl)
  if (urlResult.error) return { error: snip(urlResult.error, 400) }

  // A non-string apiKey is REFUSED, never coerced to "". Silently reducing it
  // to blank is the worst available outcome: blank means "keep whatever key is
  // already stored" at the save route, so a paste pointing at a new endpoint
  // would report success while the PREVIOUS provider's key kept being sent --
  // to a different host. Absent is fine; wrongly typed is not.
  if (entry.apiKey !== undefined && entry.apiKey !== null && typeof entry.apiKey !== 'string') {
    return { error: `"apiKey" must be a string, but the paste has ${describeType(entry.apiKey)} -- fix it or remove it` }
  }
  const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : ''
  return { baseUrl: urlResult.url, apiKey, model }
}

// Names go into user-visible refusal messages, which the settings page drops
// straight into a one-line status element. readJsonBody accepts up to 1 MB, so
// an unbounded join let a ~989 KB paste produce a ~509 KB error body that
// destroyed the page layout (red-team measurement, 2026-07-29). Cap the list
// and SAY how many were dropped -- a silent truncation would read as "those
// are all of them".
function describeType(value) {
  if (Array.isArray(value)) return 'an array'
  const t = typeof value
  return /^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`
}

function summarizeNames(names, limit = 10) {
  const shown = names.slice(0, limit).map((n) => snip(n))
  return names.length > limit ? `${shown.join(', ')}, and ${names.length - limit} more` : shown.join(', ')
}

// EVERY user-controlled scalar that reaches a refusal message goes through
// this, not just the list joins. Capping only the joins was a half-measure
// that moved the worst case by zero: readJsonBody accepts 1 MB, and a single
// 900 KB model id / api string / provider id interpolated raw produced a
// ~900 KB 400 body -- bigger than the case the cap was added for. The route
// bounds its response as well (onboarding/routes/provider.cjs), because
// resolveCustomBaseUrl's errors come from outside this function.
function snip(value, limit = 80) {
  const s = String(value)
  return s.length > limit ? `${s.slice(0, limit)}...(${s.length} chars)` : s
}

/**
 * buildProviderEnv(provider, config, deps) -> { env } | { error }
 *
 * Pure (given deps.readProviderKey is pure/deterministic for a given
 * on-disk credential state): no logging, no setAgentStatus call, no
 * process.env read/write. Never throws -- every failure path is caught
 * internally and returned as `{ error }` so the caller (main.cjs) can stay a
 * flat if/else on the return shape.
 *
 * `env` is a set of fields the caller should spread OVER its own base env
 * object (after ...process.env and after its own MODEL/AGENT_NAME/etc
 * fields) -- see caller's own merge-order comment. A field set to
 * `undefined` in the returned env means "actively unset this in the child,
 * even if process.env carries a value" (Node's child_process env-builder
 * omits `undefined`-valued keys from the child's real environment --
 * verified empirically as part of this change, not assumed from docs
 * alone).
 *
 * `error.kind` is one of:
 *   'key_error'          -- deps.readProviderKey threw (Keychain/safeStorage
 *                           read failure). Caller should
 *                           setAgentStatus('failed', 'key_error', reason).
 *   'not_ready'          -- onboarding says this provider but the
 *                           credential/model it needs isn't on file yet.
 *                           Caller should log + skip quietly, matching this
 *                           codebase's existing "no key yet" behavior (no
 *                           setAgentStatus call -- see main.cjs's original
 *                           `if (!providerKey) { log(...); return null }`,
 *                           preserved here for the 'claude' branch and
 *                           extended to the 3 new branches for parity).
 *   'provider_not_wired' -- unrecognized PROVIDER string. Caller should
 *                           setAgentStatus('failed', 'provider_not_wired', reason),
 *                           same as this codebase's pre-existing `else`
 *                           branch (defense in depth: http-server.cjs's
 *                           PROVIDERS allow-list should make this
 *                           unreachable via the wizard, this is the
 *                           hand-edited-config-file backstop).
 */
// ── the provider table (2026-07-29) ─────────────────────────────────────
// Each mode below used to be an `if (provider === '...')` branch inside
// buildProviderEnv. They are now ROWS, because every branch had already
// converged on the same three moves: (1) satisfy a credential requirement,
// (2) satisfy zero or more config preconditions, (3) return one small env
// map. Only step 3 was ever provider-specific. Adding a provider is now a
// row, not a branch.
//
// Row fields:
//   id           PROVIDERS value (onboarding/http-server.cjs's allow-list).
//   credential   'none'      -- read nothing (local proxy/daemon, or the
//                              deliberately-read-nothing claude-cli mode);
//                'required'  -- readProviderKey(keyName) must return a value,
//                              absent -> not_ready;
//                'optional'  -- read it, fall back to a placeholder.
//   keyName      argument to deps.readProviderKey (credential !== 'none').
//   notReady     reason string when a 'required' credential is missing.
//                Kept per-row and verbatim: these strings are user-visible
//                and two of them are test-pinned.
//   pre(config)  optional precondition -> { values } | { error: { kind, reason } }.
//   env(ctx)     the ONLY provider-specific part. ctx = { key, values, config }.
//                Every row lists all three of ANTHROPIC_API_KEY /
//                ANTHROPIC_BASE_URL / CLAUDE_CODE_OAUTH_TOKEN, setting
//                `undefined` for the ones it does not use -- that explicit
//                clearing is load-bearing, not hygiene (see this file's
//                header on cross-provider leakage through `...process.env`).
//
// NOT a column here, deliberately: config-dir isolation. An `isolate` field
// plus an accessor shipped in the first draft of this table and was cut --
// nothing in the spawn path read it, so the regression its tests claimed to
// guard (a global CLAUDE_CONFIG_DIR breaking claude-cli's reuse of the user's
// own login) would have shipped with every assertion still green. It lands
// with the wiring that consumes it, and its test asserts on a built env. See
// the claude-cli row for what that wiring will have to preserve.
const PROVIDER_ROWS = [
  {
    // BYOK -- PRESERVED EXACTLY as main.cjs's original (pre-4-provider)
    // 'claude' branch behaved, plus the explicit-clear hardening described
    // in this file's header comment.
    id: 'claude',
    credential: 'required',
    keyName: 'claude',
    notReady: 'onboarding says PROVIDER=claude but no validated key is on file yet',
    env: ({ key }) => ({
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_BASE_URL: undefined, // clear any stale base_url from a prior chatgpt/ollama session
      CLAUDE_CODE_OAUTH_TOKEN: undefined, // clear any stale subscription token
      CLAUDE_CONFIG_DIR: undefined, // see the claude-cli row: cleared on EVERY row so one inherited value cannot relocate ~/.claude.json under the harness seeding
    }),
  },
  {
    // Claude Code CLI's own `claude setup-token` long-lived OAuth token,
    // captured at onboarding (paste field, see http-server.cjs) and stored
    // via the SAME safeStorage plumbing as a BYOK key (keyed under the
    // pseudo-provider name 'claude-subscription' in CREDENTIALS_DIR).
    id: 'claude-subscription',
    credential: 'required',
    keyName: 'claude-subscription',
    notReady: 'onboarding says PROVIDER=claude-subscription but no OAuth token is on file yet',
    env: ({ key }) => ({
      CLAUDE_CODE_OAUTH_TOKEN: key,
      ANTHROPIC_API_KEY: undefined, // do NOT inject an API key alongside the OAuth token (LOCKED design, mode 1)
      ANTHROPIC_BASE_URL: undefined, // clear any stale base_url from a prior chatgpt/ollama session
      CLAUDE_CONFIG_DIR: undefined, // see the claude-cli row: cleared on EVERY row so one inherited value cannot relocate ~/.claude.json under the harness seeding
    }),
  },
  {
    // Reuse the Claude Code CLI login the user ALREADY has on this machine,
    // IN PLACE (2026-07-13). The true zero-auth path -- the user pastes
    // nothing, we store nothing, we copy nothing.
    //
    // The mechanism is to inject NOTHING. With no ANTHROPIC_API_KEY, no
    // CLAUDE_CODE_OAUTH_TOKEN and no ANTHROPIC_BASE_URL, the CLI falls back to
    // its own interactively-authenticated OAuth session (~/.claude/.credentials.json,
    // or the macOS keychain item that supersedes it). This isn't a guess: it is
    // exactly how the entire MAGI fleet runs today --
    // `ps eww <agent-pid> | grep -cE '^ANTHROPIC_API_KEY=|^ANTHROPIC_BASE_URL=|^CLAUDE_CODE_OAUTH_TOKEN='`
    // returns 0 for a live, working agent (verified 2026-07-13 on pid 71610).
    //
    // The three explicit `undefined`s are therefore the WHOLE implementation,
    // not hygiene: they clear anything a previous provider left in
    // process.env, which main.cjs spreads into the child. If a stale
    // ANTHROPIC_API_KEY survived here, the CLI would prefer it over the OAuth
    // session and this mode would silently become BYOK-on-someone-else's-key
    // (the exact leak sirin's run-agent.sh comment describes, quoted in this
    // file's header).
    //
    // This mode ALSO depends on the spawned child NOT getting its own
    // CLAUDE_CONFIG_DIR: the claude CLI namespaces its keychain service by
    // config dir (`Claude Code-credentials` when unset,
    // `Claude Code-credentials-<sha256(dir)[0..8]>` when set -- read out of
    // the CLI binary and confirmed live 2026-07-29, where a fresh config dir
    // reports "Not logged in" while the machine's real session stays
    // untouched). This mode works precisely BY seeing the user's own
    // un-namespaced slot. Nothing sets CLAUDE_CONFIG_DIR today; when the
    // subscription-login lane makes something set it, it MUST be per-provider
    // and this row must keep getting none -- and the test that proves it has
    // to assert against a built env, not against a data column no spawn path
    // reads.
    //
    // COST DISCLOSURE IS MANDATORY IN THE UI (locked with Mino): this spends
    // the user's OWN Claude subscription quota. "We found your login and will
    // use it" must never be presented as if it were free.
    //
    // No credential is read, so there is nothing to fail on -- readProviderKey
    // is never called and this row cannot return 'not_ready'. If the login
    // is absent or expired, the CLI itself says so at spawn, loudly, in its own
    // voice. We deliberately do NOT pre-validate by reading the credential
    // file: detection is existence-only (http-server.cjs), because reading a
    // user's OAuth token to check it is exactly the thing this mode promises
    // not to do.
    id: 'claude-cli',
    credential: 'none',
    env: () => ({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      // Cleared for the same reason as the three above, against a different
      // leak: main.cjs spreads ...process.env into the child, so a
      // CLAUDE_CONFIG_DIR exported in the launching environment would send
      // the spawned CLI to a DIFFERENT credential slot than the one this app
      // checked to decide the mode was available at all. That check is
      // hardcoded -- http-server.cjs's CLAUDE_CLI_CREDENTIALS_PATH is
      // `~/.claude/.credentials.json` via os.homedir(), and it does not
      // follow CLAUDE_CONFIG_DIR (see its computeAvailableProviders gate). So
      // detection and spawn could read different dirs, and this mode's whole
      // promise is "we reuse the login you already have" -- the one that was
      // found. Clearing it makes the spawn look where the probe looked.
      //
      // This was left inherited through two earlier rounds on the theory that
      // a user who exports CLAUDE_CONFIG_DIR and logs in under it would want
      // it honoured. That user does not reach this code: with no
      // ~/.claude/.credentials.json, claude-cli is never offered to them.
      // The only reachable case was the inconsistent one.
      CLAUDE_CONFIG_DIR: undefined,
    }),
  },
  {
    // Local codex-as-api proxy. No user secret required -- see this file's
    // header comment for why an explicit placeholder key is still injected
    // (diverging from skia's bare run-agent.sh shape).
    id: 'chatgpt',
    credential: 'none',
    pre: (config) => {
      const portResult = resolveChatgptProxyPort(config.CHATGPT_PROXY_PORT)
      if (portResult.error) return { error: { kind: 'provider_not_wired', reason: portResult.error } }
      return { values: { port: portResult.port } }
    },
    env: ({ values }) => ({
      ANTHROPIC_BASE_URL: `http://localhost:${values.port}`,
      ANTHROPIC_API_KEY: CHATGPT_PLACEHOLDER_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: undefined, // force api-key auth precedence -- see sirin ground-truth comment
      CLAUDE_CONFIG_DIR: undefined, // see the claude-cli row: cleared on EVERY row (harness-render seeds ~/.claude.json for all modes)
    }),
  },
  {
    // Local Ollama daemon. No user secret required, but a real local model
    // tag IS required -- unlike codex-as-api (which, per run-agent.sh's
    // sirin comment, "force-ignores body.model"), Ollama's OpenAI-compatible
    // surface needs an actual model name it can resolve. Falling back to
    // config.MODEL's generic default ('claude-opus-4-6') would silently send
    // an Anthropic model id to an Ollama daemon that has no such model --
    // fail loud instead.
    id: 'ollama',
    credential: 'none',
    pre: (config) => {
      const model = requiredModel(config)
      if (!model) {
        return { error: { kind: 'not_ready', reason: 'onboarding says PROVIDER=ollama but no MODEL (ollama model tag) is on file yet' } }
      }
      return { values: { model } }
    },
    env: ({ values }) => ({
      ANTHROPIC_BASE_URL: OLLAMA_BASE_URL,
      ANTHROPIC_API_KEY: 'ollama', // exact match, run-agent.sh:204 (skia-ollama), proven-live
      MODEL: values.model,
      SKIP_MODEL_GUARD: '1', // matches run-agent.sh:205's shape; NOTE run.sh has no such guard today -- see task report gaps
      CLAUDE_CODE_OAUTH_TOKEN: undefined, // force api-key auth precedence -- see sirin ground-truth comment
      CLAUDE_CONFIG_DIR: undefined, // see the claude-cli row: cleared on EVERY row (harness-render seeds ~/.claude.json for all modes)
    }),
  },
  {
    // Generic OpenAI-compatible proxy (2026-07-25): unlike chatgpt/ollama
    // above (an app-managed local proxy/daemon -- codex-as-api in-process, or
    // the bundled Ollama.app; see main.cjs's ensureCodexProxy()/
    // ensureOllamaDaemon()), this mode points at WHATEVER OpenAI-compatible
    // endpoint the user configures -- a self-hosted proxy, a local
    // model-router bridge, a manually-run codex-as-api, Ollama's own
    // OpenAI-compatible surface run standalone, etc. This module does not
    // know or care which; main.cjs has no ensureXProxy()-style gate for it
    // (nothing here for it to launch or vouch for).
    //
    // Both CUSTOM_BASE_URL and MODEL are required, fail loud if missing --
    // same reasoning as 'ollama' above.
    //
    // API key is OPTIONAL, unlike 'claude'/'claude-subscription' above --
    // plenty of local/self-hosted proxies (see the settings-page presets: a
    // local ClinePass/Grok bridge, Ollama's OpenAI-compatible surface,
    // codex-as-api) accept any bearer value or none at all. Stored the SAME
    // way the 'claude' BYOK key is (safeStorage-backed), never as a plaintext
    // .agent-config field the way CUSTOM_BASE_URL is: unlike the base URL,
    // this MAY be a real secret for whatever proxy the user points this at,
    // so it gets the exact on-disk treatment every other credential here gets.
    id: 'custom',
    credential: 'optional',
    keyName: 'custom',
    pre: (config) => {
      const urlResult = resolveCustomBaseUrl(config.CUSTOM_BASE_URL)
      if (urlResult.error) {
        return { error: { kind: 'not_ready', reason: `onboarding says PROVIDER=custom but ${urlResult.error}` } }
      }
      const model = requiredModel(config)
      if (!model) {
        return { error: { kind: 'not_ready', reason: 'onboarding says PROVIDER=custom but no MODEL (custom proxy model id) is on file yet' } }
      }
      return { values: { url: urlResult.url, model } }
    },
    env: ({ key, values }) => ({
      ANTHROPIC_BASE_URL: values.url,
      ANTHROPIC_API_KEY: key || CUSTOM_PLACEHOLDER_KEY,
      MODEL: values.model,
      SKIP_MODEL_GUARD: '1', // same reasoning as 'ollama' above -- not an Anthropic model id
      CLAUDE_CODE_OAUTH_TOKEN: undefined, // force api-key auth precedence -- see sirin ground-truth comment
      CLAUDE_CONFIG_DIR: undefined, // see the claude-cli row: cleared on EVERY row (harness-render seeds ~/.claude.json for all modes)
    }),
  },
]

// Shared by the ollama/custom rows: a MODEL that is missing or whitespace-only
// is "not configured", never a silent fallback to config.MODEL's Anthropic
// default. Returns '' for the not-configured case so callers read as a plain
// truthiness check.
function requiredModel(config) {
  return config.MODEL && String(config.MODEL).trim() ? String(config.MODEL).trim() : ''
}

const PROVIDER_ROWS_BY_ID = new Map(PROVIDER_ROWS.map((row) => [row.id, row]))

// The order the `provider_not_wired` message lists, preserved verbatim from
// the pre-table if-chain's message (claude, claude-cli, claude-subscription,
// chatgpt, ollama, custom) rather than derived from PROVIDER_ROWS order --
// this string is user-visible and one test pins its shape.
const PROVIDER_IDS_FOR_MESSAGE = ['claude', 'claude-cli', 'claude-subscription', 'chatgpt', 'ollama', 'custom']

function buildProviderEnv(provider, config, deps) {
  const { readProviderKey } = deps

  const row = PROVIDER_ROWS_BY_ID.get(provider)
  if (!row) {
    return {
      error: {
        kind: 'provider_not_wired',
        reason: `provider "${provider}" is not a recognized mode -- expected one of: ${PROVIDER_IDS_FOR_MESSAGE.join(', ')}`,
      },
    }
  }

  // Preconditions BEFORE the credential read, and the order is observable:
  // 'custom' is the only row with both, and its if-chain checked
  // CUSTOM_BASE_URL and MODEL first, so a custom config with a bad URL AND a
  // throwing Keychain reported not_ready (the URL), never key_error. Every
  // other row has one or the other, so this order reproduces all six.
  let values = {}
  if (row.pre) {
    const result = row.pre(config)
    if (result.error) return { error: result.error }
    values = result.values || {}
  }

  let key
  if (row.credential !== 'none') {
    try {
      key = readProviderKey(row.keyName)
    } catch (err) {
      return { error: { kind: 'key_error', reason: `readProviderKey(${row.keyName}) failed: ${err.message}` } }
    }
    if (!key && row.credential === 'required') {
      return { error: { kind: 'not_ready', reason: row.notReady } }
    }
  }

  return { env: row.env({ key, values, config }) }
}

// Which PROVIDERS values require a stored credential before onboarding can
// complete (single source of truth shared with onboarding/http-server.cjs's
// /api/onboarding/complete gate, so the "does this provider need a secret"
// fact lives in exactly one place). chatgpt/ollama route to a local
// proxy/daemon and need no user secret at all -- see buildProviderEnv above.
// 'custom' also needs none: its API key is OPTIONAL, not required (a stored
// key is used when present, a placeholder otherwise -- see buildProviderEnv's
// 'custom' branch), so it is never added here either.
const PROVIDERS_REQUIRING_STORED_CREDENTIAL = ['claude', 'claude-subscription']

// Table invariant, checked at module load rather than trusted: a row that
// requires a credential MUST carry the user-visible reason shown when one is
// missing. In the old if-chain the reason was part of the same `return`
// statement and could not be forgotten; in a table it is a field, and a row
// added without it would surface the literal string "undefined" in the
// onboarding status line. Throwing here fails at require() -- loud, on the
// author's machine -- instead of at a user's first spawn.
const CREDENTIAL_MODES = ['none', 'optional', 'required']
for (const row of PROVIDER_ROWS) {
  // `credential` FIRST, because it is the field the rest branch on: a typo
  // ('requried') sails past a !== 'none' gate, skips the notReady check
  // entirely, and reaches readProviderKey with an undefined key. Validating
  // keyName while leaving the value that selects the whole code path
  // unchecked catches the mistake nobody makes and misses the one that
  // matters. (Red-team catch, 2026-07-29.)
  if (!CREDENTIAL_MODES.includes(row.credential)) {
    throw new Error(`provider-env: row "${row.id}" has credential "${row.credential}", not one of ${CREDENTIAL_MODES.join('/')}`)
  }
  if (row.credential === 'none') continue
  // keyName is as load-bearing as notReady: buildProviderEnv calls
  // readProviderKey(row.keyName) for every row that reads a credential at all,
  // so a row missing it would look up the credential named `undefined`.
  if (typeof row.keyName !== 'string' || !row.keyName) {
    throw new Error(`provider-env: row "${row.id}" reads a credential but has no keyName`)
  }
  if (row.credential === 'required' && (typeof row.notReady !== 'string' || !row.notReady)) {
    throw new Error(`provider-env: row "${row.id}" requires a credential but has no notReady reason`)
  }
}

module.exports = {
  buildProviderEnv,
  resolveChatgptProxyPort,
  resolveCustomBaseUrl,
  parseCustomProviderJson,
  PROVIDERS_REQUIRING_STORED_CREDENTIAL,
  CHATGPT_PROXY_DEFAULT_PORT,
  CHATGPT_PLACEHOLDER_KEY,
  CUSTOM_PLACEHOLDER_KEY,
  OLLAMA_BASE_URL,
}
