#!/usr/bin/env node
// test-provider-env.mjs — exercises provider-env.cjs's buildProviderEnv()
// directly (no Electron, no spawn, no real safeStorage/Keychain, no real
// `claude` binary) for all 4 provider modes + the unrecognized-provider
// defense-in-depth branch. Run: node tests/test-provider-env.mjs
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
// Mirrors tests/test-liveness-marker.mjs's plain assert()/pass/fail
// convention.

import { spawnSync } from 'node:child_process'
import { buildProviderEnv, refreshClaudeCliToken, parseCustomProviderJson, PROVIDERS_REQUIRING_STORED_CREDENTIAL, CHATGPT_PROXY_DEFAULT_PORT, CHATGPT_PLACEHOLDER_KEY, OLLAMA_CLOUD_BASE_URL, normalizeOllamaCloudModel, routeClassOf, credentialClassOf, routeKindOf, anthropicThinkingShape, decideRouteChange, ROUTE_PROXY_DUMMY_KEY } from '../provider-env.cjs'

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
  // 0.2.2 harness swap: the mode now reads the CLI login's access token
  // itself (injectable extractor -- the test must not depend on the dev
  // machine's real login) and hands it to the dsh anthropic route.
  const result = buildProviderEnv('claude-cli', { MODEL: 'claude-opus-5' }, { readProviderKey: spyRead, readClaudeCliToken: () => ({ token: 'sk-ant-oat01-cli-fake' }) })
  assert(!result.error, 'claude-cli: no error when the CLI login is readable')
  assert(readCalls === 0, 'claude-cli: readProviderKey is NEVER called (no app-stored credential in this mode)')
  assert(result.env.LANE_KIND === 'dsh', 'claude-cli: spawns the dsh lane')
  assert(result.env.DSH_ROUTE === 'anthropic-catalog' && result.env.DSH_PROVIDER === 'anthropic', 'claude-cli: anthropic catalog route')
  assert(result.env.ANTHROPIC_API_KEY === 'sk-ant-oat01-cli-fake', 'claude-cli: the extracted oat token rides the route key env (pi-ai detects the prefix and flips OAuth mode)')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'claude-cli: CLI-era OAuth field actively cleared')
  assert(result.env.ANTHROPIC_BASE_URL === undefined && 'ANTHROPIC_BASE_URL' in result.env, 'claude-cli: ANTHROPIC_BASE_URL actively cleared (else a stale base-url would hijack the route)')
}
{
  // No login / expired login -> honest not_ready, never a spawn that dies
  // mid-first-turn.
  const result = buildProviderEnv('claude-cli', {}, { readProviderKey: () => null, readClaudeCliToken: () => ({ error: 'no Claude Code CLI login found' }) })
  assert(result.error && result.error.kind === 'not_ready', 'claude-cli: unreadable/expired CLI login -> not_ready')
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
  // 0.2.2: the stored token rides the dsh anthropic route's key env --
  // pi-ai's oat-prefix detection does the OAuth work the CLI used to do.
  assert(result.env.ANTHROPIC_API_KEY === 'oauth-token-fake-0002', 'claude-subscription: stored token rides the route key env')
  assert(result.env.LANE_KIND === 'dsh' && result.env.DSH_ROUTE === 'anthropic-catalog', 'claude-subscription: dsh anthropic catalog route')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'claude-subscription: CLI-era OAuth field actively cleared')
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
  // 0.2.2: codex-as-api becomes a hand-declared anthropic-messages route
  // in the dsh lane; the proxy URL moves from ANTHROPIC_BASE_URL to
  // DSH_ROUTE_BASE_URL and the placeholder key to the route's own env.
  //
  // 2026-08-04: this used to assert a default of :18080. There is no default
  // any more -- the in-process proxy binds an ephemeral port, so with nothing
  // configured this function genuinely does not know the answer and says so by
  // CLEARING the field. main.cjs fills it after the bind.
  //
  // `'X' in env` is the assertion that matters, same as the claude-cli rows
  // above: the key must be PRESENT-and-undefined so a stale base URL from a
  // previous provider is actively unset in the child, not merely not-set-here.
  assert(result.env.DSH_ROUTE_BASE_URL === undefined && 'DSH_ROUTE_BASE_URL' in result.env,
    'chatgpt: with no port configured, DSH_ROUTE_BASE_URL is CLEARED rather than defaulted (main.cjs fills in the kernel-assigned port)')
  assert(result.env.DSH_ROUTE === 'declared' && result.env.DSH_ROUTE_API === 'anthropic-messages', 'chatgpt: declared anthropic-messages route (the proxy speaks that protocol)')
  assert(result.env.CODEX_PROXY_KEY === CHATGPT_PLACEHOLDER_KEY && result.env.DSH_ROUTE_KEY_ENV === 'CODEX_PROXY_KEY', 'chatgpt: clearly-labeled placeholder rides the route key env')
  assert(result.env.ANTHROPIC_BASE_URL === undefined && 'ANTHROPIC_BASE_URL' in result.env, 'chatgpt: CLI-era ANTHROPIC_BASE_URL actively cleared')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'chatgpt: CLAUDE_CODE_OAUTH_TOKEN explicitly cleared (force api-key auth precedence)')
}
{
  const result = buildProviderEnv('chatgpt', { CHATGPT_PROXY_PORT: '19999' }, { readProviderKey: () => null })
  assert(result.env.DSH_ROUTE_BASE_URL === 'http://localhost:19999', 'chatgpt: custom CHATGPT_PROXY_PORT from config is honored')
}
{
  // Whitespace-only port config must not produce "http://localhost:" -- a
  // real, if unlikely, config-hygiene bug class, and the whole point of the
  // assertion. It used to fall back to the default; it now reads as
  // not-configured, which is the same answer to the same question now that
  // there is no default to fall back to.
  const result = buildProviderEnv('chatgpt', { CHATGPT_PROXY_PORT: '   ' }, { readProviderKey: () => null })
  assert(result.env.DSH_ROUTE_BASE_URL === undefined && 'DSH_ROUTE_BASE_URL' in result.env,
    'chatgpt: whitespace-only CHATGPT_PROXY_PORT reads as unconfigured, never as "http://localhost:"')
}
{
  // The port is a CONTRACT with main.cjs, not an internal detail: main.cjs
  // fills this field in after the bind, and if provider-env ever went back
  // to emitting a plausible default, a lost fill-in would silently route
  // the agent at whatever owns that port instead of failing loudly.
  const unset = buildProviderEnv('chatgpt', {}, { readProviderKey: () => null })
  assert(!/localhost:\d/.test(String(unset.env.DSH_ROUTE_BASE_URL)),
    'chatgpt: an unconfigured port never yields a guessable localhost URL (a lost fill-in must fail loud, not misroute)')
  // ...while an EXPLICIT port still resolves here, because there the config
  // does know the answer and main.cjs is reusing rather than binding.
  const explicit = buildProviderEnv('chatgpt', { CHATGPT_PROXY_PORT: '18080' }, { readProviderKey: () => null })
  assert(explicit.env.DSH_ROUTE_BASE_URL === 'http://localhost:18080',
    'chatgpt: an explicitly-configured port is still resolved by provider-env itself')
}

// ─────────────────────────────────────────────────────────────────────────
// 4. provider === 'ollama' (key-mode 2026-08-04, Mino "ollama -> API키":
//    ollama.com CLOUD via a stored API key -- the local-daemon/no-secret
//    era is git history. Real model tag still required.)
// ─────────────────────────────────────────────────────────────────────────
{
  // Fixture model tag: glm (a live catalog model). Was kimi-k2.7-code:cloud
  // until kimi was dropped from the catalog (Mino 2026-07-14) -- this test is
  // a generic passthrough check and a dropped model as its fixture reads as
  // "still supported". test-mute-ledger.mjs deliberately KEEPS the kimi tag:
  // that suite memorializes the exact production incident the ledger was
  // built for, and the ledger is model-agnostic anyway.
  const result = buildProviderEnv('ollama', { MODEL: 'glm-5.2:cloud' }, { readProviderKey: fakeReadProviderKey({ ollama: 'ol-key' }) })
  assert(!result.error, 'ollama: no error with a model + stored key configured')
  // 0.2.2: ollama.com rides the dsh lane's declared openai-completions
  // route (Bearer is that protocol's native key header -- the 2026-08-04
  // Bearer-only receipt is satisfied structurally now).
  assert(result.env.DSH_ROUTE_BASE_URL === `${OLLAMA_CLOUD_BASE_URL}/v1`, `ollama: route base URL == ${OLLAMA_CLOUD_BASE_URL}/v1 (openai-compatible surface)`)
  assert(result.env.DSH_ROUTE === 'declared' && result.env.DSH_ROUTE_API === 'openai-completions', 'ollama: declared openai-completions route (openai protocol sends the key as Bearer -- the 2026-08-04 field receipt, structurally)')
  assert(result.env.OLLAMA_CLOUD_KEY === 'ol-key' && result.env.DSH_ROUTE_KEY_ENV === 'OLLAMA_CLOUD_KEY', 'ollama: stored key rides the route key env')
  assert(result.env.ANTHROPIC_AUTH_TOKEN === undefined && 'ANTHROPIC_AUTH_TOKEN' in result.env, 'ollama: CLI-era Bearer field actively cleared')
  assert(result.env.ANTHROPIC_API_KEY === undefined && 'ANTHROPIC_API_KEY' in result.env, 'ollama: ANTHROPIC_API_KEY explicitly cleared (a stale Anthropic key as x-api-key must not shadow the Bearer auth)')
  assert(result.env.MODEL === 'glm-5.2', 'ollama: signin-era ":cloud" tag stripped at spawn -- ollama.com has no such names (Mino field receipt 2026-08-04 17:37)')
  assert(result.env.SKIP_MODEL_GUARD === '1', 'ollama: SKIP_MODEL_GUARD == "1" (matches run-agent.sh:205 shape; NOTE the supervisor has no such guard -- see task report gaps)')
  assert(result.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && 'CLAUDE_CODE_OAUTH_TOKEN' in result.env, 'ollama: CLAUDE_CODE_OAUTH_TOKEN explicitly cleared (force api-key auth precedence)')
}
{
  // no MODEL configured yet -- must fail loud (not_ready), NEVER silently
  // fall back to the generic 'claude-opus-4-6' default (that would send an
  // Anthropic model id to ollama.com, which has no such model).
  const result = buildProviderEnv('ollama', {}, { readProviderKey: () => null })
  assert(result.error && result.error.kind === 'not_ready', 'ollama: no MODEL configured -> error.kind === "not_ready" (never silently defaults to claude-opus-4-6)')
}
{
  const result = buildProviderEnv('ollama', { MODEL: '   ' }, { readProviderKey: () => null })
  assert(result.error && result.error.kind === 'not_ready', 'ollama: whitespace-only MODEL -> error.kind === "not_ready"')
}
{
  // model configured but NO stored key -- not_ready, same contract as
  // claude/claude-subscription (ollama joined
  // PROVIDERS_REQUIRING_STORED_CREDENTIAL in key-mode). Order pin: the
  // model precheck (pre) runs BEFORE the credential read, so the missing
  // key is only reported once the model is in place.
  const result = buildProviderEnv('ollama', { MODEL: 'glm-5.2:cloud' }, { readProviderKey: () => null })
  assert(result.error && result.error.kind === 'not_ready', 'ollama: model ok but no stored key -> error.kind === "not_ready"')
  assert(/API key/.test(result.error.reason), 'ollama: missing-key reason names the API key')
}
{
  // Keychain read THROWS (model ok) -> key_error, mirroring the claude rows.
  const result = buildProviderEnv('ollama', { MODEL: 'glm-5.2:cloud' }, { readProviderKey: () => { throw new Error('keychain sealed') } })
  assert(result.error && result.error.kind === 'key_error', 'ollama: throwing readProviderKey -> error.kind === "key_error"')
}
{
  // normalizeOllamaCloudModel: the deterministic signin-era tag strip.
  // Rule: a ':...' tag segment CONTAINING 'cloud' marks the local-daemon
  // convention and the whole suffix goes; real cloud tags with colons
  // (nemotron-3-nano:30b) never contain the word and stay whole.
  assert(normalizeOllamaCloudModel('deepseek-v4-flash:0731-cloud') === 'deepseek-v4-flash', 'normalize: ":0731-cloud" suffix stripped (the exact field case)')
  assert(normalizeOllamaCloudModel('glm-5.2:cloud') === 'glm-5.2', 'normalize: bare ":cloud" suffix stripped')
  assert(normalizeOllamaCloudModel('nemotron-3-nano:30b') === 'nemotron-3-nano:30b', 'normalize: a real size tag is NOT touched')
  assert(normalizeOllamaCloudModel('gpt-oss:120b') === 'gpt-oss:120b', 'normalize: colon tags without "cloud" pass through')
  assert(normalizeOllamaCloudModel('deepseek-v4-flash') === 'deepseek-v4-flash', 'normalize: untagged name passes through')
  assert(normalizeOllamaCloudModel('  glm-5.2:cloud  ') === 'glm-5.2', 'normalize: trims whitespace before judging')
  assert(normalizeOllamaCloudModel('') === '', 'normalize: empty stays empty (caller still fails not_ready)')
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
  const AUTH_FIELDS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
  const cases = [
    ['claude', { readProviderKey: fakeReadProviderKey({ claude: 'k' }) }, {}],
    ['claude-subscription', { readProviderKey: fakeReadProviderKey({ 'claude-subscription': 't' }) }, {}],
    ['chatgpt', { readProviderKey: () => null }, {}],
    ['ollama', { readProviderKey: fakeReadProviderKey({ ollama: 'ol-key' }) }, { MODEL: 'm' }],
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
assert(PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes('ollama'), 'PROVIDERS_REQUIRING_STORED_CREDENTIAL includes "ollama" (key-mode, 2026-08-04)')

// ─────────────────────────────────────────────────────────────────────────
// 8. EVERY row actively clears CLAUDE_CONFIG_DIR (2026-07-29)
//
// Cleared, not merely unset -- `'X' in env && env.X === undefined` is the
// distinction, and it is the same one section 1b makes for the auth vars.
// main.cjs spawns with {...process.env, ...rowEnv}, so a CLAUDE_CONFIG_DIR
// exported in the launching environment reaches the child unless a row
// clears it.
//
// Why it matters, and why it is ALL rows rather than just claude-cli:
//   - claude-cli's availability probe is hardcoded to
//     ~/.claude/.credentials.json via os.homedir() (http-server.cjs) and does
//     NOT follow CLAUDE_CONFIG_DIR, so an inherited one makes detection and
//     spawn read different dirs in the one mode whose promise is "we reuse
//     the login you already have".
//   - onboarding/harness-render.cjs seeds first-run gates into
//     ~/.claude.json for EVERY mode. An inherited CLAUDE_CONFIG_DIR
//     relocates that file and defeats the seeding, dropping the headless
//     spawn onto an interactive first-run prompt.
// Two earlier rounds got this wrong in opposite directions -- first a data
// column nothing read, then a clear on one row while five others kept the
// same exposure. Same variable, same divergence: all or nothing.
{
  const cases = [
    ['claude', { readProviderKey: fakeReadProviderKey({ claude: 'k' }) }, {}],
    ['claude-subscription', { readProviderKey: fakeReadProviderKey({ 'claude-subscription': 't' }) }, {}],
    ['claude-cli', { readProviderKey: () => null, readClaudeCliToken: () => ({ token: 'sk-ant-oat01-cli-fake' }) }, {}],
    ['chatgpt', { readProviderKey: () => null }, {}],
    ['ollama', { readProviderKey: fakeReadProviderKey({ ollama: 'ol-key' }) }, { MODEL: 'm' }],
    ['custom', { readProviderKey: () => null }, { CUSTOM_BASE_URL: 'http://127.0.0.1:1', MODEL: 'm' }],
  ]
  for (const [provider, deps, config] of cases) {
    const result = buildProviderEnv(provider, config, deps)
    assert(result.env && 'CLAUDE_CONFIG_DIR' in result.env && result.env.CLAUDE_CONFIG_DIR === undefined,
      `${provider}: CLAUDE_CONFIG_DIR actively cleared (present-as-undefined), so an inherited one cannot reach the child`)
  }
}

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
//
// The ids here are deliberately MULTI-CHARACTER and unlike any English word.
// A previous version used 'a'/'b'/'x'/'y' and asserted `error.includes('y')`
// -- which passed on the letter in "keep the one **y**ou want", i.e. it would
// still have passed with every model name stripped out of the message. Single
// letters cannot distinguish "the error names them" from "the error contains
// prose". (Red-team catch, 2026-07-29.)
{
  const many = parseCustomProviderJson(JSON.stringify({
    providers: { 'prov-zeta': { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'mdl-zeta' }] }, 'prov-kappa': { baseUrl: 'http://127.0.0.1:2', models: [{ id: 'mdl-kappa' }] } },
  }))
  assert(!!many.error, 'two providers in one paste: refused, not silently first-wins')
  assert(many.error.includes('prov-zeta') && many.error.includes('prov-kappa'), 'two providers: the error names them, so the user knows what to trim')
  const manyModels = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', models: [{ id: 'mdl-zeta' }, { id: 'mdl-kappa' }] }))
  assert(!!manyModels.error, 'two models in one paste: refused')
  assert(manyModels.error.includes('mdl-zeta') && manyModels.error.includes('mdl-kappa'), 'two models: the error names them')
}

// -- refuses: the dialect declaration wherever it appears. Checking only the
// unwrapped provider entry was a real hole -- a file declaring its dialect at
// the TOP level (the natural place for a global one) walked straight through
// the gate this function advertises. (Red-team catch, 2026-07-29.)
{
  const top = parseCustomProviderJson(JSON.stringify({
    api: 'openai-completions',
    providers: { p: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'mm' }] } },
  }))
  assert(!!top.error && top.error.includes('openai-completions'), 'unsupported api at the TOP level (beside "providers"): refused')
  const onModel = parseCustomProviderJson(JSON.stringify({
    baseUrl: 'http://127.0.0.1:1', models: [{ id: 'mm', api: 'openai-responses' }],
  }))
  assert(!!onModel.error && onModel.error.includes('openai-responses'), 'unsupported api on the MODEL row: refused')
  const arr = parseCustomProviderJson(JSON.stringify({ api: ['anthropic-messages'], baseUrl: 'http://127.0.0.1:1', model: 'm' }))
  assert(!!arr.error, 'api as a one-element array: refused, not String()-coerced into a match')
  assert(!parseCustomProviderJson(JSON.stringify({ api: null, baseUrl: 'http://127.0.0.1:1', model: 'm' })).error,
    'api: null reads as "not specified" (JSON emitters write explicit nulls), not as a dialect named "null"')
}

// -- top-level fields beside `providers` are DEFAULTS, and only an actual
// disagreement is refused. An earlier version refused on mere presence, which
// rejected `{"apiKey":"sk","providers":{...}}` -- one key, one endpoint map,
// nothing ambiguous about it. Refusing a paste that says exactly one thing is
// its own kind of wrong.
{
  const globalKey = parseCustomProviderJson(JSON.stringify({
    apiKey: 'sk-global', providers: { proxy: { baseUrl: 'http://localhost:8080', models: [{ id: 'm' }] } },
  }))
  assert(!globalKey.error, 'a top-level apiKey with a per-provider endpoint: accepted, not refused as ambiguous')
  assert(globalKey.apiKey === 'sk-global', 'a top-level apiKey is USED when the entry declares none')
  const agree = parseCustomProviderJson(JSON.stringify({
    baseUrl: 'http://127.0.0.1:1', providers: { p: { baseUrl: 'http://127.0.0.1:1', model: 'm' } },
  }))
  assert(!agree.error, 'top-level and entry agreeing on baseUrl: accepted')
  const both = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://FLAT.example', providers: { p: { baseUrl: 'http://127.0.0.1:1', model: 'm' } } }))
  assert(!!both.error && both.error.includes('baseUrl'), 'top-level baseUrl DISAGREEING with the entry: refused (it used to be dropped silently)')
  const bothModels = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: 'typed-one', models: [{ id: 'listed-one' }] }))
  assert(!!bothModels.error, 'both "model" and "models", disagreeing: refused')
  assert(!parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: 'same', models: [{ id: 'same' }] })).error,
    'both "model" and "models" AGREEING: accepted (a tool emitting both is not a contradiction)')
}

// -- refuses: a wrongly-typed apiKey, instead of coercing it to blank.
// This is the highest-consequence coercion in the file: blank means "keep the
// stored key" at the save route, so dropping a mistyped key silently ships the
// PREVIOUS provider's key to whatever new endpoint the paste just set.
{
  for (const bad of [12345, { value: 'k' }, ['k'], true]) {
    const r = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: bad }))
    assert(!!r.error, `apiKey as ${Array.isArray(bad) ? 'array' : typeof bad}: refused, never silently blanked`)
  }
  const absent = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: null }))
  assert(!absent.error && absent.apiKey === '', 'apiKey: null reads as absent (optional field), not as a type error')
}

// -- a provider entry that nests its OWN providers map used to be accepted
// with the inner one dropped whole -- dialect, endpoint and all. That is the
// same silent narrowing the >1-provider refusal exists for.
assert(!!parseCustomProviderJson(JSON.stringify({
  providers: { p: { baseUrl: 'http://127.0.0.1:1', model: 'm', providers: { q: { api: 'openai-completions', baseUrl: 'http://elsewhere:9', model: 'other' } } } },
})).error, 'a provider containing its own "providers": refused, not silently flattened to the outer one')

// -- `model` gets the same TYPE refusal as `api` and `apiKey`. It used to be
// read as `typeof x === 'string' ? x : ''`, so a wrongly-typed one was dropped
// and `models` silently won -- three sibling fields, and only this one let a
// bad type through.
for (const bad of [['a'], 123, { id: 'a' }]) {
  assert(!!parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: bad, models: ['b'] })).error,
    `model as ${Array.isArray(bad) ? 'array' : typeof bad}: refused, never dropped in favour of models[]`)
}

// -- refusal messages stay bounded, for EVERY user-controlled scalar and not
// just the list joins. readJsonBody accepts 1 MB; capping only the joins moved
// the worst case by zero, because a single ~900 KB model id / api string /
// provider id was interpolated raw and produced a ~900 KB 400 body -- larger
// than the case the cap was added for. Each entry below is one such site.
{
  const big = 'A'.repeat(900_000)
  const sites = [
    ['api', { api: big, baseUrl: 'http://127.0.0.1:1', model: 'm' }],
    ['model', { model: big, models: ['x'], baseUrl: 'http://127.0.0.1:1' }],
    ['model id on a row', { models: [{ id: big, api: 'openai-completions' }], baseUrl: 'http://127.0.0.1:1' }],
    ['provider id', { providers: { [big]: 5 } }],
    ['baseUrl', { baseUrl: `ftp://${big}`, model: 'm' }],
  ]
  for (const [label, obj] of sites) {
    const r = parseCustomProviderJson(JSON.stringify(obj))
    assert(!!r.error, `${label}: a 900KB value is refused`)
    assert(r.error.length < 1000, `${label}: refusal stays bounded (${r.error.length} chars, not ~900KB)`)
  }
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `model-number-${i}`.repeat(20) }))
  const r = parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', models: many }))
  assert(!!r.error, '400 models: refused')
  assert(r.error.length < 2000, `many models: refusal stays small (was ${r.error.length} chars)`)
  assert(r.error.includes('390 more'), 'refusal message says how many names it did not list')
}

// -- null inside a provider entry is ABSENT, not a competing value. The
// merge compared with JSON.stringify, which made `"apiKey": null` disagree
// with a top-level key -- re-creating the false-refusal class the merge was
// written to remove, and contradicting this same function's documented
// null-as-absent handling everywhere else.
{
  const r = parseCustomProviderJson(JSON.stringify({
    apiKey: 'sk-global',
    providers: { p: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: null } },
  }))
  assert(!r.error, 'explicit null inside the entry: reads as absent, not as a disagreement')
  assert(r.apiKey === 'sk-global', 'explicit null inside the entry: the top-level value is used')
}

// -- two byte-identical model lists written in different KEY ORDER are not a
// disagreement. JSON.stringify said they were.
assert(!parseCustomProviderJson(JSON.stringify({
  models: [{ id: 'm', api: 'anthropic-messages' }],
  providers: { p: { baseUrl: 'http://127.0.0.1:1', models: [{ api: 'anthropic-messages', id: 'm' }] } },
})).error, 'same models written in a different field order: accepted, not refused as disagreeing')

// -- a model ROW carrying its own endpoint or key. This function already
// walks these rows (it reads api and id), so dropping these two silently is
// narrowing at a level it demonstrably reads.
for (const k of ['baseUrl', 'apiKey']) {
  const r = parseCustomProviderJson(JSON.stringify({
    providers: { p: { baseUrl: 'http://entry:1', apiKey: 'sk-entry', models: [{ id: 'm', [k]: k === 'baseUrl' ? 'http://row:2' : 'sk-row' }] } },
  }))
  assert(!!r.error && r.error.includes(k), `a model row carrying its own "${k}": refused, not dropped whole`)
}

// -- an absurdly long base URL is refused BEFORE anything quotes it. The
// error paths interpolate the URL, and these errors reach a one-line status
// element; a ~950KB baseUrl produced a ~950KB 400 body from two OTHER routes
// that the preview route's own response cap never touched.
{
  const r = parseCustomProviderJson(JSON.stringify({ baseUrl: `http://x.example/${'A'.repeat(950_000)}`, model: 'm' }))
  assert(!!r.error && r.error.includes('too long'), 'a 950KB base URL: refused on length')
  assert(r.error.length < 200, `length refusal does not quote the URL back (${r.error.length} chars)`)
}

// -- error messages name the right problem. Both of these used to report a
// DIFFERENT refusal than the one that actually applies, which sends the user
// to fix the wrong thing.
assert(parseCustomProviderJson(JSON.stringify({ providers: 'x', baseUrl: 'y' })).error.includes('object keyed by provider id'),
  'a non-object "providers" reports the type error, not an ambiguity error')
assert(parseCustomProviderJson(JSON.stringify({ baseUrl: 'http://127.0.0.1:1', model: 'm', models: [] })).error.includes('non-empty array'),
  'an empty "models" beside a "model" reports the empty-array error, not an ambiguity error')

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

// ─────────────────────────────────────────────────────────────────────────
// 9. every error carries a FIX, not just a diagnosis (2026-08-04)
//
//    `reason` tells the user what is wrong. Only `fix` tells them what to do,
//    and the user seeing these strings cannot open the app log or read this
//    file. A reason without a fix is a dead end rendered in the status pill.
//
//    The table itself enforces this for the per-row `notReady` case at
//    require() time (provider-env.cjs's invariant loop), so THIS block exists
//    for the paths the table cannot see: the inline errors returned from
//    pre() and from buildProviderEnv's own two returns. Those are plain object
//    literals, and an object literal is exactly where a field goes missing.
// ─────────────────────────────────────────────────────────────────────────
{
  const throwingRead = () => { throw new Error('simulated Keychain failure') }
  const emptyRead = () => null
  const cases = [
    ['claude / no key on file', 'claude', {}, emptyRead],
    ['claude / credential read throws', 'claude', {}, throwingRead],
    ['claude-subscription / no token on file', 'claude-subscription', {}, emptyRead],
    ['chatgpt / unusable proxy port', 'chatgpt', { CHATGPT_PROXY_PORT: 'not-a-port' }, emptyRead],
    ['ollama / no model configured', 'ollama', {}, emptyRead],
    ['custom / base URL absent', 'custom', {}, emptyRead],
    ['custom / base URL present but scheme-less', 'custom', { CUSTOM_BASE_URL: 'localhost:8080', MODEL: 'm' }, emptyRead],
    ['custom / model absent', 'custom', { CUSTOM_BASE_URL: 'http://127.0.0.1:8080' }, emptyRead],
    ['provider string not recognized', 'not-a-real-provider', {}, emptyRead],
  ]
  for (const [label, provider, config, readProviderKey] of cases) {
    const result = buildProviderEnv(provider, config, { readProviderKey })
    assert(!!result.error, `${label}: errors (fixture still reaches the error path)`)
    assert(typeof result.error.fix === 'string' && result.error.fix.trim() !== '', `${label}: carries a non-empty error.fix`)
    // Two fields, two jobs. If they were identical the split bought nothing
    // and the next person would be right to collapse them.
    assert(result.error.fix !== result.error.reason, `${label}: fix is not a copy of reason`)
  }

  // The two 'custom' base-URL failures are DIFFERENT user tasks -- "you typed
  // it wrong" vs "you have not typed it yet" -- and the whole reason the row
  // branches on `present` is to say different things. Identical text here
  // would mean the branch is decorative.
  const absent = buildProviderEnv('custom', {}, { readProviderKey: () => null })
  const malformed = buildProviderEnv('custom', { CUSTOM_BASE_URL: 'localhost:8080', MODEL: 'm' }, { readProviderKey: () => null })
  assert(absent.error.fix !== malformed.error.fix, 'custom: an absent base URL and a malformed one give different instructions')

  // key_error must NOT reuse the row's notReadyFix. "Paste your key again" is
  // wrong advice when the key is on disk and the OS refused to unseal it.
  const notReady = buildProviderEnv('claude', {}, { readProviderKey: () => null })
  const keyError = buildProviderEnv('claude', {}, { readProviderKey: throwingRead })
  assert(notReady.error.fix !== keyError.error.fix, 'claude: a missing credential and an unreadable one give different instructions')
}


// 1c. refreshClaudeCliToken (2026-10-07): an expired CLI login is rotated via
// its refresh token and the NEW pair is written back to the same store so
// `claude` and Sera stay on one login. Everything injected; no network.
{
  const T0 = 1_000_000_000_000
  const mkStore = (oauth) => ({ parsed: { claudeAiOauth: { ...oauth, subscriptionType: 'max' } }, source: { kind: 'file', path: '/dev/null' } })
  let written = null
  const writeStore = (_src, parsed) => { written = parsed }
  const okFetch = async (url, init) => {
    const b = JSON.parse(init.body)
    assert(b.grant_type === 'refresh_token' && b.refresh_token === 'rt-old' && typeof b.client_id === 'string', 'refresh: posts grant_type=refresh_token with the stored refresh token')
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sk-ant-oat01-new', refresh_token: 'rt-new', expires_in: 3600 }) }
  }
  // still valid -> untouched
  let r = await refreshClaudeCliToken({ readStore: () => mkStore({ accessToken: 'sk-ant-oat01-old', refreshToken: 'rt-old', expiresAt: T0 + 3_600_000 }), writeStore, fetchFn: okFetch, now: () => T0 })
  assert(r.refreshed === false && written === null, 'refresh: a token with >5 min left is not refreshed and nothing is written')
  // expired -> rotated + written back, other fields preserved
  r = await refreshClaudeCliToken({ readStore: () => mkStore({ accessToken: 'sk-ant-oat01-old', refreshToken: 'rt-old', expiresAt: T0 - 1 }), writeStore, fetchFn: okFetch, now: () => T0 })
  assert(r.refreshed === true && r.expiresAt === T0 + 3_600_000, 'refresh: expired token is rotated, expiresAt = now + expires_in')
  assert(written && written.claudeAiOauth.accessToken === 'sk-ant-oat01-new' && written.claudeAiOauth.refreshToken === 'rt-new', 'refresh: new access+refresh pair written back to the store')
  assert(written.claudeAiOauth.subscriptionType === 'max', 'refresh: unrelated store fields preserved verbatim')
  // about to expire (inside 5 min headroom) -> also refreshed
  written = null
  r = await refreshClaudeCliToken({ readStore: () => mkStore({ accessToken: 'a', refreshToken: 'rt-old', expiresAt: T0 + 60_000 }), writeStore, fetchFn: okFetch, now: () => T0 })
  assert(r.refreshed === true && written !== null, 'refresh: a token inside the 5-minute headroom is refreshed too')
  // server rejects -> error, nothing written
  written = null
  r = await refreshClaudeCliToken({ readStore: () => mkStore({ accessToken: 'a', refreshToken: 'rt-old', expiresAt: T0 - 1 }), writeStore, fetchFn: async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' }), now: () => T0 })
  assert(r.error && /401/.test(r.error) && written === null, 'refresh: HTTP 401 -> error naming the status, store untouched')
  // no refresh token -> error, no fetch
  let fetched = false
  r = await refreshClaudeCliToken({ readStore: () => mkStore({ accessToken: 'a', expiresAt: T0 - 1 }), writeStore, fetchFn: async () => { fetched = true }, now: () => T0 })
  assert(r.error && !fetched, 'refresh: expired with no refresh token -> error without calling the endpoint')
  // store unreadable -> passes the read error through
  r = await refreshClaudeCliToken({ readStore: () => ({ error: 'no Claude Code CLI login found' }), writeStore, fetchFn: okFetch, now: () => T0 })
  assert(r.error === 'no Claude Code CLI login found', 'refresh: unreadable store -> its error, untouched')
}


// ─────────────────────────────────────────────────────────────────────────
// 2. Route proxy helpers (2026-10-07 live model/effort switching):
//    routeClassOf / credentialClassOf for every row, and the
//    decideRouteChange table main.cjs applyRoute acts on.
// ─────────────────────────────────────────────────────────────────────────
{
  const store = { claude: 'sk-ant-api03-byok', 'claude-subscription': 'sk-ant-oat01-sub', ollama: 'ollama-key', custom: null }
  const deps = { readProviderKey: fakeReadProviderKey(store), readClaudeCliToken: () => ({ token: 'sk-ant-oat01-cli' }) }
  const env = (provider, config) => {
    const r = buildProviderEnv(provider, config, deps)
    assert(!r.error, `route helpers: ${provider} builds (${r.error && r.error.reason})`)
    return r.env
  }
  const claude = env('claude', { MODEL: 'claude-opus-4-6', EFFORT_LEVEL: 'high' })
  const claudeSonnet = env('claude', { MODEL: 'claude-sonnet-4-6', EFFORT_LEVEL: 'high' })
  const claudeEffort = env('claude', { MODEL: 'claude-opus-4-6', EFFORT_LEVEL: 'low' })
  const claudeBudget = env('claude', { MODEL: 'claude-opus-4-5', EFFORT_LEVEL: 'high' })
  const sub = env('claude-subscription', { MODEL: 'claude-opus-4-6', EFFORT_LEVEL: 'high' })
  const cli = env('claude-cli', { MODEL: 'claude-opus-4-6' })
  const chatgpt = env('chatgpt', { MODEL: 'gpt-6-astra' })
  const ollama = env('ollama', { MODEL: 'kimi-k3', EFFORT_LEVEL: 'high' })
  const ollama2 = env('ollama', { MODEL: 'glm-5.3', EFFORT_LEVEL: 'high' })
  const customOpenai = env('custom', { MODEL: 'x', CUSTOM_BASE_URL: 'http://localhost:8080/v1', CUSTOM_ROUTE_API: 'openai-completions' })
  const customAnthropic = env('custom', { MODEL: 'x', CUSTOM_BASE_URL: 'http://localhost:8080' })
  const customKeyed = buildProviderEnv('custom', { MODEL: 'x', CUSTOM_BASE_URL: 'http://localhost:8080/v1', CUSTOM_ROUTE_API: 'openai-completions' }, { readProviderKey: fakeReadProviderKey({ custom: 'custom-secret' }) }).env
  const dsh = env('dsh', { MODEL: 'glm-5.2:cloud' })
  const dshEffort = env('dsh', { MODEL: 'glm-5.2:cloud', DSH_EFFORT: 'high' })

  // routeClassOf
  assert(routeClassOf(claude) === 'anthropic' && routeClassOf(sub) === 'anthropic' && routeClassOf(cli) === 'anthropic', 'routeClassOf: claude / claude-subscription / claude-cli -> anthropic (catalog)')
  assert(routeClassOf(chatgpt) === 'anthropic' && routeClassOf(customAnthropic) === 'anthropic', 'routeClassOf: chatgpt / custom(anthropic-messages) -> anthropic (declared)')
  assert(routeClassOf(ollama) === 'openai' && routeClassOf(customOpenai) === 'openai' && routeClassOf(dsh) === 'openai', 'routeClassOf: ollama / custom(openai) / dsh -> openai')
  assert(routeKindOf(claude) === 'catalog' && routeKindOf(ollama) === 'declared' && routeKindOf(chatgpt) === 'declared', 'routeKindOf: catalog only for the anthropic catalog rows')
  // credentialClassOf
  assert(credentialClassOf(claude) === 'api-key', 'credentialClassOf: claude BYOK -> api-key')
  assert(credentialClassOf(sub) === 'oauth' && credentialClassOf(cli) === 'oauth', 'credentialClassOf: claude-subscription / claude-cli (sk-ant-oat) -> oauth')
  assert(credentialClassOf(ollama) === 'api-key', 'credentialClassOf: ollama -> api-key')
  assert(credentialClassOf(customKeyed) === 'api-key', 'credentialClassOf: custom with a stored key -> api-key')
  assert(credentialClassOf(customOpenai) === 'none' && credentialClassOf(chatgpt) === 'none' && credentialClassOf(dsh) === 'none', 'credentialClassOf: placeholder rows (custom keyless / chatgpt / dsh) -> none')
  assert(credentialClassOf({ DSH_ROUTE_KEY_ENV: 'K' }) === 'none' && credentialClassOf({ DSH_ROUTE_KEY_ENV: 'K', K: '' }) === 'none', 'credentialClassOf: missing/empty key -> none')
  assert(typeof ROUTE_PROXY_DUMMY_KEY === 'string' && ROUTE_PROXY_DUMMY_KEY && !ROUTE_PROXY_DUMMY_KEY.includes('sk-ant-oat'), 'ROUTE_PROXY_DUMMY_KEY: non-empty and never looks like an OAuth token')
  // anthropicThinkingShape (pi-ai catalog)
  assert(anthropicThinkingShape('claude-opus-4-6') === 'adaptive' && anthropicThinkingShape('claude-opus-4-5') === 'budget' && anthropicThinkingShape('no-such-model') === null, 'anthropicThinkingShape: adaptive / budget / null from the installed pi-ai catalog')
  assert(anthropicThinkingShape('m', { m: { compat: { forceAdaptiveThinking: true } } }) === 'adaptive' && anthropicThinkingShape('m', null) === null, 'anthropicThinkingShape: injected catalog honored; unreadable catalog -> null')

  // decideRouteChange table
  const d = (a, b) => decideRouteChange(a, b)
  assert(d(claude, claudeSonnet).mode === 'live', 'decide: claude -> claude (model, adaptive -> adaptive) = live')
  assert(d(claude, claudeEffort).mode === 'live', 'decide: claude -> claude (effort) = live')
  assert(d(claude, claude).mode === 'live', 'decide: identical env = live (no-op)')
  assert(d(claude, claudeBudget).mode === 'restart' && /thinking shape/.test(d(claude, claudeBudget).reason), 'decide: claude adaptive -> budget-thinking model = restart')
  assert(d(claude, sub).mode === 'restart' && /credential/.test(d(claude, sub).reason), 'decide: claude -> claude-subscription (api-key -> oauth) = restart')
  assert(d(sub, cli).mode === 'live', 'decide: claude-subscription -> claude-cli (oauth -> oauth, same model) = live')
  assert(d(claude, chatgpt).mode === 'restart' && d(chatgpt, claude).mode === 'restart' && d(chatgpt, chatgpt).mode === 'restart', 'decide: chatgpt on either side = restart (phase 1)')
  assert(d(ollama, ollama2).mode === 'live', 'decide: ollama -> ollama (model) = live')
  assert(d(ollama, customKeyed).mode === 'live', 'decide: ollama -> custom(openai, keyed) = live (same class, same credential class)')
  assert(d(ollama, customOpenai).mode === 'restart' && /credential/.test(d(ollama, customOpenai).reason), 'decide: ollama -> custom(openai, keyless placeholder) = restart (api-key -> none)')
  assert(d(ollama, customAnthropic).mode === 'restart' && /protocol class/.test(d(ollama, customAnthropic).reason), 'decide: ollama -> custom(anthropic) = restart (openai -> anthropic)')
  assert(d(claude, customAnthropic).mode === 'restart' && /credential|route kind/.test(d(claude, customAnthropic).reason), 'decide: claude (catalog) -> custom(anthropic, declared) = restart')
  assert(d(dsh, dshEffort).mode === 'live' && /effort max -> high/.test(d(dsh, dshEffort).reason), 'decide: dsh effort max -> high = live')
  const dshVision = env('dsh', { MODEL: 'qwen3.5:cloud' })
  assert(d(dsh, dshVision).mode === 'restart' && /SIDECAR/.test(d(dsh, dshVision).reason), 'decide: dsh glm -> qwen (sidecar wiring changes) = restart')
  assert(d(null, claude).mode === 'restart' && d(claude, undefined).mode === 'restart', 'decide: missing side = restart')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
