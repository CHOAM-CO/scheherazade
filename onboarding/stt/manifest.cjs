'use strict'
// Korean streaming STT: kangkyu Zipformer, int8, left context 128.
// Default 72M/chunk-16 or optional 174M/chunk-32, sherpa-onnx OnlineRecognizer.
// Sera ships none of these bytes; first enable fetches one sha256-pinned tarball
// from the models-v1 release, extracts it into userData/models/stt-ko and checks
// each file's sha256 too. SERA_STT_MODEL_DIR overrides the directory (dev/tests).
const SERA_STT_MODEL_URL = 'https://github.com/CHOAM-CO/scheherazade-releases/releases/download/models-v1/sera-stt-ko-72m-int8.tar.gz'
const ARCHIVE = {
  name: 'sera-stt-ko-72m-int8.tar.gz',
  size: 58590777,
  sha256: 'cbcfd9b41cdd66145b3d84d5c803860ebeda55fbb89505985d3e152e31e19505',
  url: SERA_STT_MODEL_URL,
}
const ENCODER = 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'
const DECODER = 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'
const JOINER = 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx'
const TOKENS = 'tokens.txt'
const FILES = [
  [ENCODER, 70133869, '5f2b6e5e92834849cfdbda3aaa355e6f39ff993f067794e4ab9d5cb993b15311'],
  [DECODER, 1544210, '40c3c57ad27b45b59e27bec8bfc02f04d27c060aeb8e964ae2f87bd9f356bf7d'],
  [JOINER, 1270777, '7d3bd9c1e9cf60efa5d5fed728fbd52d0f08139775f9e9002fd088b4d78f3e73'],
  [TOKENS, 20844, '435dfb9e0a2b6a79124f1a4d8f0f33a951b25384726e2e0d854f081533e6ec9d'],
].map(([rel, size, sha256]) => ({ rel, size, sha256 }))
const TOTAL_BYTES = ARCHIVE.size // what the user downloads
const SAMPLE_RATE = 16000
const CREDIT = 'k2-fsa Zipformer Korean streaming (sherpa-onnx) · Apache-2.0'
const small = { id: '72m', label: 'Small · 72M', cacheName: 'stt-ko', chunkSize: 16, SERA_STT_MODEL_URL, ARCHIVE, FILES, ENCODER, DECODER, JOINER, TOKENS, TOTAL_BYTES, SAMPLE_RATE, CREDIT }
const largeFiles = [
  ['encoder', 156838446, 'd07cbf5198c8c6d41108cc9c9e057b0a3591846867b6a4d2e283add3bbb84413'],
  ['decoder', 1544210, 'f5dfa6c8609b29da86c739d4904889475c33b62e28e70c619952a0ee6c31416f'],
  ['joiner', 1270777, '64efd9aeb71fb2278c713b3d5eb5ec45edf6b2ccd8716d3709044f17723c13fd'],
].map(([part, size, sha256]) => ({ rel: `${part}-epoch-99-avg-1-chunk-32-left-128.int8.onnx`, size, sha256 }))
largeFiles.push(FILES.find(f => f.rel === TOKENS))
const largeArchive = {
  name: 'sera-stt-ko-174m-chunk-32-int8.tar.gz',
  size: 125054164,
  sha256: '59be47ede61680bcbb370d2964cd3a4a909cb905e41b36077d15383c27357628',
  url: 'https://github.com/CHOAM-CO/scheherazade-releases/releases/download/models-v1/sera-stt-ko-174m-chunk-32-int8.tar.gz',
}
const large = { ...small, id: '174m', label: 'Large · 174M', cacheName: 'stt-ko-174m-chunk-32', chunkSize: 32,
  ARCHIVE: largeArchive, SERA_STT_MODEL_URL: largeArchive.url, TOTAL_BYTES: largeArchive.size, FILES: largeFiles,
  ENCODER: largeFiles[0].rel, DECODER: largeFiles[1].rel, JOINER: largeFiles[2].rel }
const MODELS = { '72m': small, '174m': large }
function getModel(id = '72m') {
  if (!Object.hasOwn(MODELS, id)) throw new Error(`Unknown STT model: ${id}`)
  return MODELS[id]
}
// Legacy exports stay small so existing callers and installations retain their default.
module.exports = { ...small, MODELS, getModel }
