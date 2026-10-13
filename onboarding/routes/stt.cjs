'use strict'
// Voice input (local Korean streaming STT). The model is NOT bundled: first
// enable fetches one sha256-pinned tarball (~56 MiB) into userData/models/stt-ko;
// SERA_STT_MODEL_DIR overrides the directory (dev/tests). Nothing touches disk at
// route-binding time; the engine (a forked child) starts on the first session.
//
// Transport is the same plain fetch() every other route uses (no WebSocket in
// this server): the renderer opens a session, POSTs ~100 ms Float32LE 16 kHz
// PCM chunks as application/octet-stream, and each reply carries the newest
// partial plus any finals (endpoints) since the previous reply.
const path = require('node:path')
const { ensureModels, modelsPresent } = require('../stt/models.cjs')
const { createEngine } = require('../stt/engine.cjs')
const { TOTAL_BYTES, CREDIT } = require('../stt/manifest.cjs')

const MAX_CHUNK_BYTES = 16000 * 4 * 10 // 10 s of audio per POST
const SESSION_IDLE_MS = 30 * 1000

function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) { reject(new Error(`request body exceeds ${limitBytes} bytes`)); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function createRoutes(ctx) {
  const { sendJson, readJsonBody, readAgentConfig, writeAgentConfig, getElectron, DATA_HOME, log } = ctx
  let modelDir = null
  function dir() {
    if (modelDir) return modelDir
    if (process.env.SERA_STT_MODEL_DIR) return (modelDir = process.env.SERA_STT_MODEL_DIR)
    try { modelDir = path.join(getElectron().app.getPath('userData'), 'models', 'stt-ko') }
    catch { modelDir = path.join(DATA_HOME, 'models', 'stt-ko') }
    return modelDir
  }
  let engine = null
  const eng = () => (engine ||= createEngine(dir()))
  const download = { state: 'idle', done: 0, total: TOTAL_BYTES, file: null, error: null }
  const sessions = new Map() // sid -> { s, partial, finals, touched }

  function startDownload() {
    if (download.state === 'downloading') return
    Object.assign(download, { state: 'downloading', error: null })
    ensureModels(dir(), { onProgress: p => Object.assign(download, p) })
      .then(() => { download.state = 'done' })
      .catch(e => { download.state = 'error'; download.error = e.message; log?.(`[stt] ${e.message}`) })
  }
  const enabled = () => readAgentConfig().STT_ENABLED === 'true'
  function status() {
    return { enabled: enabled(), credit: CREDIT, modelsPresent: modelsPresent(dir()), totalBytes: TOTAL_BYTES, download: { ...download }, engine: engine ? engine.state : 'idle', engineError: engine?.lastError || null }
  }
  function sweep() {
    const now = Date.now()
    for (const [sid, x] of sessions) if (now - x.touched > SESSION_IDLE_MS) { x.s.cancel(); sessions.delete(sid) }
  }
  function drainOut(x) { const finals = x.finals.splice(0); return { partial: x.partial, finals } }

  return [
    { method: 'GET', match: p => p === '/api/call', handler: async (_req, res) => {
      const c = readAgentConfig(); sendJson(res, 200, { enabled: c.CALL_ENABLED === 'true' && c.STT_ENABLED === 'true' && c.TTS_ENABLED === 'true', allowed: c.STT_ENABLED === 'true' && c.TTS_ENABLED === 'true' })
    } },
    { method: 'POST', match: p => p === '/api/call', handler: async (req, res) => {
      const b = await readJsonBody(req), c = readAgentConfig()
      if (typeof b.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be boolean' })
      if (b.enabled && (c.STT_ENABLED !== 'true' || c.TTS_ENABLED !== 'true')) return sendJson(res, 409, { error: 'Enable read aloud and voice input first' })
      writeAgentConfig({ CALL_ENABLED: String(b.enabled) }); sendJson(res, 200, { enabled: b.enabled })
    } },
    { method: 'GET', match: p => p === '/api/stt/status', handler: async (req, res) => sendJson(res, 200, status()) },
    {
      method: 'POST', match: p => p === '/api/stt/settings',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be boolean' })
          writeAgentConfig({ STT_ENABLED: String(body.enabled) })
        }
        if (enabled() && !modelsPresent(dir())) startDownload()
        if (!enabled() && engine) { for (const x of sessions.values()) x.s.cancel(); sessions.clear(); engine.close() }
        sendJson(res, 200, status())
      },
    },
    {
      method: 'POST', match: p => p === '/api/stt/start',
      handler: async (req, res) => {
        await readJsonBody(req)
        if (!enabled()) return sendJson(res, 409, { error: 'voice input is off' })
        if (!modelsPresent(dir())) return sendJson(res, 409, { error: 'models not downloaded' })
        sweep()
        try {
          const x = { partial: '', finals: [], touched: Date.now() }
          x.s = await eng().createSession(ev => {
            if (ev.type === 'final') { x.finals.push(ev.text); x.partial = '' } else x.partial = ev.text
          })
          sessions.set(x.s.id, x)
          sendJson(res, 200, { sid: x.s.id, sampleRate: 16000 })
        } catch (e) { sendJson(res, 500, { error: e.message }) }
      },
    },
    {
      // Body: raw Float32 little-endian 16 kHz mono PCM. Header X-STT-Session: sid.
      method: 'POST', match: p => p === '/api/stt/audio',
      handler: async (req, res) => {
        const x = sessions.get(String(req.headers['x-stt-session'] || ''))
        if (!x) return sendJson(res, 404, { error: 'unknown session' })
        const buf = await readRawBody(req, MAX_CHUNK_BYTES)
        if (buf.length % 4) return sendJson(res, 400, { error: 'body must be Float32 PCM' })
        x.touched = Date.now()
        const pcm = new Float32Array(buf.length / 4)
        for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readFloatLE(i * 4)
        if (pcm.length) x.s.push(pcm)
        sendJson(res, 200, drainOut(x))
      },
    },
    {
      method: 'POST', match: p => p === '/api/stt/stop',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const x = sessions.get(String(body.sid || ''))
        if (!x) return sendJson(res, 404, { error: 'unknown session' })
        sessions.delete(body.sid)
        if (body.cancel === true) { x.s.cancel(); return sendJson(res, 200, { finals: [], text: '' }) }
        try {
          const tail = await x.s.stop()
          const { finals } = drainOut(x)
          if (tail) finals.push(tail)
          sendJson(res, 200, { finals, text: finals.join(' ') })
        } catch (e) { sendJson(res, 500, { error: e.message }) }
      },
    },
  ]
}

module.exports = { createRoutes, readRawBody }
