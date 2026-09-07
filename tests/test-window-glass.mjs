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
  ['linux', '6.1.0'],       // a kernel release, not a Windows build number
  ['linux', '6.8.0-45-generic'], // the shape os.release() actually returns there
  ['linux', ''],            // release unavailable
]
for (const [platform, release] of cases) {
  const o = glassOptions(platform, release)
  const hasEffect = 'vibrancy' in o || 'backgroundMaterial' in o
  const hasFallback = 'backgroundColor' in o
  assert(hasEffect !== hasFallback, `${platform} ${release || '(empty)'}: exactly one of effect/fallback (${JSON.stringify(o)})`)
}

console.log('\n2. platform matrix')
const mac = glassOptions('darwin', '23.0.0')
assert(mac.vibrancy === 'under-window' && mac.visualEffectState === 'active',
  "darwin gets under-window vibrancy with 'active' state (electron#46164: followWindow DROPS vibrancy on inactive windows)")
assert(!('backgroundColor' in mac), 'darwin carries NO backgroundColor (an opaque one killed vibrancy in 0.59)')
assert(glassOptions('darwin', '23.0.0', 'hud').vibrancy === 'hud', 'darwin material override (blur level → material) is honored')
assert(glassOptions('win32', '10.0.26100', 'hud').backgroundMaterial === 'acrylic', 'material override is a no-op off-mac')

console.log("\n2b. v3 blur-off sentinel ('none')")
const off = glassOptions('darwin', '23.0.0', 'none')
assert(off.backgroundColor === FLAT_FALLBACK && !('vibrancy' in off),
  "material 'none' (blur off) constructs flat on mac — no vibrancy at all")
assert(glassOptions('win32', '10.0.26100', 'none').backgroundColor === FLAT_FALLBACK,
  "material 'none' constructs flat on win too (blur off beats acrylic)")
const noConfig = glassOptions('darwin', '23.0.0', null)
assert(noConfig.vibrancy === 'under-window', 'null (no config) still means the default material, NOT off')
const win11 = glassOptions('win32', '10.0.26100')
assert(win11.backgroundMaterial === 'acrylic', 'win11 24H2 gets acrylic')
assert(!('backgroundColor' in win11), 'win11 carries NO backgroundColor (it kills backgroundMaterial)')
assert(glassOptions('win32', `10.0.${WIN11_22H2_BUILD}`).backgroundMaterial === 'acrylic', `build ${WIN11_22H2_BUILD} (22H2 floor) is inclusive`)
assert(glassOptions('win32', '10.0.19045').backgroundColor === FLAT_FALLBACK, 'win10 falls back to the flat color')
assert(glassOptions('win32', '').backgroundColor === FLAT_FALLBACK, 'unparseable win release degrades to flat, never throws')

console.log('\n2c. linux row (explicit, not the else-branch)')
// Linux used to be covered only by "everything else". 0.3 ships it as a
// first-class platform (design-0023), so the row is spelled out and pins
// CURRENT behavior: flat, always. There is no Electron API for GNOME/KDE
// blur, so unlike win10 this is not a version floor anyone can cross -- a
// future linux material would have to change window-glass.cjs, and these
// assertions are what would notice.
for (const release of ['6.1.0', '6.8.0-45-generic', '']) {
  const o = glassOptions('linux', release)
  assert(o.backgroundColor === FLAT_FALLBACK && !('vibrancy' in o) && !('backgroundMaterial' in o),
    `linux ${release || '(empty release)'}: flat fallback, no platform effect (${JSON.stringify(o)})`)
}
assert(glassOptions('linux', '6.1.0', 'hud').backgroundColor === FLAT_FALLBACK,
  'a saved mac material is a no-op on linux (the switcher cannot turn blur ON there)')
assert(glassOptions('linux', '6.1.0', 'under-window').backgroundColor === FLAT_FALLBACK,
  "...including the default material name")
assert(glassOptions('linux', '6.1.0', 'none').backgroundColor === FLAT_FALLBACK,
  "the blur-off sentinel is already what linux gets -- 'none' changes nothing there")
// A build-number parse must never leak across from the win32 branch: '6.1.0'
// has no third component the win path would read as >= 22621, but a linux
// release string like '6.8.0-45-generic' would parse as 0 anyway. Assert the
// branch, not the arithmetic.
assert(!('backgroundMaterial' in glassOptions('linux', '10.0.26100')),
  'a Windows-SHAPED release string on linux still gets no acrylic (the platform decides, not the version)')

// design-0023 P4: the same fact is now NAMED, in onboarding/platform.cjs, and
// two modules answer it -- window-glass.cjs at window CONSTRUCTION and the
// capability table at every LIVE apply and in the appearance UI. If they ever
// disagree, one of them is lying to the user: the window would be built flat
// while the page offers a working-looking blur control (which is exactly what
// shipped before the flag existed). Asserted across all three platforms so a
// future material lands in both places or in neither.
{
  const { capabilities } = require(path.join(root, 'onboarding', 'platform.cjs'))
  const mk = (platform) => capabilities({ platform, arch: 'x64', env: {}, home: '/h', dataHome: '/h/d', existsSync: () => false, hasTmux: () => false })
  for (const [platform, release] of [['darwin', '23.0.0'], ['win32', '10.0.26100'], ['linux', '6.8.0-45-generic']]) {
    const o = glassOptions(platform, release)
    const constructsWithEffect = 'vibrancy' in o || 'backgroundMaterial' in o
    assert(constructsWithEffect === mk(platform).supportsBlur,
      `${platform}: window-glass constructs ${constructsWithEffect ? 'with' : 'without'} an effect and the capability table says supportsBlur=${mk(platform).supportsBlur} -- they agree`)
  }
  assert(mk('linux').windowMaterial === 'none',
    "linux names its material 'none' rather than leaving it undefined -- the appearance route branches on this string")
}

console.log('\n3. main.cjs uses glassOptions and does not reintroduce the 0.59 shape')
const main = readFileSync(path.join(root, 'main.cjs'), 'utf8')
assert(/require\(path\.join\(__dirname, 'window-glass\.cjs'\)\)/.test(main), 'main.cjs requires window-glass.cjs')
assert(/\.\.\.glassOptions\(process\.platform, os\.release\(\), readSavedMacMaterial\(\)\)/.test(main), 'BrowserWindow spreads glassOptions with the saved mac material')
assert(/function readSavedMacMaterial\(\)/.test(main) && main.includes("appearance.json"), 'main.cjs restores the Appearance material across relaunches')
assert(main.includes(".macMaterial || 'none'"), "main.cjs maps saved blur-off (null material) to the explicit 'none' sentinel — distinct from no-config")
const winOpts = /new BrowserWindow\(\{[\s\S]*?\}\)/.exec(main)
assert(winOpts && !/backgroundColor:/.test(winOpts[0]), 'no literal backgroundColor beside the spread (the 0.59 regression shape)')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
