// onboarding/routes/chat.cjs -- in-app chat proxy (group 11). The chat page
// talks to channel-local.mjs's loopback listener THROUGH this server so the
// browser keeps exactly one origin; the alternative (page fetches the
// channel's own port directly) is a second origin, a CORS grant on the
// channel, and the channel's bearer token handed to the page. Here the token
// never leaves this process.
//
// What gate actually applies -- read from createOnboardingServer, not
// assumed: Host is checked on EVERY request; Origin + X-Onboard-Token on
// POST/DELETE only. So POST /api/chat/in gets the full per-launch-token
// gate automatically, and the two GETs are Host-gated only -- the same
// exposure class as /api/logs and /api/memory/*, which already serve
// comparable content to any local process. If chat reads ever need the
// token gate too, that is a createOnboardingServer change, not a route one.
//
// The channel's endpoint is discovered per request from
// DATA_HOME/local-channel.json (written by channel-local.mjs's
// writePortFile; the app spawns claude which spawns the channel, so the
// port is OS-picked and changes per agent restart). Per-request read on
// purpose: a cached port goes stale the moment the agent restarts, and one
// small fs read per poll tick is nothing. Address match is verified, not
// assumed: main.cjs passes AGENT_DATA_HOME: DATA_HOME into the child env
// (spawnRealAgentChild), and resolveDataHome honors it first.
//
// Failure vocabulary is FIXED ENUMS ('not_running' | 'unreachable' |
// 'upstream_refused' | ...), never upstream prose and never caller input --
// the unbounded-echo rule, same as setup-token.cjs. The channel token
// appears in exactly one place: the Authorization header of the loopback
// fetch. It is never in a response, an error, or a log line here.
'use strict'

// Loopback round trips; generous only because /in does a notification write
// under load. Not in staticCtx: single owner, this file.
const CHAT_PROXY_TIMEOUT_MS = 5_000
const CHAT_STATUS_TIMEOUT_MS = 1_500

function createRoutes(staticCtx) {
  const { fs, path, sendJson, readJsonBody, DATA_HOME, activeChannelBackend } = staticCtx

  // null = not running (file absent or unparseable -- an unparseable file is
  // a mid-write race with the channel's atomic rename, or a corrupt leftover;
  // both read honestly as "not up right now", and the next poll self-heals).
  function readChannelEndpoint() {
    try {
      const raw = fs.readFileSync(path.join(DATA_HOME, 'local-channel.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const port = Number(parsed && parsed.port)
      const token = parsed && parsed.token
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null
      if (typeof token !== 'string' || !token) return null
      return { port, token }
    } catch {
      return null
    }
  }

  // One shape for both proxied routes: {status, body} on an upstream answer,
  // {status: 0} when the channel could not be reached at all (dead port from
  // a stale file, or a hung socket past the timeout).
  async function proxyToChannel(ep, pathname, { method = 'GET', search = '', body, timeoutMs = CHAT_PROXY_TIMEOUT_MS } = {}) {
    try {
      const r = await fetch(`http://127.0.0.1:${ep.port}${pathname}${search}`, {
        method,
        headers: {
          authorization: `Bearer ${ep.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      let parsed = null
      try { parsed = await r.json() } catch { /* non-JSON upstream body -> null; status still tells the story */ }
      return { status: r.status, body: parsed }
    } catch {
      return { status: 0 }
    }
  }

  return [
    // GET status: is there a chat to render at all? `backend` tells the page
    // whether in-app chat is even the active channel (wizard slice 5 reads
    // this); `up` is a live probe, not a file-existence guess -- a stale
    // local-channel.json left by a dead agent must read as down.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/chat/status',
      handler: async (req, res) => {
        const backend = activeChannelBackend()
        const ep = readChannelEndpoint()
        if (!ep) {
          sendJson(res, 200, { up: false, backend, reason: 'not_running' })
          return
        }
        const r = await proxyToChannel(ep, '/health', { timeoutMs: CHAT_STATUS_TIMEOUT_MS })
        if (r.status !== 200) {
          sendJson(res, 200, { up: false, backend, reason: 'unreachable' })
          return
        }
        // agent name passes through: fixed shape from channel-local's own
        // /health handler, not caller input.
        sendJson(res, 200, { up: true, backend, agent: r.body && r.body.agent })
        return
      },
    },
    // GET out: drain-by-cursor. `since` is coerced to a number BEFORE it is
    // put in a URL -- the one caller-supplied value here never rides as a
    // string.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/chat/out',
      handler: async (req, res) => {
        const ep = readChannelEndpoint()
        if (!ep) {
          sendJson(res, 503, { error: 'chat channel is not running', reason: 'not_running' })
          return
        }
        const since = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('since')) || 0
        const r = await proxyToChannel(ep, '/out', { search: `?since=${since}` })
        if (r.status === 0) {
          sendJson(res, 502, { error: 'chat channel did not answer', reason: 'unreachable' })
          return
        }
        if (r.status !== 200 || !r.body) {
          // 401 lands here too: a token from a stale file the moment after a
          // restart. Not distinguished on purpose -- the client's move is
          // identical (retry next tick, the file rewrite has already landed).
          sendJson(res, 502, { error: 'chat channel refused the request', reason: 'upstream_refused' })
          return
        }
        sendJson(res, 200, r.body)
        return
      },
    },
    // POST in: the user's message. Mutating, so the per-launch
    // X-Onboard-Token gate has already run before this handler is reached.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/chat/in',
      handler: async (req, res) => {
        const { text } = await readJsonBody(req)
        if (typeof text !== 'string' || !text.trim()) {
          sendJson(res, 400, { error: 'text is required', reason: 'text_required' })
          return
        }
        const ep = readChannelEndpoint()
        if (!ep) {
          sendJson(res, 503, { error: 'chat channel is not running', reason: 'not_running' })
          return
        }
        const r = await proxyToChannel(ep, '/in', { method: 'POST', body: { text } })
        if (r.status === 0) {
          sendJson(res, 502, { error: 'chat channel did not answer', reason: 'unreachable' })
          return
        }
        if (r.status !== 202) {
          sendJson(res, 502, { error: 'chat channel refused the message', reason: 'upstream_refused' })
          return
        }
        sendJson(res, 202, { ok: true })
        return
      },
    },
    // POST react: an emoji tap on an agent bubble (DM interactions, v0.0.34).
    // Mutating -> token-gated like /in. Validation here is shape-only
    // (string, positive int); the channel owns the real rules (emoji enum,
    // reactable target) so there is exactly one authority on what a valid
    // reaction is.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/chat/react',
      handler: async (req, res) => {
        const { emoji, targetSeq } = await readJsonBody(req)
        const n = Number(targetSeq)
        if (typeof emoji !== 'string' || !emoji.trim() || !Number.isInteger(n) || n < 1) {
          sendJson(res, 400, { error: 'emoji and targetSeq are required', reason: 'bad_reaction' })
          return
        }
        const ep = readChannelEndpoint()
        if (!ep) {
          sendJson(res, 503, { error: 'chat channel is not running', reason: 'not_running' })
          return
        }
        const r = await proxyToChannel(ep, '/react', { method: 'POST', body: { emoji, targetSeq: n } })
        if (r.status === 0) {
          sendJson(res, 502, { error: 'chat channel did not answer', reason: 'unreachable' })
          return
        }
        if (r.status !== 202) {
          sendJson(res, 502, { error: 'chat channel refused the reaction', reason: 'upstream_refused' })
          return
        }
        sendJson(res, 202, { ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
