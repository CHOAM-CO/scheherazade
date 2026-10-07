// test-route-proxy.mjs -- the loopback route proxy (route-proxy.cjs) is REAL.
// Run: node tests/test-route-proxy.mjs
//
// Mino 2026-10-07: model/effort picks must not restart the agent. The agent's
// LLM route always targets route-proxy.cjs; a pick moves the proxy's live
// config. This test runs the real proxy against a recording stub upstream:
//   (a) model + output_config.effort rewritten on anthropic, reasoning_effort
//       on openai, effort 'off' deletes thinking;
//   (b) x-api-key / Bearer injected in api-key mode; passthrough leaves the
//       OAuth headers and the system block byte-identical;
//   (c) SSE streams through un-buffered (events seen before end);
//   (d) setRoute mid-run changes the NEXT request's model, no reconnect;
//   (e) store / max_completion_tokens normalization for a non-standard host;
//   (f) source pins: dsh-lane.mjs emits baseURL under anthropic: when
//       DSH_ROUTE_BASE_URL is set, and /select-model exists behind the token.
// No LLM call is made.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createRouteProxy, rewriteRequestBody, isNonStandardOpenAIHost } = require_('./route-proxy.cjs')

let pass = 0
let fail = 0
function ok (name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── stub upstream: records every request; /sse streams 3 events with delays ──
const seen = []
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    seen.push({ url: req.url, method: req.method, headers: req.headers, body })
    if (req.url.endsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let i = 0
      const tick = () => {
        i++
        res.write(`event: ping\ndata: {"n":${i},"t":${Date.now()}}\n\n`)
        if (i < 3) setTimeout(tick, 120)
        else res.end()
      }
      tick()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    let echoed = null
    try { echoed = body.length ? JSON.parse(body.toString('utf8')) : null } catch { echoed = 'non-json' }
    res.end(JSON.stringify({ echoed, path: req.url }))
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const upPort = upstream.address().port
const upBase = `http://127.0.0.1:${upPort}`

const proxy = await createRouteProxy({ log: () => {} })
const post = async (url, body, headers = {}) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const last = () => seen[seen.length - 1]
const lastBody = () => JSON.parse(last().body.toString('utf8'))

// ---------- (a) model + effort rewrites ----------
{
  proxy.setRoute('anthropic', { upstreamBase: upBase + '/base', model: 'claude-sonnet-4-6', effort: 'high', key: 'real-key', keyMode: 'api-key' })
  const r = await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`,
    { model: 'claude-opus-4-6', thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' }, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-api-key': 'sera-proxy' })
  ok('anthropic: upstream answers 200 through the proxy', r.status === 200, String(r.status))
  ok('anthropic: path prefix stripped, rest appended to upstreamBase', last().url === '/base/v1/messages', last().url)
  ok('anthropic: body.model rewritten to the live model', lastBody().model === 'claude-sonnet-4-6', lastBody().model)
  ok('anthropic: output_config.effort rewritten on an adaptive body', lastBody().output_config && lastBody().output_config.effort === 'high', JSON.stringify(lastBody().output_config))
  ok('anthropic: thinking block left as the lane shaped it', lastBody().thinking && lastBody().thinking.type === 'adaptive' && lastBody().thinking.display === 'summarized')
  ok('anthropic: messages untouched', lastBody().messages[0].content === 'hi')
  ok('anthropic: content-length matches the rewritten body', Number(last().headers['content-length']) === last().body.length)
  ok('anthropic: host header is the upstream host', last().headers.host === `127.0.0.1:${upPort}`, last().headers.host)
  ok('anthropic: accept-encoding forced to identity', last().headers['accept-encoding'] === 'identity')

  // budget-thinking body: effort must NOT invent an output_config
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'm', thinking: { type: 'enabled', budget_tokens: 4096 }, messages: [] })
  ok('anthropic: budget_tokens body gets no output_config and keeps its budget', !('output_config' in lastBody()) && lastBody().thinking.budget_tokens === 4096, JSON.stringify(lastBody()))

  // effortAlwaysSupported (chatgpt row, 0.3.14): the lane shapes a BUDGET
  // thinking block for the declared codex model (pi-ai: no
  // forceAdaptiveThinking on a hand-declared model -> thinking {type:
  // 'enabled', budget_tokens}); codex-as-api reads output_config.effort on
  // any body, so the proxy sets it regardless of thinking shape.
  const codexBody = { model: 'gpt-5.5', max_tokens: 16000, thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' }, messages: [{ role: 'user', content: 'hi' }], tools: [] }
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'gpt-5.4', effort: 'low', key: null, keyMode: 'passthrough', protocol: 'anthropic-messages', effortAlwaysSupported: true })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, codexBody)
  ok('codex flag: output_config.effort set on a budget-thinking body', lastBody().output_config && lastBody().output_config.effort === 'low' && lastBody().model === 'gpt-5.4', JSON.stringify(lastBody()))
  ok('codex flag: budget thinking block kept as the lane shaped it', lastBody().thinking && lastBody().thinking.type === 'enabled' && lastBody().thinking.budget_tokens === 4096)
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'gpt-5.4', effort: 'off', key: null, keyMode: 'passthrough', protocol: 'anthropic-messages', effortAlwaysSupported: true })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, codexBody)
  ok("codex flag: effort 'off' -> thinking {type:'disabled'} (codex reads 'none'), no output_config", lastBody().thinking && lastBody().thinking.type === 'disabled' && !('output_config' in lastBody()), JSON.stringify(lastBody()))
  ok('no flag: same budget body still gets no output_config (pure rewrite)', !('output_config' in JSON.parse(rewriteRequestBody('anthropic', Buffer.from(JSON.stringify(codexBody)), { model: 'gpt-5.4', effort: 'low' }).toString())))
  ok('flag: pure rewrite sets output_config.effort on the budget body', JSON.parse(rewriteRequestBody('anthropic', Buffer.from(JSON.stringify(codexBody)), { model: 'gpt-5.4', effort: 'max', effortAlwaysSupported: true }).toString()).output_config.effort === 'max')

  // effort off deletes thinking + output_config
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'claude-sonnet-4-6', effort: 'off', key: 'real-key', keyMode: 'api-key' })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'm', thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, messages: [] })
  ok("anthropic: effort 'off' deletes thinking and output_config", !('thinking' in lastBody()) && !('output_config' in lastBody()), JSON.stringify(lastBody()))

  // openai
  proxy.setRoute('openai', { upstreamBase: upBase + '/v1', model: 'kimi-k3', effort: 'low', key: 'ollama-real', keyMode: 'api-key' })
  await post(`${proxy.baseUrlFor('openai')}/chat/completions`, { model: 'glm-5.3', reasoning_effort: 'high', messages: [], max_completion_tokens: 10, store: true })
  ok('openai: path -> upstreamBase(/v1) + /chat/completions', last().url === '/v1/chat/completions', last().url)
  ok('openai: body.model rewritten', lastBody().model === 'kimi-k3', lastBody().model)
  ok('openai: reasoning_effort rewritten', lastBody().reasoning_effort === 'low', lastBody().reasoning_effort)
  ok('openai: standard (loopback) host keeps store + max_completion_tokens', lastBody().store === true && lastBody().max_completion_tokens === 10, JSON.stringify(lastBody()))
  proxy.setRoute('openai', { upstreamBase: upBase + '/v1', model: 'kimi-k3', effort: 'off', key: 'ollama-real', keyMode: 'api-key' })
  await post(`${proxy.baseUrlFor('openai')}/chat/completions`, { model: 'glm-5.3', reasoning_effort: 'high', messages: [] })
  ok("openai: effort 'off' deletes reasoning_effort", !('reasoning_effort' in lastBody()))

  // non-JSON body passes through byte-identical
  const raw = 'this is not json {'
  const res = await fetch(`${proxy.baseUrlFor('openai')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: raw })
  ok('non-JSON body forwards byte-identical', res.status === 200 && last().body.toString('utf8') === raw)
  // unknown path / unconfigured class
  const nf = await fetch(`http://127.0.0.1:${proxy.port}/nope`, { method: 'POST', body: '{}' })
  ok('unknown path -> 404 from the proxy itself', nf.status === 404)
  const health = await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()
  ok('GET /health reports model/effort/upstream per class and never the key',
    health.anthropic.model === 'claude-sonnet-4-6' && health.openai.model === 'kimi-k3' && !JSON.stringify(health).includes('real-key') && !JSON.stringify(health).includes('ollama-real'),
    JSON.stringify(health))
}

// ---------- (b) auth: api-key injects, passthrough leaves everything ----------
{
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'claude-sonnet-4-6', effort: 'high', key: 'sk-ant-api03-REAL', keyMode: 'api-key' })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'm', messages: [] }, { 'x-api-key': 'sera-proxy' })
  ok('api-key mode (anthropic): x-api-key replaced with the real key', last().headers['x-api-key'] === 'sk-ant-api03-REAL', last().headers['x-api-key'])
  ok('api-key mode (anthropic): no authorization header invented', !('authorization' in last().headers))
  proxy.setRoute('openai', { upstreamBase: upBase + '/v1', model: 'kimi-k3', effort: 'high', key: 'OLLAMA-REAL', keyMode: 'api-key' })
  await post(`${proxy.baseUrlFor('openai')}/chat/completions`, { model: 'm', messages: [] }, { authorization: 'Bearer sera-proxy' })
  ok('api-key mode (openai): Bearer replaced with the real key', last().headers.authorization === 'Bearer OLLAMA-REAL', last().headers.authorization)

  // OAuth passthrough: the lane sent everything pi-ai's OAuth mode sends.
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'claude-opus-4-6', effort: 'high', keyMode: 'passthrough' })
  const oauthHeaders = {
    authorization: 'Bearer sk-ant-oat01-SECRET',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
    'user-agent': 'claude-cli/2.0.0',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
  }
  const oauthBody = {
    model: 'claude-opus-4-6',
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'persona' }],
    messages: [{ role: 'user', content: 'x' }],
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
  }
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, oauthBody, oauthHeaders)
  for (const [k, v] of Object.entries(oauthHeaders)) ok(`passthrough: header ${k} forwarded verbatim`, last().headers[k] === v, `${last().headers[k]}`)
  ok('passthrough: no x-api-key invented', !('x-api-key' in last().headers))
  ok('passthrough: body byte-identical when model+effort already match (system block untouched)',
    last().body.toString('utf8') === JSON.stringify(oauthBody))
  // and when the live model differs, ONLY model/effort move; system stays byte-identical
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'claude-sonnet-4-6', effort: 'low', keyMode: 'passthrough' })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, oauthBody, oauthHeaders)
  ok('passthrough + switch: system block byte-identical', JSON.stringify(lastBody().system) === JSON.stringify(oauthBody.system))
  ok('passthrough + switch: model/effort moved', lastBody().model === 'claude-sonnet-4-6' && lastBody().output_config.effort === 'low')
  ok('passthrough + switch: Bearer still the lane\'s oat token', last().headers.authorization === 'Bearer sk-ant-oat01-SECRET')
}

// ---------- (c) SSE streams un-buffered ----------
{
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'm', effort: 'high', keyMode: 'passthrough' })
  const t0 = Date.now()
  const arrivals = []
  const res = await fetch(`${proxy.baseUrlFor('anthropic')}/v1/sse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' })
  ok('SSE: content-type forwarded', String(res.headers.get('content-type')).startsWith('text/event-stream'))
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      arrivals.push(Date.now() - t0)
      buf = buf.slice(idx + 2)
    }
  }
  const tEnd = Date.now() - t0
  ok('SSE: 3 events arrived', arrivals.length === 3, String(arrivals.length))
  ok('SSE: first event arrived BEFORE the stream ended (not buffered)', arrivals.length === 3 && arrivals[0] < tEnd - 150, `${arrivals.join(',')} end=${tEnd}`)
}

// ---------- (d) setRoute mid-run moves the NEXT request, same server ----------
{
  const port0 = proxy.port
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'model-A', effort: 'high', keyMode: 'passthrough' })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'x', messages: [] })
  const a = lastBody().model
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'model-B', effort: 'max', keyMode: 'passthrough' })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'x', thinking: { type: 'adaptive' }, messages: [] })
  ok('setRoute mid-run: first request carried model-A, next carries model-B', a === 'model-A' && lastBody().model === 'model-B', `${a} ${lastBody().model}`)
  ok('setRoute mid-run: effort moved too', lastBody().output_config && lastBody().output_config.effort === 'max')
  ok('setRoute mid-run: same server, same port', proxy.port === port0 && proxy.server.listening)
  // upstream base swap, same class
  const up2 = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"who":"up2"}') })
  await new Promise((r) => up2.listen(0, '127.0.0.1', r))
  proxy.setRoute('anthropic', { upstreamBase: `http://127.0.0.1:${up2.address().port}`, model: 'model-B', effort: 'max', keyMode: 'passthrough' })
  const r2 = await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'x' })
  ok('setRoute mid-run: upstream base swap reaches the new upstream', r2.json && r2.json.who === 'up2')
  up2.close()
  // unreachable upstream -> 502 JSON, proxy stays up
  proxy.setRoute('anthropic', { upstreamBase: 'http://127.0.0.1:1', model: 'm', effort: 'high', keyMode: 'passthrough' })
  const r3 = await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'x' })
  ok('unreachable upstream -> 502 with an error body; proxy still listening', r3.status === 502 && r3.json && r3.json.type === 'error' && proxy.server.listening, String(r3.status))
}

// ---------- (e) non-standard openai host normalization (pure) ----------
{
  ok('isNonStandardOpenAIHost: ollama.com / deepseek.com yes, loopback no',
    isNonStandardOpenAIHost('https://ollama.com/v1') && isNonStandardOpenAIHost('https://api.deepseek.com/v1') && !isNonStandardOpenAIHost('http://127.0.0.1:9/v1') && !isNonStandardOpenAIHost('https://api.openai.com/v1'))
  const out = JSON.parse(rewriteRequestBody('openai', Buffer.from(JSON.stringify({ model: 'a', store: true, max_completion_tokens: 2048, reasoning_effort: 'high', messages: [] })), { model: 'b', effort: 'max', upstreamBase: 'https://ollama.com/v1' }).toString('utf8'))
  ok('normalization: store deleted, max_completion_tokens -> max_tokens, model/effort moved',
    !('store' in out) && !('max_completion_tokens' in out) && out.max_tokens === 2048 && out.model === 'b' && out.reasoning_effort === 'max', JSON.stringify(out))
  const same = Buffer.from(JSON.stringify({ model: 'b', messages: [] }))
  ok('rewrite: unchanged body returns the SAME buffer (byte-identical)', rewriteRequestBody('anthropic', same, { model: 'b', effort: '' }) === same)
  const arr = Buffer.from('[1,2]')
  ok('rewrite: JSON array body passes through untouched', rewriteRequestBody('anthropic', arr, { model: 'b' }) === arr)
}

// ---------- (f) source pins on dsh-lane.mjs ----------
{
  const src = fs.readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')
  const catalogBlock = src.slice(src.indexOf("if (DSH_ROUTE === 'anthropic-catalog') {"), src.indexOf('} else {', src.indexOf("if (DSH_ROUTE === 'anthropic-catalog') {")))
  ok('pin: buildPatch emits baseURL under anthropic: when DSH_ROUTE_BASE_URL is set',
    /process\.env\.DSH_ROUTE_BASE_URL \? \[`\s+baseURL: \$\{yamlQuote\(process\.env\.DSH_ROUTE_BASE_URL\)\}`\]/.test(catalogBlock))
  const sel = src.slice(src.indexOf("if (req.url === '/select-model') {"))
  ok('pin: POST /select-model exists on the lane control server', sel.length > 0)
  ok('pin: /select-model is x-ingest-token gated before anything else',
    sel.indexOf("tokenOk(req.headers['x-ingest-token'])") !== -1 && sel.indexOf("tokenOk(req.headers['x-ingest-token'])") < sel.indexOf('client.selectModel'))
  ok('pin: /select-model calls client.selectModel on the anthropic catalog route and answers applied:false on declared',
    /client\.selectModel\(sessionId, 'anthropic', model/.test(sel) && /applied: false/.test(sel))
  ok('pin: package.json build.files ships route-proxy.cjs', require_('./package.json').build.files.includes('route-proxy.cjs'))
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  ok('pin: main.cjs keeps the real model id in DSH_MODEL (route config reads env.DSH_MODEL, lane env rewrite touches only base url + key env)',
    /model: env\.DSH_MODEL/.test(mainSrc) && /DSH_ROUTE_BASE_URL: `http:\/\/127\.0\.0\.1:\$\{port\}/.test(mainSrc) && !/DSH_MODEL: ROUTE_PROXY/.test(mainSrc))
  ok('pin: main.cjs has no raw claude-cli literal (uses CLAUDE_CLI_PROVIDER_ID)', !/'claude-cli'/.test(mainSrc))
}

await proxy.close()
upstream.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
