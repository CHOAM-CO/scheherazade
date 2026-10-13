'use strict'
// companion-orb.cjs -- the "sound only" companion presenter (design-0027).
// A canvas ring that breathes when idle, deforms with Sera's real TTS audio
// (AnalyserNode on the companion's own <audio> element) and shows orbiting
// dots while the mic listens. Ported from the voice-orb mock; the clip switcher
// and demo audio are gone. Pure math is exported for node tests; the canvas
// part runs only in the browser (window.SeraCompanionOrb).
;(function (root) {
  const N = 128
  const lerp = (a, b, t) => a + (b - a) * t

  // RMS of byte time-domain samples (128 = silence), scaled so speech sits near 1.
  function rms(td) {
    if (!td || !td.length) return 0
    let s = 0
    for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s += v * v }
    return Math.min(1, Math.sqrt(s / td.length) * 3.2)
  }
  // Mean byte magnitude of bins [from, to) as 0..1.
  function band(fd, from, to) {
    if (!fd || !fd.length) return 0
    const end = Math.min(to, fd.length)
    if (end <= from) return 0
    let s = 0
    for (let i = from; i < end; i++) s += fd[i]
    return s / (end - from) / 255
  }
  // Per-frame targets from one analyser read. lo = bins 1-20 (body of the
  // voice), hi = bins 60-200 (sibilants); tilt = hi relative to lo, which is
  // what shifts the hue.
  function measure(td, fd) {
    const amp = rms(td)
    const lo = band(fd, 1, 20)
    const hi = Math.min(1, band(fd, 60, 200) * 3)
    return { amp, lo, hi, tilt: Math.max(-1, Math.min(1, hi - lo)) }
  }
  // State -> smoothed values. All transitions are lerped so states cross-fade.
  function step(prev, { state, sample, reduced }) {
    const speaking = state === 'speaking' && !reduced
    const m = speaking && sample ? sample : { amp: 0, lo: 0, hi: 0 }
    return {
      amp: lerp(prev.amp, m.amp, 0.22),
      lo: lerp(prev.lo, m.lo, 0.18),
      hi: lerp(prev.hi, m.hi, 0.18),
      act: lerp(prev.act, speaking ? 1 : 0, 0.08),
      lis: lerp(prev.lis, state === 'listening' && !reduced ? 1 : 0, 0.06),
      dim: lerp(prev.dim, state === 'off' ? 0.25 : 1, 0.08),
    }
  }
  const initial = () => ({ amp: 0, lo: 0, hi: 0, act: 0, lis: 0, dim: 1 })
  const hueOf = v => 235 + v.hi * 70 - v.lo * 20

  // Browser presenter. getAnalyser() returns the AnalyserNode or null (no audio
  // played yet: no AudioContext exists until the first clip, so an orb that
  // never speaks never creates one). getState() -> off|idle|speaking|listening.
  function createOrb(canvas, { getAnalyser, getState }) {
    const g = canvas.getContext('2d')
    const reducedQuery = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false }
    const lightQuery = root.matchMedia ? root.matchMedia('(prefers-color-scheme: light)') : { matches: false }
    let v = initial(), ring = new Float32Array(N), td = null, fd = null, raf = 0, W = 0, dpr = 1
    function size() { dpr = Math.min(root.devicePixelRatio || 1, 2); W = canvas.clientWidth || 200; canvas.width = canvas.height = Math.round(W * dpr) }
    function frame(t) {
      raf = 0
      if (document.hidden) return
      const state = getState()
      const reduced = reducedQuery.matches
      const an = getAnalyser()
      let sample = null
      if (an && state === 'speaking' && !reduced) {
        if (!td || td.length !== an.fftSize) { td = new Uint8Array(an.fftSize); fd = new Uint8Array(an.frequencyBinCount) }
        an.getByteTimeDomainData(td); an.getByteFrequencyData(fd)
        sample = measure(td, fd)
      }
      v = step(v, { state, sample, reduced })
      draw(t / 1000, state, reduced, an && state === 'speaking' && !reduced)
      // Reduced motion: one static frame, CSS pulses the opacity.
      if (!reduced && state !== 'off') raf = requestAnimationFrame(frame)
      canvas.dataset.state = state
    }
    function draw(T, state, reduced, live) {
      const S = W * dpr, c = S / 2, R = S * 0.3
      const light = lightQuery.matches
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, S, S)
      const breath = state === 'off' || reduced ? 0 : Math.sin(T * 1.1) * 0.5 + 0.5
      const hue = hueOf(v)
      g.globalAlpha = v.dim
      const gr = g.createRadialGradient(c, c, R * 0.5, c, c, R * (1.6 + v.amp * 0.5 + breath * 0.12))
      gr.addColorStop(0, `hsla(${hue},90%,${light ? 52 : 62}%,${0.14 + breath * 0.08 + v.amp * 0.25})`)
      gr.addColorStop(1, `hsla(${hue},90%,50%,0)`)
      g.fillStyle = gr; g.fillRect(0, 0, S, S)
      const base = R * (1 + breath * 0.025 * (1 - v.act) + v.amp * 0.12)
      g.beginPath()
      for (let i = 0; i <= N; i++) {
        const k = i % N, th = k / N * Math.PI * 2
        let d = 0
        if (live && td && v.act > 0.01) d = (td[Math.floor(k / N * Math.min(512, td.length))] - 128) / 128 * S * 0.07 * v.act
        if (!reduced) ring[k] = lerp(ring[k], d + Math.sin(th * 3 + T * 0.8) * S * 0.004 * (1 + v.amp * 4), 0.3)
        else ring[k] = 0
        const r = base + ring[k]
        const x = c + Math.cos(th) * r, y = c + Math.sin(th) * r
        i ? g.lineTo(x, y) : g.moveTo(x, y)
      }
      g.closePath()
      g.lineWidth = S * (0.012 + v.amp * 0.03); g.lineJoin = 'round'
      const lightness = light ? (state === 'off' ? 45 : 50) : (state === 'off' ? 60 : 72)
      g.strokeStyle = `hsl(${hue},85%,${reduced && state === 'listening' ? lightness + 10 : lightness}%)`
      g.shadowColor = `hsl(${hue},90%,60%)`; g.shadowBlur = state === 'off' ? 0 : S * (0.03 + v.amp * 0.08)
      g.stroke(); g.shadowBlur = 0
      const ri = R * (0.62 + v.lo * 0.18 - v.hi * 0.04)
      g.beginPath()
      for (let i = 0; i <= N; i++) {
        const th = i / N * Math.PI * 2, r = ri + Math.sin(th * 5 + T * 2) * S * 0.008 * (v.hi * 3 + 0.2) * v.act
        const x = c + Math.cos(th) * r, y = c + Math.sin(th) * r
        i ? g.lineTo(x, y) : g.moveTo(x, y)
      }
      g.closePath(); g.lineWidth = S * 0.006
      g.strokeStyle = `hsla(${hue + 40},90%,${light ? 55 : 78}%,${(0.25 + v.lo * 0.6) * (0.4 + 0.6 * v.act)})`; g.stroke()
      if (v.lis > 0.01) {
        for (let i = 0; i < 8; i++) {
          const th = T * 1.4 + i / 8 * Math.PI * 2, rr = R * 0.5 * (1 + Math.sin(T * 2 + i) * 0.08)
          g.beginPath(); g.arc(c + Math.cos(th) * rr, c + Math.sin(th) * rr, S * (0.012 + 0.006 * Math.sin(T * 3 + i * 1.3)), 0, 7)
          g.fillStyle = `hsla(${170 + i * 6},80%,${light ? 45 : 75}%,${v.lis * 0.9})`; g.fill()
        }
      }
      g.globalAlpha = 1
    }
    function kick() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame) }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0 }
    size()
    root.addEventListener('resize', () => { size(); kick() })
    document.addEventListener('visibilitychange', kick)
    reducedQuery.addEventListener?.('change', kick)
    lightQuery.addEventListener?.('change', kick)
    return { kick, stop }
  }

  const api = { N, lerp, rms, band, measure, step, initial, hueOf, createOrb }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.SeraCompanionOrb = api
})(typeof window !== 'undefined' ? window : globalThis)
