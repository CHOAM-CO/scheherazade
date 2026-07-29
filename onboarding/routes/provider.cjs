// onboarding/routes/provider.cjs -- provider / BYOK credential routes (group 2)
// (issue #9 PR-2 route grouping).
//
// Route BODIES ONLY, moved verbatim (comments included) from
// onboarding/http-server.cjs's old handleApi if-chain. Helper functions,
// constants, and mutable singletons STAY in http-server.cjs with exactly one
// owner; this file binds what its bodies need ONCE from staticCtx (one
// destructuring statement, below). Per-call values -- agentControls,
// onOnboardingComplete, the live askpassToken getter -- arrive via callCtx
// on every request (see http-server.cjs handleApi). The returned array's
// order IS the dispatch order and preserves the old chain's intra-group
// order exactly.
'use strict'

function createRoutes(staticCtx) {
  const {
    readJsonBody, sendJson, PROVIDERS, PROVIDERS_REQUIRING_STORED_CREDENTIAL,
    rejectIfRouterNotWired, validateProviderKey, storeProviderKeyVerified, resolveCustomBaseUrl,
    parseCustomProviderJson, MODEL_ID_PATTERN, readAgentConfig, writeAgentConfig, clearMuteStrikes,
  } = staticCtx
  return [
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/byok/validate',
      handler: async (req, res, callCtx) => {
        // proxyPort added (server-side validate fix, 2026-07-04): optional,
        // only consulted for provider === 'chatgpt' (see validateProviderKey).
        // Not sent by today's wizard.js (out of scope here) -- defaults to
        // CHATGPT_PROXY_DEFAULT_PORT when absent, additive/forward-compatible.
        // baseUrl added (custom-provider addition, 2026-07-25): optional, only
        // consulted for provider === 'custom'. Not sent by wizard.js either
        // (no wizard tab for 'custom' -- see PROVIDERS' own comment above); the
        // settings page's POST /api/agent/custom-provider is the primary path.
        const { provider, key, proxyPort, baseUrl } = await readJsonBody(req)
        if (!PROVIDERS.includes(provider)) {
          sendJson(res, 400, { error: `unknown provider: ${String(provider).slice(0, 80)}` })
          return
        }
        // PIECE 3 enforcement: reject BEFORE ever validating/storing a key for
        // a non-wired provider -- this is the earliest point a provider choice
        // becomes persisted (storeProviderKeyVerified below), so gating here
        // closes the backdoor at its source rather than only at
        // onboarding-complete.
        if (rejectIfRouterNotWired(res, provider)) return
        const result = await validateProviderKey(provider, key, { proxyPort, baseUrl })
        if (!result.ok) {
          sendJson(res, 200, result)
          return
        }
        // Only store a credential for providers that actually need one on disk
        // (Codex finding #2 fix, 2026-07-04). chatgpt/ollama are no-secret local
        // modes -- buildProviderEnv() never calls readProviderKey() for either
        // (chatgpt gets a fixed placeholder key, ollama gets the literal string
        // 'ollama'; see provider-env.cjs), so storing whatever was pasted/left
        // in the `key` field for them just persists an unused, never-read-back
        // value. PROVIDERS_REQUIRING_STORED_CREDENTIAL is the single source of
        // truth shared with /api/onboarding/complete's own credential gate below.
        // 'custom' is deliberately NOT in that array (its key is optional, not
        // required -- provider-env.cjs), but unlike chatgpt/ollama it DOES read
        // a stored key back at spawn time when one exists (buildProviderEnv's
        // 'custom' branch) -- so a non-empty key here is worth storing, just
        // never REQUIRED the way PROVIDERS_REQUIRING_STORED_CREDENTIAL entries
        // are.
        if (PROVIDERS_REQUIRING_STORED_CREDENTIAL.includes(provider) || (provider === 'custom' && key && key.trim())) {
          storeProviderKeyVerified(provider, key) // throws (fail loud) on storage failure -> caught by outer handler -> 500
        }
        // Spread `result` rather than a hardcoded `{ ok: true }` (server-side
        // validate fix, 2026-07-04): 'chatgpt'/'ollama' carry the informational
        // `reachable`/`detail` local-liveness fields from checkLocalLiveness(),
        // and 'claude-subscription' can carry `verified:false` + `detail` when
        // the OAuth ping could not reach a verdict (real validation, 2026-07-29
        // -- an earlier version of this comment promised that provider was
        // "still exactly { ok: true }"). All additive and backward compatible
        // with wizard.js's existing `if (result.ok) {...}` check, which ignores
        // unknown extra fields.
        //
        // Worth naming since the storage above already ran: on `verified:false`
        // a credential we could NOT confirm has just been persisted. That is
        // the deliberate trade -- see the claude-subscription branch in
        // validateProviderKey -- because a setup-token cannot be pasted twice.
        sendJson(res, 200, result)
        return
      },
    },
    // POST /api/agent/custom-provider {baseUrl, apiKey, model} -- the 'custom'
    // provider's OWN entry point (custom-provider addition, 2026-07-25).
    // Unlike /api/agent/model above (a single `model` field, provider
    // inferred/optional), 'custom' carries two EXTRA fields no existing
    // single-purpose endpoint accepts together (a base URL, an optional API
    // key) -- so it gets its own route rather than overloading /api/agent/
    // model's narrower contract, same "one endpoint per settings concern"
    // shape as /api/agent/effort, /api/autonomy, /api/topology, /api/sudo/
    // config.
    //
    // Deliberately does NOT gate on computeAvailableProviders() the way
    // /api/agent/model's provider field does: 'custom' has no login step or
    // pre-existing credential to check for -- the base URL IS the thing that
    // makes it usable, and it arrives in THIS SAME request. Gating this route
    // on computeAvailableProviders() would deadlock the very first save
    // (nothing could ever make 'custom' available before this route runs
    // once). No onboarding-wizard path exists for this provider either (same
    // settings-page-only precedent as claude-subscription/chatgpt/ollama
    // before their own wizard UI shipped -- see the ROUTER_WIRED comment
    // above) -- this route is the only way to configure or switch to it.
    // Preview for the pasted-definition path below. Writes NOTHING: no
    // credential store, no .agent-config, no restart. It exists because
    // switching provider restarts the agent brain, and a paste is opaque --
    // the user should see which base URL and which model id a blob resolves
    // to BEFORE that happens, and get the same named-model confirm dialog the
    // typed form gives them.
    //
    // It DOES return an apiKey found inside the paste, which is a deliberate
    // exception to the settings page's write-only key field (that field never
    // pre-fills from STORAGE, and this is not storage). The key being echoed
    // is the one the caller sent in this very request, from a textarea that is
    // holding it in cleartext on the same page, over the loopback server --
    // anything able to read this response could already read the request, so
    // this widens nothing. The alternative (boolean only) would drop the key
    // on the floor and make the user paste it a second time, or force a second
    // write path on the save route. Do NOT extend this to keys read back out
    // of safeStorage; those never leave the server.
    //
    // Ordered BEFORE the save route only for readability; the dispatcher
    // matches on exact pathname, so neither shadows the other.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/agent/custom-provider/preview',
      handler: async (req, res) => {
        if (rejectIfRouterNotWired(res, 'custom')) return
        const { json } = await readJsonBody(req)
        const pasted = parseCustomProviderJson(json)
        if (pasted.error) {
          // Bound the response independently of whatever built the message.
          // The request body may be up to 1 MB (readJsonBody), refusal text
          // quotes user input, and the settings page drops this string into a
          // ONE-LINE status element -- an unbounded echo wrecks the page. The
          // parser caps its own interpolations; this also covers errors that
          // come from elsewhere (resolveCustomBaseUrl), so the bound holds
          // even when a future error path forgets.
          sendJson(res, 400, { error: String(pasted.error).slice(0, 600) })
          return
        }
        // The model id is gated here too, not just on save, so the preview
        // can never show a green "this resolves to X" for something the save
        // route would then reject.
        if (!pasted.model || pasted.model.length > 200 || !MODEL_ID_PATTERN.test(pasted.model)) {
          sendJson(res, 400, { error: 'invalid model id' })
          return
        }
        sendJson(res, 200, { baseUrl: pasted.baseUrl, model: pasted.model, apiKey: pasted.apiKey })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/agent/custom-provider',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        if (!agentControls || typeof agentControls.restartAgent !== 'function') {
          sendJson(res, 500, { error: 'agent controls not wired' })
          return
        }
        // Belt-and-suspenders, same as every other endpoint that accepts a
        // provider choice (see ROUTER_WIRED's own comment above): this route IS
        // implicitly a 'custom' choice even though it takes no `provider` field
        // on the wire, so the documented kill-switch must reach it too.
        if (rejectIfRouterNotWired(res, 'custom')) return
        // Still the ONLY route that writes a custom provider config. The
        // pasted-definition path (preview route above) deliberately does not
        // get its own write branch: it resolves a blob into these same three
        // fields client-side-visibly and the user saves through here, so
        // there is exactly one place CUSTOM_BASE_URL/MODEL/key are set and
        // exactly one confirm dialog in front of it.
        const { baseUrl, apiKey, model } = await readJsonBody(req)
        // Single source of truth shared with provider-env.cjs's buildProviderEnv()
        // 'custom' branch (spawn-time) -- see resolveCustomBaseUrl's own header
        // comment for why this is not restricted to localhost.
        const urlResult = resolveCustomBaseUrl(baseUrl)
        if (urlResult.error) {
          sendJson(res, 400, { error: urlResult.error })
          return
        }
        const modelValue = typeof model === 'string' ? model.trim() : ''
        if (!modelValue || modelValue.length > 200 || !MODEL_ID_PATTERN.test(modelValue)) {
          sendJson(res, 400, { error: 'invalid model id' })
          return
        }
        // API key is OPTIONAL for 'custom' (buildProviderEnv falls back to a
        // clearly-labeled placeholder -- provider-env.cjs). Blank input means
        // "keep whatever is already stored", same write-only convention as the
        // Discord reconnect token field (discordStoredTokenNote copy) and the
        // sudo password field -- never "blank means clear it", which would
        // silently lock the user out of a proxy that DOES check the key.
        if (typeof apiKey === 'string' && apiKey.trim()) {
          storeProviderKeyVerified('custom', apiKey) // throws (fail loud) on storage failure -> caught by outer handler -> 500
        }
        // Same before/after bookkeeping as /api/agent/model above: a strike
        // ledger is about ONE model/provider pair, and PREVIOUS_MODEL/
        // PREVIOUS_PROVIDER are what makes the mute-revert offer possible.
        const prior = readAgentConfig()
        const previousFields = {}
        if (prior.MODEL && (prior.MODEL !== modelValue || prior.PROVIDER !== 'custom')) {
          previousFields.PREVIOUS_MODEL = prior.MODEL
          previousFields.PREVIOUS_PROVIDER = prior.PROVIDER || ''
        }
        writeAgentConfig({
          ...previousFields,
          CUSTOM_BASE_URL: urlResult.url,
          MODEL: modelValue,
          PROVIDER: 'custom',
        })
        clearMuteStrikes()
        agentControls.restartAgent().catch((err) => console.error('[scheherazade/onboarding] restartAgent (custom-provider swap) threw:', err))
        sendJson(res, 202, { ok: true, provider: 'custom', model: modelValue, baseUrl: urlResult.url })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
