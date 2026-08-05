// appearance-model.cjs — the ONE definition of appearance knobs (Appearance
// tab, Mino 2026-08-05 "어피어런스 탭 만들고 ... CSS들 게이지로 쭉 나열";
// v2 same day: "제일 중요한 대원칙 : 일관성 ... 악센트 컬러 / 백그라운드
// 컬러 colour Picker로 찍을 수 있게").
// Dual-environment on purpose: the browser loads it as a plain script
// (window.AppearanceModel) for live picker/slider apply, and http-server.cjs
// require()s the SAME file to render the pre-paint <style> injection —
// mapping drift between server and client is structurally impossible.
//
// v2 consistency contract: the user picks exactly TWO colors (bg, accent).
// Everything else — panel ladder, frost wash, hover, focus ring — is DERIVED
// here, so no component can hold a color the seed didn't produce. Radius
// vocabulary and hairline borders are also emitted from here for the same
// reason: one file, one tone.
//
// Knobs:
//   glass      0..100   one gauge for the whole frosted-glass look.
//   fontSize   12..16   base px (half steps). Everything else is rem/em.
//   fontFamily system | serif | mono | rounded
//   bg         hex — canvas seed. Default black (Mino 2026-08-05).
//   accent     hex — accent seed. Default blue (Mino 2026-08-05).
;(function (root) {
  'use strict'

  const DEFAULTS = { glass: 60, fontSize: 13.5, fontFamily: 'system', accent: '#5b8dee', bg: '#000000', macMaterial: 'under-window' }

  // Quick-pick swatches beside the pickers. Presets are plain hex — a
  // swatch click and a picker pick flow through the SAME field.
  const PRESET_ACCENTS = ['#5b8dee', '#8b7bee', '#5fae7c', '#d9a15f', '#d9695f']
  const PRESET_BGS = ['#000000', '#0f1115', '#111214', '#14100f']

  // Pre-v2 configs stored accent as a named key. Map, don't reject — a
  // saved file from 0.0.63 must not silently reset the user's color.
  const LEGACY_ACCENTS = { blue: '#5b8dee', violet: '#8b7bee', green: '#5fae7c', amber: '#d9a15f', rose: '#d9695f' }

  // macOS-only: which NSVisualEffectView material backs the window. Tahoe
  // (macOS 26) renders these differently and only eyes on the target
  // machine can judge — the Appearance tab live-switches via
  // win.setVibrancy. Ignored on Windows (acrylic) and Linux (flat).
  const MAC_MATERIALS = ['under-window', 'sidebar', 'hud', 'fullscreen-ui', 'header', 'window', 'content']

  const FONTS = {
    system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    serif: 'ui-serif, Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    rounded: 'ui-rounded, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  }

  // ── color math (hex in, hex/rgb-triplet out; no dependencies) ──────────
  function parseHex(v) {
    if (typeof v !== 'string') return null
    const s = v.trim().toLowerCase()
    const m3 = /^#([0-9a-f]{3})$/.exec(s)
    if (m3) return `#${m3[1].split('').map((ch) => ch + ch).join('')}`
    return /^#[0-9a-f]{6}$/.test(s) ? s : null
  }

  function rgbOf(hex) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  }

  function mix(hexA, hexB, t) {
    const a = rgbOf(hexA)
    const b = rgbOf(hexB)
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t))
    return `#${c.map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('')}`
  }

  function triplet(hex) {
    return rgbOf(hex).join(' ')
  }

  function clampNum(v, lo, hi, fallback) {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.min(hi, Math.max(lo, n))
  }

  // Any input → a complete, safe config. Unknown keys dropped, bad values
  // fall back per-field (never throws — this also validates PUT bodies).
  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {}
    return {
      glass: Math.round(clampNum(src.glass, 0, 100, DEFAULTS.glass)),
      fontSize: Math.round(clampNum(src.fontSize, 12, 16, DEFAULTS.fontSize) * 2) / 2,
      fontFamily: Object.prototype.hasOwnProperty.call(FONTS, src.fontFamily) ? src.fontFamily : DEFAULTS.fontFamily,
      accent: parseHex(src.accent) || LEGACY_ACCENTS[src.accent] || DEFAULTS.accent,
      bg: parseHex(src.bg) || DEFAULTS.bg,
      macMaterial: MAC_MATERIALS.includes(src.macMaterial) ? src.macMaterial : DEFAULTS.macMaterial,
    }
  }

  // Seeds → the full palette.
  //   glass gauge → the three translucency alphas. g=0 reproduces the solid
  //   pre-0.61 look exactly; g=60 = the calibrated 0.61 defaults; g=100 =
  //   raw effect with whisper-thin panels.
  //   bg → surface ladder (design-research 2026-08: Linear-style — surfaces
  //   get LIGHTER as they elevate, never shadowed). Panels are rgb triplets
  //   so the glass alphas compose with the derived colors.
  //   accent → hover (darker sibling) + focus ring (translucent).
  //   Static grammar (hairline borders, top-edge highlight, radius
  //   vocabulary 6/12/999) lives here too so every surface shares it.
  function cssVars(cfg) {
    const c = normalize(cfg)
    const g = c.glass / 100
    return {
      '--bg': c.bg,
      '--frost-rgb': triplet(c.bg),
      '--panel-rgb': triplet(mix(c.bg, '#ffffff', 0.08)),
      '--raised-rgb': triplet(mix(c.bg, '#ffffff', 0.115)),
      '--frost-alpha': (0.82 * (1 - g)).toFixed(3),
      '--panel-alpha': (1 - 0.75 * g).toFixed(3),
      '--raised-alpha': (1 - 0.5 * g).toFixed(3),
      '--border': 'rgb(255 255 255 / 0.09)',
      '--border-strong': 'rgb(255 255 255 / 0.16)',
      '--edge-highlight': 'inset 0 1px 0 rgb(255 255 255 / 0.06)',
      '--radius-s': '6px',
      '--radius-m': '12px',
      '--radius-pill': '999px',
      '--font-base': `${c.fontSize}px`,
      '--font': FONTS[c.fontFamily],
      '--accent': c.accent,
      '--accent-hover': mix(c.accent, '#000000', 0.15),
      '--accent-ring': `rgb(${triplet(c.accent)} / 0.45)`,
    }
  }

  function cssText(cfg) {
    const vars = cssVars(cfg)
    return `:root {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`
  }

  const model = { DEFAULTS, FONTS, PRESET_ACCENTS, PRESET_BGS, LEGACY_ACCENTS, MAC_MATERIALS, normalize, cssVars, cssText, mix }
  if (typeof module !== 'undefined' && module.exports) module.exports = model
  else root.AppearanceModel = model
})(typeof window !== 'undefined' ? window : globalThis)
