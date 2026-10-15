'use strict'
// Pocket-TTS Korean 100M, int8 ONNX (one file: flow LM + Mimi decoder + text
// embedding + SentencePiece tokenizer + voice encoder + a baked voice tamura_1 that
// Sera never uses or lists; the shipped default is the bundled 'sera' voice in
// tts/voices/, cloned from a Supertonic 3 synthetic preset).
// Exported 2026-10-13 from seastar105/pocket-tts-korean-100m (korean.yaml) with
// thewh1teagle/pocket-tts-onnx export.py --quantize. Weights: CC BY 4.0
// (Kyutai Pocket-TTS; seastar105 Korean fine-tune). Sera ships none of these
// bytes; first enable fetches the file into userData/models/pocket-ko and
// checks its sha256. SERA_TTS_MODEL_DIR overrides the directory (dev/tests).
const SERA_TTS_MODEL_URL = 'https://github.com/CHOAM-CO/scheherazade-releases/releases/download/models-v1/pocket-tts-ko-100m-int8.onnx'
const FILES = [
  ['pocket-tts-ko-100m-int8.onnx', 226210253, 'd944f9bb99f2aed1207e7ab359fc740716de647196ce23af14d76b40490e880d', SERA_TTS_MODEL_URL],
].map(([rel, size, sha256, url]) => ({ rel, size, sha256, url }))
const MODEL_FILE = FILES[0].rel
const TOTAL_BYTES = FILES.reduce((n, f) => n + f.size, 0)
const DEFAULT_VOICE = 'sera' // bundled conditioning in tts/voices/sera.bin; the voice baked into the .onnx is unused
const CREDIT = 'Pocket-TTS (Kyutai) · Korean 100M (seastar105) · CC BY 4.0'
module.exports = { SERA_TTS_MODEL_URL, FILES, MODEL_FILE, TOTAL_BYTES, DEFAULT_VOICE, CREDIT }
