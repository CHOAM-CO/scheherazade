#!/usr/bin/env node
// test-usage-oauth.mjs -- the full-scope usage-gauge OAuth capture
// (oauth-usage-session.cjs), the real fix for the win tester's stuck "HTTP
// 429" (2026-08-13). The setup-token the app already holds carries
// user:inference only; the usage endpoint refuses it and the repeated 403s
// promote to a persistent 429. This flow mints the CLI's full scope set
// instead, stored separately as 'claude-usage'.
//
// Attacked without a real socket or network: createServer and fetch are both
// injected, so the loopback callback is simulated by calling the captured
// request handler with fake req/res, and the token exchange is a stub. The
// promises under test:
//   1. HAPPY PATH: start() binds a listener and returns a well-formed
//      authorize URL (client_id, full scopes, PKCE S256, loopback redirect,
//      state). A matching /callback drives exchange -> a serialized
//      credential is stored, state -> connected.
//   2. CSRF: a /callback whose state does not match the live run gets 404 and
//      stores nothing.
//   3. EXCHANGE FAILURE: a non-200 token response -> failed, no store.
//   4. CANCEL: supersedes an in-flight exchange -- a late success cannot
//      write a credential after the user backed out.
//   5. REFRESH: refreshUsageCredential rotates the token, carries the old
//      refresh token forward when the response omits one, and returns null
//      (never throws) on every failure shape.
//
// Run: node tests/test-usage-oauth.mjs

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const {
  createUsageOAuthSession, refreshUsageCredential, serializeCredential,
  CLIENT_ID, SCOPES,
} = require(path.join(ROOT, 'oauth-usage-session.cjs'))

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// A fake http.Server: captures the request handler, hands out a fixed port,
// and lets the test invoke the handler directly. address() returns an object
// with .port like a real loopback listener.
function fakeServerFactory(port = 54321) {
  let handler = null
  let closed = false
  const server = {
    _fire(reqUrl, method = 'GET') {
      const req = { url: reqUrl, method, headers: { host: `localhost:${port}` } }
      let statusCode = null, ended = false
      const res = {
        writeHead(code) { statusCode = code },
        end() { ended = true },
        get statusCode() { return statusCode },
      }
      handler(req, res)
      return { statusCode, ended }
    },
    // Mirror the real http.Server contract start() now depends on: listen()
    // is async and the port is only known in the callback (the bug the live
    // E2E caught -- a synchronous address() hid it). on('error') is present so
    // the module's error listener attaches cleanly.
    on() { /* no error injected in these cases */ },
    listen(_port, _host, cb) { if (typeof cb === 'function') setImmediate(cb) },
    address() { return { port } },
    close() { closed = true },
    get closed() { return closed },
  }
  return {
    create: (h) => { handler = h; return server },
    server,
  }
}

// A fake response object for res captured above needs statusCode readable;
// simplest is to let the handler set it. The _fire helper reads it back.

async function tick() { await new Promise((r) => setImmediate(r)) }

// ── 1. happy path ─────────────────────────────────────────────────────────
{
  const fs = fakeServerFactory(54321)
  const stored = []
  let fetchArgs = null
  const session = createUsageOAuthSession({
    storeUsageCredential: (json) => stored.push(json),
    createServer: fs.create,
    now: () => 1_000_000,
    fetchImpl: async (url, opts) => {
      fetchArgs = { url, body: JSON.parse(opts.body) }
      return { status: 200, json: async () => ({ access_token: 'sk-ant-oat01-FULL', refresh_token: 'sk-ant-ort01-R', expires_in: 28800, scope: SCOPES.join(' ') }) }
    },
  })
  const r = await session.start()
  check('start returns ok + authorizeUrl', r.ok && typeof r.authorizeUrl === 'string', JSON.stringify(r).slice(0, 120))
  const u = new URL(r.authorizeUrl)
  check('authorize host is claude.ai', u.host === 'claude.ai', u.host)
  check('authorize client_id matches', u.searchParams.get('client_id') === CLIENT_ID)
  check('authorize scope is the full set', u.searchParams.get('scope') === SCOPES.join(' '), u.searchParams.get('scope'))
  check('authorize uses S256 PKCE', u.searchParams.get('code_challenge_method') === 'S256' && !!u.searchParams.get('code_challenge'))
  check('authorize redirect is loopback', /^http:\/\/localhost:54321\/callback$/.test(u.searchParams.get('redirect_uri')), u.searchParams.get('redirect_uri'))
  const state = u.searchParams.get('state')
  check('authorize carries a state', !!state)
  check('state is awaiting_authorize', session.status().state === 'awaiting_authorize', session.status().state)

  // Simulate the browser redirect landing on the loopback listener.
  const fired = fs.server._fire(`/callback?code=THE_CODE&state=${encodeURIComponent(state)}`)
  check('callback answered 200', fired.statusCode === 200, String(fired.statusCode))
  await tick(); await tick()
  check('exchange POSTed the code + verifier', fetchArgs && fetchArgs.body.code === 'THE_CODE' && !!fetchArgs.body.code_verifier)
  check('exchange sent grant_type=authorization_code', fetchArgs && fetchArgs.body.grant_type === 'authorization_code')
  check('state -> connected', session.status().state === 'connected', session.status().state)
  check('credential stored once', stored.length === 1, String(stored.length))
  const cred = JSON.parse(stored[0] || '{}')
  check('stored credential has access + refresh token', cred.accessToken === 'sk-ant-oat01-FULL' && cred.refreshToken === 'sk-ant-ort01-R')
  check('stored expiresAt = now + expires_in', cred.expiresAt === 1_000_000 + 28800 * 1000, String(cred.expiresAt))
  check('listener closed after connect', fs.server.closed === true)
}

// ── 2. CSRF: mismatched state ──────────────────────────────────────────────
{
  const fs = fakeServerFactory(54322)
  const stored = []
  const session = createUsageOAuthSession({
    storeUsageCredential: (json) => stored.push(json),
    createServer: fs.create,
    fetchImpl: async () => ({ status: 200, json: async () => ({ access_token: 'x', expires_in: 1 }) }),
  })
  await session.start()
  const fired = fs.server._fire('/callback?code=C&state=WRONG_STATE')
  check('mismatched-state callback -> 404', fired.statusCode === 404, String(fired.statusCode))
  await tick()
  check('mismatched state stores nothing', stored.length === 0, String(stored.length))
  check('state stays awaiting_authorize on bad callback', session.status().state === 'awaiting_authorize', session.status().state)
}

// ── 3. exchange non-200 ────────────────────────────────────────────────────
{
  const fs = fakeServerFactory(54323)
  const stored = []
  const session = createUsageOAuthSession({
    storeUsageCredential: (json) => stored.push(json),
    createServer: fs.create,
    fetchImpl: async () => ({ status: 400, json: async () => ({ error: 'bad' }) }),
  })
  const r = await session.start()
  const state = new URL(r.authorizeUrl).searchParams.get('state')
  fs.server._fire(`/callback?code=C&state=${encodeURIComponent(state)}`)
  await tick(); await tick()
  check('exchange 400 -> failed', session.status().state === 'failed', session.status().state)
  check('exchange failure reason carries status', session.status().reason === 'exchange_http_400', session.status().reason)
  check('exchange failure stores nothing', stored.length === 0, String(stored.length))
}

// ── 4. cancel supersedes an in-flight exchange ─────────────────────────────
{
  const fs = fakeServerFactory(54324)
  const stored = []
  let release
  const gate = new Promise((r) => { release = r })
  const session = createUsageOAuthSession({
    storeUsageCredential: (json) => stored.push(json),
    createServer: fs.create,
    fetchImpl: async () => { await gate; return { status: 200, json: async () => ({ access_token: 'LATE', expires_in: 1 }) } },
  })
  const r = await session.start()
  const state = new URL(r.authorizeUrl).searchParams.get('state')
  fs.server._fire(`/callback?code=C&state=${encodeURIComponent(state)}`)
  await tick() // enter exchanging, now blocked on gate
  check('is exchanging before cancel', session.status().state === 'exchanging', session.status().state)
  session.cancel()
  check('cancel -> cancelled', session.status().state === 'cancelled', session.status().state)
  release() // let the stubbed exchange resolve AFTER cancel
  await tick(); await tick()
  check('late exchange after cancel stores nothing', stored.length === 0, String(stored.length))
  check('cancel did not flip back to connected', session.status().state === 'cancelled', session.status().state)
}

// ── 5. refreshUsageCredential ──────────────────────────────────────────────
{
  const base = serializeCredential({ access_token: 'A', refresh_token: 'R1', expires_in: 28800, scope: 's' }, 1000)
  // success + rotation
  const rotated = await refreshUsageCredential(base, {
    now: () => 5000,
    fetchImpl: async (url, opts) => {
      const b = JSON.parse(opts.body)
      check('refresh sends grant_type=refresh_token', b.grant_type === 'refresh_token' && b.refresh_token === 'R1')
      return { status: 200, json: async () => ({ access_token: 'A2', refresh_token: 'R2', expires_in: 28800 }) }
    },
  })
  const rc = JSON.parse(rotated)
  check('refresh returns new access token', rc.accessToken === 'A2', rc.accessToken)
  check('refresh carries rotated refresh token', rc.refreshToken === 'R2', rc.refreshToken)
  check('refresh recomputes expiresAt from new now', rc.expiresAt === 5000 + 28800 * 1000, String(rc.expiresAt))

  // response omits refresh_token -> carry the old one forward
  const kept = await refreshUsageCredential(base, {
    now: () => 5000,
    fetchImpl: async () => ({ status: 200, json: async () => ({ access_token: 'A3', expires_in: 100 }) }),
  })
  check('refresh keeps old refresh token when response omits it', JSON.parse(kept).refreshToken === 'R1')

  // non-200 -> null
  const dead = await refreshUsageCredential(base, { fetchImpl: async () => ({ status: 400, json: async () => ({}) }) })
  check('refresh non-200 -> null', dead === null)

  // network throw -> null (never throws)
  const threw = await refreshUsageCredential(base, { fetchImpl: async () => { throw new Error('net down') } })
  check('refresh network error -> null (no throw)', threw === null)

  // no refresh token -> null
  const noR = await refreshUsageCredential(serializeCredential({ access_token: 'A', expires_in: 1 }, 1), {})
  check('refresh with no refresh token -> null', noR === null)

  // garbage input -> null
  check('refresh garbage json -> null', (await refreshUsageCredential('not json', {})) === null)
}

// ── 6. LOGIN VARIANT: inference-only scope + raw-token store ────────────────
// The agent-lane login (getLoginOAuthSession in http-server.cjs) reuses this
// same factory with two overrides: scopes=['user:inference'] and a serialize
// that returns the bare access_token. This proves the parameterization mints a
// setup-token-equivalent credential (inference scope only) and stores the RAW
// oat string -- not the access+refresh blob -- so the dsh lane reads it exactly
// as it read the CLI's setup-token.
{
  const { LOGIN_SCOPES } = require(path.join(ROOT, 'oauth-usage-session.cjs'))
  const fs = fakeServerFactory(54399)
  const stored = []
  const session = createUsageOAuthSession({
    storeUsageCredential: (v) => stored.push(v),
    scopes: LOGIN_SCOPES,
    serialize: (body) => body.access_token,
    createServer: fs.create,
    now: () => 2_000_000,
    fetchImpl: async () => ({ status: 200, json: async () => ({ access_token: 'sk-ant-oat01-LOGIN', refresh_token: 'sk-ant-ort01-IGNORED', expires_in: 31536000, scope: 'user:inference' }) }),
  })
  const r = await session.start()
  const u = new URL(r.authorizeUrl)
  check('login authorize scope is user:inference ONLY', u.searchParams.get('scope') === 'user:inference', u.searchParams.get('scope'))
  check('login LOGIN_SCOPES is exactly [user:inference]', Array.isArray(LOGIN_SCOPES) && LOGIN_SCOPES.length === 1 && LOGIN_SCOPES[0] === 'user:inference')
  check('login still uses S256 PKCE + client_id', u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('client_id') === CLIENT_ID)
  const state = u.searchParams.get('state')
  fs.server._fire(`/callback?code=LC&state=${encodeURIComponent(state)}`)
  await tick(); await tick()
  check('login state -> connected', session.status().state === 'connected', session.status().state)
  check('login stored the RAW oat string, not a JSON blob', stored.length === 1 && stored[0] === 'sk-ant-oat01-LOGIN', String(stored[0]))
}

// ── 7. serializeLoginCredential (0.4.3): blob when renewable, bare otherwise ──
{
  const { serializeLoginCredential } = require(path.join(ROOT, 'oauth-usage-session.cjs'))
  const blob = JSON.parse(serializeLoginCredential({ access_token: 'sk-ant-oat01-A', refresh_token: 'sk-ant-ort01-R', expires_in: 28800 }, 1_000))
  check('login serialize: refresh_token + expires_in -> {accessToken, refreshToken, expiresAt} blob', blob.accessToken === 'sk-ant-oat01-A' && blob.refreshToken === 'sk-ant-ort01-R' && blob.expiresAt === 1_000 + 28800_000, JSON.stringify(blob))
  check('login serialize: no refresh_token -> bare string', serializeLoginCredential({ access_token: 'sk-ant-oat01-B', expires_in: 31536000 }, 1) === 'sk-ant-oat01-B')
  check('login serialize: no expires_in -> bare string', serializeLoginCredential({ access_token: 'sk-ant-oat01-C', refresh_token: 'r' }, 1) === 'sk-ant-oat01-C')
  const src = require('node:fs').readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  check('pin: getLoginOAuthSession stores through serializeLoginCredential', /serialize: serializeLoginCredential,/.test(src))
  check('pin: Test + usage paths unwrap the claude-subscription key', (src.match(/unwrapOAuthKey\(readProviderKey\('claude-subscription'\)\)/g) || []).length === 2)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
