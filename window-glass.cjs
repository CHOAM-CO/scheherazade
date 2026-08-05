// window-glass.cjs — BrowserWindow backdrop options for the frosted-glass
// look. Lives outside main.cjs so plain node can require it (main.cjs pulls
// in electron at import time); scripts/test-window-glass.mjs asserts the
// platform matrix below.
//
// History (대공사 2026-08-05, FIXED same day after Mino's "유리질감 렌더
// 안되고있음"): 0.59 set backgroundColor:'#111214' as a "zero-risk fallback"
// ALONGSIDE vibrancy/acrylic — but an explicit backgroundColor paints over
// the platform effect on BOTH platforms (Electron: the window's solid paint
// sits above the material), so the fallback was the only thing that ever
// rendered. The visual receipt missed it because webContents captures don't
// composite the window backdrop, and the fallback was DESIGNED to look
// identical. Lesson: a fallback indistinguishable from success is
// unverifiable by construction.
//
// The invariant this module owns: the platform effect and the solid
// fallback are EXCLUSIVE — an option set never carries both.
//  - darwin: vibrancy, no backgroundColor. NSVisualEffectView self-degrades
//    to a solid system tint under reduced-transparency; no fallback color
//    needed, and adding one would kill the effect again.
//  - win32 build >= 22621 (Win11 22H2+, the floor where backgroundMaterial
//    is implemented; Mino's box is 26100): acrylic, no backgroundColor. The
//    OS renders it solid when the user disables transparency effects.
//  - everything else (win10, linux): the 0.59 flat fallback, unchanged.

'use strict'

const WIN11_22H2_BUILD = 22621
const FLAT_FALLBACK = '#111214'

// electron#46164 (open, confirmed): with 'followWindow' modern macOS does
// not merely dim the vibrancy backdrop on an inactive window — it drops it
// entirely, which reads as "유리 안 뜬다". 'active' pins the backdrop on;
// reproduced 2026-08-05 on macOS 26 via dev-glass-probe (followWindow
// probe = dead backdrop, active probe = material alive). Construction-only
// option (electron#25513) — changing it means relaunch.
const MAC_EFFECT_STATE = 'active'

// material may come from the user's Appearance config (macOS "유리 재질"
// switcher, 2026-08-05 — Tahoe renders materials differently and only eyes
// on the target machine can pick; the switcher makes Mino the verifier).
function glassOptions(platform, release, material) {
  if (platform === 'darwin') {
    return { vibrancy: material || 'under-window', visualEffectState: MAC_EFFECT_STATE }
  }
  if (platform === 'win32') {
    const build = Number(String(release || '').split('.')[2] || 0)
    if (build >= WIN11_22H2_BUILD) return { backgroundMaterial: 'acrylic' }
  }
  return { backgroundColor: FLAT_FALLBACK }
}

module.exports = { glassOptions, WIN11_22H2_BUILD, FLAT_FALLBACK, MAC_EFFECT_STATE }
