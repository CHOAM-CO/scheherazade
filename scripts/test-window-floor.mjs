#!/usr/bin/env node
// test-window-floor.mjs — the packaged window must never be narrower than the
// layout it has to render. Run: node scripts/test-window-floor.mjs
//
// WHY THIS FILE EXISTS: the 2026-07-25 alignment pass gave settings a FIXED
// label column (--label-col) next to a flexible control column. That fixes the
// ragged control edges, but it also means the row has a hard minimum width --
// squeeze the window and the label column stops yielding while the controls
// shrink toward zero. main.cjs grew minWidth/minHeight in the same pass.
//
// A manual "drag the window and look" check verifies that once, for the person
// dragging, on the day they drag. It does not survive someone widening
// .page-shell six weeks later. This ties the two numbers together instead:
// the window floor is asserted against the layout's OWN declared width, so
// changing either side without the other fails here.
//
// SCOPE: static source assertion. It does NOT launch Electron and does NOT
// prove macOS honors minWidth (it does; that is an OS-level guarantee we are
// not re-testing). It proves the two numbers in THIS repo stay consistent.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const main = readFileSync(path.join(root, 'main.cjs'), 'utf8')
const css = readFileSync(path.join(root, 'onboarding/public/css/app.css'), 'utf8')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

// The BrowserWindow floor.
const minW = /minWidth:\s*(\d+)/.exec(main)
const minH = /minHeight:\s*(\d+)/.exec(main)
console.log('\n1. main.cjs declares a window floor')
assert(minW !== null, 'minWidth is declared')
assert(minH !== null, 'minHeight is declared')
if (!minW || !minH) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

// What the widest layout actually needs. .page-shell is the post-onboarding
// shell (settings/memory/channels/connectors/logs) and is wider than the
// wizard's .card, so it is the binding constraint.
const shell = /\.page-shell\s*\{([^}]*)\}/.exec(css)
assert(shell !== null, '.page-shell rule is present in app.css')
const shellBody = shell ? shell[1] : ''
const maxW = /max-width:\s*(\d+)px/.exec(shellBody)
assert(maxW !== null, '.page-shell declares a max-width in px')
if (!maxW) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

// 대공사 2026-08-05: .page-shell went FLUID (max-width 1100 + .page-grid
// two-column reflow), so "minWidth >= max-width" stopped being the contract
// -- the floor no longer has to fit the WIDEST layout, it has to land in
// SINGLE-COLUMN territory, where rows are known to fit. The binding numbers
// are now: (a) the floor sits BELOW the two-column breakpoint, so a
// floor-width window renders one column, never two squeezed ones; (b) the
// breakpoint sits at or below the layout cap, so two-column mode actually
// exists inside the fluid range.
const gridBp = /@media\s*\(min-width:\s*(\d+)px\)\s*\{[^}]*\.page-grid/.exec(css)
assert(gridBp !== null, '.page-grid declares its two-column breakpoint (min-width media)')
if (!gridBp) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

console.log('\n2. the floor lands in single-column territory')
console.log(`     window floor ${minW[1]}px | 2-col breakpoint ${gridBp[1]}px | shell cap ${maxW[1]}px`)
assert(Number(minW[1]) < Number(gridBp[1]),
  `minWidth (${minW[1]}) < two-column breakpoint (${gridBp[1]}) -- a floor-width window is single-column`)
assert(Number(gridBp[1]) <= Number(maxW[1]),
  `breakpoint (${gridBp[1]}) <= shell max-width (${maxW[1]}) -- two-column mode exists in range`)

const REM = 16

// The settings label column is the reason the floor exists at all. If it ever
// grows past a third of the content width, the control column is the thing
// being squeezed and the responsive fallback below becomes load-bearing.
console.log('\n3. the fixed label column has a stacked fallback')
const labelCol = /--label-col:\s*([\d.]+)rem/.exec(css)
assert(labelCol !== null, '--label-col is declared as a single source of truth')
const hasStackFallback = /@media\s*\(max-width:\s*(\d+)px\)/.test(css)
assert(hasStackFallback, 'a narrow-window media query exists so rows stack instead of colliding')
if (labelCol) {
  const labelPx = Number(labelCol[1]) * REM
  // Judged at the FLOOR width -- the narrowest single-column window is where
  // the control column is most squeezed, so that is where majority must hold.
  assert(labelPx * 3 < Number(minW[1]), `--label-col (${labelPx}px) leaves the control column the majority of the row at floor width (${minW[1]}px)`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
