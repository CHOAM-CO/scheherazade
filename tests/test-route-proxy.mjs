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
const { createRouteProxy, rewriteRequestBody, isNonStandardOpenAIHost, cachedAuthSource } = require_('./route-proxy.cjs')

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
    if (req.url.endsWith('/v1/expired')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth access token has expired.' } }))
      return
    }
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

const statuses = []
const proxy = await createRouteProxy({ log: () => {}, onUpstreamStatus: (cls, code) => statuses.push([cls, code]) })
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

// ---------- (e2) setRoute onto a NEW upstream (codex handover, 0.3.14) ----------
// Two stub upstreams: after setRoute with a new upstreamBase the NEXT request
// lands on the second server, nothing reconnects, the first stops seeing traffic.
{
  const seen2 = []
  const upstream2 = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen2.push({ url: req.url, body: Buffer.concat(chunks) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, from: 'upstream2' }))
    })
  })
  await new Promise((r) => upstream2.listen(0, '127.0.0.1', r))
  const upBase2 = `http://127.0.0.1:${upstream2.address().port}`
  const body = { model: 'gpt-6-luna', thinking: { type: 'enabled', budget_tokens: 4096 }, messages: [] }
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'gpt-6-luna', effort: 'high', key: null, keyMode: 'passthrough', effortAlwaysSupported: true })
  const seenBefore = seen.length
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, body)
  ok('handover: before setRoute the request lands on upstream 1', seen.length === seenBefore + 1 && seen2.length === 0)
  proxy.setRoute('anthropic', { upstreamBase: upBase2, model: 'gpt-6-sol', effort: 'high', key: null, keyMode: 'passthrough', effortAlwaysSupported: true })
  const r2 = await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, body)
  ok('handover: after setRoute the NEXT request lands on upstream 2 (same proxy port, no reconnect)', r2.json && r2.json.from === 'upstream2' && seen2.length === 1 && seen.length === seenBefore + 1, JSON.stringify(r2.json))
  const b2 = JSON.parse(seen2[0].body.toString('utf8'))
  ok('handover: new model + effort rewritten on the way to upstream 2', b2.model === 'gpt-6-sol' && b2.output_config && b2.output_config.effort === 'high' && seen2[0].url === '/v1/messages', JSON.stringify(b2))
  ok('handover: /health reports the new upstream', (await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).anthropic.upstream === upBase2)
  upstream2.close()
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
  // codex handover (0.3.14): applyRouteInner spawns a SECOND instance, repoints
  // the route proxy, and only then retires the old one -- never
  // killCodexProxy before setRoute (that cuts the in-flight stream).
  const apply = mainSrc.slice(mainSrc.indexOf('async function applyRouteInner()'), mainSrc.indexOf('\n}\n', mainSrc.indexOf('async function applyRouteInner()')))
  ok('pin: main.cjs defines spawnCodexProxyInstance over the shared startCodexProxyInstance (port 0, never installs itself)',
    /async function spawnCodexProxyInstance\(model\)/.test(mainSrc) && /startCodexProxyInstance\(\{ model, port: 0 \}\)/.test(mainSrc) && /async function startCodexProxyInstance\(/.test(mainSrc))
  ok('pin: ensureCodexProxy builds through the same startCodexProxyInstance', /await startCodexProxyInstance\(\{ model: desiredModel, port: requestedPort \}\)/.test(mainSrc))
  ok('pin: applyRouteInner handles decision.handover by spawning a new instance BEFORE setRoute',
    apply.includes('if (decision.handover)') && apply.indexOf('await spawnCodexProxyInstance(next.DSH_MODEL)') > -1 && apply.indexOf('await spawnCodexProxyInstance(next.DSH_MODEL)') < apply.indexOf('routeProxy.setRoute(cls'))
  ok('pin: applyRouteInner never calls killCodexProxy; the old instance goes through retireCodexProxy (grace period, in-flight streams finish)',
    !apply.includes('killCodexProxy(') && apply.includes('retireCodexProxy(old.server, old.port, old.model)') && /function retireCodexProxy\(server, port, model, graceMs = CODEX_PROXY_RETIRE_GRACE_MS\)/.test(mainSrc) && /setTimeout\(/.test(mainSrc.slice(mainSrc.indexOf('function retireCodexProxy('), mainSrc.indexOf('\n}\n', mainSrc.indexOf('function retireCodexProxy(')))))
  ok('pin: handover repoints the route at the new port and records it as the proxy to reuse on the next spawn',
    apply.includes('next.DSH_ROUTE_BASE_URL = `http://localhost:${inst.port}`') && apply.includes('codexProxyPort = inst.port') && apply.includes('codexProxyModel = next.DSH_MODEL'))
  ok('pin: handover health failure falls back to restart', /if \(!inst\.ok\) return fallback\(`codex proxy handover failed/.test(apply))
  ok('pin: applyRouteInner never calls ensureCodexProxy (that rebuild kills in-flight streams)', !apply.includes('ensureCodexProxy('))
  ok('pin: killCodexProxy closes retiring instances too (quit / fatal)', /function killCodexProxy\(\) \{\s*for \(const entry of retiringCodexProxies\)/.test(mainSrc))
}

// ---------- (g) live credential header swap (0.4.3 auth-expiry hotfix) ----------
{
  let store = { token: 'sk-ant-oat01-fresh-A', expiresAt: Date.now() + 3600_000 }
  let loads = 0
  const src = cachedAuthSource(async () => { loads++; return store })
  proxy.setRoute('anthropic', { upstreamBase: upBase, model: 'claude-opus-5-5', key: null, keyMode: 'passthrough', authSource: src })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'x', messages: [] }, { authorization: 'Bearer sk-ant-oat01-STALE', 'anthropic-beta': 'oauth-2025-04-20' })
  ok('auth swap: stale lane Bearer replaced by the current store token', last().headers.authorization === 'Bearer sk-ant-oat01-fresh-A', last().headers.authorization)
  ok('auth swap: other lane headers (anthropic-beta) untouched', last().headers['anthropic-beta'] === 'oauth-2025-04-20')
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'x', messages: [] }, { authorization: 'Bearer sk-ant-oat01-STALE' })
  ok('auth swap: cached per expiry (one load for two requests)', loads === 1, String(loads))
  store = { token: 'sk-ant-oat01-fresh-B', expiresAt: Date.now() + 3600_000 }
  statuses.length = 0
  const r401 = await post(`${proxy.baseUrlFor('anthropic')}/v1/expired`, { model: 'x', messages: [] }, { authorization: 'Bearer sk-ant-oat01-STALE' })
  ok('auth swap: 401 passes through and is reported to onUpstreamStatus', r401.status === 401 && statuses.some(([c, s]) => c === 'anthropic' && s === 401), JSON.stringify(statuses))
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { model: 'x', messages: [] }, { authorization: 'Bearer sk-ant-oat01-STALE' })
  ok('auth swap: a 401 invalidates the cache; next request carries the rotated token', last().headers.authorization === 'Bearer sk-ant-oat01-fresh-B' && loads === 2, `${last().headers.authorization} loads=${loads}`)
  // expiry-driven reload: token inside the headroom is re-read
  let t = 1_000_000
  let n = 0
  const src2 = cachedAuthSource(async () => { n++; return { token: `tok-${n}`, expiresAt: t + 10 * 60_000 } }, { now: () => t })
  await src2(); t += 4 * 60_000; await src2()
  ok('cache: reused while outside the 5-min headroom', n === 1, String(n))
  t += 2 * 60_000; const g = await src2()
  ok('cache: reloaded once inside the headroom (per token expiry, not per process)', n === 2 && g.token === 'tok-2', `${n} ${g && g.token}`)
  // non-oat token -> x-api-key, Authorization dropped
  proxy.setRoute('anthropic', { upstreamBase: upBase, key: null, keyMode: 'passthrough', authSource: async () => ({ token: 'sk-ant-api03-k' }) })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { messages: [] }, { authorization: 'Bearer old' })
  ok('auth swap: non-oat token goes in x-api-key, Authorization removed', last().headers['x-api-key'] === 'sk-ant-api03-k' && !last().headers.authorization)
  // loader returns null -> lane header forwarded verbatim (env path kept)
  proxy.setRoute('anthropic', { upstreamBase: upBase, key: null, keyMode: 'passthrough', authSource: async () => null })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { messages: [] }, { authorization: 'Bearer lane-env' })
  ok('auth swap: no current credential -> lane header forwarded verbatim', last().headers.authorization === 'Bearer lane-env')
  // no authSource (every other provider) -> unchanged passthrough
  proxy.setRoute('anthropic', { upstreamBase: upBase, key: null, keyMode: 'passthrough' })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { messages: [] }, { authorization: 'Bearer other-provider' })
  ok('no authSource: passthrough untouched', last().headers.authorization === 'Bearer other-provider')
  // api-key mode ignores authSource
  proxy.setRoute('anthropic', { upstreamBase: upBase, key: 'real', keyMode: 'api-key', authSource: async () => ({ token: 'sk-ant-oat01-x' }) })
  await post(`${proxy.baseUrlFor('anthropic')}/v1/messages`, { messages: [] }, { 'x-api-key': 'dummy' })
  ok('api-key mode: authSource ignored, proxy key injected', last().headers['x-api-key'] === 'real' && !last().headers.authorization)
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  ok('pin: both main.cjs setRoute sites go through withLiveCredential', (mainSrc.match(/setRoute\(cls, withLiveCredential\(provider, route\)\)/g) || []).length === 2)
  ok('pin: main polls .restart-request and restarts through restartAgent', /function pollRestartRequest\(\)/.test(mainSrc) && /pollRestartRequest\(\) \}, FAILURE_POLL_MS\)/.test(mainSrc))
  const laneSrc = fs.readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')
  ok("pin: dsh-lane writes .restart-request on an AUTH recycle for Claude login rows only, and holds instead of exiting", /if \(code === 'AUTH' && \['claude-subscription', 'claude-cli'\]\.includes\(process\.env\.SCHZ_PROVIDER/.test(laneSrc) && /\.restart-request[\s\S]{0,900}setTimeout\([\s\S]{0,200}process\.exit\(1\) \}, 60_000\)\s*return/.test(laneSrc))
  ok('pin: main sets SCHZ_PROVIDER, drops a stale .restart-request at boot and ignores pre-start requests', /env\.SCHZ_PROVIDER = provider/.test(mainSrc) && /try \{ fs\.unlinkSync\(RESTART_REQUEST_PATH\)/.test(mainSrc) && /ts < MAIN_STARTED_AT/.test(mainSrc))
  ok('pin: credential cache invalidated at spawn and on key store', /invalidateClaudeAuthSources\('spawn'\)/.test(mainSrc) && /onProviderKeyStored\(/.test(mainSrc))
  ok('pin: auth marker cleared when spawning / switching to a non-Claude row, via turn-error-marker.mjs', /clearAuthMarker\(`spawn on/.test(mainSrc) && /clearAuthMarker\(`live switch to/.test(mainSrc) && /writeTurnErrorMarker\(DATA_HOME/.test(mainSrc) && !/subtype: 'AUTH', detail/.test(mainSrc))
  // in-flight dedupe + negative TTL
  {
    let calls = 0
    let release
    const gate = new Promise((r) => { release = r })
    const s1 = cachedAuthSource(async () => { calls++; await gate; return { token: 'T', expiresAt: Date.now() + 3600_000 } })
    const ps = [s1(), s1(), s1()]
    release()
    const rs = await Promise.all(ps)
    ok('dedupe: 3 parallel callers share one load', calls === 1 && rs.every((r) => r && r.token === 'T'), String(calls))
    let tn = 0
    let nulls = 0
    const s2 = cachedAuthSource(async () => { nulls++; return null }, { now: () => tn })
    await s2(); await s2(); tn += 29_000; await s2()
    ok('negative TTL: a failed load is not retried inside 30s', nulls === 1, String(nulls))
    tn += 2_000; await s2()
    ok('negative TTL: retried after 30s', nulls === 2, String(nulls))
    s2.invalidate(); await s2()
    ok('invalidate clears a negative entry', nulls === 3, String(nulls))
  }
}

await proxy.close()
upstream.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
