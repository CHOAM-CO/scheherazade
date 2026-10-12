// route-proxy.cjs -- loopback LLM route proxy for live model/effort switching.
//
// WHY (Mino 2026-10-07 16:46/16:49): a model or effort pick in the UI used to
// restart the agent (POST /api/agent/model|effort -> restartAgent). The
// restart kills the session, the in-flight turn and the context the user
// was mid-way through. The engine (dsh + pi-ai) honours a route-level
// baseURL even on the anthropic CATALOG route (dsh-llm-pi-ai lib/index.js:
// `request.baseURL ?? base?.baseUrl ?? providerBaseUrl`), so the agent's
// route can ALWAYS point at this proxy and the proxy can rewrite the model
// id and effort fields on the way out while the engine keeps its catalog
// metadata (context window, vision, thinking shape).
//
// WHAT: one http server bound 127.0.0.1:0 in the Electron main process,
// started by main.cjs ensureRouteProxy before the agent spawns and torn down
// in quitTeardown. Two protocol classes, each with its own live config:
//
//   /anthropic/<rest>  -> upstreamBase + /<rest>   (Anthropic SDK appends /v1/messages)
//   /openai/v1/<rest>  -> upstreamBase + /<rest>   (OpenAI SDK appends /chat/completions;
//                                                    the base already ends in /v1)
//
// Per class: { upstreamBase, model, effort, key, keyMode, protocol }.
//   keyMode 'api-key'     the lane holds a dummy key; the proxy injects the
//                         real one (x-api-key for anthropic, Bearer for openai).
//   keyMode 'passthrough' auth headers are forwarded verbatim. REQUIRED for
//                         OAuth rows (sk-ant-oat): pi-ai decides OAuth mode in
//                         the lane from the key prefix (Bearer + anthropic-beta
//                         oauth-2025-04-20 + user-agent claude-cli + x-app +
//                         the "You are Claude Code" system block). The proxy
//                         never touches those headers or the system block.
//
// Body rewrite (JSON POST only; anything else forwards byte-identical):
//   body.model = live.model
//   anthropic: effort 'off' -> delete thinking + output_config; else when
//              body.thinking.type === 'adaptive' -> output_config = { effort }.
//              Never invents a thinking block for budget models.
//              effortAlwaysSupported (the chatgpt row, 0.3.14): the upstream
//              is codex-as-api, which reads output_config.effort on ANY
//              body (low|medium|high|xhigh|max) and maps a budget
//              thinking block to a flat "high" -- so effort is set
//              regardless of thinking shape, and 'off' becomes
//              thinking {type:'disabled'} (-> reasoning "none") instead
//              of a deletion the backend would read as "default".
//   openai:    effort 'off' -> delete reasoning_effort; else set it.
//              Non-standard hosts (pi-ai detectCompat keys on the base URL host,
//              which from the lane is now 127.0.0.1): delete `store`, rename
//              max_completion_tokens -> max_tokens.
//
// Headers: host rewritten, content-length set, transfer-encoding dropped,
// accept-encoding forced to identity so the piped SSE stream is readable.
// Responses are PIPED, never buffered (SSE must flow). Shape copied from
// codex-proxy-shim.cjs.
//
// GET /health -> { anthropic: {model, effort, upstream}, openai: {...} }.
// The key is never reported.
//
// authSource (0.4.3 hotfix, field report 2026-10-12 sanha): a passthrough
// route may carry an async authSource() -> { token } | null. When present the
// proxy reads the CURRENT credential on every request and overwrites the
// lane's auth header with it (oat -> Bearer, anything else -> x-api-key).
// The lane's env token is frozen at spawn; a lane alive past the access
// token's lifetime 401'd every turn and the supervisor respawned it with the
// same env. main.cjs wires it only for the Claude login rows -> api.anthropic.com;
// every other route keeps the env path untouched. onUpstreamStatus(cls, code)
// lets main surface a 401 and drop its credential cache.
'use strict'
const http = require('node:http')
const https = require('node:https')

const CLASSES = ['anthropic', 'openai']
const PREFIX = { anthropic: '/anthropic', openai: '/openai/v1' }

// Hosts pi-ai's openai detectCompat treats as non-standard (store unsupported,
// max_tokens spelling) plus ollama.com, which rejects neither today but has
// no use for `store`. Mirror of dist/api/openai-completions.js detectCompat.
const NON_STANDARD_OPENAI_HOSTS = [
  'ollama.com',
  'deepseek.com',
  'api.moonshot.',
  'api.together.ai',
  'api.together.xyz',
  'cerebras.ai',
  'api.x.ai',
  'chutes.ai',
  'api.z.ai',
  'open.bigmodel.cn',
  'opencode.ai',
  'api.cloudflare.com',
  'gateway.ai.cloudflare.com',
  'integrate.api.nvidia.com',
  'api.ant-ling.com',
]

function isNonStandardOpenAIHost (upstreamBase) {
  const base = String(upstreamBase || '')
  return NON_STANDARD_OPENAI_HOSTS.some((h) => base.includes(h))
}

/**
 * Pure body rewrite. Returns the original buffer when the body is not a JSON
 * object (nothing to rewrite) or when nothing changed.
 * @param {'anthropic'|'openai'} cls
 * @param {Buffer} bodyBuf
 * @param {{ model?: string, effort?: string, upstreamBase?: string, effortAlwaysSupported?: boolean }} live
 */
function rewriteRequestBody (cls, bodyBuf, live) {
  let parsed
  try { parsed = JSON.parse(bodyBuf.toString('utf8')) } catch { return bodyBuf }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyBuf
  const before = JSON.stringify(parsed)
  if (live.model) parsed.model = live.model
  const effort = live.effort ? String(live.effort) : ''
  if (cls === 'anthropic') {
    if (effort === 'off') {
      if (live.effortAlwaysSupported) parsed.thinking = { type: 'disabled' }
      else delete parsed.thinking
      delete parsed.output_config
    } else if (effort && (live.effortAlwaysSupported || (parsed.thinking && parsed.thinking.type === 'adaptive'))) {
      parsed.output_config = { ...(parsed.output_config || {}), effort }
    }
  } else {
    if (effort === 'off') delete parsed.reasoning_effort
    else if (effort) parsed.reasoning_effort = effort
    if (isNonStandardOpenAIHost(live.upstreamBase)) {
      delete parsed.store
      if ('max_completion_tokens' in parsed) {
        if (!('max_tokens' in parsed)) parsed.max_tokens = parsed.max_completion_tokens
        delete parsed.max_completion_tokens
      }
    }
  }
  const after = JSON.stringify(parsed)
  return after === before ? bodyBuf : Buffer.from(after)
}

/**
 * Cache an async credential loader per token EXPIRY, not per process.
 * load() -> { token, expiresAt? } | { error } (expiresAt epoch ms). A token
 * with no known expiry is re-read after unknownTtlMs so a re-login lands
 * without a restart. invalidate() forces the next call to reload (on a 401).
 */
// Parallel callers share ONE in-flight load (a refresh token must be spent
// once; concurrent refresh grants with the same token can revoke the family).
// A load that yields no token is cached as negative for negativeTtlMs so a
// dead login does not send every request to the refresh endpoint.
function cachedAuthSource (load, { now = Date.now, headroomMs = 5 * 60 * 1000, unknownTtlMs = 60 * 1000, negativeTtlMs = 30 * 1000 } = {}) {
  let cache = null
  let inflight = null
  let gen = 0
  const get = () => {
    if (cache && now() < cache.validUntil) return Promise.resolve(cache.token ? { token: cache.token } : null)
    if (inflight) return inflight
    const myGen = gen
    inflight = (async () => {
      try {
        const r = await load()
        if (myGen !== gen) return r && r.token ? { token: r.token } : null // invalidated mid-load: answer, do not cache
        if (!r || !r.token) { cache = { token: null, validUntil: now() + negativeTtlMs }; return null }
        const exp = Number(r.expiresAt)
        cache = { token: r.token, validUntil: Number.isFinite(exp) ? exp - headroomMs : now() + unknownTtlMs }
        return { token: r.token }
      } finally {
        if (myGen === gen) inflight = null
      }
    })()
    return inflight
  }
  get.invalidate = () => { cache = null; inflight = null; gen++ }
  return get
}

// Overwrite the lane's auth header with a current credential (pure).
function applyAuthToken (headers, token) {
  if (/^sk-ant-oat/.test(token)) {
    headers.authorization = `Bearer ${token}`
    delete headers['x-api-key']
  } else {
    headers['x-api-key'] = token
    delete headers.authorization
  }
  return headers
}

function classOf (url) {
  for (const cls of CLASSES) {
    const p = PREFIX[cls]
    if (url === p || url.startsWith(p + '/') || url.startsWith(p + '?')) return { cls, rest: url.slice(p.length) }
  }
  return null
}

/**
 * Start the proxy. Resolves once listening.
 * @param {{ log?: (msg: string) => void, host?: string }} opts
 * @returns {Promise<{ server: import('http').Server, port: number, host: string, setRoute: Function, getRoute: Function, baseUrlFor: Function, close: Function }>}
 */
function createRouteProxy ({ log = () => {}, host = '127.0.0.1', onUpstreamStatus = () => {} } = {}) {
  const routes = { anthropic: null, openai: null }

  const setRoute = (cls, cfg) => {
    if (!CLASSES.includes(cls)) throw new Error(`route-proxy: unknown class ${cls}`)
    if (!cfg || typeof cfg.upstreamBase !== 'string' || !cfg.upstreamBase) throw new Error(`route-proxy: ${cls} route needs an upstreamBase`)
    const keyMode = cfg.keyMode === 'api-key' ? 'api-key' : 'passthrough'
    routes[cls] = {
      upstreamBase: cfg.upstreamBase.replace(/\/+$/, ''),
      model: cfg.model ? String(cfg.model) : '',
      effort: cfg.effort ? String(cfg.effort) : '',
      key: keyMode === 'api-key' ? (cfg.key ? String(cfg.key) : '') : null,
      keyMode,
      protocol: cfg.protocol || (cls === 'anthropic' ? 'anthropic-messages' : 'openai-completions'),
      effortAlwaysSupported: cfg.effortAlwaysSupported === true,
      authSource: keyMode === 'passthrough' && typeof cfg.authSource === 'function' ? cfg.authSource : null,
      since: new Date().toISOString(),
    }
    log(`route-proxy: ${cls} -> ${routes[cls].upstreamBase} model=${routes[cls].model || '(passthrough)'} effort=${routes[cls].effort || '(passthrough)'}${routes[cls].effortAlwaysSupported ? ' (always set)' : ''} key=${keyMode}${routes[cls].authSource ? ' (live credential)' : ''}`)
    return getRoute(cls)
  }
  const getRoute = (cls) => (routes[cls] ? { ...routes[cls] } : null)
  const health = () => {
    const out = {}
    for (const cls of CLASSES) {
      const r = routes[cls]
      out[cls] = r ? { model: r.model, effort: r.effort, upstream: r.upstreamBase, keyMode: r.keyMode, since: r.since } : null
    }
    return out
  }

  const server = http.createServer((req, res) => {
    const sendJson = (code, obj) => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) return sendJson(200, { ok: true, ...health() })
    const target = classOf(String(req.url || ''))
    if (!target) return sendJson(404, { type: 'error', error: { type: 'not_found_error', message: 'route-proxy: unknown path' } })
    const live = routes[target.cls]
    if (!live) return sendJson(503, { type: 'error', error: { type: 'api_error', message: `route-proxy: no ${target.cls} route configured` } })

    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      let auth = null
      if (live.authSource) {
        try { auth = await live.authSource() } catch (err) { log(`route-proxy: credential read failed (${err && err.message}) -- forwarding the lane's own header`) }
      }
      let body = Buffer.concat(chunks)
      if (req.method === 'POST' && body.length) body = rewriteRequestBody(target.cls, body, live)
      let upstream
      try { upstream = new URL(live.upstreamBase) } catch (err) {
        return sendJson(502, { type: 'error', error: { type: 'api_error', message: `route-proxy: bad upstream base (${err.message})` } })
      }
      const rest = target.rest || '/'
      const upstreamPath = upstream.pathname.replace(/\/+$/, '') + (rest.startsWith('/') ? rest : '/' + rest)
      const headers = { ...req.headers, host: upstream.host, 'content-length': String(body.length), 'accept-encoding': 'identity' }
      delete headers['transfer-encoding'] // fully buffered; the length header is authoritative
      if (live.keyMode === 'api-key' && live.key) {
        if (target.cls === 'anthropic') headers['x-api-key'] = live.key
        else headers.authorization = `Bearer ${live.key}`
      }
      if (auth && auth.token) applyAuthToken(headers, auth.token)
      const mod = upstream.protocol === 'https:' ? https : http
      const up = mod.request({
        host: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstreamPath,
        method: req.method,
        headers,
      }, (upRes) => {
        if (upRes.statusCode === 401 && live.authSource && live.authSource.invalidate) live.authSource.invalidate()
        try { onUpstreamStatus(target.cls, upRes.statusCode) } catch {}
        res.writeHead(upRes.statusCode, upRes.headers)
        upRes.pipe(res)
      })
      up.on('error', (err) => {
        log(`route-proxy: upstream ${upstream.host} unreachable (${err.message})`)
        sendJson(502, { type: 'error', error: { type: 'api_error', message: `route-proxy: upstream unreachable (${err.message})` } })
      })
      res.on('close', () => { if (!up.destroyed) up.destroy() })
      up.end(body)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.removeListener('error', reject)
      const port = server.address().port
      resolve({
        server,
        port,
        host,
        setRoute,
        getRoute,
        health,
        baseUrlFor: (cls) => `http://${host}:${port}${PREFIX[cls]}`,
        close: () => new Promise((r) => { try { server.close(() => r()) } catch { r() } }),
      })
    })
  })
}

module.exports = { createRouteProxy, rewriteRequestBody, cachedAuthSource, applyAuthToken, isNonStandardOpenAIHost, NON_STANDARD_OPENAI_HOSTS, ROUTE_PROXY_PREFIX: PREFIX }
