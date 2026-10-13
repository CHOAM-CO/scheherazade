#!/usr/bin/env node
// Model selection, cache isolation, and optional real large-archive verification.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { getModel, MODELS } = require('../onboarding/stt/manifest.cjs')
const { ensureModels, modelsPresent } = require('../onboarding/stt/models.cjs')
const { createRoutes } = require('../onboarding/routes/stt.cjs')
assert.equal(getModel().id, '72m')
assert.throws(() => getModel('__proto__'))
assert.equal(getModel('174m').chunkSize, 32)
assert.notEqual(getModel().cacheName, getModel('174m').cacheName)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-stt-models-'))
const previous = process.env.SERA_STT_MODEL_DIR
delete process.env.SERA_STT_MODEL_DIR
try {
  const cfg = {}
  let result
  const ctx = { readAgentConfig: () => cfg, writeAgentConfig: b => Object.assign(cfg, b),
    readJsonBody: async req => req, sendJson: (_res, code, body) => { result = { code, body } },
    DATA_HOME: tmp, getElectron: () => { throw new Error('headless') } }
  let routes = createRoutes(ctx)
  const settings = body => routes.find(r => r.match('/api/stt/settings')).handler(body, {})
  const status = () => routes.find(r => r.match('/api/stt/status')).handler({}, {})
  await status(); assert.equal(result.body.modelId, '174m', 'large is the default')
  assert.equal(result.body.models.length, 2)
  for (const modelId of ['__proto__', 'bad', {}, null]) {
    await settings({ modelId, enabled: true }); assert.equal(result.code, 400); assert.deepEqual(cfg, {})
  }
  await settings({ modelId: '174m', enabled: 'yes' }); assert.equal(result.code, 400); assert.deepEqual(cfg, {})
  await settings({ modelId: '72m' }); assert.equal(cfg.STT_MODEL, '72m')
  await settings({ modelId: '174m' }); assert.equal(result.code, 200); assert.equal(cfg.STT_MODEL, '174m')
  assert.equal(result.body.totalBytes, getModel('174m').TOTAL_BYTES)
  assert.equal(result.body.download.state, 'idle')
  assert.equal(fs.existsSync(path.join(tmp, 'models')), false, 'disabled selection does not download')
  routes = createRoutes(ctx); await status(); assert.equal(result.body.modelId, '174m', 'selection survives route restart')
  const archive = process.env.SERA_STT_LARGE_ARCHIVE
  if (archive) {
    const model = MODELS['174m'], data = fs.readFileSync(archive)
    assert.equal(data.length, model.ARCHIVE.size)
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), model.ARCHIVE.sha256)
    const dest = path.join(tmp, 'models', model.cacheName), seen = []
    await ensureModels(dest, { modelId: model.id, onProgress: p => seen.push(p.done), fetchImpl: async url => {
      assert.equal(url, model.ARCHIVE.url)
      return { ok: true, body: (async function* () { for (let i = 0; i < data.length; i += 65536) yield data.subarray(i, i + 65536) })() }
    } })
    assert.equal(modelsPresent(dest, '174m'), true)
    assert.equal(modelsPresent(dest, '72m'), false)
    assert.deepEqual(fs.readdirSync(dest).sort(), model.FILES.map(f => f.rel).sort())
    assert.equal(seen.at(-1), model.TOTAL_BYTES)
    assert(seen.every((n, i) => !i || n >= seen[i - 1]))
    await ensureModels(dest, { modelId: model.id, fetchImpl: () => { throw new Error('unexpected fetch') } })
    await status(); assert.equal(result.body.modelsPresent, true)
    await settings({ modelId: '72m' }); assert.equal(result.body.modelsPresent, false, 'small uses a separate cache')
    await settings({ modelId: '174m' }); assert.equal(result.body.modelsPresent, true, 'large cache retained')
    console.log('PASS large archive: size/hash, download, extract, progress, reuse, isolated caches')
  } else console.log('SKIP large archive: set SERA_STT_LARGE_ARCHIVE')
  console.log('PASS model selection: default, validation, persistence, metadata, disabled selection')
} finally {
  if (previous === undefined) delete process.env.SERA_STT_MODEL_DIR
  else process.env.SERA_STT_MODEL_DIR = previous
  fs.rmSync(tmp, { recursive: true, force: true })
}
