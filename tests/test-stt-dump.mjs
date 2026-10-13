#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { writeWav, rotate, createDump } = require('../onboarding/stt/dump.cjs')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sera-stt-dump-'))
const previous = process.env.SERA_STT_DUMP_DIR
const enginePath = require.resolve('../onboarding/stt/engine.cjs')
const modelsPath = require.resolve('../onboarding/stt/models.cjs')
const routesPath = require.resolve('../onboarding/routes/stt.cjs')
const oldEngine = require.cache[enginePath], oldModels = require.cache[modelsPath]
const pcm = Buffer.alloc(28)
;[-2, -1, -0.5, 0, 0.5, 1, 2].forEach((v, i) => pcm.writeFloatLE(v, i * 4))
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('dump did not finish within 2 seconds')
}
try {
  const raw = path.join(tmp, 'sample.f32'), wav = path.join(tmp, 'sample.wav')
  await fs.writeFile(raw, pcm); await writeWav(raw, wav)
  const b = await fs.readFile(wav)
  assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.readUInt32LE(4), b.length - 8)
  assert.equal(b.toString('ascii', 8, 16), 'WAVEfmt ')
  assert.equal(b.readUInt32LE(16), 16); assert.equal(b.readUInt16LE(20), 1)
  assert.equal(b.readUInt16LE(22), 1); assert.equal(b.readUInt32LE(24), 16000)
  assert.equal(b.readUInt32LE(28), 32000); assert.equal(b.readUInt16LE(32), 2)
  assert.equal(b.readUInt16LE(34), 16); assert.equal(b.toString('ascii', 36, 40), 'data')
  assert.equal(b.readUInt32LE(40), 14)
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => b.readInt16LE(44 + i * 2)), [-32768, -32768, -16384, 0, 16384, 32767, 32767])
  const rot = path.join(tmp, 'rotation'); await fs.mkdir(rot)
  const names = Array.from({ length: 55 }, (_, i) => `${new Date(1700000000000 + i * 1000).toISOString().replace(/:/g, '-')}-abc.wav`)
  await Promise.all(names.map(n => fs.writeFile(path.join(rot, n), '')))
  await fs.writeFile(path.join(rot, 'unrelated.wav'), '')
  await rotate(rot)
  assert.deepEqual((await fs.readdir(rot)).sort(), [...names.slice(5), 'unrelated.wav'].sort())
  const errors = []
  const bad = createDump(raw, 'bad', e => errors.push(e)); bad.append(pcm); await bad.close()
  assert(errors.length > 0, 'disk failures logged, close does not reject')
  let seq = 0
  const pushed = []
  require.cache[enginePath] = { exports: { createEngine: () => ({ state: 'ready', close() {}, createSession: async () => ({ id: `sid${++seq}`, push: p => pushed.push([...p]), stop: async () => '', cancel() {} }) }) } }
  require.cache[modelsPath] = { exports: { modelsPresent: () => true, ensureModels: async () => {} } }
  delete require.cache[routesPath]
  const { createRoutes } = require(routesPath)
  const cfg = { STT_ENABLED: 'true' }; let response
  const ctx = { readAgentConfig: () => cfg, writeAgentConfig: v => Object.assign(cfg, v), readJsonBody: async r => r,
    sendJson: (_r, code, body) => { response = { code, body } }, DATA_HOME: tmp,
    getElectron: () => ({ app: { getPath: () => tmp } }), log: e => errors.push(e) }
  delete process.env.SERA_STT_DUMP_DIR
  let routes = createRoutes(ctx)
  const call = async (p, body = {}) => { await routes.find(r => r.match(`/api/stt/${p}`)).handler(body, {}); return response }
  assert.equal((await call('status')).body.dump, false)
  assert.equal(response.body.dumpDir, path.join(tmp, 'stt-dumps'))
  async function start() { return (await call('start')).body.sid }
  async function audio(sid) { const req = Readable.from([pcm]); req.headers = { 'x-stt-session': sid }; assert.equal((await call('audio', req)).code, 200) }
  let sid = await start(); await audio(sid); await call('stop', { sid })
  assert.equal(await fs.stat(path.join(tmp, 'stt-dumps')).then(() => true, () => false), false)
  assert.equal((await call('settings', { dump: 'true' })).code, 400)
  process.env.SERA_STT_DUMP_DIR = path.join(tmp, 'override')
  await call('settings', { dump: true }); assert.equal(cfg.STT_DUMP, 'true')
  routes = createRoutes(ctx); assert.equal((await call('status')).body.dump, true)
  const folder = response.body.dumpDir; assert.equal(folder, process.env.SERA_STT_DUMP_DIR)
  for (const mode of ['stop', 'cancel', 'disable', 'dump-off']) {
    await call('settings', { enabled: true, dump: true })
    sid = await start(); await audio(sid)
    await waitFor(async () => (await fs.readdir(folder)).some(n => n.endsWith(`${sid}.f32`)))
    if (mode === 'disable') await call('settings', { enabled: false })
    else if (mode === 'dump-off') await call('settings', { dump: false })
    else await call('stop', { sid, cancel: mode === 'cancel' })
    await waitFor(async () => { const ns = await fs.readdir(folder); return ns.some(n => n.endsWith(`${sid}.wav`)) && !ns.some(n => n.endsWith(`${sid}.f32`)) })
    const file = (await fs.readdir(folder)).find(n => n.endsWith(`${sid}.wav`))
    assert.deepEqual(await fs.readFile(path.join(folder, file)), b)
    if (mode === 'dump-off') await call('stop', { sid })
  }
  assert.equal(pushed.length, 5)
  assert.deepEqual(pushed[0], [-2, -1, -0.5, 0, 0.5, 1, 2])
  console.log('PASS STT dump: WAV header/samples, rotation, disk failure isolation, default off, settings persistence, directory override, audio fidelity, stop/cancel/disable/toggle-off')
} finally {
  if (previous === undefined) delete process.env.SERA_STT_DUMP_DIR; else process.env.SERA_STT_DUMP_DIR = previous
  delete require.cache[routesPath]
  if (oldEngine) require.cache[enginePath] = oldEngine; else delete require.cache[enginePath]
  if (oldModels) require.cache[modelsPath] = oldModels; else delete require.cache[modelsPath]
  await fs.rm(tmp, { recursive: true, force: true })
}
