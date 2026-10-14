'use strict'
// Pocket-TTS Korean engine. The model (one int8 .onnx) is loaded once, lazily,
// in a forked child (pocket-worker.mjs) so the ~1.5 GB inference footprint and
// onnxruntime stay out of the server process. synth(text, voiceId) -> 24 kHz
// 16-bit mono wav Buffer. Voices: the bundled read-only 'sera' (tts/voices/) plus user
// voices cloned from a wav, cached as raw float32 conditioning in voicesDir.
// The voice baked into the .onnx ('default') is never used or listed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { fork } = require('node:child_process')
const { DEFAULT_VOICE } = require('./manifest.cjs')

const VOICE_ID = /^v[0-9a-f]{12}$/
const BUILTIN_DIR = path.join(__dirname, 'voices')

function createEngine(modelPath, { voicesDir = path.join(path.dirname(modelPath), 'voices'), threads = 2 } = {}) {
  let child = null
  let loadPromise = null
  let state = 'idle' // idle | loading | ready | error
  let lastError = null
  let seq = 0
  const pending = new Map()
  const condCache = new Map()

  function spawn() {
    const env = { ...process.env }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    // Inside a packaged app the worker must run from app.asar.unpacked (asarUnpack onboarding/tts/**).
    const script = path.join(__dirname, 'pocket-worker.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    child = fork(script, [modelPath, String(threads)], { env, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.on('message', m => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(m.error)) })
    child.on('exit', code => {
      const err = new Error(`tts worker exited (${code})`)
      for (const p of pending.values()) p.reject(err)
      pending.clear(); child = null; loadPromise = null
      if (state !== 'idle') { state = 'error'; lastError = err.message }
    })
  }
  function call(msg) {
    if (!child) spawn()
    const id = ++seq
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ ...msg, id }) })
  }

  function load() {
    if (!loadPromise) {
      state = 'loading'; lastError = null
      loadPromise = call({ op: 'load' })
        .then(r => { state = 'ready'; return r })
        .catch(e => { state = 'error'; lastError = e.message; loadPromise = null; throw e })
    }
    return loadPromise
  }

  function readCond(id) {
    if (!condCache.has(id)) {
      const b = fs.readFileSync(path.join(id === DEFAULT_VOICE ? BUILTIN_DIR : voicesDir, `${id}.bin`))
      condCache.set(id, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)))
    }
    return condCache.get(id)
  }
  function listVoices() {
    const out = [{ id: DEFAULT_VOICE, name: 'Sera', builtin: true }]
    let names = []
    try { names = fs.readdirSync(voicesDir) } catch {}
    for (const f of names.filter(n => n.endsWith('.json')).sort()) {
      const id = f.slice(0, -5)
      if (!VOICE_ID.test(id) || !fs.existsSync(path.join(voicesDir, `${id}.bin`))) continue
      try { const meta = JSON.parse(fs.readFileSync(path.join(voicesDir, f), 'utf8')); out.push({ id, name: meta.name || id, createdAt: meta.createdAt }) } catch {}
    }
    return out
  }
  const hasVoice = id => listVoices().some(v => v.id === id)

  async function synth(text, voiceId = DEFAULT_VOICE) {
    await load()
    // Unknown / legacy ids (incl. 'default') fall back to the bundled Sera voice.
    const id = voiceId !== DEFAULT_VOICE && VOICE_ID.test(voiceId) && hasVoice(voiceId) ? voiceId : DEFAULT_VOICE
    const r = await call({ op: 'synth', text, voice: readCond(id), voiceKey: id })
    return Buffer.from(r.wav.buffer, r.wav.byteOffset, r.wav.byteLength)
  }

  // wav: Buffer of a .wav file. Returns the saved voice entry.
  async function addVoice(name, wav) {
    await load()
    const r = await call({ op: 'clone', wav: new Uint8Array(wav) })
    const id = 'v' + crypto.randomBytes(6).toString('hex')
    fs.mkdirSync(voicesDir, { recursive: true })
    fs.writeFileSync(path.join(voicesDir, `${id}.bin`), Buffer.from(r.cond.buffer, r.cond.byteOffset, r.cond.byteLength))
    const meta = { name: String(name || '').trim().slice(0, 40) || id, createdAt: new Date().toISOString(), refSeconds: r.refSeconds }
    fs.writeFileSync(path.join(voicesDir, `${id}.json`), JSON.stringify(meta, null, 2))
    return { id, ...meta }
  }
  function removeVoice(id) {
    if (!VOICE_ID.test(id)) return false
    condCache.delete(id)
    let gone = false
    for (const ext of ['.bin', '.json']) { try { fs.unlinkSync(path.join(voicesDir, id + ext)); gone = true } catch {} }
    return gone
  }

  function close() { if (child) { child.kill(); child = null } state = 'idle'; loadPromise = null }

  return { load, synth, addVoice, removeVoice, listVoices, hasVoice, close, get state() { return state }, get lastError() { return lastError } }
}

module.exports = { createEngine }
