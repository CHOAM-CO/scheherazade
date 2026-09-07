// test-codex-proxy-shim.mjs -- the chatgpt lane's tool-hint strip is REAL.
// Run: node tests/test-codex-proxy-shim.mjs
//
// Caught live (Mino's cto-mac field test, 2026-08-20): pi-ai stamps
// `eager_input_streaming: true` on EVERY tool of an anthropic-messages
// request (default-on, no dsh compat switch reaches it on a declared route),
// and codex-as-api 0.6.5 convertTools() throws on it -> 400 -> every codex
// (gpt-*) turn ends INVALID_REQUEST on arrival. Pre-existing since the 0.2.2
// dsh swap; the 0.2.2 "200 3/3" probes carried no tools array.
//
// main.cjs's fix = codex-proxy-shim.cjs in front of the in-process proxy.
// This test executes the REAL shim: (1) stripToolHints unit surface;
// (2) an end-to-end shimmed hop against a recording stub that REJECTS the
// hint fields exactly like codex-as-api does, proving the wire path;
// (3) SSE responses stream through un-buffered; (4) close() closes both
// servers. No ChatGPT call is made.

import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { startShimmedProxy, stripToolHints, STRIPPED_TOOL_FIELDS } = require_('./codex-proxy-shim.cjs')

let pass = 0
let fail = 0
function ok (name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ---------- (1) stripToolHints unit surface ----------
{
  const body = (obj) => Buffer.from(JSON.stringify(obj))
  const parse = (buf) => JSON.parse(buf.toString('utf8'))

  const req = {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'ㅇ' }],
    tools: [
      { name: 'reply', description: 'd', eager_input_streaming: true, input_schema: { type: 'object' } },
      { name: 'bash', description: 'd', eager_input_streaming: true, strict: true, defer_loading: true, cache_control: { type: 'ephemeral' } },
    ],
  }
  const out = parse(stripToolHints(body(req)))
  ok('every hint field is gone from every tool',
    out.tools.every((t) => STRIPPED_TOOL_FIELDS.every((f) => !(f in t))),
    JSON.stringify(out.tools))
  ok('non-hint tool fields survive (cache_control, input_schema)',
    out.tools[1].cache_control?.type === 'ephemeral' && out.tools[0].input_schema?.type === 'object')
  ok('messages/model untouched', out.model === 'gpt-5.6-sol' && out.messages[0].content === 'ㅇ')

  const clean = body({ model: 'm', tools: [{ name: 'reply' }] })
  ok('body without hint fields passes through byte-identical', stripToolHints(clean) === clean)

  const noTools = body({ model: 'm', messages: [] })
  ok('body without tools array passes through byte-identical', stripToolHints(noTools) === noTools)

  const junk = Buffer.from('this is not json {')
  ok('non-JSON body passes through byte-identical', stripToolHints(junk) === junk)
}

// ---------- (2)+(3)+(4) end-to-end shimmed hop ----------
{
  // Stub backend with codex-as-api's exact rejection posture.
  const seen = []
  const stub = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      seen.push({ url: req.url, raw })
      if (req.url === '/v1/messages') {
        let parsed = null
        try { parsed = JSON.parse(raw) } catch {}
        for (const [i, tool] of (parsed?.tools ?? []).entries()) {
          for (const field of STRIPPED_TOOL_FIELDS) {
            if (tool[field] === true) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Error: tool ${i} ${field}=true is not supported` } }))
              return
            }
          }
        }
        // SSE reply, chunked -- (3) needs to see it stream.
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {}\n\n')
        setTimeout(() => { res.end('event: message_stop\ndata: {}\n\n') }, 30)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
    })
  })
  // app.listen(port, host) contract: the shim treats the stub as the inner app.
  const appLike = { listen: (port, host) => stub.listen(port, host) }
  const outer = await startShimmedProxy({ app: appLike, port: 0 })
  const port = outer.address().port

  // (2) a pi-ai-shaped request (hints on every tool) survives the strict backend.
  const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'ㅇ' }],
      tools: [{ name: 'reply', eager_input_streaming: true, input_schema: {} }],
    }),
  })
  ok('pi-ai-shaped request passes the codex-as-api-strict backend through the shim', resp.status === 200, `status ${resp.status}`)
  const text = await resp.text()
  ok('SSE body streams through intact', text.includes('message_start') && text.includes('message_stop'), text.slice(0, 120))
  const forwarded = JSON.parse(seen.find((s) => s.url === '/v1/messages').raw)
  ok('backend actually received the stripped body', forwarded.tools.every((t) => !('eager_input_streaming' in t)))

  // Non-messages routes pass through untouched.
  const health = await fetch(`http://127.0.0.1:${port}/health`)
  ok('GET passthrough (health) works', health.status === 200 && (await health.json()).status === 'ok')

  // (4) close() takes the inner server down too.
  await new Promise((resolve) => outer.close(resolve))
  ok('close() closed the inner server too', !stub.listening)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
