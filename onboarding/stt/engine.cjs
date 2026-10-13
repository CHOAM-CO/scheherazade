'use strict'
// Korean streaming speech-to-text engine. sherpa-onnx-node and the selected
// Zipformer stay out of the server process in a forked child (stt-worker.mjs),
// started lazily on first use and killed after IDLE_MS without a session.
// createSession(onEvent) -> { push(Float32Array 16 kHz), stop() -> Promise<text>, cancel() }
// onEvent({ type: 'partial' | 'final', text }) while audio streams in; 'final'
// fires on each endpoint (a pause), stop() resolves with the trailing text.
const path = require('node:path')
const crypto = require('node:crypto')
const { fork } = require('node:child_process')

const IDLE_MS = 3 * 60 * 1000

function createEngine(modelDir, { threads = 2, idleMs = IDLE_MS, modelId = '72m' } = {}) {
  let child = null
  let loadPromise = null
  let state = 'idle' // idle | loading | ready | error
  let lastError = null
  let seq = 0
  let idleTimer = null
  const calls = new Map() // id -> { resolve, reject }
  const sessions = new Map() // sid -> { onEvent, done }

  function spawn() {
    const env = { ...process.env }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    // Inside a packaged app the worker must run from app.asar.unpacked (asarUnpack onboarding/stt/**).
    const script = path.join(__dirname, 'stt-worker.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    const c = fork(script, [modelDir, String(threads), modelId], { env, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child = c
    c.on('message', m => {
      if (m.id) { const p = calls.get(m.id); if (!p) return; calls.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(m.error)); return }
      const s = sessions.get(m.sid)
      if (m.type === 'error') { lastError = m.error; if (s) { sessions.delete(m.sid); s.done.reject(new Error(m.error)) } return }
      if (!s) return
      if (m.type === 'done') { sessions.delete(m.sid); s.done.resolve(m.text); armIdle(); return }
      s.onEvent({ type: m.type, text: m.text })
    })
    c.on('exit', code => {
      if (child !== c) return
      const err = new Error(`stt worker exited (${code})`)
      for (const p of calls.values()) p.reject(err)
      for (const s of sessions.values()) s.done.reject(err)
      calls.clear(); sessions.clear(); child = null; loadPromise = null
      if (state !== 'idle') { state = 'error'; lastError = err.message }
    })
  }
  function armIdle() {
    clearTimeout(idleTimer)
    if (sessions.size) return
    idleTimer = setTimeout(() => { if (!sessions.size) close() }, idleMs)
    idleTimer.unref?.()
  }

  function load() {
    clearTimeout(idleTimer)
    if (!loadPromise) {
      if (!child) spawn()
      state = 'loading'; lastError = null
      const id = ++seq
      loadPromise = new Promise((resolve, reject) => { calls.set(id, { resolve, reject }); child.send({ op: 'load', id }) })
        .then(r => { state = 'ready'; armIdle(); return r })
        .catch(e => { state = 'error'; lastError = e.message; loadPromise = null; throw e })
    }
    return loadPromise
  }

  async function createSession(onEvent = () => {}) {
    await load()
    clearTimeout(idleTimer)
    const sid = crypto.randomBytes(8).toString('hex')
    let resolve, reject
    const done = new Promise((a, b) => { resolve = a; reject = b })
    done.catch(() => {})
    sessions.set(sid, { onEvent, done: { resolve, reject } })
    child.send({ op: 'start', sid })
    let open = true
    return {
      id: sid,
      push(pcm) { if (open && child) child.send({ op: 'audio', sid, pcm: pcm instanceof Float32Array ? pcm : new Float32Array(pcm) }) },
      stop() { if (open && child) { open = false; child.send({ op: 'stop', sid }) } return done },
      cancel() { if (!open) return; open = false; sessions.delete(sid); child?.send({ op: 'cancel', sid }); resolve(''); armIdle() },
    }
  }

  function close() {
    clearTimeout(idleTimer)
    if (child) { const c = child; child = null; c.kill() }
    for (const s of sessions.values()) s.done.resolve('')
    sessions.clear(); state = 'idle'; loadPromise = null
  }

  return { load, createSession, close, get state() { return state }, get lastError() { return lastError }, get running() { return !!child } }
}

module.exports = { createEngine, IDLE_MS }
