// oauth-usage-session.cjs -- captures a FULL-SCOPE Claude OAuth credential for
// the usage gauge, via a loopback redirect. Sibling to
// setup-token-session.cjs, and deliberately shaped like it (fire-and-forget
// start, client polls status, single-flight, timeout, terminal-state guard).
//
// WHY THIS EXISTS (measured 2026-08-13, the owner: the win tester's gauge is stuck
// on "HTTP 429" and "되게 만들어야지"): the credential the app already
// captures -- `claude setup-token` -- carries scope ["user:inference"] and
// NOTHING else (read out of the CLI binary, not assumed). The usage endpoint
// api.anthropic.com/api/oauth/usage requires user:profile; it answers a
// scope-limited token 403 "OAuth token does not meet scope requirement
// user:profile", and because the gauge polls, the repeated 403s trip a
// per-token rate limit that PROMOTES to a persistent 429 -- reproduced live
// on this machine, identical to the tester's screenshot. No amount of
// retrying the setup-token fixes it; it is the wrong credential class.
//
// The Claude Code CLI's own interactive login DOES read usage, because it
// holds the full scope set. So this flow mints exactly that: the same
// authorize endpoint, the same client_id, the same scopes the CLI login
// requests. The resulting credential is stored SEPARATELY (provider
// 'claude-usage') and used ONLY to read the meter -- the agent lane keeps
// running on its setup-token. Two credentials, two jobs.
//
// WHY LOOPBACK, NOT A PTY: setup-token has to parse a token a child process
// prints. This flow owns both ends of an OAuth code exchange, so it runs the
// exchange itself. It binds an ephemeral 127.0.0.1 listener, hands the
// browser a redirect_uri pointing at it (verified live: claude.ai's OAuth
// server redirects to http://localhost:PORT/callback?code=...&state=... on a
// dynamically chosen port -- the CLI does the same), catches the code, and
// POSTs it to the token endpoint. Zero copy-paste on the happy path.
//
// SECURITY POSTURE inherited from the setup-token sibling and tightened for a
// long-lived refresh token:
//   - state (CSRF) and PKCE (code interception) are both required; a callback
//     whose state does not match the in-flight run is refused without a
//     network call.
//   - the loopback listener answers ONLY GET /callback and ONLY for the live
//     run's state; anything else gets a 404 and is ignored. It is bound to
//     127.0.0.1, never 0.0.0.0.
//   - the credential (access + refresh token) is handed straight to the
//     injected store and never returned to the client, never logged. Error
//     text from the network is scrubbed the same way setup-token scrubs it.
//   - single-flight + a generation counter: a superseded run's late callback
//     or in-flight exchange cannot write a credential or move the state.
'use strict'

const crypto = require('crypto')
const http = require('http')

// The CLI's own OAuth client. Read out of the 2.1.229 binary
// (CLAUDE_CODE_OAUTH_CLIENT_ID) alongside the authorize/token hosts and the
// scope set the interactive login requests. Kept as named constants so the
// day one of them rotates, the diff is one line and obvious.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
// Token exchange + refresh. platform.claude.com is the live host as of
// 2026-08-13 (console.anthropic.com answered the same POST 404/429
// inconsistently in probing; platform answered 200 every time). Both the
// code exchange and the refresh grant go here.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
// Exactly the CLI interactive-login scope set. user:profile is the one the
// usage endpoint demands and the setup-token lacks; the rest match the CLI so
// the consent screen and the resulting token are indistinguishable from a
// normal `claude` login.
const SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers']

// The Claude-login (agent-lane) variant requests ONLY this. Exactly what
// `claude setup-token` asks for -- inference and nothing else -- which is what
// mints the long-lived (~1yr) oat token instead of the short-lived,
// refresh-backed pair the full scope set returns. Storing that raw token as
// 'claude-subscription' makes the browser flow a drop-in for the CLI's
// setup-token: same credential class, same store slot, lane reads it unchanged.
const LOGIN_SCOPES = ['user:inference']

const PROVIDER_ID = 'claude-usage'

// Longer than setup-token's 300s is unnecessary -- this is one browser
// redirect with no account-picker detour more likely than that flow. Kept at
// 300s for parity; an abandoned flow must not hold a listener forever.
const OAUTH_USAGE_TIMEOUT_MS = 300_000

const TERMINAL_STATES = new Set(['connected', 'failed', 'cancelled'])

// A Set, not a single slot: this factory now builds TWO long-lived sessions
// from one module (the usage gauge's full-scope flow and the agent lane's
// login flow), each holding its own loopback /callback listener. A single
// "last one wins" slot would leave the other flow's socket open across
// shutdown -- the exact orphan the shutdown hook exists to prevent. Every
// created session registers here and is cancelled on shutdown.
const liveSessionsForShutdown = new Set()
function killUsageOAuthChildOnShutdown() {
  for (const s of liveSessionsForShutdown) {
    try { s.cancel() } catch { /* already gone */ }
  }
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * @param {object} deps
 * @param {(storedValue: string) => void} deps.storeUsageCredential  throws on failure; receives whatever `serialize` returned (default: the serialized {accessToken, refreshToken, expiresAt, scope} blob)
 * @param {(msg: string) => void} [deps.log]
 * @param {typeof fetch} [deps.fetchImpl]  injectable for tests
 * @param {() => number} [deps.now]
 * @param {(handler: Function) => object} [deps.createServer]  injectable http server factory for tests
 * @param {number} [deps.timeoutMs]
 * @param {string[]} [deps.scopes]  OAuth scopes to request. Default: the full CLI-login set (usage gauge needs user:profile). The Claude-login variant passes ['user:inference'] to mint the long-lived, setup-token-equivalent oat and nothing more.
 * @param {(tokenBody: object, nowMs: number) => string} [deps.serialize]  turns the token endpoint's JSON into the string handed to storeUsageCredential. Default = serializeCredential (the access+refresh blob the gauge reads). The Claude-login variant passes (body) => body.access_token to store the raw oat string exactly as `claude setup-token` did, so the agent lane reads it unchanged.
 */
function createUsageOAuthSession(deps) {
  const {
    storeUsageCredential,
    log = () => {},
    fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(),
    createServer = (handler) => http.createServer(handler),
    timeoutMs = OAUTH_USAGE_TIMEOUT_MS,
    scopes = SCOPES,
    serialize = serializeCredential,
  } = deps

  let server = null
  let timer = null
  let state = 'idle'
  let reason = null
  let startedAt = null
  // Per-run secrets. Live only between start() and a terminal state; cleared
  // in clearRun() so a stored verifier cannot outlive its exchange.
  let pkceVerifier = null
  let oauthState = null
  let runId = 0

  function setState(next, why = null) {
    state = next
    reason = why
    // State only. `why` is always one of this module's fixed strings.
    log(`oauth-usage: ${next}${why ? ` (${why})` : ''}`)
  }

  function clearRun() {
    if (timer) { clearTimeout(timer); timer = null }
    if (server) {
      try { server.close() } catch { /* already closed */ }
      server = null
    }
    pkceVerifier = null
    oauthState = null
  }

  const TOKEN_LIKE = /sk-ant-[A-Za-z0-9_-]+/g
  function safeMessage(msg) {
    return String(msg === undefined || msg === null ? '' : msg).replace(TOKEN_LIKE, '<redacted>').slice(0, 300)
  }

  async function exchangeAndStore(code, redirectUri, myRun) {
    // Disarm the timeout before the network await, same reason as the
    // setup-token sibling: a slow exchange must not be clobbered by its own
    // timer flipping the run to failed('timeout') mid-flight.
    if (timer) { clearTimeout(timer); timer = null }
    const verifier = pkceVerifier
    setState('exchanging')
    let out
    try {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Both proven in probing; harmless if the endpoint ignores them.
          'anthropic-beta': 'oauth-2025-04-20',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          state: oauthState,
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15000),
      })
      out = { status: res.status, body: await res.json().catch(() => null) }
    } catch (err) {
      if (myRun !== runId) return
      log(`oauth-usage: exchange threw: ${safeMessage(err && err.message)}`)
      setState('failed', 'exchange_failed')
      clearRun()
      return
    }
    // Cancel/timeout supersede across the await -- a user who closed the flow
    // must not still get a credential written.
    if (myRun !== runId) return
    if (out.status !== 200 || !out.body || !out.body.access_token) {
      setState('failed', out.status === 200 ? 'exchange_empty' : `exchange_http_${out.status}`)
      clearRun()
      return
    }
    try {
      storeUsageCredential(serialize(out.body, now()))
      setState('connected')
    } catch (err) {
      if (myRun !== runId) return
      log(`oauth-usage: store threw: ${safeMessage(err && err.message)}`)
      setState('failed', 'store_failed')
    }
    clearRun()
  }

  async function start() {
    if (server || state === 'exchanging') return { ok: true, alreadyRunning: true, authorizeUrl: null }
    startedAt = now()
    const myRun = ++runId
    pkceVerifier = b64url(crypto.randomBytes(32))
    const challenge = b64url(crypto.createHash('sha256').update(pkceVerifier).digest())
    oauthState = b64url(crypto.randomBytes(32))

    let redirectUri = null
    const onRequest = (req, res) => {
      // Only GET /callback for the LIVE run's state is honored. Everything
      // else -- a stray probe, a superseded run's late redirect, a mismatched
      // state -- gets a flat 404 and touches no state and no network.
      let url
      try { url = new URL(req.url, redirectUri) } catch { url = null }
      const okPath = url && url.pathname === '/callback' && req.method === 'GET'
      const code = okPath ? url.searchParams.get('code') : null
      const gotState = okPath ? url.searchParams.get('state') : null
      if (!okPath || !code || gotState !== oauthState || myRun !== runId) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center">'
        + '<h2>연결됐어요</h2><p>이 탭을 닫고 Scheherazade로 돌아가세요.</p></body>')
      // Fire the exchange after the response is flushed; the browser tab does
      // not wait on the token round-trip.
      exchangeAndStore(code, redirectUri, myRun)
    }

    try {
      server = createServer(onRequest)
    } catch (err) {
      log(`oauth-usage: createServer threw: ${safeMessage(err && err.message)}`)
      setState('failed', 'listen_failed')
      clearRun()
      return { ok: false, reason: 'listen_failed' }
    }

    // listen() is ASYNC: server.address() returns null until the 'listening'
    // event fires, so the port -- and thus the redirect_uri -- is only known
    // in the callback. (An early version read address() synchronously right
    // after listen() and every real bind reported listen_failed; the fake
    // server in the unit test returned a synchronous port and hid it. Caught
    // by the live end-to-end run.) Bind on the loopback interface ONLY:
    // 0.0.0.0 would expose the callback to the LAN, and while the code is
    // single-use and PKCE-bound, the listener has no business answering a
    // non-local caller.
    const port = await new Promise((resolve) => {
      let settled = false
      const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
      try {
        server.on('error', (err) => {
          log(`oauth-usage: listen error: ${safeMessage(err && err.message)}`)
          finish(null)
        })
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          finish(addr && typeof addr === 'object' ? addr.port : null)
        })
      } catch (err) {
        log(`oauth-usage: listen threw: ${safeMessage(err && err.message)}`)
        finish(null)
      }
    })
    // Cancel/timeout may have superseded this run while we awaited the bind.
    if (myRun !== runId) return { ok: false, reason: 'superseded' }
    if (!port) {
      setState('failed', 'listen_failed')
      clearRun()
      return { ok: false, reason: 'listen_failed' }
    }
    // Host 'localhost' matches what the CLI registers and what rendered the
    // consent screen live; the browser resolves it to the 127.0.0.1 the
    // listener is bound to.
    redirectUri = `http://localhost:${port}/callback`
    const authorizeUrl = buildAuthorizeUrl(challenge, redirectUri)
    setState('awaiting_authorize')

    timer = setTimeout(() => {
      if (myRun !== runId || TERMINAL_STATES.has(state)) return
      setState('failed', 'timeout')
      runId++
      clearRun()
    }, timeoutMs)

    return { ok: true, authorizeUrl }
  }

  function buildAuthorizeUrl(challenge, redirectUri) {
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: oauthState,
    })
    return `${AUTHORIZE_URL}?${q.toString()}`
  }

  function cancel() {
    if (!server && state !== 'exchanging') return { ok: true, alreadyStopped: true }
    setState('cancelled', 'user_cancelled')
    runId++ // supersede any in-flight exchange or late callback first
    clearRun()
    return { ok: true }
  }

  function status() {
    return {
      state,
      reason,
      elapsedMs: startedAt === null ? 0 : now() - startedAt,
      provider: PROVIDER_ID,
    }
  }

  const api = { start, cancel, status }
  liveSessionsForShutdown.add(api)
  return api
}

// The serialized credential shape the gauge reads back. expiresAt is an
// absolute epoch-ms computed from expires_in at capture time, so the reader
// can decide "refresh before use" without a clock-skew guess. scope is kept
// for diagnostics only -- the reader trusts the endpoint, not this string.
function serializeCredential(tokenBody, nowMs) {
  const expiresInMs = Number.isFinite(tokenBody.expires_in) ? tokenBody.expires_in * 1000 : 0
  return JSON.stringify({
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token || null,
    expiresAt: expiresInMs ? nowMs + expiresInMs : null,
    scope: tokenBody.scope || null,
    obtainedAt: nowMs,
  })
}

// Refresh grant. Pulled out as a pure-ish function so the gauge can call it
// without a session object: given the stored credential JSON, returns a fresh
// serialized credential (rotated refresh token included) or null on any
// failure. NEVER throws -- the caller falls through to the next credential.
async function refreshUsageCredential(storedJson, opts = {}) {
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a))
  const now = opts.now || (() => Date.now())
  let cred
  try { cred = JSON.parse(storedJson) } catch { return null }
  if (!cred || !cred.refreshToken) return null
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: cred.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (res.status !== 200) return null
    const body = await res.json().catch(() => null)
    if (!body || !body.access_token) return null
    // A refresh response may omit refresh_token (endpoint keeps the old one)
    // -- carry the previous one forward so we never drop the ability to
    // refresh again.
    if (!body.refresh_token) body.refresh_token = cred.refreshToken
    return serializeCredential(body, now())
  } catch { return null }
}

module.exports = {
  createUsageOAuthSession,
  killUsageOAuthChildOnShutdown,
  refreshUsageCredential,
  serializeCredential,
  PROVIDER_ID,
  OAUTH_USAGE_TIMEOUT_MS,
  TERMINAL_STATES,
  CLIENT_ID,
  TOKEN_URL,
  AUTHORIZE_URL,
  SCOPES,
  LOGIN_SCOPES,
}
