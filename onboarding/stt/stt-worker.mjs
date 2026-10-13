// Forked child that owns sherpa-onnx-node + the Korean streaming Zipformer.
// Spawned by engine.cjs (child_process.fork, serialization 'advanced',
// ELECTRON_RUN_AS_NODE=1 under Electron). One OnlineRecognizer, one stream per
// session id; audio is Float32 16 kHz mono PCM.
// argv: <modelDir> <threads>
// in:  { op: 'load', id } | { op: 'start', sid } | { op: 'audio', sid, pcm: Float32Array } | { op: 'stop', sid } | { op: 'cancel', sid }
// out: { id, ok, error? } for load; { sid, type: 'partial' | 'final', text } ; { sid, type: 'done', text } after stop; { sid?, type: 'error', error }
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ENCODER, DECODER, JOINER, TOKENS, SAMPLE_RATE } = require('./manifest.cjs')
const [modelDir, threadsArg] = process.argv.slice(2)
const threads = Math.max(1, Number(threadsArg) || 2)
let recognizer = null
const streams = new Map() // sid -> { stream, last }

function load() {
  if (recognizer) return recognizer
  const sherpa = require('sherpa-onnx-node')
  const p = f => path.join(modelDir, f)
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { transducer: { encoder: p(ENCODER), decoder: p(DECODER), joiner: p(JOINER) }, tokens: p(TOKENS), numThreads: threads, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  })
  return recognizer
}

const send = m => { try { process.send(m) } catch {} }

function drain(sid, s) {
  const r = recognizer
  while (r.isReady(s.stream)) r.decode(s.stream)
  const text = r.getResult(s.stream).text.trim()
  if (r.isEndpoint(s.stream)) {
    if (text) send({ sid, type: 'final', text })
    r.reset(s.stream); s.last = ''
    return
  }
  if (text !== s.last) { s.last = text; send({ sid, type: 'partial', text }) }
}

function handle(msg) {
  if (msg.op === 'load') { load(); return send({ id: msg.id, ok: true }) }
  const r = load()
  if (msg.op === 'start') { streams.set(msg.sid, { stream: r.createStream(), last: '' }); return }
  const s = streams.get(msg.sid)
  if (!s) return send({ sid: msg.sid, type: 'error', error: 'unknown session' })
  if (msg.op === 'audio') {
    s.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: msg.pcm })
    return drain(msg.sid, s)
  }
  if (msg.op === 'stop') {
    // Half a second of tail silence lets the last chunk through the encoder.
    s.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(SAMPLE_RATE / 2) })
    s.stream.inputFinished()
    while (r.isReady(s.stream)) r.decode(s.stream)
    const text = r.getResult(s.stream).text.trim()
    streams.delete(msg.sid)
    return send({ sid: msg.sid, type: 'done', text })
  }
  if (msg.op === 'cancel') { streams.delete(msg.sid); return }
  send({ sid: msg.sid, type: 'error', error: `unknown op ${msg.op}` })
}

process.on('message', msg => {
  try { handle(msg) } catch (e) {
    const error = e?.message || String(e)
    if (msg.id) send({ id: msg.id, ok: false, error })
    else send({ sid: msg.sid, type: 'error', error })
  }
})
process.on('disconnect', () => process.exit(0))
