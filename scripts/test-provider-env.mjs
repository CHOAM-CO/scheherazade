#!/usr/bin/env node
// test-provider-env.mjs — exercises provider-env.cjs's buildProviderEnv()
// directly (no Electron, no spawn, no real safeStorage/Keychain, no real
// `claude` binary) for all 4 provider modes + the unrecognized-provider
// defense-in-depth branch. Run: node scripts/test-provider-env.mjs
//
// SCOPE: this proves the ENV-BUILDING DECISION LOGIC only -- given a
// (fake, injected) readProviderKey and a config object, does
// buildProviderEnv() return the right env fields / the right error kind.
// It does NOT prove: the spawned `claude` CLI actually authenticates
// successfully against a real codex-as-api proxy / real Ollama daemon /
// real Anthropic API with these env shapes (no live spawn anywhere in this
// file); or that the onboarding HTTP endpoints (http-server.cjs)
// accept/store the right fields (separate, not covered here). It DOES
// include one live `child_process.spawnSync` check (section 0 below) of the
// Node-internal behavior this module's `undefined`-clearing design depends
// on -- that main.cjs's real `spawn()` call actually honors it is
// consistent with this (same Node child_process code path), but is not
// itself re-exercised against main.cjs's actual spawn call here.
//
// Mirrors scripts/test-liveness-marker.mjs's plain assert()/pass/fail
// convention.

import { spawnSync } from 'node:child_process'
import { buildProviderEnv, providerNeedsIsolatedConfigDir, parseCustomProviderJson, PROVIDERS_REQUIRING_STORED_CREDENTIAL, CHATGPT_PROXY_DEFAULT_PORT, CHATGPT_PLACEHOLDER_KEY, OLLAMA_BASE_URL } from '../provider-env.cjs'

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) {
    pass++
    console.log(`PASS  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label}`)
  }
}

// Fake readProviderKey: a tiny in-memory credential store so no real
// safeStorage/Keychain/Electron dependency is needed at all.
function fakeReadProviderKey(store) {
  return (provider) => {
    if (store.throwFor === provider) throw new Error(`simulated Keychain/safeStorage decrypt failure for ${provider}`)
    return Object.prototype.hasOwnProperty.call(store, provider) ? store[provider] : null
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 0. Node-internal precondition this module's `undefined`-clearing design
//    depends on: does child_process actually OMIT an `undefined`-valued env
//    key from the child's real environment, rather than e.g. stringifying
//    it to the literal text "undefined"? A real spawnSync, not a guess.
// ─────────────────────────────────────────────────────────────────────────
{
  // console.log(), not process.stdout.write(): write() throws on a literal
  // JS `undefined` argument (TypeError: chunk must be string/Buffer) --
  // console.log() stringifies it to the text "undefined" instead, which is
  // exactly the distinction this probe needs to observe from the OUTSIDE
  // (this child's own process.env.PROBE_VAR, not this test file's `probe`
  // object).
  const probe = spawnSync(process.execPath, ['-e', 'console.log(process.env.PROBE_VAR)'], {
    env: { ...process.env, PROBE_VAR: undefined },
    encoding: 'utf8',
  })
  assert(probe.status === 0, `child_process undefined-env probe: child exited 0 (status=${probe.status}, stderr=${(probe.stderr || '').slice(0, 200)})`)
  assert(probe.stdout.trim() === 'undefined', `child_process undefined-env probe: child sees process.env.PROBE_VAR as JS undefined, not the string "undefined" (got stdout=${JSON.stringify(probe.stdout)})`)
}

// ─────────────────────────────────────────────────────────────────────────
// 1. provider === 'claude' (BYOK) -- PRESERVED existing behavior
// ─────────────────────────────────────────────────────────────────────────
{
  const store = { claude: 'sk-ant-fake-byok-key-0001' }
  const result = buildProviderEnv('claude', {}, { readProviderKey: fakeReadProviderKey(store) })
  assert(!result.error, 'claude: no error when a key is on file')
  assert(result.env && result.env.ANTHROPIC_API_KEY === 'sk-ant-fake-byok-key-0001', 'claude: ANTHROPIC_API_KEY == stored key')
  assert(result.env.ANTHROPIC_BASE_URL === undefined && 'ANTHROPIC_BASE_URL' in result.env, 'claude: ANTHROPIC_BASE_URL explicitly cleared (present key, undefined value)')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'claude: CLAUDE_CODE_OAUTH_TOKEN explicitly cleared (present key, undefined value)')
}
{
  // no key on file yet -- quiet skip, not a hard error
  const store = {}
  const result = buildProviderEnv('claude', {}, { readProviderKey: fakeReadProviderKey(store) })
  assert(result.error && result.error.kind === 'not_ready', 'claude: no key on file -> error.kind === "not_ready"')
}
{
  // readProviderKey throws -- key_error
  const store = { throwFor: 'claude' }
  const result = buildProviderEnv('claude', {}, { readProviderKey: fakeReadProviderKey(store) })
  assert(result.error && result.error.kind === 'key_error', 'claude: readProviderKey throws -> error.kind === "key_error"')
  assert(/simulated Keychain/.test(result.error.reason), 'claude: key_error reason carries the underlying error message')
}

// ─────────────────────────────────────────────────────────────────────────
// 1b. provider === 'claude-cli' (NEW 2026-07-13: reuse the machine's EXISTING
//     Claude Code CLI login in place; zero paste, zero storage, zero copy)
//
//     The contract is unusual and worth asserting hard: the implementation is
//     the ABSENCE of env. All three auth vars must be present-as-undefined --
//     i.e. actively cleared in the child, not merely "not set here" -- because
//     main.cjs spreads ...process.env into the spawn, so a value left over from
//     a previous provider would otherwise win and silently turn this mode into
//     BYOK-on-a-stale-key. `'X' in env` is the assertion that matters; a plain
//     `env.X === undefined` would pass even if the key were missing entirely.
// ─────────────────────────────────────────────────────────────────────────
{
  // Deliberately hand it a store that WOULD satisfy other modes: claude-cli
  // must not read, prefer, or fall back to any stored credential.
  const store = { claude: 'sk-ant-should-not-be-used', 'claude-subscription': 'token-should-not-be-used' }
  let readCalls = 0
  const spyRead = (p) => { readCalls++; return store[p] }
  const result = buildProviderEnv('claude-cli', { MODEL: 'opus' }, { readProviderKey: spyRead })
  assert(!result.error, 'claude-cli: never errors (no credential to be missing)')
  assert(readCalls === 0, 'claude-cli: readProviderKey is NEVER called (the promise is that we do not read the user credential)')
  assert(result.env.ANTHROPIC_API_KEY === undefined && 'ANTHROPIC_API_KEY' in result.env, 'claude-cli: ANTHROPIC_API_KEY actively cleared (a stale key would out-rank the OAuth session)')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'claude-cli: CLAUDE_CODE_OAUTH_TOKEN actively cleared')
  assert(result.env.ANTHROPIC_BASE_URL === undefined && 'ANTHROPIC_BASE_URL' in result.env, 'claude-cli: ANTHROPIC_BASE_URL actively cleared (else a stale ollama/codex base-url would hijack the session)')
  assert(Object.values(result.env).every((v) => v === undefined), 'claude-cli: injects NOTHING -- the empty env IS the mechanism')
}
{
  // A stored credential is NOT required for this mode to be completable.
  assert(
    !PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes('claude-cli'),
    'claude-cli: not in PROVIDERS_REQUIRING_STORED_CREDENTIAL (onboarding must not demand a paste)',
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 2. provider === 'claude-subscription' (NEW: OAuth token from `claude
//    setup-token`)
// ─────────────────────────────────────────────────────────────────────────
{
  const store = { 'claude-subscription': 'oauth-token-fake-0002' }
  const result = buildProviderEnv('claude-subscription', {}, { readProviderKey: fakeReadProviderKey(store) })
  assert(!result.error, 'claude-subscription: no error when a token is on file')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-token-fake-0002', 'claude-subscription: CLAUDE_CODE_OAUTH_TOKEN == stored token')
  assert(result.env.ANTHROPIC_API_KEY === undefined && 'ANTHROPIC_API_KEY' in result.env, 'claude-subscription: ANTHROPIC_API_KEY explicitly cleared (LOCKED design: do NOT inject alongside OAuth token)')
  assert(result.env.ANTHROPIC_BASE_URL === undefined && 'ANTHROPIC_BASE_URL' in result.env, 'claude-subscription: ANTHROPIC_BASE_URL explicitly cleared (no base_url override)')
}
{
  const store = {}
  const result = buildProviderEnv('claude-subscription', {}, { readProviderKey: fakeReadProviderKey(store) })
  assert(result.error && result.error.kind === 'not_ready', 'claude-subscription: no token on file -> error.kind === "not_ready"')
}
{
  const store = { throwFor: 'claude-subscription' }
  const result = buildProviderEnv('claude-subscription', {}, { readProviderKey: fakeReadProviderKey(store) })
  assert(result.error && result.error.kind === 'key_error', 'claude-subscription: readProviderKey throws -> error.kind === "key_error"')
}

// ─────────────────────────────────────────────────────────────────────────
// 3. provider === 'chatgpt' (NEW: local codex-as-api proxy, no user secret)
// ─────────────────────────────────────────────────────────────────────────
{
  // no readProviderKey call expected at all -- pass a store that would
  // throw for ANY provider, proving chatgpt's branch never touches it.
  const angryReadProviderKey = () => {
    throw new Error('buildProviderEnv should never call readProviderKey() for chatgpt')
  }
  const result = buildProviderEnv('chatgpt', {}, { readProviderKey: angryReadProviderKey })
  assert(!result.error, 'chatgpt: no error with no config at all (no secret required)')
  assert(result.env.ANTHROPIC_BASE_URL === `http://localhost:${CHATGPT_PROXY_DEFAULT_PORT}`, `chatgpt: ANTHROPIC_BASE_URL defaults to :${CHATGPT_PROXY_DEFAULT_PORT}`)
  assert(result.env.ANTHROPIC_API_KEY === CHATGPT_PLACEHOLDER_KEY, 'chatgpt: ANTHROPIC_API_KEY == clearly-labeled placeholder (see task report: deliberate divergence from skia\'s bare run-agent.sh shape)')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'chatgpt: CLAUDE_CODE_OAUTH_TOKEN explicitly cleared (force api-key auth precedence)')
}
{
  const result = buildProviderEnv('chatgpt', { CHATGPT_PROXY_PORT: '19999' }, { readProviderKey: () => null })
  assert(result.env.ANTHROPIC_BASE_URL === 'http://localhost:19999', 'chatgpt: custom CHATGPT_PROXY_PORT from config is honored')
}
{
  // whitespace-only port config falls back to the default rather than
  // producing "http://localhost:" (a real, if unlikely, config-hygiene bug
  // class -- worth a direct assertion).
  const result = buildProviderEnv('chatgpt', { CHATGPT_PROXY_PORT: '   ' }, { readProviderKey: () => null })
  assert(result.env.ANTHROPIC_BASE_URL === `http://localhost:${CHATGPT_PROXY_DEFAULT_PORT}`, 'chatgpt: whitespace-only CHATGPT_PROXY_PORT falls back to default, not "http://localhost:"')
}

// ─────────────────────────────────────────────────────────────────────────
// 4. provider === 'ollama' (NEW: local daemon, no user secret, real model
//    tag required)
// ─────────────────────────────────────────────────────────────────────────
{
  const angryReadProviderKey = () => {
    throw new Error('buildProviderEnv should never call readProviderKey() for ollama')
  }
  // Fixture model tag: glm (a live catalog model). Was kimi-k2.7-code:cloud
  // until kimi was dropped from the catalog (Mino 2026-07-14) -- this test is
  // a generic passthrough check and a dropped model as its fixture reads as
  // "still supported". test-mute-ledger.mjs deliberately KEEPS the kimi tag:
  // that suite memorializes the exact production incident the ledger was
  // built for, and the ledger is model-agnostic anyway.
  const result = buildProviderEnv('ollama', { MODEL: 'glm-5.2:cloud' }, { readProviderKey: angryReadProviderKey })
  assert(!result.error, 'ollama: no error with a model configured (no secret required)')
  assert(result.env.ANTHROPIC_BASE_URL === OLLAMA_BASE_URL, `ollama: ANTHROPIC_BASE_URL == ${OLLAMA_BASE_URL} (matches run-agent.sh:203 exactly)`)
  assert(result.env.ANTHROPIC_API_KEY === 'ollama', 'ollama: ANTHROPIC_API_KEY == "ollama" (matches run-agent.sh:204 exactly)')
  assert(result.env.MODEL === 'glm-5.2:cloud', 'ollama: MODEL == config model tag (overrides the generic claude-model default)')
  assert(result.env.SKIP_MODEL_GUARD === '1', 'ollama: SKIP_MODEL_GUARD == "1" (matches run-agent.sh:205 shape; NOTE run.sh has no such guard today -- see task report gaps)')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'ollama: CLAUDE_CODE_OAUTH_TOKEN explicitly cleared (force api-key auth precedence)')
}
{
  // no MODEL configured yet -- must fail loud (not_ready), NEVER silently
  // fall back to the generic 'claude-opus-4-6' default (that would send an
  // Anthropic model id to an Ollama daemon that has no such model).
  const result = buildProviderEnv('ollama', {}, { readProviderKey: () => null })
  assert(result.error && result.error.kind === 'not_ready', 'ollama: no MODEL configured -> error.kind === "not_ready" (never silently defaults to claude-opus-4-6)')
}
{
  const result = buildProviderEnv('ollama', { MODEL: '   ' }, { readProviderKey: () => null })
  assert(result.error && result.error.kind === 'not_ready', 'ollama: whitespace-only MODEL -> error.kind === "not_ready"')
}

// ─────────────────────────────────────────────────────────────────────────
// 5. unrecognized provider -- fail-loud defense in depth
// ─────────────────────────────────────────────────────────────────────────
{
  const result = buildProviderEnv('some-made-up-provider', {}, { readProviderKey: () => null })
  assert(result.error && result.error.kind === 'provider_not_wired', 'unrecognized provider -> error.kind === "provider_not_wired"')
  assert(/some-made-up-provider/.test(result.error.reason), 'unrecognized provider: reason names the bad provider string')
}
{
  // config.PROVIDER unset entirely -- main.cjs's own `config.PROVIDER ||
  // 'claude'` default applies BEFORE calling buildProviderEnv(), so this
  // module never sees an empty-string provider in practice; still worth
  // confirming it fails loud rather than silently matching some branch by
  // accident (e.g. falsy-string coercion bugs).
  const result = buildProviderEnv('', {}, { readProviderKey: () => null })
  assert(result.error && result.error.kind === 'provider_not_wired', 'empty-string provider -> error.kind === "provider_not_wired" (not silently treated as claude)')
}

// ─────────────────────────────────────────────────────────────────────────
// 6. cross-mode field hygiene: every returned `env` object explicitly
//    accounts for all 3 auth-shaped fields (ANTHROPIC_API_KEY,
//    ANTHROPIC_BASE_URL, CLAUDE_CODE_OAUTH_TOKEN) -- either sets it to a
//    real value or explicitly clears it to `undefined`. A field silently
//    ABSENT from the returned env (neither set nor cleared) would let a
//    stale value from a PREVIOUS provider's env leak through main.cjs's
//    `...process.env, ...baseFields, ...providerEnv` spread untouched --
//    exactly the cross-provider leak class the sirin ground-truth comment
//    in provider-env.cjs's header describes.
// ─────────────────────────────────────────────────────────────────────────
{
  const AUTH_FIELDS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']
  const cases = [
    ['claude', { readProviderKey: fakeReadProviderKey({ claude: 'k' }) }, {}],
    ['claude-subscription', { readProviderKey: fakeReadProviderKey({ 'claude-subscription': 't' }) }, {}],
    ['chatgpt', { readProviderKey: () => null }, {}],
    ['ollama', { readProviderKey: () => null }, { MODEL: 'm' }],
  ]
  for (const [provider, deps, config] of cases) {
    const result = buildProviderEnv(provider, config, deps)
    for (const field of AUTH_FIELDS) {
      assert(field in result.env, `${provider}: env explicitly accounts for ${field} (set or cleared, never silently absent)`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 7. PROVIDERS_REQUIRING_STORED_CREDENTIAL shape (consumed by
//    http-server.cjs's onboarding-complete gate)
// ─────────────────────────────────────────────────────────────────────────
assert(Array.isArray(PROVIDERS_REQUIRING_STORED_CREDENTIAL), 'PROVIDERS_REQUIRING_STORED_CREDENTIAL is an array')
assert(PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes('claude'), 'PROVIDERS_REQUIRING_STORED_CREDENTIAL includes "claude"')
assert(PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes('claude-subscription'), 'PROVIDERS_REQUIRING_STORED_CREDENTIAL includes "claude-subscription"')
assert(!PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes('chatgpt'), 'PROVIDERS_REQUIRING_STORED_CREDENTIAL excludes "chatgpt" (no user secret)')
assert(!PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes('ollama'), 'PROVIDERS_REQUIRING_STORED_CREDENTIAL excludes "ollama" (no user secret)')

// ─────────────────────────────────────────────────────────────────────────
// 8. config-dir isolation column (2026-07-29)
//
// Nothing sets CLAUDE_CONFIG_DIR for the spawned child today, so these
// assertions look inert. They are not. The claude CLI namespaces its
// credential store BY config dir -- keychain service `Claude Code-credentials`
// when the var is unset, `Claude Code-credentials-<sha256(dir)[0..8]>` when it
// is set (read out of the CLI binary and confirmed live 2026-07-29: a spawn
// with a fresh CLAUDE_CONFIG_DIR reports "Not logged in · Please run /login"
// while the machine's real session stays untouched). `claude-cli` is the mode
// that works by REUSING the login the user already has, so it can only ever
// see that login from the un-namespaced slot. If a later change introduces
// isolation for one provider and applies it globally -- the natural way to
// write it -- `claude-cli` breaks, and it breaks SILENTLY at spawn time on a
// user's machine, not here. That is the regression these lines exist to fail
// on, loudly, in CI-less local `node scripts/test-*.mjs`.
for (const provider of ['claude', 'claude-cli', 'claude-subscription', 'chatgpt', 'ollama', 'custom']) {
  assert(providerNeedsIsolatedConfigDir(provider) === false, `${provider}: no config-dir isolation today`)
}
assert(providerNeedsIsolatedConfigDir('claude-cli') === false,
  'claude-cli: isolation is FALSE as a requirement, not a default -- isolating it would hide the very login this mode exists to reuse')
assert(providerNeedsIsolatedConfigDir('some-made-up-provider') === null,
  'unrecognized provider: isolation reads null ("no opinion"), distinguishable from a deliberate false')

// ─────────────────────────────────────────────────────────────────────────
// 9. parseCustomProviderJson -- pasted provider definition (2026-07-29)
//
// The refusal cases matter more than the accept cases here. A paste that
// declares five providers or a wire dialect this app cannot speak has ONE
// dangerous failure mode: accepting it, configuring a narrower thing than
// the paste says, and reporting success. The user then debugs a model they
// never chose. Every assertion below that checks for an `error` is pinning
// "refuse out loud" against the pressure to be accommodating.
// ─────────────────────────────────────────────────────────────────────────

// -- accepts: the nested shape other tools hand out
{
  const r = parseCustomProviderJson(JSON.stringify({
    providers: { 'my-provider': { name: 'Mine', baseUrl: 'http://127.0.0.1:8080', apiKey: 'sk-x', models: [{ id: 'my-model', name: 'My Model' }] } },
  }))
  assert(!r.error, 'nested paste: parses without error')
  assert(r.baseUrl === 'http://127.0.0.1:8080', 'nested paste: baseUrl carried through resolveCustomBaseUrl')
  assert(r.model === 'my-model', 'nested paste: model id taken from models[0].id')
  assert(r.apiKey === 'sk-x', 'nested paste: apiKey carried through')
}

// -- accepts: the flat shorthand, key omitted (custom mode's key is optional)
{
  const r = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://localhost:11434', model: 'llama3' }))
  assert(!r.error, 'flat paste: parses without error')
  assert(r.model === 'llama3' && r.apiKey === '', 'flat paste: model read, absent key becomes empty string (never undefined-vs-missing ambiguity)')
}

// -- accepts: an explicitly-declared dialect we DO speak
assert(!parseCustomProviderJson(JSON.stringify({ api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', model: 'm' })).error,
  'api: "anthropic-messages" is accepted (it is what the spawned CLI emits)')

// -- refuses: more than one provider / more than one model
{
  const many = parseCustomProviderJson(JSON.stringify({
    providers: { a: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'x' }] }, b: { baseUrl: 'http://127.0.0.1:2', models: [{ id: 'y' }] } },
  }))
  assert(!!many.error, 'two providers in one paste: refused, not silently first-wins')
  assert(many.error.includes('a') && many.error.includes('b'), 'two providers: the error names them, so the user knows what to trim')
  const manyModels = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', models: [{ id: 'x' }, { id: 'y' }] }))
  assert(!!manyModels.error && manyModels.error.includes('y'), 'two models in one paste: refused, and the error names them')
}

// -- refuses: a wire dialect this app has no translation layer for.
// Scheherazade delegates inference to the bundled Claude Code CLI, which
// emits Anthropic Messages and nothing else. Accepting `openai-completions`
// here would be the app promising a proxy's compatibility as if it were its
// own capability. (Aside can carry 9 dialects because it owns its request
// builders; we do not own ours -- teardown 2026-07-29, §6.2.)
{
  const wrong = parseCustomProviderJson(JSON.stringify({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', model: 'm' }))
  assert(!!wrong.error, 'unsupported api dialect: refused rather than ignored')
  assert(wrong.error.includes('openai-completions') && wrong.error.includes('anthropic-messages'),
    'unsupported api dialect: the error names both what was asked and what we can do')
}

// -- refuses: malformed input, each with its own reason (never one vague message)
assert(!!parseCustomProviderJson('').error, 'empty string: refused')
assert(!!parseCustomProviderJson('not json at all').error, 'non-JSON: refused')
assert(!!parseCustomProviderJson('[1,2]').error, 'JSON array: refused (expected an object)')
assert(!!parseCustomProviderJson(JSON.stringify({ providers: {} })).error, 'empty providers map: refused')
assert(!!parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1' })).error, 'no model anywhere: refused')
assert(!!parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', models: [{ name: 'no id here' }] })).error, 'model entry without an id: refused')
assert(!!parseCustomProviderJson(JSON.stringify({ model: 'm' })).error, 'no baseUrl: refused by resolveCustomBaseUrl')
assert(!!parseCustomProviderJson(JSON.stringify({ baseUrl: 'ftp://nope', model: 'm' })).error, 'non-http baseUrl: refused by the SAME validator the typed form uses')

// -- the paste path must not become a way around the typed form's validator:
// whatever comes out still has to survive resolveCustomBaseUrl (asserted
// above) and, at the route, MODEL_ID_PATTERN. This asserts the parser hands
// back the RAW model id rather than pre-blessing it.
{
  const r = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: '  spaced-model  ' }))
  assert(r.model === 'spaced-model', 'model id is trimmed but otherwise unmodified -- the route still gates it on MODEL_ID_PATTERN')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
