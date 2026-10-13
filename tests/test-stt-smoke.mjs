#!/usr/bin/env node
// test-stt-smoke.mjs -- real Korean streaming recognition through
// onboarding/stt/engine.cjs (forked sherpa-onnx worker). Needs the model:
// SERA_STT_MODEL_DIR holding the four pinned files (sizes+sha checked here),
// SERA_STT_MODEL selects 72m (default) or 174m,
// and a 16 kHz mono wav saying "안녕, 나 세라야..." in SERA_STT_WAV. Both
// default to the voice-input spike scratchpad when it exists. Prints a column-0
// SKIP otherwise.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(path.join(ROOT, 'package.json'))
const { createEngine } = req(path.join(ROOT, 'onboarding/stt/engine.cjs'))
const modelId = process.env.SERA_STT_MODEL || '72m'
const { FILES } = req(path.join(ROOT, 'onboarding/stt/manifest.cjs')).getModel(modelId)
const { modelsPresent } = req(path.join(ROOT, 'onboarding/stt/models.cjs'))

const SPIKE = '/private/tmp/claude-501/-Users-narr-Desktop-MAGI/3b70b6c6-8c17-4a59-a884-b3519d3c1ec9/scratchpad/stt-ko'
const modelDir = process.env.SERA_STT_MODEL_DIR || path.join(SPIKE, 'models/k72')
const wavPath = process.env.SERA_STT_WAV || path.join(SPIKE, 'wav/a.wav')
if (!modelsPresent(modelDir, modelId) || !fs.existsSync(wavPath)) {
  console.log('SKIP: no Korean STT model or test wav (set SERA_STT_MODEL_DIR and SERA_STT_WAV)'); process.exit(0)
}

let fail = 0
const check = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'} ${msg}`); if (!cond) fail++ }
for (const f of FILES) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(modelDir, f.rel))).digest('hex')
  check(sha === f.sha256, `${f.rel} sha256 matches manifest (${sha.slice(0, 8)})`)
}

// 16-bit PCM mono wav -> Float32 (the fixture format).
function readWav16(b) {
  let o = 12, sr = 0, ch = 0, bits = 0, data = null
  while (o <= b.length - 8) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4)
    if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22) }
    if (id === 'data') { data = b.subarray(o + 8, Math.min(b.length, o + 8 + n)); break }
    o += 8 + n + (n & 1)
  }
  if (!data || bits !== 16 || ch !== 1) throw new Error('fixture must be 16-bit mono wav')
  const f = new Float32Array(data.length / 2)
  for (let i = 0; i < f.length; i++) f[i] = data.readInt16LE(i * 2) / 32768
  return { samples: f, sr }
}

const { samples, sr } = readWav16(fs.readFileSync(wavPath))
check(sr === 16000, `fixture is 16 kHz (${path.basename(wavPath)}, ${(samples.length / sr).toFixed(2)} s)`)
const engine = createEngine(modelDir, { idleMs: 500, modelId })
try {
  let t0 = Date.now()
  await engine.load()
  console.log(`  load ${Date.now() - t0} ms (forked worker, 2 threads)`)
  const partials = []
  const finals = []
  t0 = Date.now()
  let firstAt = null
  const s = await engine.createSession(ev => {
    if (firstAt === null) firstAt = Date.now() - t0
    ;(ev.type === 'final' ? finals : partials).push(ev.text)
  })
  // Paced like the renderer: 100 ms chunks at real time (fast-forwarded 4x).
  for (let i = 0; i < samples.length; i += 1600) {
    s.push(samples.slice(i, i + 1600))
    await new Promise(r => setTimeout(r, 25))
  }
  const tail = await s.stop()
  const text = [...finals, tail].filter(Boolean).join(' ')
  console.log(`  transcript: ${text}`)
  check(partials.length >= 3, `${partials.length} partials streamed, first after ${firstAt} ms`)
  check(text.includes('세라'), 'transcript contains "세라"')
  // A second session on the same worker works (stream reset per session).
  const s2 = await engine.createSession()
  for (let i = 0; i < samples.length; i += 16000) s2.push(samples.slice(i, i + 16000))
  check((await s2.stop()).includes('세라'), 'second session on the same worker')
  const s3 = await engine.createSession()
  s3.cancel()
  await new Promise(r => setTimeout(r, 900))
  check(!engine.running && engine.state === 'idle', 'idle worker killed after idleMs')
  const s4 = await engine.createSession()
  s4.push(samples.slice(0, 32000))
  check(engine.running && typeof (await s4.stop()) === 'string', 'worker respawns lazily after idle kill')
} finally { engine.close() }

// Route layer over real HTTP: settings gate, session, Float32LE chunks, stop.
{
  const http = await import('node:http')
  const cfg = { STT_MODEL: modelId }
  const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const readJsonBody = r => new Promise(ok => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => ok(b ? JSON.parse(b) : {})) })
  process.env.SERA_STT_MODEL_DIR = modelDir
  const routes = req(path.join(ROOT, 'onboarding/routes/stt.cjs')).createRoutes({ sendJson, readJsonBody, readAgentConfig: () => cfg, writeAgentConfig: f => Object.assign(cfg, f), getElectron: () => { throw new Error('no electron') }, DATA_HOME: '/nonexistent' })
  const srv = http.createServer((rq, rs) => { const p = new URL(rq.url, 'http://x').pathname; const r = routes.find(x => x.method === rq.method && x.match(p)); r ? r.handler(rq, rs) : sendJson(rs, 404, {}) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const post = (u, body, headers = { 'content-type': 'application/json' }) => fetch(base + u, { method: 'POST', headers, body: typeof body === 'string' ? body : body instanceof Uint8Array ? body : JSON.stringify(body) })
  try {
    check((await post('/api/stt/start', {})).status === 409, 'route: start refused while STT_ENABLED is off')
    const st = await (await post('/api/stt/settings', { enabled: true })).json()
    check(cfg.STT_ENABLED === 'true' && st.enabled && st.modelsPresent && st.download.state === 'idle', 'route: enable writes STT_ENABLED, no download when present')
    check(st.modelId === modelId, 'route: persisted model selection used')
    check((await post('/api/stt/settings', { modelId: 'invalid', enabled: false })).status === 400 && cfg.STT_ENABLED === 'true', 'route: invalid model does not mutate settings')
    const { sid } = await (await post('/api/stt/start', {})).json()
    check((await post('/api/stt/settings', { modelId: modelId === '72m' ? '174m' : '72m' })).status === 409, 'route: model switching blocked during active recognition')
    let partial = ''
    for (let i = 0; i < samples.length; i += 1600) {
      const c = samples.slice(i, i + 1600)
      const r = await (await post('/api/stt/audio', new Uint8Array(c.buffer), { 'content-type': 'application/octet-stream', 'x-stt-session': sid })).json()
      if (r.partial) partial = r.partial
      await new Promise(r => setTimeout(r, 25))
    }
    const done = await (await post('/api/stt/stop', { sid })).json()
    console.log(`  route transcript: ${done.text}`)
    check(partial.length > 0 && done.text.includes('세라'), 'route: partials over HTTP, final text contains "세라"')
    check((await post('/api/stt/audio', new Uint8Array(4), { 'content-type': 'application/octet-stream', 'x-stt-session': sid })).status === 404, 'route: stopped session is gone')
    await post('/api/stt/settings', { enabled: false })
  } finally { srv.close() }
}
process.exit(fail ? 1 : 0)
