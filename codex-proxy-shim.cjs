// codex-proxy-shim.cjs -- strip Anthropic tool HINT fields the codex-as-api
// backend rejects, in front of the in-process proxy.
//
// WHY (2026-08-20, Mino cto-mac field test): pi-ai's anthropic-messages
// serializer marks EVERY tool `eager_input_streaming: true` (default-on,
// dist/api/anthropic-messages.js line ~1008: `model.compat?.
// supportsEagerToolInputStreaming ?? true`), and dsh exposes no compat switch
// to turn it off on a declared route (its compat surface is two
// openai-completions-only reasoning switches). codex-as-api 0.6.5 (latest)
// convertTools() throws on `eager_input_streaming|strict|defer_loading ===
// true` -> HTTP 400 -> the lane surfaces INVALID_REQUEST and every codex
// (gpt-*) turn dies on arrival. Pre-existing since the 0.2.2 dsh swap -- the
// 0.2.2 "measured 200" probes carried no tools array, so the first real
// field turn was the first time this path ran.
//
// WHAT: an outer loopback HTTP server on the configured proxy port buffers
// each POST body, deletes those three fields from every entry of a top-level
// `tools` array (JSON bodies only; anything else forwards untouched), and
// forwards to the real codex-as-api express app listening on an ephemeral
// loopback port. Responses are PIPED, not buffered -- SSE streams must flow.
// Dropping the fields is semantically safe: they are optimization hints
// (eager tool-arg streaming / strict schemas / deferred loading), and a
// backend that cannot honor a hint should simply not receive it. Cost on the
// codex lane: reply args arrive whole instead of streaming, so the in-app
// draft paints late -- a nicety lost, against a lane that did not work at all.
//
// Upstream (github.com/Eunho-J/codex-as-api) ignoring the hints instead of
// throwing would make this shim removable; that is Eunho's repo, not ours to
// hotfix -- candidate PR, Mino's call.
'use strict'
const http = require('node:http')

const STRIPPED_TOOL_FIELDS = ['eager_input_streaming', 'strict', 'defer_loading']

/**
 * Strip rejected tool hint fields from a serialized JSON request body.
 * Non-JSON bodies and bodies without a tools array pass through byte-identical.
 * @param {Buffer} bodyBuf raw request body
 * @returns {Buffer} original buffer, or a re-serialized one when stripped
 */
function stripToolHints (bodyBuf) {
  let parsed
  try { parsed = JSON.parse(bodyBuf.toString('utf8')) } catch { return bodyBuf }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) return bodyBuf
  let touched = false
  for (const tool of parsed.tools) {
    if (!tool || typeof tool !== 'object') continue
    for (const field of STRIPPED_TOOL_FIELDS) {
      if (field in tool) {
        delete tool[field]
        touched = true
      }
    }
  }
  return touched ? Buffer.from(JSON.stringify(parsed)) : bodyBuf
}

/**
 * Start the shimmed proxy: `app` (the codex-as-api express app) binds an
 * ephemeral loopback port; the returned server binds `port` and forwards
 * every request through stripToolHints. Closing the returned server closes
 * the inner one too. Pre-listen errors (EADDRINUSE et al) reject with the
 * original error so the caller's existing error branches keep working.
 * @param {{ app: import('http').RequestListener & { listen: Function }, port: number, host?: string, log?: (msg: string) => void }} opts
 * @returns {Promise<import('http').Server>}
 */
function startShimmedProxy ({ app, port, host = '127.0.0.1', log = () => {} }) {
  return new Promise((resolve, reject) => {
    const inner = app.listen(0, host)
    inner.once('error', reject)
    inner.once('listening', () => {
      const innerPort = inner.address().port
      const outer = http.createServer((req, res) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          let body = Buffer.concat(chunks)
          if (req.method === 'POST' && body.length) body = stripToolHints(body)
          const headers = { ...req.headers, host: `${host}:${innerPort}`, 'content-length': String(body.length) }
          delete headers['transfer-encoding'] // body is fully buffered; length header is authoritative
          const up = http.request({ host, port: innerPort, path: req.url, method: req.method, headers }, (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers)
            upRes.pipe(res)
          })
          up.on('error', (err) => {
            log(`codex-proxy-shim: inner proxy unreachable (${err.message})`)
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'codex proxy shim: inner proxy unreachable' } }))
          })
          up.end(body)
        })
      })
      const realClose = outer.close.bind(outer)
      outer.close = (cb) => {
        try { inner.close() } catch { /* inner already down is fine */ }
        return realClose(cb)
      }
      const onPreListenError = (err) => {
        try { inner.close() } catch { /* ditto */ }
        reject(err)
      }
      outer.once('error', onPreListenError)
      outer.once('listening', () => {
        outer.removeListener('error', onPreListenError)
        resolve(outer)
      })
      outer.listen(port, host)
    })
  })
}

module.exports = { startShimmedProxy, stripToolHints, STRIPPED_TOOL_FIELDS }
