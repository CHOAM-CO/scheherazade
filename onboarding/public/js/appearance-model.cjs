// appearance-model.js — the ONE definition of appearance knobs (Appearance
// tab, Mino 2026-08-05 "어피어런스 탭 만들고 ... CSS들 게이지로 쭉 나열").
// Dual-environment on purpose: the browser loads it as a plain script
// (window.AppearanceModel) for live slider apply, and http-server.cjs
// require()s the SAME file to render the pre-paint <style> injection —
// mapping drift between server and client is structurally impossible.
//
// Knobs (chosen per "폰트 + 니가 알아서 골라내"):
//   glass      0..100   one gauge for the whole frosted-glass look.
//              0 = the solid pre-0.61 look, 100 = raw platform blur.
//              Calibrated against the win acrylic probe 2026-08-05.
//   fontSize   12..16   base px (half steps). Everything else is rem/em.
//   fontFamily system | serif | mono | rounded
//   accent     one of ACCENTS below (buttons, links, active tab)
;(function (root) {
  'use strict'

  const DEFAULTS = { glass: 60, fontSize: 13.5, fontFamily: 'system', accent: 'blue' }

  const FONTS = {
    system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    serif: 'ui-serif, Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    rounded: 'ui-rounded, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  }

  // hover = hand-picked darker sibling (matches the pre-existing blue pair).
  const ACCENTS = {
    blue: { accent: '#5b8dee', hover: '#4877d6' },
    violet: { accent: '#8b7bee', hover: '#7463d8' },
    green: { accent: '#5fae7c', hover: '#4c9468' },
    amber: { accent: '#d9a15f', hover: '#c28b49' },
    rose: { accent: '#d9695f', hover: '#c25850' },
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
      accent: Object.prototype.hasOwnProperty.call(ACCENTS, src.accent) ? src.accent : DEFAULTS.accent,
    }
  }

  // glass gauge → the three translucency alphas. g=0 reproduces the solid
  // 0.60 look exactly (wash 0.82, opaque panels); g=60 = the calibrated
  // 0.61 defaults; g=100 = raw effect with whisper-thin panels.
  function cssVars(cfg) {
    const c = normalize(cfg)
    const g = c.glass / 100
    return {
      '--frost-alpha': (0.82 * (1 - g)).toFixed(3),
      '--panel-alpha': (1 - 0.75 * g).toFixed(3),
      '--raised-alpha': (1 - 0.5 * g).toFixed(3),
      '--font-base': `${c.fontSize}px`,
      '--font': FONTS[c.fontFamily],
      '--accent': ACCENTS[c.accent].accent,
      '--accent-hover': ACCENTS[c.accent].hover,
    }
  }

  function cssText(cfg) {
    const vars = cssVars(cfg)
    return `:root {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`
  }

  const model = { DEFAULTS, FONTS, ACCENTS, normalize, cssVars, cssText }
  if (typeof module !== 'undefined' && module.exports) module.exports = model
  else root.AppearanceModel = model
})(typeof window !== 'undefined' ? window : globalThis)
