// Forked child that owns onnxruntime-node + the Pocket-TTS Korean model.
// Spawned by engine.cjs (child_process.fork, serialization 'advanced',
// ELECTRON_RUN_AS_NODE=1 under Electron). One request at a time.
// argv: <modelPath> <threads>
// in:  { id, op: 'load' } | { id, op: 'synth', text, voice: string | Float32Array, voiceKey } | { id, op: 'clone', wav: Uint8Array }
// out: { id, ok: true, ... } | { id, ok: false, error }
import fs from 'node:fs'
import * as ort from 'onnxruntime-node'
import { readOnnxMetadata } from './pocket/onnxMeta.js'
import { PocketTTS } from './pocket/tts.js'
import { encodeWav } from './pocket/wav.js'
import { resample } from './pocket/audio.js'

const [modelPath, threadsArg] = process.argv.slice(2)
const threads = Math.max(1, Number(threadsArg) || 2)
let ttsPromise = null
const cloned = new Map() // voiceKey -> Float32Array (same identity => prefill cache hit)

function load() {
  return (ttsPromise ||= (async () => {
    const buf = fs.readFileSync(modelPath)
    const md = readOnnxMetadata(buf)
    const voices = {}
    for (const [k, v] of Object.entries(md)) if (k.startsWith('pocket_tts_voice/')) voices[k.slice(17)] = v
    const assets = { config: JSON.parse(md.pocket_tts_config), tokenizer: md.pocket_tts_tokenizer, voices }
    const so = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 }
    const tts = new PocketTTS(await ort.InferenceSession.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), so), assets)
    if (md.pocket_tts_encoder) tts.encoder = await ort.InferenceSession.create(new Uint8Array(Buffer.from(md.pocket_tts_encoder, 'base64')), so)
    return tts
  })())
}

export function readWav(b) {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav file')
  let o = 12, fmt, data
  while (o <= b.length - 8) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    if (id === 'fmt ' && fmt.tag === 0xfffe && n >= 40) fmt.tag = b.readUInt16LE(o + 32) // WAVE_FORMAT_EXTENSIBLE subformat
    if (id === 'data') { data = b.subarray(o + 8, Math.min(b.length, o + 8 + n)); break }
    o += 8 + n + (n & 1)
  }
  if (!fmt || !data) throw new Error('wav has no fmt/data chunk')
  const bps = fmt.bits / 8
  if (![1, 3].includes(fmt.tag) || ![16, 24, 32].includes(fmt.bits)) throw new Error(`unsupported wav format (tag ${fmt.tag}, ${fmt.bits}-bit)`)
  const fr = Math.floor(data.length / bps / fmt.ch), m = new Float32Array(fr)
  for (let i = 0; i < fr; i++) {
    let s = 0
    for (let c = 0; c < fmt.ch; c++) {
      const q = (i * fmt.ch + c) * bps
      s += fmt.tag === 3 ? data.readFloatLE(q) : fmt.bits === 16 ? data.readInt16LE(q) / 32768 : fmt.bits === 24 ? data.readIntLE(q, 3) / 8388608 : data.readInt32LE(q) / 2147483648
    }
    m[i] = s / fmt.ch
  }
  return { samples: m, sr: fmt.sr }
}

async function handle(msg) {
  const tts = await load()
  if (msg.op === 'load') return { voices: tts.voices, sampleRate: tts.sampleRate }
  if (msg.op === 'synth') {
    let voice = msg.voice
    if (voice === 'default' || typeof voice === 'string' || voice == null) throw new Error('the baked default voice is not available; send a conditioning Float32Array')
    if (voice instanceof Float32Array) {
      if (!cloned.has(msg.voiceKey)) cloned.set(msg.voiceKey, voice)
      voice = cloned.get(msg.voiceKey)
    }
    const audio = await tts.speak({ text: msg.text, voice, seed: 0 })
    return { wav: encodeWav(audio, tts.sampleRate), seconds: audio.length / tts.sampleRate }
  }
  if (msg.op === 'clone') {
    const { samples, sr } = readWav(Buffer.from(msg.wav.buffer, msg.wav.byteOffset, msg.wav.byteLength))
    if (samples.length < sr * 2) throw new Error('reference wav is shorter than 2 s')
    const cond = await tts.cloneVoice(resample(samples, sr, tts.sampleRate))
    return { cond: new Float32Array(cond), refSeconds: samples.length / sr }
  }
  throw new Error(`unknown op ${msg.op}`)
}

let chain = Promise.resolve()
process.on('message', msg => {
  chain = chain.then(() => handle(msg))
    .then(r => process.send({ id: msg.id, ok: true, ...r }), e => process.send({ id: msg.id, ok: false, error: e?.message || String(e) }))
})
process.on('disconnect', () => process.exit(0))
