#!/usr/bin/env node
// test-window-glass.mjs — the frosted-glass regression that 0.59 shipped:
// backgroundColor set ALONGSIDE vibrancy/acrylic paints over the platform
// effect, so the "fallback" was the only thing that ever rendered (Mino,
// 2026-08-05 11:41 "유리질감 렌더 안되고있음"). The invariant window-glass.cjs
// owns: platform effect and solid fallback are EXCLUSIVE.
//
// Also pins main.cjs's usage by text (same pattern as test-window-floor.mjs:
// main.cjs cannot be require()d outside electron): the BrowserWindow options
// must come from glassOptions and must not reintroduce a literal
// backgroundColor beside it.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { glassOptions, WIN11_22H2_BUILD, FLAT_FALLBACK } = require(path.join(root, 'window-glass.cjs'))

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

console.log('1. exclusivity: no option set carries both an effect and a solid fallback')
const cases = [
  ['darwin', '23.0.0'],
  ['win32', '10.0.26100'],  // Mino's box (Win11 24H2)
  ['win32', '10.0.22621'],  // exact 22H2 floor
  ['win32', '10.0.19045'],  // Win10 -- no material support
  ['win32', ''],            // unparseable release
  ['linux', '6.1.0'],
]
for (const [platform, release] of cases) {
  const o = glassOptions(platform, release)
  const hasEffect = 'vibrancy' in o || 'backgroundMaterial' in o
  const hasFallback = 'backgroundColor' in o
  assert(hasEffect !== hasFallback, `${platform} ${release || '(empty)'}: exactly one of effect/fallback (${JSON.stringify(o)})`)
}

console.log('\n2. platform matrix')
const mac = glassOptions('darwin', '23.0.0')
assert(mac.vibrancy === 'under-window' && mac.visualEffectState === 'followWindow', 'darwin gets under-window vibrancy')
assert(!('backgroundColor' in mac), 'darwin carries NO backgroundColor (an opaque one killed vibrancy in 0.59)')
const win11 = glassOptions('win32', '10.0.26100')
assert(win11.backgroundMaterial === 'acrylic', 'win11 24H2 gets acrylic')
assert(!('backgroundColor' in win11), 'win11 carries NO backgroundColor (it kills backgroundMaterial)')
assert(glassOptions('win32', `10.0.${WIN11_22H2_BUILD}`).backgroundMaterial === 'acrylic', `build ${WIN11_22H2_BUILD} (22H2 floor) is inclusive`)
assert(glassOptions('win32', '10.0.19045').backgroundColor === FLAT_FALLBACK, 'win10 falls back to the flat color')
assert(glassOptions('win32', '').backgroundColor === FLAT_FALLBACK, 'unparseable win release degrades to flat, never throws')
assert(glassOptions('linux', '6.1.0').backgroundColor === FLAT_FALLBACK, 'linux falls back to the flat color')

console.log('\n3. main.cjs uses glassOptions and does not reintroduce the 0.59 shape')
const main = readFileSync(path.join(root, 'main.cjs'), 'utf8')
assert(/require\(path\.join\(__dirname, 'window-glass\.cjs'\)\)/.test(main), 'main.cjs requires window-glass.cjs')
assert(/\.\.\.glassOptions\(process\.platform, os\.release\(\)\)/.test(main), 'BrowserWindow spreads glassOptions(process.platform, os.release())')
const winOpts = /new BrowserWindow\(\{[\s\S]*?\}\)/.exec(main)
assert(winOpts && !/backgroundColor:/.test(winOpts[0]), 'no literal backgroundColor beside the spread (the 0.59 regression shape)')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
