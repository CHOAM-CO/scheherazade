'use strict'
// Korean streaming speech-to-text: k2-fsa Zipformer transducer, 72M params, int8
// ONNX (chunk 16, left context 128), run by sherpa-onnx-node's OnlineRecognizer.
// Sera ships none of these bytes; first enable fetches one sha256-pinned tarball
// from the models-v1 release, extracts it into userData/models/stt-ko and checks
// each file's sha256 too. SERA_STT_MODEL_DIR overrides the directory (dev/tests).
const SERA_STT_MODEL_URL = 'https://github.com/Mino-is-me/scheherazade-releases/releases/download/models-v1/sera-stt-ko-72m-int8.tar.gz'
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
module.exports = { SERA_STT_MODEL_URL, ARCHIVE, FILES, ENCODER, DECODER, JOINER, TOKENS, TOTAL_BYTES, SAMPLE_RATE, CREDIT }
