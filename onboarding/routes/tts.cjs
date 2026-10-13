'use strict'
// Read-aloud (local Pocket-TTS Korean). The model is NOT bundled: first enable
// fetches one sha256-pinned int8 .onnx (~216 MiB) into userData/models/pocket-ko;
// SERA_TTS_MODEL_DIR overrides the directory (dev/tests). Nothing touches disk at
// route-binding time; the engine (a forked child) starts on the first synth/enable.
const path = require('node:path')
const { ensureModels, modelsPresent } = require('../tts/models.cjs')
const { createEngine } = require('../tts/engine.cjs')
const { MODEL_FILE, DEFAULT_VOICE, TOTAL_BYTES, CREDIT } = require('../tts/manifest.cjs')

const MAX_WAV_BYTES = 30 * 1024 * 1024

function createRoutes(ctx) {
  const { sendJson, readJsonBody, readAgentConfig, writeAgentConfig, getElectron, DATA_HOME, log } = ctx
  let modelDir = null
  function dir() {
    if (modelDir) return modelDir
    if (process.env.SERA_TTS_MODEL_DIR) return (modelDir = process.env.SERA_TTS_MODEL_DIR)
    try { modelDir = path.join(getElectron().app.getPath('userData'), 'models', 'pocket-ko') }
    catch { modelDir = path.join(DATA_HOME, 'models', 'pocket-ko') }
    return modelDir
  }
  let engine = null
  const eng = () => (engine ||= createEngine(path.join(dir(), MODEL_FILE), { voicesDir: path.join(dir(), 'voices') }))
  const download = { state: 'idle', done: 0, total: TOTAL_BYTES, file: null, error: null }

  function startDownload() {
    if (download.state === 'downloading') return
    Object.assign(download, { state: 'downloading', error: null })
    ensureModels(dir(), { onProgress: p => Object.assign(download, p) })
      .then(() => { download.state = 'done'; return eng().load() })
      .catch(e => { download.state = 'error'; download.error = e.message; log?.(`[tts] ${e.message}`) })
  }
  function settings() {
    const cfg = readAgentConfig()
    const voice = cfg.TTS_VOICE && eng().hasVoice(cfg.TTS_VOICE) ? cfg.TTS_VOICE : DEFAULT_VOICE
    return { enabled: cfg.TTS_ENABLED === 'true', voice }
  }
  function status() {
    const present = modelsPresent(dir())
    return { ...settings(), voices: eng().listVoices(), credit: CREDIT, modelsPresent: present, totalBytes: TOTAL_BYTES, download: { ...download }, engine: engine ? engine.state : 'idle', engineError: engine?.lastError || null }
  }

  return [
    { method: 'GET', match: p => p === '/api/tts/status', handler: async (req, res) => sendJson(res, 200, status()) },
    {
      method: 'POST', match: p => p === '/api/tts/settings',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const fields = {}
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be boolean' })
          fields.TTS_ENABLED = String(body.enabled)
        }
        if (body.voice !== undefined) {
          if (typeof body.voice !== 'string' || !eng().hasVoice(body.voice)) return sendJson(res, 400, { error: 'unknown voice' })
          fields.TTS_VOICE = body.voice
        }
        if (Object.keys(fields).length) writeAgentConfig(fields)
        if (settings().enabled) {
          if (!modelsPresent(dir())) startDownload()
          else eng().load().catch(() => {})
        }
        sendJson(res, 200, status())
      },
    },
    {
      // Add a voice from a reference wav: { name, wavBase64 }. Clones in the worker
      // (needs the model), stores the conditioning, returns the new status.
      method: 'POST', match: p => p === '/api/tts/voices',
      handler: async (req, res) => {
        const body = await readJsonBody(req, Math.ceil(MAX_WAV_BYTES * 1.4) + 4096)
        if (typeof body.wavBase64 !== 'string' || !body.wavBase64) return sendJson(res, 400, { error: 'wavBase64 required' })
        if (!modelsPresent(dir())) return sendJson(res, 409, { error: 'models not downloaded' })
        const wav = Buffer.from(body.wavBase64, 'base64')
        if (wav.length > MAX_WAV_BYTES) return sendJson(res, 413, { error: 'wav too large' })
        try {
          const voice = await eng().addVoice(body.name, wav)
          writeAgentConfig({ TTS_VOICE: voice.id })
          sendJson(res, 200, { added: voice, ...status() })
        } catch (e) { sendJson(res, 400, { error: e.message }) }
      },
    },
    {
      method: 'POST', match: p => p === '/api/tts/voices/delete',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (typeof body.id !== 'string' || body.id === DEFAULT_VOICE || !eng().removeVoice(body.id)) return sendJson(res, 400, { error: 'unknown voice' })
        sendJson(res, 200, status())
      },
    },
    {
      method: 'POST', match: p => p === '/api/tts',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1200) : ''
        if (!text) return sendJson(res, 400, { error: 'text required' })
        if (!modelsPresent(dir())) return sendJson(res, 409, { error: 'models not downloaded' })
        try {
          const t0 = Date.now()
          const voice = typeof body.voice === 'string' && eng().hasVoice(body.voice) ? body.voice : settings().voice
          const wav = await eng().synth(text, voice)
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'x-synth-ms': String(Date.now() - t0) })
          res.end(wav)
        } catch (e) { sendJson(res, 500, { error: e.message }) }
      },
    },
  ]
}

module.exports = { createRoutes }
