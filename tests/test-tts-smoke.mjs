#!/usr/bin/env node
// test-tts-smoke.mjs -- real Pocket-TTS Korean synth + voice clone through
// onboarding/tts/engine.cjs (forked worker). Needs the model: SERA_TTS_MODEL_DIR
// holding pocket-tts-ko-100m-int8.onnx, or SERA_TTS_MODEL_FILE pointing at the
// .onnx itself (any name; size+sha are checked here). Prints a column-0 SKIP
// otherwise. SERA_TTS_REF_WAV = reference wav for the clone case (skipped if
// unset). SERA_TTS_OUT_DIR keeps the wavs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(path.join(ROOT, 'package.json'))
const { createEngine } = req(path.join(ROOT, 'onboarding/tts/engine.cjs'))
const { FILES, MODEL_FILE } = req(path.join(ROOT, 'onboarding/tts/manifest.cjs'))

const modelPath = process.env.SERA_TTS_MODEL_FILE || (process.env.SERA_TTS_MODEL_DIR && path.join(process.env.SERA_TTS_MODEL_DIR, MODEL_FILE))
if (!modelPath || !fs.existsSync(modelPath) || fs.statSync(modelPath).size !== FILES[0].size) {
  console.log(`SKIP: no Pocket-TTS Korean model (set SERA_TTS_MODEL_DIR or SERA_TTS_MODEL_FILE)`); process.exit(0)
}
const outDir = process.env.SERA_TTS_OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sera-tts-smoke-'))
fs.mkdirSync(outDir, { recursive: true })
const voicesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-tts-voices-'))

let fail = 0
const check = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'} ${msg}`); if (!cond) fail++ }
const secsOf = wav => (wav.length - 44) / 2 / wav.readUInt32LE(24)

const sha = crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex')
check(sha === FILES[0].sha256, `model sha256 matches manifest (${sha.slice(0, 12)})`)

const engine = createEngine(modelPath, { voicesDir })
const TEXT = '안녕, 나 세라야. 오늘 뭐 할까?'
try {
  let t0 = Date.now()
  await engine.load()
  console.log(`  load ${Date.now() - t0} ms (forked worker, 2 threads)`)
  async function say(tag, voice) {
    const runs = []
    let wav
    for (let i = 0; i < 2; i++) { t0 = Date.now(); wav = await engine.synth(TEXT, voice); runs.push(Date.now() - t0) }
    const file = path.join(outDir, `sera-ko-${tag}.wav`)
    fs.writeFileSync(file, wav)
    const secs = secsOf(wav)
    check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 24000 && wav.readUInt16LE(34) === 16, `${tag}: RIFF 24 kHz 16-bit`)
    check(wav.length > 50 * 1024, `${tag}: ${wav.length} bytes > 50 KB`)
    check(secs >= 2 && secs <= 8, `${tag}: ${secs.toFixed(2)} s audio in 2-8 s; synth ${runs.join(' / ')} ms (first/warm) -> ${file}`)
  }
  await say('sera', 'sera')
  const ref = process.env.SERA_TTS_REF_WAV
  if (!ref || !fs.existsSync(ref)) console.log('  SKIP clone: set SERA_TTS_REF_WAV')
  else {
    t0 = Date.now()
    const v = await engine.addVoice('tamura_2', fs.readFileSync(ref))
    console.log(`  clone ${Date.now() - t0} ms from ${path.basename(ref)} (${v.refSeconds.toFixed(1)} s ref)`)
    const list = engine.listVoices()
    check(list.length === 2 && list[0].id === 'sera' && list[1].id === v.id && list[1].name === 'tamura_2', `voice saved + listed (${v.id})`)
    check(fs.statSync(path.join(voicesDir, `${v.id}.bin`)).size % (1024 * 4) === 0, 'conditioning .bin is T x 1024 float32')
    await say('clone-tamura_2', v.id)
    // A fresh engine (new worker) must reuse the saved conditioning without cloning.
    engine.close()
    const e2 = createEngine(modelPath, { voicesDir })
    const w2 = await e2.synth(TEXT, v.id)
    check(secsOf(w2) >= 2, `saved voice reloads in a new worker (${secsOf(w2).toFixed(2)} s)`)
    check(e2.removeVoice(v.id) && e2.listVoices().length === 1, 'voice removed')
    e2.close()
  }
  let bad = null
  try { await engine.addVoice('x', Buffer.from('not a wav at all, definitely not')) } catch (e) { bad = e.message }
  check(bad && /wav/.test(bad), `non-wav clone rejected (${bad})`)
} finally { engine.close(); fs.rmSync(voicesDir, { recursive: true, force: true }) }
process.exit(fail ? 1 : 0)
