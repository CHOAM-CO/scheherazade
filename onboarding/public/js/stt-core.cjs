// stt-core.cjs -- pure helpers for voice input (stt.js), shared with tests.
// Same dual-environment contract as tts-core.cjs: a <script> in the page sets
// window.SeraSTTCore; require() in node gets module.exports.
;(function (root) {
  const TARGET_RATE = 16000

  // Streaming downsampler: mic-rate Float32 mono chunks -> 16 kHz Float32.
  // Each output sample is the mean of the input samples it covers (a box
  // filter, enough anti-aliasing for speech recognition). State carries over
  // between chunks so chunk boundaries add no clicks or drift. inRate below
  // the target is linearly interpolated up; equal rates pass through.
  function createDownsampler(inRate, outRate = TARGET_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('bad sample rate')
    const ratio = inRate / outRate
    let carry = new Float32Array(0)
    let pos = 0 // fractional read position into carry
    return function push(chunk) {
      if (inRate === outRate) return Float32Array.from(chunk)
      const buf = new Float32Array(carry.length + chunk.length)
      buf.set(carry); buf.set(chunk, carry.length)
      const out = []
      if (ratio > 1) {
        while (pos + ratio <= buf.length) {
          const a = Math.floor(pos), b = Math.max(a + 1, Math.floor(pos + ratio))
          let s = 0
          for (let i = a; i < b; i++) s += buf[i]
          out.push(s / (b - a))
          pos += ratio
        }
      } else {
        while (pos + 1 < buf.length) {
          const a = Math.floor(pos), t = pos - a
          out.push(buf[a] * (1 - t) + buf[a + 1] * t)
          pos += ratio
        }
      }
      const keep = Math.floor(pos)
      carry = buf.slice(keep)
      pos -= keep
      return Float32Array.from(out)
    }
  }

  // Input-box text while listening: what was there before + committed finals
  // + the live partial. Joined with single spaces, empty parts dropped.
  function composeText(base, finals, partial) {
    return [base, ...finals, partial].map(s => (s || '').trim()).filter(Boolean).join(' ')
  }

  const api = { createDownsampler, composeText, TARGET_RATE }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.SeraSTTCore = api
})(typeof window !== 'undefined' ? window : globalThis)
