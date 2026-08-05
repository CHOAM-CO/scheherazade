#!/usr/bin/env node
// test-appearance.mjs — Appearance tab (2026-08-05, Mino "어피어런스 탭
// 만들고 -> UX랑 컴포넌트 마진부터 설계해서 -> CSS들 게이지로 쭉 나열").
//
// Three layers:
//  1. functional — appearance-model.cjs (the ONE mapping shared verbatim by
//     server injection and browser live-apply; drift here is the whole bug
//     class this design exists to prevent)
//  2. functional — server store roundtrip (readAppearance/writeAppearance
//     via a sandboxed DATA_HOME require of http-server.cjs is too heavy;
//     the store is 6 lines over normalize(), so the model layer plus text
//     pins carry it)
//  3. text pins — server injection wiring, route registration, page/nav/css
//     wiring, and the glass-fix CSS invariants (0.61: translucent panels,
//     frost default, --font-base var)

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(path.join(root, 'package.json')).href)

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

console.log('1. appearance-model.cjs — the single mapping')
const M = require(path.join(root, 'onboarding', 'public', 'js', 'appearance-model.cjs'))
const d = M.normalize(null)
assert(d.glass === 60 && d.fontSize === 13.5 && d.fontFamily === 'system' && d.accent === '#5b8dee' && d.bg === '#000000',
  'defaults: glass 60 / 13.5px / system / accent blue / bg black (Mino 2026-08-05)')
const solid = M.cssVars({ glass: 0 })
assert(solid['--frost-alpha'] === '0.820' && solid['--panel-alpha'] === '1.000' && solid['--raised-alpha'] === '1.000',
  'glass 0 reproduces the solid pre-0.61 look exactly (wash .82, opaque panels)')
const raw = M.cssVars({ glass: 100 })
assert(raw['--frost-alpha'] === '0.000' && Number(raw['--panel-alpha']) < 0.3,
  'glass 100 is the raw platform effect')
const junk = M.normalize({ glass: 'x', fontSize: 999, fontFamily: 'evil', accent: '<script>', bg: 'url(evil)' })
assert(junk.glass === 60 && junk.fontSize === 16 && junk.fontFamily === 'system' && junk.accent === '#5b8dee' && junk.bg === '#000000',
  'junk input falls back per-field, never throws (PUT-body safety — colors reject non-hex)')
assert(M.normalize({ fontSize: 12.7 }).fontSize === 12.5, 'fontSize snaps to half steps')
assert(d.macMaterial === 'under-window' && M.normalize({ macMaterial: 'hud' }).macMaterial === 'hud'
  && M.normalize({ macMaterial: 'evil' }).macMaterial === 'under-window',
  'macMaterial: default under-window, whitelist enforced')
assert(Array.isArray(M.MAC_MATERIALS) && M.MAC_MATERIALS.length >= 5, 'material catalog exported for the switcher UI')
assert(M.cssText({ glass: 60 }).startsWith(':root {'), 'cssText emits a :root block')
for (const hex of [...M.PRESET_ACCENTS, ...M.PRESET_BGS]) {
  assert(/^#[0-9a-f]{6}$/.test(hex), `preset ${hex} is normalized hex`)
}

console.log('\n1b. v2 seed-derivation (Mino "제일 중요한 대원칙 : 일관성")')
// two seeds → whole palette. Pick a tinted bg and a custom accent; every
// derived var must move with them — no component color can escape the seed.
const seeded = M.cssVars({ bg: '#0f1115', accent: '#d9a15f' })
assert(seeded['--frost-rgb'] === '15 17 21', 'bg seed drives the frost wash rgb')
assert(seeded['--panel-rgb'] === '34 36 40' && seeded['--raised-rgb'] === '43 44 48',
  'panel ladder derives from bg (lighter as it elevates, Linear-style)')
assert(seeded['--accent'] === '#d9a15f' && seeded['--accent-hover'] === '#b88951',
  'accent hover derives (darker sibling), not hand-picked')
assert(seeded['--accent-ring'] === 'rgb(217 161 95 / 0.45)', 'focus ring derives from accent')
assert(M.normalize({ accent: 'blue' }).accent === '#5b8dee' && M.normalize({ accent: 'rose' }).accent === '#d9695f',
  'legacy 0.63 preset keys map to their hex (saved configs survive the v2 migration)')
assert(M.normalize({ accent: '#ABC' }).accent === '#aabbcc', 'shorthand hex expands + lowercases')
const defVars = M.cssVars(null)
assert(defVars['--accent-hover'] === M.mix('#5b8dee', '#000000', 0.15), 'default hover comes from the same mix path')
assert(defVars['--radius-s'] === '6px' && defVars['--radius-m'] === '12px' && defVars['--radius-pill'] === '999px',
  'radius vocabulary (exactly three values) emitted from the model')
assert(defVars['--border'] === 'rgb(255 255 255 / 0.09)' && defVars['--edge-highlight'].includes('inset 0 1px 0'),
  'hairline border + top-edge highlight emitted from the model')

console.log('\n2. server wiring pins (http-server.cjs)')
const server = readFileSync(path.join(root, 'onboarding', 'http-server.cjs'), 'utf8')
assert(server.includes("require('./public/js/appearance-model.cjs')"), 'server requires the SAME model file the browser loads')
assert(server.includes("'/appearance': 'appearance.html'"), '/appearance route maps to the page')
assert(server.includes('appearance-style') && server.includes('AppearanceModel.cssText(readAppearance())'),
  'HTML serve injects the pre-paint appearance style')
const closeHeadIdx = server.indexOf("injected.replace(\n      '</head>'")
assert(closeHeadIdx !== -1, 'appearance style lands before </head> (AFTER app.css, wins the :root cascade)')
assert(server.includes("'.cjs': 'text/javascript; charset=utf-8'"), '.cjs gets a script MIME (browsers refuse octet-stream)')
assert(/readAppearance, writeAppearance, AppearanceModel,/.test(server), 'store + model exported via staticCtx')

console.log('\n3. route pins (onboarding-meta.cjs)')
const routes = readFileSync(path.join(root, 'onboarding', 'routes', 'onboarding-meta.cjs'), 'utf8')
assert(routes.includes("pathname === '/api/appearance'"), 'GET/PUT /api/appearance registered')
assert(routes.includes("method: 'PUT'"), 'PUT variant present')
assert(routes.includes('writeAppearance(body)'), 'PUT saves through normalize (writeAppearance)')
assert(routes.includes('win.setVibrancy(values.macMaterial)'), 'PUT live-applies the mac material (setVibrancy is runtime-mutable)')
const page2 = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'appearance.js'), 'utf8')
assert(page2.includes("meta.content === 'darwin'") && page2.includes('MAC_MATERIALS'), 'material switcher renders only on macOS, from the model catalog')

console.log('\n4. page + nav + copy wiring')
const page = readFileSync(path.join(root, 'onboarding', 'public', 'appearance.html'), 'utf8')
for (const id of ['ap-glass-range', 'ap-fontsize-range', 'ap-fontfamily-options', 'ap-accent-options', 'ap-reset']) {
  assert(page.includes(`id="${id}"`), `appearance.html carries #${id}`)
}
assert(page.includes('/js/appearance-model.cjs'), 'page loads the shared model')
const nav = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'nav.js'), 'utf8')
assert(nav.includes("id: 'appearance', href: '/appearance'"), 'nav tab registered')
assert(nav.includes("startsWith('/appearance')"), 'active-tab derivation knows the page')
const copy = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'copy.js'), 'utf8')
assert(copy.includes('appearance: {') && copy.includes("appearance: 'Appearance'"), 'copy strings + tab label present')

console.log('\n5. glass CSS invariants (the 0.61 fix + v2 tokens)')
const css = readFileSync(path.join(root, 'onboarding', 'public', 'css', 'app.css'), 'utf8')
assert(css.includes('--panel: rgb(var(--panel-rgb) / var(--panel-alpha))'), 'panels are translucent AND bg-seeded (rgb triplet var)')
assert(css.includes('--frost-alpha: 0.35'), 'frost default is the calibrated 0.35, not the 0.82 curtain')
assert(css.includes('font-size: var(--font-base, 13.5px)'), 'base font size is appearance-controllable')
assert(!/--panel:\s*#/.test(css), 'no opaque hex --panel anywhere (the regression shape)')
assert(css.includes('background: rgb(var(--frost-rgb) / var(--frost-alpha))'), 'frost wash color comes from the bg seed, not a hardcoded rgba')
assert(!css.includes('rgba(17, 18, 20'), 'no hardcoded frost rgba left (nav bar included)')
assert(css.includes('--radius: var(--radius-m)'), 'legacy --radius aliases into the vocabulary')
assert(!/border-radius:\s*(7px|8px|10px|999px)/.test(css), 'no ad-hoc radius values outside the vocabulary (50% circles exempt)')
assert(css.includes('box-shadow: var(--edge-highlight)'), 'panels carry the top-edge light-catch')
assert(css.includes('box-shadow: 0 0 0 2px var(--accent-ring)'), 'focus ring uses the derived accent ring')

console.log('\n6. v2 picker wiring (page + controller)')
for (const id of ['ap-bg-picker', 'ap-accent-picker', 'ap-bg-options']) {
  assert(page.includes(`id="${id}"`), `appearance.html carries #${id}`)
}
assert(page2.includes("addEventListener('input', (e) => update({ accent: e.target.value }))")
  && page2.includes("addEventListener('input', (e) => update({ bg: e.target.value }))"),
  "pickers live-apply on 'input' (repaint while dragging)")
assert(page2.includes('PRESET_ACCENTS') && page2.includes('PRESET_BGS'), 'swatches render from the model presets')
assert(copy.includes('bgRowLabel'), 'bg row label in copy')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
