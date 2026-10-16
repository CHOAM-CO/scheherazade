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
// 'upstream_refused' | 'no_turn' | ...), never upstream prose and never caller input --
// the unbounded-echo rule, same as setup-token.cjs. The channel token
// appears in exactly one place: the Authorization header of the loopback
// fetch. It is never in a response, an error, or a log line here.
'use strict'

// Loopback round trips; generous only because /in does a notification write
// under load. Not in staticCtx: single owner, this file.
const CHAT_PROXY_TIMEOUT_MS = 5_000
const CHAT_INTERRUPT_TIMEOUT_MS = 25_000
const CHAT_STATUS_TIMEOUT_MS = 1_500

function createRoutes(staticCtx) {
  const { fs, path, log, sendJson, readJsonBody, DATA_HOME, activeChannelBackend, laneVision, fetchImageCaption } = staticCtx

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
        const { text, origin } = await readJsonBody(req)
        if (typeof text !== 'string' || !text.trim()) {
          sendJson(res, 400, { error: 'text is required', reason: 'text_required' })
          return
        }
        const ep = readChannelEndpoint()
        if (!ep) {
          sendJson(res, 503, { error: 'chat channel is not running', reason: 'not_running' })
          return
        }
        const r = await proxyToChannel(ep, '/in', { method: 'POST', body: { text, origin: origin === 'voice' ? 'voice' : 'text' } })
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
    // POST interrupt: the Stop button (0.3.1). No body at all -- the only
    // thing this route carries is the fact that it was called, so there is
    // nothing caller-supplied to validate or echo. Mutating, so the Host +
    // Origin + X-Onboard-Token gate has already run.
    //
    // 409 is a first-class answer, not an error: the turn finished while the
    // click was in flight. The page treats it as "already done" and just
    // re-renders. Reason strings stay in this file's fixed vocabulary; the
    // channel's own enum is already the same words, and anything unfamiliar
    // collapses to 'upstream_refused' rather than passing lane prose through.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/chat/interrupt',
      handler: async (req, res) => {
        const ep = readChannelEndpoint()
        if (!ep) {
          sendJson(res, 503, { error: 'chat channel is not running', reason: 'not_running' })
          return
        }
        const r = await proxyToChannel(ep, '/interrupt', { method: 'POST', body: {}, timeoutMs: CHAT_INTERRUPT_TIMEOUT_MS })
        if (r.status === 0) {
          sendJson(res, 502, { error: 'chat channel did not answer', reason: 'unreachable' })
          return
        }
        if (r.status === 200) {
          sendJson(res, 200, { ok: true })
          return
        }
        const upstream = r.body && r.body.reason
        const reason = ['not_running', 'unreachable', 'no_turn', 'upstream_refused'].includes(upstream)
          ? upstream
          : 'upstream_refused'
        if (r.status === 409 || reason === 'no_turn') {
          sendJson(res, 409, { error: 'no turn is running', reason: 'no_turn' })
          return
        }
        sendJson(res, 502, { error: 'chat channel refused the stop', reason })
        return
      },
    },
    // POST upload: chat image attachment (2026-08-04, the owner "인앱챗에
    // 이미지 업로드할수있는 방법이 없음 >> 수정해놔야겠지?"). JSON
    // {filename, dataBase64} rather than multipart -- readJsonBody is the
    // one body reader this server has, and a 15MB cap covers a 10MB image
    // in base64. The file lands in DATA_HOME/chat_uploads/ and the SEND
    // path (chat.js) appends "[image attached: <path>]" to the message so
    // the agent opens it with its Read tool -- the same local-path
    // convention the Discord channel already uses for inbound images.
    // Mutating -> token-gated automatically.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/chat/upload',
      handler: async (req, res, callCtx) => {
        let parsed
        try {
          parsed = await readJsonBody(req, 15_000_000)
        } catch (err) {
          sendJson(res, 413, { error: 'image too large (10MB max)', reason: 'too_large' })
          return
        }
        const { filename, dataBase64 } = parsed
        // 0.1.4 (PO item #4, attachment generalization): text-y documents and
        // PDFs join images. kind drives the client marker -- 'text' is safe
        // for ANY lane to Read; 'image'/'pdf' are vision-gated (Read renders
        // PDF pages as images, so a non-vision lane must not open them).
        // 0.1.18 (the owner "파일 주고받기"): media + archives join. kind 'file'
        // = agent can reference/process it with shell tools but must not
        // Read it (binary; Read renders nothing useful).
        const ext = String(filename || '').toLowerCase().match(/\.(png|jpe?g|gif|webp|pdf|txt|md|csv|tsv|json|log|xml|yaml|yml|mp3|m4a|wav|mp4|mov|webm|zip)$/)
        if (!ext) {
          sendJson(res, 400, { error: 'unsupported type -- images (png/jpg/gif/webp), pdf, text files (txt/md/csv/tsv/json/log/xml/yaml), media (mp3/m4a/wav/mp4/mov/webm), or zip', reason: 'bad_type' })
          return
        }
        const kind = /^\.(png|jpe?g|gif|webp)$/.test(ext[0]) ? 'image'
          : ext[0] === '.pdf' ? 'pdf'
          : /^\.(mp3|m4a|wav|mp4|mov|webm|zip)$/.test(ext[0]) ? 'file'
          : 'text'
        if (typeof dataBase64 !== 'string' || !dataBase64) {
          sendJson(res, 400, { error: 'dataBase64 is required', reason: 'no_data' })
          return
        }
        let buf
        try { buf = Buffer.from(dataBase64, 'base64') } catch { buf = null }
        if (!buf || buf.length === 0) {
          sendJson(res, 400, { error: 'could not decode image data', reason: 'bad_data' })
          return
        }
        if (buf.length > 10_000_000) {
          sendJson(res, 413, { error: 'image too large (10MB max)', reason: 'too_large' })
          return
        }
        const dir = path.join(DATA_HOME, 'chat_uploads')
        try {
          fs.mkdirSync(dir, { recursive: true })
          // Server-minted name: timestamp + sanitized stem + whitelisted
          // ext. The client's filename never becomes a path component
          // beyond this sanitation.
          const stem = String(filename).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'image'
          const name = `${Date.now()}_${stem}${ext[0]}`
          const full = path.join(dir, name)
          fs.writeFileSync(full, buf, { mode: 0o600 })
          // Vision stand-in (0.0.56, the owner "작은 비전모델 붙여서"): a lane
          // that provably cannot see images gets a caption from the small
          // vision model, folded into the marker client-side. Only the
          // KNOWN-'no' lane pays the extra call -- 'yes' doesn't need it,
          // 'unknown' must not pretend. Caption failure degrades to the
          // honest no-caption marker; the upload itself never fails on it.
          let caption
          const spawn = callCtx && callCtx.agentControls && typeof callCtx.agentControls.spawnInfo === 'function'
            ? callCtx.agentControls.spawnInfo() : null
          if (kind === 'image' && laneVision(spawn) === 'no' && typeof fetchImageCaption === 'function') {
            const type = ext[0] === '.png' ? 'image/png' : ext[0] === '.gif' ? 'image/gif' : ext[0] === '.webp' ? 'image/webp' : 'image/jpeg'
            const cap = await fetchImageCaption(buf.toString('base64'), type)
            if (cap.ok) caption = { text: cap.caption, model: cap.model }
            else log && log(`chat upload: vision stand-in caption failed (${cap.reason}) -- marker degrades to the honest no-vision text`)
          }
          sendJson(res, 200, { ok: true, name, path: full, kind, ...(caption ? { caption } : {}) })
        } catch (err) {
          sendJson(res, 500, { error: `could not save the image: ${err.message}`, reason: 'write_failed' })
        }
        return
      },
    },
    // GET upload/<name>: serve a saved attachment back for bubble display.
    // Basename-only lookup inside chat_uploads -- a name with a separator
    // or dot-dot never reaches the filesystem.
    {
      method: 'GET',
      match: (pathname) => pathname.startsWith('/api/chat/upload/'),
      handler: async (req, res) => {
        const name = decodeURIComponent(String(req.url || '').split('/api/chat/upload/')[1] || '').split('?')[0]
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          sendJson(res, 400, { error: 'bad name' })
          return
        }
        const full = path.join(DATA_HOME, 'chat_uploads', name)
        let buf
        try { buf = fs.readFileSync(full) } catch {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        const type = /\.png$/i.test(name) ? 'image/png'
          : /\.jpe?g$/i.test(name) ? 'image/jpeg'
          : /\.gif$/i.test(name) ? 'image/gif'
          : /\.webp$/i.test(name) ? 'image/webp'
          : /\.pdf$/i.test(name) ? 'application/pdf'
          : /\.mp4$/i.test(name) ? 'video/mp4'
          : /\.webm$/i.test(name) ? 'video/webm'
          : /\.mov$/i.test(name) ? 'video/quicktime'
          : /\.mp3$/i.test(name) ? 'audio/mpeg'
          : /\.m4a$/i.test(name) ? 'audio/mp4'
          : /\.wav$/i.test(name) ? 'audio/wav' : 'application/octet-stream'
        res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'private, max-age=86400' })
        res.end(buf)
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
