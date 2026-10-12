import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { readKeyFile, resolveRequestKey } = require('../onboarding/key-file.cjs')
const { createRoutes } = require('../onboarding/routes/provider.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-key-file-'))
try {
  const file = path.join(dir, 'key.txt'), yaml = path.join(dir, '.credentials.yaml')
  const secret = 'test-secret-never-echo'
  fs.writeFileSync(file, `  ${secret}  \nignored`)
  fs.writeFileSync(yaml, `GEMINI_API_KEY: ${secret}\nOTHER: other\n`)
  assert.equal(readKeyFile(file), secret)
  assert.equal(readKeyFile(yaml, 'GEMINI_API_KEY'), secret)
  assert.equal(resolveRequestKey({ key: ` ${secret} ` }), secret)
  assert.equal(resolveRequestKey({ apiKey: secret }), secret)
  for (const body of [{ keyFile: 'relative' }, { keyFile: dir }, { keyFile: path.join(dir, 'absent') },
    { keyFile: yaml }, { keyFile: yaml, keyName: 'missing' }, { keyFile: file, key: secret }, { keyName: 'alone' }]) {
    assert.throws(() => resolveRequestKey(body), (e) => !e.message.includes(secret))
  }
  fs.writeFileSync(path.join(dir, 'large'), Buffer.alloc(65537))
  assert.throws(() => readKeyFile(path.join(dir, 'large')), /64 KiB/)
  fs.writeFileSync(path.join(dir, 'empty'), '\n')
  assert.throws(() => readKeyFile(path.join(dir, 'empty')), /empty key/)
  fs.writeFileSync(path.join(dir, 'bad.yaml'), `KEY: [${secret}`)
  assert.throws(() => readKeyFile(path.join(dir, 'bad.yaml'), 'KEY'), (e) => !e.message.includes(secret))
  const events = []
  let body, response, valid = true
  const ctx = {
    readJsonBody: async () => body, sendJson: (_res, status, data) => { response = { status, data } },
    rejectIfRouterNotWired: () => false,
    resolveCustomBaseUrl: (url) => ({ url }), MODEL_ID_PATTERN: /^[\w.-]+$/,
    validateProviderKey: async (provider, key) => { events.push('validate'); assert.equal(provider, 'custom'); assert.equal(key, secret); return { ok: valid, reason: secret } },
    storeProviderKeyVerified: (_p, key) => { events.push('store'); assert.equal(key, secret) },
    readAgentConfig: () => ({}), writeAgentConfig: () => events.push('config'), clearMuteStrikes: () => {},
  }
  const route = createRoutes(ctx).find((r) => r.match('/api/agent/custom-provider'))
  const controls = { agentControls: { restartAgent: async () => events.push('restart') } }
  for (const credential of [{ keyFile: file }, { keyFile: yaml, keyName: 'GEMINI_API_KEY' }, { key: secret }, { apiKey: secret }]) {
    body = { baseUrl: 'https://example.test/v1', model: 'model', ...credential }; events.length = 0
    await route.handler({}, {}, controls)
    assert.equal(response.status, 202)
    assert.deepEqual(events, ['validate', 'store', 'config', 'restart'])
    assert.ok(!JSON.stringify(response).includes(secret))
  }
  valid = false; events.length = 0
  await route.handler({}, {}, controls)
  assert.equal(response.status, 400); assert.deepEqual(events, ['validate'])
  assert.ok(!JSON.stringify(response).includes(secret))
  body = { keyFile: 'relative' }; events.length = 0
  await route.handler({}, {}, controls)
  assert.equal(response.status, 400); assert.deepEqual(events, [])
  const manual = fs.readFileSync(new URL('../onboarding/templates/SCHEHERAZADE_MANUAL.md', import.meta.url), 'utf8')
  for (const term of ['keyFile', 'keyName', '64 KiB', 'lane.patch.yml', 'lane.runtime.patch.yml', '.credentials.yaml', '[UI custom]', 'source: "lane"', 'X-Onboard-Token']) assert.ok(manual.includes(term), `manual documents ${term}`)
  console.log('PASS keyFile bounds, YAML selection, redaction, route validation/store ordering and compatibility')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
