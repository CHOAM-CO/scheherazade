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
function buildProviderEnv(provider, config, deps) {
  const { readProviderKey } = deps

  if (provider === 'claude') {
    // BYOK -- PRESERVED EXACTLY as main.cjs's original (pre-4-provider)
    // 'claude' branch behaved, plus the new explicit-clear hardening
    // described in this file's header comment.
    let providerKey
    try {
      providerKey = readProviderKey('claude')
    } catch (err) {
      return { error: { kind: 'key_error', reason: `readProviderKey(claude) failed: ${err.message}` } }
    }
    if (!providerKey) {
      return { error: { kind: 'not_ready', reason: 'onboarding says PROVIDER=claude but no validated key is on file yet' } }
    }
    return {
      env: {
        ANTHROPIC_API_KEY: providerKey,
        ANTHROPIC_BASE_URL: undefined, // clear any stale base_url from a prior chatgpt/ollama session
        CLAUDE_CODE_OAUTH_TOKEN: undefined, // clear any stale subscription token
      },
    }
  }

  if (provider === 'claude-subscription') {
    // NEW mode: Claude Code CLI's own `claude setup-token` 1-year OAuth
    // token, captured at onboarding (paste field, see http-server.cjs) and
    // stored via the SAME safeStorage plumbing as a BYOK key (keyed under
    // the pseudo-provider name 'claude-subscription' in CREDENTIALS_DIR).
    let token
    try {
      token = readProviderKey('claude-subscription')
    } catch (err) {
      return { error: { kind: 'key_error', reason: `readProviderKey(claude-subscription) failed: ${err.message}` } }
    }
    if (!token) {
      return { error: { kind: 'not_ready', reason: 'onboarding says PROVIDER=claude-subscription but no OAuth token is on file yet' } }
    }
    return {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        ANTHROPIC_API_KEY: undefined, // do NOT inject an API key alongside the OAuth token (LOCKED design, mode 1)
        ANTHROPIC_BASE_URL: undefined, // clear any stale base_url from a prior chatgpt/ollama session
      },
    }
  }

  if (provider === 'chatgpt') {
    // NEW mode: local codex-as-api proxy. No user secret required -- see
    // this file's header comment for why an explicit placeholder key is
    // still injected (diverging from skia's bare run-agent.sh shape).
    const portResult = resolveChatgptProxyPort(config.CHATGPT_PROXY_PORT)
    if (portResult.error) {
      return { error: { kind: 'provider_not_wired', reason: portResult.error } }
    }
    const port = portResult.port
    return {
      env: {
        ANTHROPIC_BASE_URL: `http://localhost:${port}`,
        ANTHROPIC_API_KEY: CHATGPT_PLACEHOLDER_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: undefined, // force api-key auth precedence -- see sirin ground-truth comment
      },
    }
  }

  if (provider === 'ollama') {
    // NEW mode: local Ollama daemon. No user secret required, but a real
    // local model tag IS required -- unlike codex-as-api (which, per
    // run-agent.sh's sirin comment, "force-ignores body.model"), Ollama's
    // OpenAI-compatible surface needs an actual model name it can resolve.
    // Falling back to config.MODEL's generic default ('claude-opus-4-6')
    // would silently send an Anthropic model id to an Ollama daemon that
    // has no such model -- fail loud instead.
    const model = config.MODEL && String(config.MODEL).trim() ? String(config.MODEL).trim() : ''
    if (!model) {
      return { error: { kind: 'not_ready', reason: 'onboarding says PROVIDER=ollama but no MODEL (ollama model tag) is on file yet' } }
    }
    return {
      env: {
        ANTHROPIC_BASE_URL: OLLAMA_BASE_URL,
        ANTHROPIC_API_KEY: 'ollama', // exact match, run-agent.sh:204 (skia-ollama), proven-live
        MODEL: model,
        SKIP_MODEL_GUARD: '1', // matches run-agent.sh:205's shape; NOTE run.sh has no such guard today -- see task report gaps
        CLAUDE_CODE_OAUTH_TOKEN: undefined, // force api-key auth precedence -- see sirin ground-truth comment
      },
    }
  }

  return {
    error: {
      kind: 'provider_not_wired',
      reason: `provider "${provider}" is not a recognized mode -- expected one of: claude, claude-subscription, chatgpt, ollama`,
    },
  }
}

// Which PROVIDERS values require a stored credential before onboarding can
// complete (single source of truth shared with onboarding/http-server.cjs's
// /api/onboarding/complete gate, so the "does this provider need a secret"
// fact lives in exactly one place). chatgpt/ollama route to a local
// proxy/daemon and need no user secret at all -- see buildProviderEnv above.
const PROVIDERS_REQUIRING_STORED_CREDENTIAL = ['claude', 'claude-subscription']

module.exports = {
  buildProviderEnv,
  resolveChatgptProxyPort,
  PROVIDERS_REQUIRING_STORED_CREDENTIAL,
  CHATGPT_PROXY_DEFAULT_PORT,
  CHATGPT_PLACEHOLDER_KEY,
  OLLAMA_BASE_URL,
}
