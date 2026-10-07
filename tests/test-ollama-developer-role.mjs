#!/usr/bin/env node
// test-ollama-developer-role.mjs -- the leading instruction message on a
// third-party OpenAI-compatible route must be `system`, not `developer`.
//
// Mino 2026-10-07 16:46, capturing proxy between Sera and ollama.com on the
// `ollama-cloud` route (provider-env.cjs: DSH_ROUTE_API=openai-completions,
// base https://ollama.com/v1): the body's first message was
// {"role":"developer","content":"You are an AI agent powered by DeepSeek
// Harness..."} and ollama.com answered 400 for mistral-large-4 ("Input tag
// 'developer' found using 'role' does not match any of the expected tags:
// system, user, assistant, tool"). deepseek-v4.1-flash happened to accept it,
// which is why the lane looked healthy on one model and dead on the next.
//
// The role is chosen in pi-ai's openai-completions provider
// (dist/api/openai-completions.js convertMessages:
//   useDeveloperRole = model.reasoning && compat.supportsDeveloperRole)
// and compat.supportsDeveloperRole comes from detectCompat(), which upstream
// sets TRUE for every base URL it does not recognise as non-standard. dsh's
// pi-ai wrapper (@deepseek-ai/dsh-llm-pi-ai) exposes only thinkingFormat /
// supportsReasoningEffort in its compat schema, so the switch cannot be set
// from lane.patch.yml. patches/@earendil-works+pi-ai+0.82.1.patch narrows
// detection to api.openai.com (plus the OpenRouter pass-through upstream
// already special-cases); this test pins the produced request body on both
// sides of that line, driven through pi-ai's real request builder via the
// onPayload hook (no network: the hook throws after capturing the params).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// pi-ai's export map hides the provider file (and its package.json); the
// patched file is the top-level install, which is also what dsh-llm-pi-ai loads.
const { stream } = await import(path.join(ROOT, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js'))

const SYSTEM = 'You are an AI agent powered by DeepSeek Harness. Pin me.'

// Mirrors what dsh-llm-pi-ai materializes from the lane's declared route:
// api openai-completions, reasoning true (the lane declares reasoningEfforts
// on every model row -- dsh-lane.mjs modelRow()), the route's baseURL.
function laneModel (provider, baseUrl, id) {
  return {
    id, name: id, api: 'openai-completions', provider, baseUrl,
    reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

async function producedBody (model) {
  let captured
  const s = stream(model, { systemPrompt: SYSTEM, messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, {
    apiKey: 'test-key',
    maxRetries: 0,
    onPayload: (params) => { captured = params; throw new Error('captured -- no network') },
  })
  for await (const ev of s) { if (ev.type === 'error') break }
  assert.ok(captured, `${model.provider}: request builder never reached onPayload`)
  return captured
}

const cases = [
  // the live repro
  { provider: 'ollama-cloud', base: 'https://ollama.com/v1', id: 'mistral-large-4', want: 'system' },
  { provider: 'ollama-cloud', base: 'https://ollama.com/v1', id: 'deepseek-v4.1-flash', want: 'system' },
  // custom route with CUSTOM_ROUTE_API=openai-completions (provider-env.cjs)
  { provider: 'custom', base: 'http://127.0.0.1:8000/v1', id: 'local-model', want: 'system' },
  { provider: 'custom', base: 'https://my-proxy.example.com/openai/v1', id: 'gpt-5', want: 'system' },
  // bundled Ollama.app route
  { provider: 'ollama', base: 'http://localhost:11434/v1', id: 'glm-5.2:cloud', want: 'system' },
  // OpenAI proper keeps the developer role
  { provider: 'custom', base: 'https://api.openai.com/v1', id: 'gpt-5', want: 'developer' },
  { provider: 'openai', base: 'https://api.openai.com/v1', id: 'o4-mini', want: 'developer' },
]

let n = 0
for (const c of cases) {
  const body = await producedBody(laneModel(c.provider, c.base, c.id))
  const first = body.messages[0]
  assert.equal(first.role, c.want, `${c.provider} ${c.base} ${c.id}: leading instruction role ${first.role}, want ${c.want}`)
  assert.equal(first.content, SYSTEM, `${c.provider}: instruction text carried verbatim`)
  assert.ok(!body.messages.some((m) => m.role === 'developer' && c.want === 'system'), `${c.provider}: no developer role anywhere in the body`)
  n++
}

// An explicit model-level override still wins over detection (pi-ai getCompat).
{
  const m = { ...laneModel('ollama-cloud', 'https://ollama.com/v1', 'x'), compat: { supportsDeveloperRole: true } }
  const body = await producedBody(m)
  assert.equal(body.messages[0].role, 'developer', 'explicit compat.supportsDeveloperRole=true overrides the narrowed detection')
  n++
}

// Source pin: the patch file is present so a fresh `npm ci` (postinstall:
// patch-package) re-applies it.
const patch = fs.readFileSync(path.join(ROOT, 'patches', '@earendil-works+pi-ai+0.82.1.patch'), 'utf8')
assert.ok(patch.includes('isOpenAIProper = baseUrl.includes("api.openai.com")'), 'patch file pins the api.openai.com gate')
n++

console.log(`ok test-ollama-developer-role (${n} cases)`)
