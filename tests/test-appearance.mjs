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
assert(d.glass === 60 && d.fontSize === 13.5 && d.fontFamily === 'system' && d.accent === '#d5a458' && d.bg === '#0b111e',
  'defaults: glass 60 / 13.5px / system / accent gold / bg navy (identity palette, Mino 2026-08-20 "우리만의 색")')
assert(d.fg === '#e8e6df' && d.blur === 'soft' && d.macMaterial === 'under-window',
  'v3 defaults: fg #e8e6df parchment, blur soft (macMaterial derives to under-window)')
const solid = M.cssVars({ glass: 0 })
assert(solid['--frost-alpha'] === '0.820' && solid['--panel-alpha'] === '1.000' && solid['--raised-alpha'] === '1.000',
  'glass 0 reproduces the solid pre-0.61 look exactly (wash .82, opaque panels)')
const raw = M.cssVars({ glass: 100 })
assert(raw['--frost-alpha'] === '0.000' && Number(raw['--panel-alpha']) < 0.3,
  'glass 100 is the raw platform effect')
const junk = M.normalize({ glass: 'x', fontSize: 999, fontFamily: 'evil', accent: '<script>', bg: 'url(evil)' })
assert(junk.glass === 60 && junk.fontSize === 16 && junk.fontFamily === 'system' && junk.accent === '#d5a458' && junk.bg === '#0b111e',
  'junk input falls back per-field, never throws (PUT-body safety — colors reject non-hex)')
assert(M.normalize({ fontSize: 12.7 }).fontSize === 12.5, 'fontSize snaps to half steps')
// v3 blur: 3 levels, macMaterial DERIVED. Legacy v2 macMaterial configs
// migrate to the nearest step instead of resetting.
assert(M.normalize({ blur: 'off' }).macMaterial === null, 'blur off derives macMaterial null (no platform effect)')
assert(M.normalize({ blur: 'strong' }).macMaterial === 'hud', 'blur strong derives hud (max contrast vs soft)')
assert(M.normalize({ blur: 'evil' }).blur === 'soft', 'junk blur falls back to soft')
assert(M.normalize({ macMaterial: 'hud' }).blur === 'strong' && M.normalize({ macMaterial: 'sidebar' }).blur === 'soft',
  'legacy v2 macMaterial configs migrate to the nearest blur step')
assert(Array.isArray(M.BLUR_LEVELS) && M.BLUR_LEVELS.join(',') === 'off,soft,strong', 'blur catalog exported for the UI')
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
assert(defVars['--accent-hover'] === M.mix('#d5a458', '#000000', 0.15), 'default hover comes from the same mix path')
assert(defVars['--accent-fg'] === '#1c170b', 'accent-fg: bright accents (gold) carry dark button text')
assert(M.cssVars({ accent: '#5b8dee' })['--accent-fg'] === '#ffffff', 'accent-fg: legacy blue keeps white button text (threshold 0.35 non-breaking)')
assert(defVars['--radius-s'] === '6px' && defVars['--radius-m'] === '12px' && defVars['--radius-pill'] === '999px',
  'radius vocabulary (exactly three values) emitted from the model')
assert(defVars['--border'] === 'rgb(255 255 255 / 0.09)' && defVars['--edge-highlight'].includes('inset 0 1px 0'),
  'hairline border + top-edge highlight emitted from the model')

console.log('\n1c. v3 fg seed + blur-off solid guarantee')
const fgSeeded = M.cssVars({ fg: '#ffffff', bg: '#000000' })
assert(fgSeeded['--fg'] === '#ffffff' && fgSeeded['--fg-dim'] === M.mix('#ffffff', '#000000', 0.38)
  && fgSeeded['--fg-faint'] === M.mix('#ffffff', '#000000', 0.6),
  'text hierarchy derives from the fg seed toward the bg seed')
assert(M.normalize({ fg: 'red' }).fg === '#e8e6df', 'junk fg falls back (colors are hex-only)')
const offVars = M.cssVars({ blur: 'off', glass: 100 })
assert(offVars['--frost-alpha'] === '1.000' && offVars['--panel-alpha'] === '1.000' && offVars['--raised-alpha'] === '1.000',
  'blur off forces the whole tint stack opaque even at glass 100 — nothing behind the window to reveal')
const softVars = M.cssVars({ blur: 'soft', glass: 100 })
assert(softVars['--frost-alpha'] === '0.000', 'blur soft keeps the gauge live (glass 100 = raw effect)')

console.log('\n1d. sticky-chrome blur (0.67 feedback: blur option owns scroll occlusion)')
assert(offVars['--chrome-blur'] === 'none' && offVars['--chrome-alpha'] === '1.000',
  'blur off: nav masks with opaque paint, no backdrop filter')
assert(softVars['--chrome-blur'] === 'blur(14px)' && M.cssVars({ blur: 'strong' })['--chrome-blur'] === 'blur(24px)',
  'blur soft/strong emit the two backdrop strengths')
assert(M.cssVars({ glass: 0, blur: 'soft' })['--chrome-alpha'] === '0.880',
  'glass 0 reproduces the pre-0.67 nav mask (0.88) exactly')
assert(softVars['--chrome-alpha'] === '0.250',
  'glass 100 floors chrome alpha at 0.25 — legible over a fully transparent body')

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
assert(routes.includes('win.setVibrancy(null)') && routes.includes('win.setVibrancy(values.macMaterial)'),
  'PUT live-applies blur via the null-then-material dance (direct setMaterial: swaps do not reliably repaint — native_window_mac.mm)')
assert(routes.includes("win.setBackgroundMaterial(values.blur === 'off' ? 'none' : 'acrylic')"),
  'PUT live-applies blur on Windows too (acrylic on/off — no strength axis there)')
// design-0023 P4: those two literals now live in ONE helper instead of two
// inline `if (process.platform === ...)` blocks that had no third arm -- so on
// Linux the value was written to disk, never applied, and nothing said so.
assert(/function applyWindowMaterial\(values\)/.test(routes), 'the live apply has one owner, applyWindowMaterial()')
assert(routes.includes('applyWindowMaterial(values)'), '...and the PUT handler calls it')
assert(/HOST\.windowMaterial === 'vibrancy'/.test(routes) && /HOST\.windowMaterial === 'acrylic'/.test(routes),
  'the branch is the capability table, not a process.platform test')
assert(!/process\.platform === 'darwin'/.test(routes) && !/process\.platform === 'win32'/.test(routes),
  'no binary platform test survives in this route file')
assert(routes.includes('supportsBlur: HOST.supportsBlur'),
  'GET /api/appearance carries supportsBlur so the page can disable a control the platform cannot honour')
const page2 = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'appearance.js'), 'utf8')
assert(page2.includes('BLUR_LEVELS') && page2.includes("update({ blur: key })"), 'blur 3-step control renders from the model catalog')
assert(!page2.includes('MAC_MATERIALS'), 'the raw 7-material switcher is gone from the UI (v3)')
assert(/function applyBlurSupport\(supported\)/.test(page2) && /b\.disabled = true/.test(page2),
  'the page disables the blur buttons when the server says the platform has no material API')
assert(/if \(supported !== false\) return/.test(page2),
  'only an explicit false disables -- an old server that does not send the flag leaves the control alone')
assert(page2.includes('C.blurUnsupported'), '...and says why, rather than silently going grey')
{
  // The three platforms, from the capability table itself: this is the value
  // the route serves and the page reads.
  const caps = require(path.join(root, 'onboarding', 'platform.cjs'))
  const mk = (platform) => caps.capabilities({ platform, arch: 'x64', env: {}, home: '/h', dataHome: '/h/d', existsSync: () => false, hasTmux: () => false })
  assert(mk('darwin').supportsBlur === true && mk('win32').supportsBlur === true && mk('linux').supportsBlur === false,
    'supportsBlur: mac (vibrancy) yes, win (acrylic) yes, linux no -- Electron exposes no GNOME/KDE material API')
  const css = readFileSync(path.join(root, 'onboarding', 'public', 'css', 'app.css'), 'utf8')
  assert(/\.ap-options\.disabled/.test(css), 'the disabled state has a style (dimmed and inert, still readable)')
}

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
// 0.2.9: the html,body frost wash is gone (page ground moved to the html
// canvas -- the win gray-band fix); the frost token's surviving consumer is
// the sticky chrome bar. Pin THAT usage so the seed-derivation contract
// stays enforced.
assert(css.includes('background: rgb(var(--frost-rgb) / var(--chrome-alpha))'), 'frost wash color comes from the bg seed, not a hardcoded rgba (chrome bar)')
assert(!css.includes('rgba(17, 18, 20'), 'no hardcoded frost rgba left (nav bar included)')
assert(css.includes('--radius: var(--radius-m)'), 'legacy --radius aliases into the vocabulary')
assert(!/border-radius:\s*(7px|8px|10px|999px)/.test(css), 'no ad-hoc radius values outside the vocabulary (50% circles exempt)')
assert(css.includes('box-shadow: var(--edge-highlight)'), 'panels carry the top-edge light-catch')
assert(css.includes('box-shadow: 0 0 0 2px var(--accent-ring)'), 'focus ring uses the derived accent ring')
{
  // Anchor to the .app-nav block specifically (source-grep tests must anchor
  // to their selector — 0.67 lesson), not to a whole-file substring.
  const navBlock = css.slice(css.indexOf('.app-nav {'), css.indexOf('}', css.indexOf('.app-nav {')))
  assert(navBlock.includes('background: rgb(var(--frost-rgb) / var(--chrome-alpha'),
    'sticky nav alpha is model-seeded, not a 0.88 literal')
  assert(navBlock.includes('backdrop-filter: var(--chrome-blur') && navBlock.includes('-webkit-backdrop-filter: var(--chrome-blur'),
    'sticky nav blurs scrolled content via the chrome-blur seed (both prefixes)')
  assert(!navBlock.includes('0.88'), 'no hardcoded nav alpha remains')
}

console.log('\n5b. Pretendard Variable bundling (P0)')
import { statSync } from 'node:fs'
{
  const fontPath = path.join(root, 'onboarding', 'public', 'fonts', 'PretendardVariable.woff2')
  const sz = statSync(fontPath).size
  assert(sz > 1_000_000, `bundled font is a real file (${sz} bytes)`)
  assert(statSync(path.join(root, 'onboarding', 'public', 'fonts', 'LICENSE-Pretendard.txt')).size > 500,
    'OFL license ships beside the font (the one obligation the license carries)')
  assert(M.FONTS.pretendard && M.FONTS.pretendard.includes('"Pretendard Variable"'),
    'model FONTS carries the pretendard stack')
  assert(css.includes("font-family: 'Pretendard Variable'") && css.includes('/fonts/PretendardVariable.woff2')
    && css.includes('font-weight: 45 920'), '@font-face with the full variable weight axis')
  assert(server.includes("'.woff2': 'font/woff2'"), 'server MIME map serves woff2 (browsers refuse octet-stream fonts)')
}

console.log('\n6. v2/v3 picker wiring (page + controller)')
for (const id of ['ap-bg-picker', 'ap-accent-picker', 'ap-fg-picker', 'ap-bg-options', 'ap-fg-options', 'ap-blur-options']) {
  assert(page.includes(`id="${id}"`), `appearance.html carries #${id}`)
}
assert(page2.includes("addEventListener('input', (e) => update({ accent: e.target.value }))")
  && page2.includes("addEventListener('input', (e) => update({ bg: e.target.value }))")
  && page2.includes("addEventListener('input', (e) => update({ fg: e.target.value }))"),
  "all three pickers live-apply on 'input' (repaint while dragging)")
assert(page2.includes('PRESET_ACCENTS') && page2.includes('PRESET_BGS') && page2.includes('PRESET_FGS'),
  'swatches render from the model presets')
assert(copy.includes('bgRowLabel') && copy.includes('fgRowLabel') && copy.includes('blurLevels'),
  'bg/fg row labels + blur level names in copy')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
