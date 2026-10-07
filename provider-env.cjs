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
// directly here), so tests/test-provider-env.mjs can require it standalone
// and assert against every branch with a fake readProviderKey.
//
// Ground truth this mirrors (the reference fleet's OWN proven-live wiring,
// its run-agent.sh):
//   - the proxy lane (gpt-5.5 via codex-as-api proxy), line ~194:
//       export ANTHROPIC_BASE_URL=http://localhost:18080
//     -- no ANTHROPIC_API_KEY set at all in that block.
//   - the ollama lane (kimi via ollama direct), lines ~202-205:
//       MODEL=kimi-k2.7-code:cloud
//       export ANTHROPIC_BASE_URL=http://localhost:11434
//       export ANTHROPIC_API_KEY=ollama
//       SKIP_MODEL_GUARD=1
//   - the gemini lane (Gemini via antigravity-proxy, its OWN later/more-hardened
//     entry, lines ~237-241):
//       export ANTHROPIC_BASE_URL=http://localhost:18090
//       export ANTHROPIC_API_KEY=sk-proxy-passthrough
//     with the explicit comment: "Force api-key auth -> CLI does NOT send
//     ~/.claude OAuth bearer to the local proxy. Proxy holds its own Google
//     OAuth (accounts.json)... Without this, default account-1 OAuth leaks
//     to :18090."
//
// DELIBERATE DIVERGENCE from the proxy lane's literal shape, flagged here and in the
// task report: the proxy lane's own block sets NO ANTHROPIC_API_KEY, but the proxy lane runs
// under an account that already has an interactively-authenticated
// ~/.claude(.json) OAuth session from a prior manual `claude login` --
// the gemini lane's later comment above explains that WITHOUT an explicit
// ANTHROPIC_API_KEY, the CLI falls back to sending that existing OAuth
// bearer to whatever ANTHROPIC_BASE_URL points at. scheherazade's target
// user is the OPPOSITE precondition -- a fresh Mac with NO prior `claude
// login` (that is the entire reason main.cjs's Critical-A BYOK-key-forward
// fix exists at all) -- so mirroring the proxy lane's bare shape here risks either
// (a) hanging at claude's own missing-credential prompt (no OAuth session
// AND no key), or (b) on a machine that DOES have some stray auth (e.g. a
// leftover claude-subscription token from a previous provider switch on the
// same real ~/.claude.json -- this app sets no CLAUDE_CONFIG_DIR override,
// see http-server.cjs's own ensureClaudeOnboardingDone() comment), silently
// leaking that unrelated credential to the local codex-as-api proxy exactly
// as the gemini lane's fix describes. This module instead follows the gemini lane's *more
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
// Ollama CLOUD (2026-08-04 the owner: "ollama -> API키" -- the connect method for
// ollama is an ollama.com API key, not web-login/`ollama signin`; the signin
// flow shipped a false "connected" a real external tester paid for the same
// day). ollama.com speaks the Anthropic Messages API directly -- receipt:
// unauthenticated POST https://ollama.com/v1/messages returns an
// Anthropic-SHAPED 401 ({"type":"error","error":{"type":"authentication_
// error",...}}); api.ollama.com 301s here. So the runtime lane is just
// base-url + Bearer key, no proxy, no local daemon.
const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'

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
    // Depth-capped. JSON.parse accepts far deeper input than a recursive walk
    // can survive, so a deeply-nested paste threw RangeError out of the one
    // function whose entire contract is "refuse out loud, never throw" -- the
    // user got an opaque 500 instead of the specific 400 every other bad paste
    // produces. Past the cap we simply decline to call them equal.
    const MAX_DEPTH = 64
    const DEEP = '\u0000__too_deep__'
    const norm = (v, d = 0) => {
      if (d > MAX_DEPTH) return DEEP
      return Array.isArray(v)
        ? v.map((x) => norm(x, d + 1))
        : (v && typeof v === 'object' ? Object.keys(v).sort().map((k) => [k, norm(v[k], d + 1)]) : v)
    }
    const a2 = norm(a)
    const b2 = norm(b)
    if (JSON.stringify(a2).includes(DEEP) || JSON.stringify(b2).includes(DEEP)) return false
    return JSON.stringify(a2) === JSON.stringify(b2)
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
  if (present(parsed.providers)) {
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
    if (present(inner.providers)) {
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
 *
 * `error.fix` (2026-08-04) is a user-facing instruction in the imperative,
 * present on every error this function can return. `reason` says what is
 * wrong; `fix` says what to do, which is the only half a non-developer can
 * act on. Kept as a separate field rather than appended to `reason` because
 * `reason` is quoted verbatim in logs and pinned by tests, while `fix`
 * changes every time the settings page moves a control.
 *
 * Caller MUST NOT assume `fix` reaches a human on its own -- main.cjs
 * appends it to the `detail` it passes to setAgentStatus for the two kinds
 * the UI renders ('key_error', 'provider_not_wired'). 'not_ready' is a quiet
 * skip by design and today its fix reaches only the app log, which the user
 * cannot open (the openLogs button is rendered disabled). The field is
 * correct and ready for whatever surfaces it; it is not yet a shipped fix
 * for that path.
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
//   notReadyFix  what the user should DO about it, in the imperative. A
//                separate field rather than a longer notReady because the
//                two have different audiences and different lifetimes: the
//                reason is a diagnosis (pinned by tests, quoted in logs and
//                bug reports), the fix is instructions that change whenever
//                the settings page moves a control. Concatenating them makes
//                every UI reshuffle edit a test-pinned string.
//   pre(config)  optional precondition -> { values } | { error: { kind, reason, fix } }.
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
// ── dsh route helpers (0.2.2 full harness swap) ─────────────────────────
// Every row now emits LANE_KIND=dsh plus a route description the lane's
// buildPatch consumes (dsh-lane.mjs "route contract v2"). The CLI-era
// auth fields are still explicitly cleared on every row -- process.env
// spreading has not changed, only what the child does with it.
function dshCommonEnv(config) {
  return {
    LANE_KIND: 'dsh',
    // EFFORT_LEVEL (low/medium/high/max) passes through; the lane's
    // selectModel is fail-soft on a level the route's model doesn't offer.
    DSH_EFFORT: (config.EFFORT_LEVEL && String(config.EFFORT_LEVEL).trim()) || 'high',
    ANTHROPIC_BASE_URL: undefined, // CLI-era fields: cleared on every dsh route
    ANTHROPIC_API_KEY: undefined, // anthropicRouteEnv re-sets this AFTER the spread; every other route must not leak a stale key
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    SKIP_MODEL_GUARD: '1', // no claude CLI argv to guard anymore
  }
}
// Shared by claude / claude-subscription / claude-cli: the pi-ai anthropic
// CATALOG route. `key` may be a real API key or an sk-ant-oat OAuth token
// -- pi-ai branches on the prefix itself.
function anthropicRouteEnv(key, config) {
  const model = requiredModel(config) || 'claude-opus-4-6'
  return {
    ...dshCommonEnv(config),
    DSH_ROUTE: 'anthropic-catalog',
    DSH_PROVIDER: 'anthropic',
    DSH_ROUTE_KEY_ENV: 'ANTHROPIC_API_KEY',
    ANTHROPIC_API_KEY: key,
    DSH_MODEL: model,
    DSH_MODEL_VISION: '1', // claude models are vision-capable; markers attach inline
    MODEL: model, // spawn-info/laneVision truth
  }
}
// claude-cli (0.2.2): with the Claude Code binary gone, "reuse the login
// you already have" can no longer mean "inject nothing and let the CLI
// read its own store" -- SOMEONE has to read the token, and now it is us.
// This is a deliberate promise change, named in the row comment below.
// macOS: the CLI stores under Keychain item "Claude Code-credentials"
// (un-namespaced slot -- CLAUDE_CONFIG_DIR namespacing note in the old row
// comment, git history); elsewhere ~/.claude/.credentials.json. Returns
// { token } or { error: reason }.
// --- Claude Code CLI credential store: read / refresh / write-back ---------
// 2026-10-07 (Mino, idea home 12:58): "세라에서 클로드 토큰 만료됐을때 재로그인으로
// 토큰 리프레시 안되는거같음. 터미널 열고 클로드코드 -> 로그인 해줘야 다시 되더라고".
// The old promise ("no refresh here, writing into the CLI's store is not ours
// to do") is REVISED: the CLI store carries a refreshToken, and Anthropic's
// OAuth token endpoint rotates the pair on refresh. Refreshing without
// writing back would strand the CLI's own copy, so we refresh AND write the
// new pair into the same store (keychain item on macOS, ~/.claude/.credentials.json
// elsewhere), keeping `claude` and Sera on one login. Only the three rotated
// fields change; every other field in the store is preserved verbatim.
const CLAUDE_CLI_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
// Claude Code's public OAuth client id (same value pi-ai ships, base64-decoded).
const CLAUDE_CLI_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_CLI_KEYCHAIN_SERVICE = 'Claude Code-credentials'
// Row id of the CLI-login route; main.cjs compares against this (the packaging
// test forbids the raw literal in main.cjs so the bundled-CLI era cannot creep back).
const CLAUDE_CLI_PROVIDER_ID = 'claude-cli'
const CLAUDE_CLI_TOKEN_HEADROOM_MS = 5 * 60 * 1000

function readClaudeCliStore() {
  const fsMod = require('node:fs')
  const pathMod = require('node:path')
  const osMod = require('node:os')
  const fileP = pathMod.join(osMod.homedir(), '.claude', '.credentials.json')
  let raw = null
  let source = null
  try { raw = fsMod.readFileSync(fileP, 'utf8'); source = { kind: 'file', path: fileP } } catch {}
  if (raw == null && process.platform === 'darwin') {
    try {
      const { execFileSync } = require('node:child_process')
      raw = execFileSync('security', ['find-generic-password', '-s', CLAUDE_CLI_KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', timeout: 5000 })
      let account = osMod.userInfo().username
      try {
        const meta = execFileSync('security', ['find-generic-password', '-s', CLAUDE_CLI_KEYCHAIN_SERVICE], { encoding: 'utf8', timeout: 5000 })
        const m = /"acct"<blob>="([^"]*)"/.exec(meta)
        if (m) account = m[1]
      } catch {}
      source = { kind: 'keychain', account }
    } catch {}
  }
  if (raw == null) return { error: 'no Claude Code CLI login found (no ~/.claude/.credentials.json and no keychain item)' }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { error: 'the Claude Code CLI credential store could not be parsed' } }
  return { parsed, source }
}

function writeClaudeCliStore(source, parsed) {
  const json = JSON.stringify(parsed)
  if (source.kind === 'file') {
    const fsMod = require('node:fs')
    const tmp = source.path + '.tmp-' + process.pid
    fsMod.writeFileSync(tmp, json, { mode: 0o600 })
    fsMod.renameSync(tmp, source.path)
    return
  }
  const { execFileSync } = require('node:child_process')
  // -U updates the existing item in place (same service + account).
  execFileSync('security', ['add-generic-password', '-U', '-a', source.account, '-s', CLAUDE_CLI_KEYCHAIN_SERVICE, '-w', json], { encoding: 'utf8', timeout: 5000 })
}

// Refresh the CLI login if its access token is expired or about to expire.
// Resolves { refreshed: false } when still valid, { refreshed: true } after a
// successful rotate + write-back, or { error } (never throws). deps lets tests
// inject readStore / writeStore / fetchFn / now.
async function refreshClaudeCliToken(deps) {
  const d = deps || {}
  const readStore = d.readStore || readClaudeCliStore
  const writeStore = d.writeStore || writeClaudeCliStore
  const fetchFn = d.fetchFn || globalThis.fetch
  const now = d.now || Date.now
  const st = readStore()
  if (st.error) return { error: st.error }
  const parsed = st.parsed
  const holder = parsed && parsed.claudeAiOauth ? parsed.claudeAiOauth : parsed
  if (!holder || typeof holder !== 'object') return { error: 'the Claude Code CLI credential store holds no OAuth block' }
  const expiresAt = Number(holder.expiresAt)
  if (holder.accessToken && Number.isFinite(expiresAt) && expiresAt >= now() + CLAUDE_CLI_TOKEN_HEADROOM_MS) {
    return { refreshed: false }
  }
  if (!holder.refreshToken || typeof holder.refreshToken !== 'string') {
    return { error: 'the Claude Code CLI login is expired and holds no refresh token; run `claude` once to log in again' }
  }
  if (typeof fetchFn !== 'function') return { error: 'no fetch available for the OAuth refresh' }
  let res
  try {
    res = await fetchFn(CLAUDE_CLI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: CLAUDE_CLI_OAUTH_CLIENT_ID, refresh_token: holder.refreshToken }),
    })
  } catch (e) {
    return { error: `Claude Code login refresh request failed: ${e && e.message ? e.message : String(e)}` }
  }
  let body = ''
  try { body = await res.text() } catch {}
  if (!res.ok) {
    return { error: `Claude Code login refresh rejected (HTTP ${res.status}); run \`claude\` once to log in again${body ? `: ${body.slice(0, 200)}` : ''}` }
  }
  let data
  try { data = JSON.parse(body) } catch { return { error: 'Claude Code login refresh returned invalid JSON' } }
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    return { error: 'Claude Code login refresh returned no access token' }
  }
  holder.accessToken = data.access_token
  if (typeof data.refresh_token === 'string' && data.refresh_token) holder.refreshToken = data.refresh_token
  const expiresIn = Number(data.expires_in)
  holder.expiresAt = now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000)
  try { writeStore(st.source, parsed) } catch (e) {
    return { error: `Claude Code login refreshed but the credential store could not be written: ${e && e.message ? e.message : String(e)}` }
  }
  return { refreshed: true, expiresAt: holder.expiresAt }
}

function readClaudeCliToken() {
  const st = readClaudeCliStore()
  if (st.error) return { error: st.error }
  const parsed = st.parsed
  const oauth = parsed && (parsed.claudeAiOauth || parsed)
  const token = oauth && oauth.accessToken
  if (!token || typeof token !== 'string') return { error: 'the Claude Code CLI credential store holds no access token' }
  const expiresAt = Number(oauth.expiresAt)
  // 5-minute headroom: a token that dies mid-first-turn is worse than an
  // honest not_ready. Refresh lives in refreshClaudeCliToken() (async, called
  // by main.cjs right before this sync read on the claude-cli route).
  if (Number.isFinite(expiresAt) && expiresAt < Date.now() + CLAUDE_CLI_TOKEN_HEADROOM_MS) {
    return { error: 'the Claude Code CLI login token is expired (or about to expire)' }
  }
  return { token }
}

const PROVIDER_ROWS = [
  {
    // BYOK (0.2.2 harness swap, the owner 08-19 "클로드코드 아예 의존성째로
    // 날려버려"): the key now feeds the dsh lane's anthropic CATALOG route
    // (pi-ai ships the model list + anthropic-messages protocol) instead of
    // the Claude Code CLI. Credential handling unchanged.
    id: 'claude',
    credential: 'required',
    keyName: 'claude',
    notReady: 'onboarding says PROVIDER=claude but no validated key is on file yet',
    notReadyFix: 'Open Settings > Model, choose the Anthropic API key mode, and paste your key. It is checked against the API before it is stored, so a bad key is rejected there rather than here.',
    env: ({ key, config }) => anthropicRouteEnv(key, config),
  },
  {
    // `claude setup-token` long-lived OAuth token (sk-ant-oat), captured at
    // onboarding and stored via the same safeStorage plumbing as BYOK.
    // 0.2.2: rides the SAME anthropic catalog route -- pi-ai detects the
    // oat prefix and flips its native OAuth mode (Bearer + oauth beta
    // headers + Claude Code identity system block + Claude Code tool-name
    // normalization; raw-API 200 measured 2026-08-19, and the identity
    // block requirement measured with it: without the block the API
    // refuses).
    id: 'claude-subscription',
    credential: 'required',
    keyName: 'claude-subscription',
    notReady: 'onboarding says PROVIDER=claude-subscription but no OAuth token is on file yet',
    notReadyFix: 'Run `claude setup-token` in a terminal, copy the token it prints, and paste it into Settings > Model.',
    env: ({ key, config }) => anthropicRouteEnv(key, config),
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
    // exactly how the entire the reference fleet runs today --
    // `ps eww <agent-pid> | grep -cE '^ANTHROPIC_API_KEY=|^ANTHROPIC_BASE_URL=|^CLAUDE_CODE_OAUTH_TOKEN='`
    // returns 0 for a live, working agent (verified 2026-07-13 on pid 71610).
    //
    // The three explicit `undefined`s are therefore the WHOLE implementation,
    // not hygiene: they clear anything a previous provider left in
    // process.env, which main.cjs spreads into the child. If a stale
    // ANTHROPIC_API_KEY survived here, the CLI would prefer it over the OAuth
    // session and this mode would silently become BYOK-on-someone-else's-key
    // (the exact leak the gemini lane's run-agent.sh comment describes, quoted in this
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
    // COST DISCLOSURE IS MANDATORY IN THE UI (locked with the owner): this spends
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
    // PROMISE CHANGE (0.2.2, logged): the pre-swap mode injected NOTHING
    // and let the Claude Code CLI read its own store -- "we store nothing,
    // we copy nothing, we READ nothing". With the CLI gone from the spawn
    // path, the only way to keep this mode alive (the owner 08-19 "빼지말고
    // 되게 해봐") is to read the login's access token ourselves at spawn
    // and hand it to the dsh anthropic route (pi-ai OAuth mode). Still
    // never stored, never copied to disk, read fresh per spawn -- but it
    // IS now read. Expired token -> honest not_ready (no refresh: writing
    // into the CLI's credential store is not ours to do; running `claude`
    // once refreshes it in place). Cost disclosure in the UI stays
    // mandatory: this spends the user's own subscription quota.
    id: 'claude-cli',
    credential: 'none',
    pre: (config, deps) => {
      const r = (deps && deps.readClaudeCliToken ? deps.readClaudeCliToken : readClaudeCliToken)()
      if (r.error) {
        return {
          error: {
            kind: 'not_ready',
            reason: `onboarding says PROVIDER=claude-cli but ${r.error}`,
            fix: 'Open a terminal and run `claude` once (it logs in again), or switch Settings > Model to the setup-token mode.',
          },
        }
      }
      return { values: { token: r.token } }
    },
    env: ({ values, config }) => anthropicRouteEnv(values.token, config),
  },
  {
    // Local codex-as-api proxy. No user secret required -- see this file's
    // header comment for why an explicit placeholder key is still injected
    // (diverging from the proxy lane's bare run-agent.sh shape).
    id: 'chatgpt',
    credential: 'none',
    pre: (config) => {
      // Absent is not an error and not a default any more (2026-08-04). The
      // proxy is in-process and now binds an EPHEMERAL port, so when the user
      // configured nothing, THIS FUNCTION CANNOT KNOW THE ANSWER -- only the
      // bind does. resolveChatgptProxyPort is still the single validator for
      // the explicit case; it just is not consulted for a default that no
      // longer exists.
      const raw = config.CHATGPT_PROXY_PORT
      const explicit = raw != null && String(raw).trim() !== ''
      if (!explicit) return { values: { port: null } }
      const portResult = resolveChatgptProxyPort(raw)
      if (portResult.error) {
        return {
          error: {
            kind: 'provider_not_wired',
            reason: portResult.error,
            fix: 'Set CHATGPT_PROXY_PORT to a whole number between 1 and 65535, or remove it entirely -- with it unset the app picks a free port itself, which is the normal case.',
          },
        }
      }
      return { values: { port: portResult.port } }
    },
    env: ({ values, config }) => {
      // 0.2.2: codex-as-api speaks the anthropic-messages protocol (it was
      // consumed via ANTHROPIC_BASE_URL pre-swap), so it becomes a
      // hand-declared anthropic-messages route in the dsh lane. The proxy
      // ignores auth; the placeholder satisfies pi-ai's key requirement.
      // Fallback must name a row the catalog actually carries: dshContextWindowFor()
      // reads model-catalog.cjs, and an unknown id silently drops this lane's
      // declared window to the 131072 floor (the 0.3 P4 regression). gpt-6-astra
      // is the catalog's GPT default as of the 2026-09-28 prune.
      const model = requiredModel(config) || 'gpt-6-astra'
      return {
        ...dshCommonEnv(config),
        DSH_ROUTE: 'declared',
        DSH_PROVIDER: 'codex',
        DSH_ROUTE_API: 'anthropic-messages',
        // null port -> CLEARED, not guessed (2026-08-04). main.cjs fills this
        // in with the port the kernel actually assigned, after
        // ensureCodexProxy binds.
        //
        // Cleared rather than left at a plausible default ON PURPOSE. If that
        // fill-in is ever lost, the route has no base URL and the lane fails
        // loudly instead of talking to whoever happens to answer. The old
        // behaviour -- a hardcoded localhost:18080 -- would instead hand the
        // whole conversation stream to whatever process owned that port. A
        // loud failure and a silent misroute are not comparable, so the
        // failure mode is chosen deliberately.
        DSH_ROUTE_BASE_URL: values.port ? `http://localhost:${values.port}` : undefined,
        DSH_ROUTE_KEY_ENV: 'CODEX_PROXY_KEY',
        CODEX_PROXY_KEY: CHATGPT_PLACEHOLDER_KEY,
        // Pass the discovered receipt even if the child starts before async discovery settles.
        DSH_MODEL_CONTEXT: String(require('./onboarding/public/js/model-catalog.cjs').dshContextWindowFor(model)),
        DSH_MODEL: model,
        DSH_MODEL_VISION: '1', // parity with the pre-swap lane's vision 'yes'
        MODEL: model,
      }
    },
  },
  {
    // Ollama CLOUD via API key (2026-08-04, the owner "ollama -> API키" -- see
    // OLLAMA_CLOUD_BASE_URL's comment for the receipt and the history; the
    // previous local-daemon/`ollama signin` mode is gone from this lane.
    // A local daemon is still reachable through the 'custom' row with
    // http://localhost:11434 as the base URL). A real model tag is still
    // required -- same reasoning as before: falling back to config.MODEL's
    // generic default ('claude-opus-4-6') would silently send an Anthropic
    // model id to ollama.com, which has no such model -- fail loud instead.
    id: 'ollama',
    credential: 'required',
    keyName: 'ollama',
    notReady: 'onboarding says PROVIDER=ollama but no ollama.com API key is on file yet',
    notReadyFix: 'Open Settings > Model, pick Ollama, and paste an API key from ollama.com (account settings > API keys). It is checked against ollama.com before it is stored.',
    pre: (config) => {
      const model = requiredModel(config)
      if (!model) {
        return {
          error: {
            kind: 'not_ready',
            reason: 'onboarding says PROVIDER=ollama but no MODEL (ollama model tag) is on file yet',
            fix: 'Pick an Ollama model in Settings > Model. It has to be a name from the ollama.com model list.',
          },
        }
      }
      // signin-era ':cloud' tags normalized here so old configs keep
      // working -- see normalizeOllamaCloudModel's own comment.
      return { values: { model: normalizeOllamaCloudModel(model) } }
    },
    env: ({ key, values, config }) => ({
      // 0.2.2: ollama.com cloud via its OpenAI-compatible surface
      // (https://ollama.com/v1) as a hand-declared openai-completions
      // route. The Bearer-only auth requirement (field receipt 2026-08-04:
      // x-api-key = 401, only `authorization: Bearer` works) is satisfied
      // structurally -- the openai protocol sends its key as Bearer.
      // ⚠ ollama.com/v1 openai surface: protocol-inferred, not yet
      // field-verified with a live key (no ollama.com key on the dev box).
      ...dshCommonEnv(config),
      DSH_ROUTE: 'declared',
      DSH_PROVIDER: 'ollama-cloud',
      DSH_ROUTE_API: 'openai-completions',
      DSH_ROUTE_BASE_URL: `${OLLAMA_CLOUD_BASE_URL}/v1`,
      DSH_ROUTE_KEY_ENV: 'OLLAMA_CLOUD_KEY',
      OLLAMA_CLOUD_KEY: key,
      DSH_MODEL: values.model,
      MODEL: values.model, // laneVision: model-based (glm -> 'no' -> app caption fallback)
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
        // ABSENT is not_ready ("no URL yet" -- main.cjs skips the spawn
        // silently, by design). PRESENT BUT INVALID is provider_not_wired, the
        // same call the chatgpt row above makes for a bad port: it stamps a
        // 'failed' status the UI can show. Collapsing both into not_ready meant
        // a typo like CUSTOM_BASE_URL=localhost:8080 (no scheme) produced an
        // app that opened, never spawned an agent, and eventually reported
        // 'timeout' -- a diagnosis with nothing to do with the cause.
        const present = String(config.CUSTOM_BASE_URL || '').trim() !== ''
        return {
          error: {
            kind: present ? 'provider_not_wired' : 'not_ready',
            reason: `onboarding says PROVIDER=custom but ${urlResult.error}`,
            // Two different user tasks, so two different sentences. "You
            // typed it wrong" and "you have not typed it yet" get the same
            // instruction only if you assume the user remembers what they
            // entered -- and the single commonest wrong value here is a
            // scheme-less host, which looks correct to the person who wrote it.
            fix: present
              ? 'Check the Base URL in Settings > Model. It needs a scheme and a host -- `http://localhost:8080`, not `localhost:8080`.'
              : 'Enter the Base URL of your OpenAI-compatible proxy in Settings > Model.',
          },
        }
      }
      const model = requiredModel(config)
      if (!model) {
        return {
          error: {
            kind: 'not_ready',
            reason: 'onboarding says PROVIDER=custom but no MODEL (custom proxy model id) is on file yet',
            fix: 'Enter the model id your proxy expects in Settings > Model. It is passed through verbatim, so it has to match what that endpoint accepts, not an Anthropic model name.',
          },
        }
      }
      return { values: { url: urlResult.url, model } }
    },
    env: ({ key, values, config }) => ({
      // 0.2.2: hand-declared route. Pre-swap this base URL was consumed as
      // ANTHROPIC_BASE_URL (anthropic-messages protocol); the settings-page
      // presets are anthropic-compatible proxies, so the declared route
      // keeps that protocol. A genuinely OpenAI-only proxy needs the api
      // field made configurable -- CUSTOM_ROUTE_API config knob, honored
      // here, defaulting to anthropic-messages for preset parity.
      ...dshCommonEnv(config),
      DSH_ROUTE: 'declared',
      DSH_PROVIDER: 'custom',
      DSH_ROUTE_API: (config.CUSTOM_ROUTE_API === 'openai-completions') ? 'openai-completions' : 'anthropic-messages',
      DSH_ROUTE_BASE_URL: values.url,
      DSH_ROUTE_KEY_ENV: 'CUSTOM_PROXY_KEY',
      CUSTOM_PROXY_KEY: key || CUSTOM_PLACEHOLDER_KEY,
      DSH_MODEL: values.model,
      MODEL: values.model,
    }),
  },
  {
    // dsh lane (0.2.1 harness swap, the owner 2026-08-19 "클로드코드가 해주던거
    // DSV로 갈아낸다"): the supervisor spawns dsh-lane.mjs instead of
    // headless-lane.mjs (LANE_KIND is the switch -- supervisor.mjs
    // resolveConfig reads it from this env). The lane owns a pinned
    // @deepseek-ai/dsh rc-7 web engine against the LOCAL ollama daemon
    // (localhost:11434/v1 openai-completions), models fixed by the lane's
    // patch layer: glm-5.2:cloud text default / qwen3.5:cloud vision.
    //
    // credential 'none': the local daemon takes any bearer value; the lane
    // exports a dummy OLLAMA_API_KEY because pi-ai refuses a route whose
    // apiKeyEnv resolves to nothing (PI_AI_ERROR, measured 2026-08-19) --
    // the header itself is ignored by ollama. Note this is NOT the 'ollama'
    // row's ollama.com key mode; nothing here touches the credential store.
    //
    // config.MODEL is honored ONLY when it names a model the lane's patch
    // layer actually serves (DSH_LANE_MODELS below) -- a provider flip from
    // claude/chatgpt leaves MODEL=claude-opus-*/gpt-* in .agent-config, and
    // sending that to the lane's ollama route would fail every turn, the
    // exact silent-fallback trap the ollama row's comment warns about, in
    // mirror image. Not-served tags fall back to the lane's text default
    // rather than failing loud, because unlike ollama.com this lane HAS a
    // designed default (the owner 08-19: glm-5.2 text / effort max). DSH_MODEL
    // config field overrides unconditionally (hand-edit lane until the
    // settings page grows dsh fields). MODEL is still set in the returned
    // env so spawn-info/laneVision sees the real tag (glm-5.2 -> vision
    // 'no' -> caption fallback route, correct).
    id: 'dsh',
    credential: 'none',
    env: ({ config }) => {
      const configured = (config.MODEL && String(config.MODEL).trim()) || ''
      const model = (config.DSH_MODEL && String(config.DSH_MODEL).trim())
        || (DSH_LANE_MODELS.includes(configured) ? configured : 'glm-5.2:cloud')
      return {
        ...dshCommonEnv(config),
        DSH_ROUTE: 'declared',
        DSH_PROVIDER: 'ollama',
        DSH_ROUTE_API: 'openai-completions',
        DSH_ROUTE_BASE_URL: (config.OLLAMA_BASE_URL && String(config.OLLAMA_BASE_URL).trim()) || 'http://localhost:11434/v1',
        DSH_ROUTE_KEY_ENV: 'OLLAMA_API_KEY',
        OLLAMA_API_KEY: 'ollama-local', // dummy -- see row comment
        DSH_MODEL: model,
        DSH_EFFORT: (config.DSH_EFFORT && String(config.DSH_EFFORT).trim()) || 'max', // this route's own default beats the shared EFFORT_LEVEL mapping
        DSH_VISION_SIDECAR: model === 'qwen3.5:cloud' ? '' : 'qwen3.5:cloud',
        MODEL: model, // laneVision/spawn-info truth, not a harness arg
        ANTHROPIC_API_KEY: undefined, // this route never talks Anthropic wire
      }
    },
  },
]

// Local-daemon-era cloud tags do not exist on ollama.com (field receipt:
// the owner 2026-08-04 17:37 -- every ollama model dead right after the key-mode
// swap; validate said `deepseek-v4-flash:0731-cloud` is not in the catalog,
// whose actual name is `deepseek-v4-flash`). The local ollama convention
// marked cloud-proxied models with a ':cloud' / ':0731-cloud' style tag;
// ollama.com's own names never carry it, while REAL cloud tags with colons
// (nemotron-3-nano:30b, gpt-oss:120b) never contain the word 'cloud'. So the
// deterministic rule: when the tag segment contains 'cloud', strip the whole
// ':...' suffix; otherwise leave the name alone. Applied at BOTH ends --
// spawn env (here) and key validation (http-server) -- so a config written
// in the signin era keeps working without the user retyping the model.
function normalizeOllamaCloudModel(model) {
  const m = String(model || '').trim()
  const idx = m.indexOf(':')
  if (idx === -1) return m
  return /cloud/i.test(m.slice(idx + 1)) ? m.slice(0, idx) : m
}

// Shared by the ollama/custom rows: a MODEL that is missing or whitespace-only
// is "not configured", never a silent fallback to config.MODEL's Anthropic
// default. Returns '' for the not-configured case so callers read as a plain
// truthiness check.
function requiredModel(config) {
  return config.MODEL && String(config.MODEL).trim() ? String(config.MODEL).trim() : ''
}

// The models the dsh lane's patch layer serves (dsh-lane.mjs buildPatch:
// llm-pi-ai ollama providers block). The 'dsh' row above honors config.MODEL
// only when it is one of these; keep in sync with the lane's patch when a
// model joins/leaves.
//
// Re-verified 2026-09-16 (the owner's "올라마 최신 리스트 다시 긁기" pass): both ids
// are still live on ollama.com (glm-5.2 and qwen3.5 both present in the
// cloud-model scrape that day) and both still tool-call, so this list is
// UNCHANGED even though the picker's Ollama group moved
// deepseek-v4-flash:0731 -> deepseek-v4.1-flash and gained glm-5.3. Those two
// are picker rows for the ollama row's own lane, not ids the dsh patch layer
// serves, so copying them here would re-open the silent-fallback trap this
// allowlist exists to close.
const DSH_LANE_MODELS = ['glm-5.2:cloud', 'qwen3.5:cloud']

const PROVIDER_ROWS_BY_ID = new Map(PROVIDER_ROWS.map((row) => [row.id, row]))

// The order the `provider_not_wired` message lists, preserved verbatim from
// the pre-table if-chain's message (claude, claude-cli, claude-subscription,
// chatgpt, ollama, custom) rather than derived from PROVIDER_ROWS order --
// this string is user-visible and one test pins its shape.
const PROVIDER_IDS_FOR_MESSAGE = ['claude', 'claude-cli', 'claude-subscription', 'chatgpt', 'ollama', 'custom', 'dsh']

function buildProviderEnv(provider, config, deps) {
  const { readProviderKey } = deps

  const row = PROVIDER_ROWS_BY_ID.get(provider)
  if (!row) {
    return {
      error: {
        kind: 'provider_not_wired',
        reason: `provider "${provider}" is not a recognized mode -- expected one of: ${PROVIDER_IDS_FOR_MESSAGE.join(', ')}`,
        fix: 'Pick a provider in Settings > Model. Reaching this means the config file on disk holds a PROVIDER value the wizard cannot produce, so it was hand-edited.',
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
    // deps rides into pre() too (0.2.2): claude-cli's login extraction is
    // injectable (deps.readClaudeCliToken) so tests do not depend on the
    // dev machine's real CLI login. Rows that don't need deps ignore it.
    const result = row.pre(config, deps)
    if (result.error) return { error: result.error }
    values = result.values || {}
  }

  let key
  if (row.credential !== 'none') {
    try {
      key = readProviderKey(row.keyName)
    } catch (err) {
      return {
        error: {
          kind: 'key_error',
          reason: `readProviderKey(${row.keyName}) failed: ${err.message}`,
          // Deliberately NOT row.notReadyFix: "paste your key again" is the
          // wrong instruction here. The key may well be on disk and correct --
          // what failed is the read, which on macOS means the OS refused to
          // unseal the credential store.
          fix: 'The stored credential could not be read. Re-saving it in Settings > Model rewrites the entry; if that fails too, the OS credential store is refusing this app rather than the key being wrong.',
        },
      }
    }
    if (!key && row.credential === 'required') {
      return { error: { kind: 'not_ready', reason: row.notReady, fix: row.notReadyFix } }
    }
  }

  return { env: row.env({ key, values, config }) }
}

// Which PROVIDERS values require a stored credential before onboarding can
// complete (single source of truth shared with onboarding/http-server.cjs's
// /api/onboarding/complete gate, so the "does this provider need a secret"
// fact lives in exactly one place). chatgpt routes to a local proxy and
// needs no user secret at all -- see buildProviderEnv above. 'ollama' joined
// this list 2026-08-04 (cloud API-key mode; see the ollama row). 'custom'
// needs none: its API key is OPTIONAL, not required (a stored key is used
// when present, a placeholder otherwise -- see buildProviderEnv's 'custom'
// branch), so it is never added here either.
const PROVIDERS_REQUIRING_STORED_CREDENTIAL = ['claude', 'claude-subscription', 'ollama']

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
  // Same argument as notReady one line up, one step further: a reason with no
  // fix is a dead end shown to someone who cannot open the log. The whole
  // point of splitting the field was that the fix would be maintained; an
  // unchecked optional field is how it silently stops being.
  if (row.credential === 'required' && (typeof row.notReadyFix !== 'string' || !row.notReadyFix)) {
    throw new Error(`provider-env: row "${row.id}" requires a credential but has no notReadyFix instruction`)
  }
}

// ── route proxy helpers (2026-10-07, live model/effort switching) ───────
// Pure readers over a BUILT env (buildProviderEnv().env). main.cjs points
// every row's DSH_ROUTE_BASE_URL at route-proxy.cjs after the build; these
// decide which proxy class a row rides and whether a config change can be
// absorbed by the proxy (live) or needs the agent cycled (restart). The rows
// above are untouched: their upstream fields stay the truth the proxy
// forwards to.
const ROUTE_PROXY_DUMMY_KEY = 'sera-proxy'
// Rows whose key env carries a placeholder rather than a secret. The proxy
// forwards those verbatim (passthrough): there is nothing to inject.
const ROUTE_PLACEHOLDER_KEYS = [CHATGPT_PLACEHOLDER_KEY, CUSTOM_PLACEHOLDER_KEY, 'ollama-local']

// 'anthropic' for the pi-ai catalog route and every declared
// anthropic-messages route; 'openai' for openai-completions.
function routeClassOf (env) {
  if (!env) return null
  return env.DSH_ROUTE === 'anthropic-catalog' || env.DSH_ROUTE_API === 'anthropic-messages' ? 'anthropic' : 'openai'
}

// 'oauth' (sk-ant-oat -- pi-ai flips native OAuth mode in the lane; the
// proxy must stay passthrough), 'api-key' (a real secret the proxy injects),
// 'none' (placeholder or absent -- passthrough).
function credentialClassOf (env) {
  if (!env) return null
  const keyEnv = env.DSH_ROUTE_KEY_ENV
  const value = keyEnv ? env[keyEnv] : undefined
  if (typeof value !== 'string' || !value.trim()) return 'none'
  if (value.includes('sk-ant-oat')) return 'oauth'
  if (ROUTE_PLACEHOLDER_KEYS.includes(value)) return 'none'
  return 'api-key'
}

function routeKindOf (env) {
  return env && env.DSH_ROUTE === 'anthropic-catalog' ? 'catalog' : 'declared'
}

// pi-ai's anthropic catalog: adaptive-thinking models take thinking
// {type:'adaptive'} + output_config.effort, older ones thinking.budget_tokens.
// The proxy rewrites fields on a body the lane shaped for ITS session model,
// so a live switch across that line would 400 -- phase 1 restarts instead.
// Returns 'adaptive' | 'budget' | null (unknown model or catalog unreadable;
// null on either side means restart, never a guess).
let anthropicCatalogCache
function loadAnthropicCatalog () {
  if (anthropicCatalogCache !== undefined) return anthropicCatalogCache
  anthropicCatalogCache = null
  const fs = require('node:fs')
  const path = require('node:path')
  const rel = path.join('@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'anthropic.json')
  const candidates = [
    path.join(__dirname, 'node_modules', rel),
    path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules', rel),
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const models = parsed && parsed['anthropic-messages']
      if (models && typeof models === 'object') { anthropicCatalogCache = models; break }
    } catch { /* next candidate */ }
  }
  return anthropicCatalogCache
}
function anthropicThinkingShape (modelId, catalog = loadAnthropicCatalog()) {
  if (!catalog || !modelId) return null
  const row = catalog[String(modelId)]
  if (!row || typeof row !== 'object') return null
  return row.compat && row.compat.forceAdaptiveThinking === true ? 'adaptive' : 'budget'
}

// codex-as-api's known model set (0.3.14, chatgpt live switch). The in-process
// codex proxy (main.cjs ensureCodexProxy) is built ONCE per spawn with
// CODEX_AS_API_MODEL = the spawn model, and that env is only the FALLBACK:
// dist/index.cjs resolveAnthropicBackendModel(body.model, fallback) serves
// body.model itself whenever KNOWN_CODEX_MODELS has it, else the fallback.
// So a live model switch reaches the engine iff the new id is in that set;
// an unknown id would be silently served as the spawn model. The set is
// built from the package's bundled model-capabilities table, which tsup
// inlines into the bundle (no json file ships), hence the text scan below
// over the one constant path. Unreadable -> null -> restart, never a guess.
const CODEX_AS_API_BUNDLE = require('node:path').join('codex-as-api', 'dist', 'index.cjs')
const CODEX_CAPABILITIES_MARKER = 'var model_capabilities_default = {'
let codexKnownModelsCache
function loadCodexKnownModels () {
  if (codexKnownModelsCache !== undefined) return codexKnownModelsCache
  codexKnownModelsCache = null
  const fs = require('node:fs')
  const path = require('node:path')
  const candidates = [path.join(__dirname, 'node_modules', CODEX_AS_API_BUNDLE)]
  try { candidates.unshift(require.resolve('codex-as-api')) } catch { /* not installed here */ }
  for (const file of candidates) {
    try {
      const src = fs.readFileSync(file, 'utf8')
      const start = src.indexOf(CODEX_CAPABILITIES_MARKER)
      if (start < 0) continue
      const end = src.indexOf('\n};', start)
      const block = src.slice(start, end < 0 ? undefined : end)
      const ids = new Set()
      for (const m of block.matchAll(/^ {4}"([^"]+)":\s*\{/gm)) ids.add(m[1])
      if (ids.size) { codexKnownModelsCache = ids; break }
    } catch { /* next candidate */ }
  }
  return codexKnownModelsCache
}
function codexModelKnown (modelId, known = loadCodexKnownModels()) {
  if (!known || !modelId) return null
  return known.has(String(modelId))
}

// { mode: 'live' | 'restart', reason, handover? }. Live only when the
// protocol class, credential class and route kind all hold, the lane's
// vision wiring is unchanged, the chatgpt row is on BOTH sides or neither
// (its codex proxy is spawn-bound), and an anthropic catalog switch stays
// on one thinking shape. Everything else the proxy absorbs: model, effort,
// a same-class base URL or key swap. handover:true marks a codex model
// change onto an id the codex-as-api table lacks (see loadCodexKnownModels):
// live, but main.cjs must stand up a new codex proxy instance first.
function decideRouteChange (prevEnv, nextEnv, opts = {}) {
  if (!prevEnv || !nextEnv) return { mode: 'restart', reason: 'no previous route to compare against' }
  if (prevEnv.LANE_KIND !== nextEnv.LANE_KIND) return { mode: 'restart', reason: `lane kind ${prevEnv.LANE_KIND} -> ${nextEnv.LANE_KIND}` }
  const prevCodex = prevEnv.DSH_PROVIDER === 'codex'
  const nextCodex = nextEnv.DSH_PROVIDER === 'codex'
  if (prevCodex !== nextCodex) return { mode: 'restart', reason: `chatgpt row ${prevCodex ? 'left' : 'entered'}: the codex proxy is spawn-bound` }
  // codex -> codex model change: an id the table knows rides the pure body
  // rewrite; any other id (the gpt-6 family on 0.6.5, or an unreadable
  // table) needs a NEW codex proxy instance whose fallback IS that id --
  // main.cjs applyRoute's handover (spawn beside, repoint, retire). Still
  // live: the lane never restarts. Same model = the live instance's own
  // fallback, so effort-only switches need neither.
  let handover = false
  if (prevCodex && nextCodex && prevEnv.DSH_MODEL !== nextEnv.DSH_MODEL) {
    const known = codexModelKnown(nextEnv.DSH_MODEL, opts.codexModels)
    if (known !== true) handover = known === null ? 'codex-as-api model table unreadable' : `${nextEnv.DSH_MODEL} not in codex-as-api's model table`
  }
  const prevClass = routeClassOf(prevEnv)
  const nextClass = routeClassOf(nextEnv)
  if (prevClass !== nextClass) return { mode: 'restart', reason: `protocol class ${prevClass} -> ${nextClass}` }
  const prevCred = credentialClassOf(prevEnv)
  const nextCred = credentialClassOf(nextEnv)
  if (prevCred !== nextCred) return { mode: 'restart', reason: `credential class ${prevCred} -> ${nextCred}` }
  const prevKind = routeKindOf(prevEnv)
  const nextKind = routeKindOf(nextEnv)
  if (prevKind !== nextKind) return { mode: 'restart', reason: `route kind ${prevKind} -> ${nextKind}` }
  if ((prevEnv.DSH_MODEL_VISION || '') !== (nextEnv.DSH_MODEL_VISION || '')) return { mode: 'restart', reason: 'DSH_MODEL_VISION changed (lane marker wiring is spawn-time)' }
  if ((prevEnv.DSH_VISION_SIDECAR || '') !== (nextEnv.DSH_VISION_SIDECAR || '')) return { mode: 'restart', reason: 'DSH_VISION_SIDECAR changed (lane caption wiring is spawn-time)' }
  if (nextKind === 'catalog' && prevEnv.DSH_MODEL !== nextEnv.DSH_MODEL) {
    const a = anthropicThinkingShape(prevEnv.DSH_MODEL, opts.catalog)
    const b = anthropicThinkingShape(nextEnv.DSH_MODEL, opts.catalog)
    if (!a || !b) return { mode: 'restart', reason: `thinking shape unknown for ${!a ? prevEnv.DSH_MODEL : nextEnv.DSH_MODEL} (not in the pi-ai anthropic catalog)` }
    if (a !== b) return { mode: 'restart', reason: `thinking shape ${a} -> ${b} (${prevEnv.DSH_MODEL} -> ${nextEnv.DSH_MODEL})` }
  }
  const changed = []
  if (prevEnv.DSH_MODEL !== nextEnv.DSH_MODEL) changed.push(`model ${prevEnv.DSH_MODEL} -> ${nextEnv.DSH_MODEL}`)
  if ((prevEnv.DSH_EFFORT || '') !== (nextEnv.DSH_EFFORT || '')) changed.push(`effort ${prevEnv.DSH_EFFORT || '-'} -> ${nextEnv.DSH_EFFORT || '-'}`)
  if ((prevEnv.DSH_ROUTE_BASE_URL || '') !== (nextEnv.DSH_ROUTE_BASE_URL || '')) changed.push('base url')
  const prevKey = prevEnv.DSH_ROUTE_KEY_ENV ? prevEnv[prevEnv.DSH_ROUTE_KEY_ENV] : undefined
  const nextKey = nextEnv.DSH_ROUTE_KEY_ENV ? nextEnv[nextEnv.DSH_ROUTE_KEY_ENV] : undefined
  if (prevKey !== nextKey || prevEnv.DSH_ROUTE_KEY_ENV !== nextEnv.DSH_ROUTE_KEY_ENV) changed.push('key')
  if (prevEnv.DSH_PROVIDER !== nextEnv.DSH_PROVIDER) changed.push(`provider ${prevEnv.DSH_PROVIDER} -> ${nextEnv.DSH_PROVIDER}`)
  if (handover) return { mode: 'live', reason: `codex proxy handover (${handover}): ${changed.join(', ')}`, handover: true }
  return { mode: 'live', reason: changed.length ? changed.join(', ') : 'no route-relevant change' }
}

module.exports = {
  buildProviderEnv,
  routeClassOf,
  credentialClassOf,
  routeKindOf,
  anthropicThinkingShape,
  loadCodexKnownModels,
  codexModelKnown,
  CODEX_AS_API_BUNDLE,
  decideRouteChange,
  ROUTE_PROXY_DUMMY_KEY,
  refreshClaudeCliToken,
  CLAUDE_CLI_PROVIDER_ID,
  resolveChatgptProxyPort,
  resolveCustomBaseUrl,
  parseCustomProviderJson,
  PROVIDERS_REQUIRING_STORED_CREDENTIAL,
  CHATGPT_PROXY_DEFAULT_PORT,
  CHATGPT_PLACEHOLDER_KEY,
  CUSTOM_PLACEHOLDER_KEY,
  OLLAMA_BASE_URL,
  OLLAMA_CLOUD_BASE_URL,
  normalizeOllamaCloudModel,
}
