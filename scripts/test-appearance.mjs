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
assert(d.glass === 60 && d.fontSize === 13.5 && d.fontFamily === 'system' && d.accent === 'blue',
  'defaults: glass 60 / 13.5px / system / blue')
const solid = M.cssVars({ glass: 0 })
assert(solid['--frost-alpha'] === '0.820' && solid['--panel-alpha'] === '1.000' && solid['--raised-alpha'] === '1.000',
  'glass 0 reproduces the solid pre-0.61 look exactly (wash .82, opaque panels)')
const raw = M.cssVars({ glass: 100 })
assert(raw['--frost-alpha'] === '0.000' && Number(raw['--panel-alpha']) < 0.3,
  'glass 100 is the raw platform effect')
const junk = M.normalize({ glass: 'x', fontSize: 999, fontFamily: 'evil', accent: '<script>' })
assert(junk.glass === 60 && junk.fontSize === 16 && junk.fontFamily === 'system' && junk.accent === 'blue',
  'junk input falls back per-field, never throws (PUT-body safety)')
assert(M.normalize({ fontSize: 12.7 }).fontSize === 12.5, 'fontSize snaps to half steps')
assert(M.cssText({ glass: 60 }).startsWith(':root {'), 'cssText emits a :root block')
for (const [k, v] of Object.entries(M.ACCENTS)) {
  assert(/^#[0-9a-f]{6}$/.test(v.accent) && /^#[0-9a-f]{6}$/.test(v.hover), `accent ${k} is a hex pair`)
}

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

console.log('\n5. glass CSS invariants (the 0.61 fix itself)')
const css = readFileSync(path.join(root, 'onboarding', 'public', 'css', 'app.css'), 'utf8')
assert(css.includes('--panel: rgb(26 28 31 / var(--panel-alpha))'), 'panels are translucent via the alpha var')
assert(css.includes('--frost-alpha: 0.35'), 'frost default is the calibrated 0.35, not the 0.82 curtain')
assert(css.includes('font-size: var(--font-base, 13.5px)'), 'base font size is appearance-controllable')
assert(!/--panel:\s*#/.test(css), 'no opaque hex --panel anywhere (the regression shape)')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
