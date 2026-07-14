#!/usr/bin/env node
// test-shell-reality.mjs -- source pins on the "셸은 현실, 설정은 의도"
// principle (IA v0.0.9 merge lock). These are wiring pins, not behavior
// tests: the client files run in a browser, so what CAN be enforced from
// node is that the load-bearing lines exist and the forbidden ones don't.
//
// The forbidden class, named: writing CONFIG into a slot the user reads as
// RUNNING STATE. That is how a dropdown said gpt-5.6-sol while the engine
// served gpt-5.5 for a whole morning (07-14 live catch).
//
// Run: node scripts/test-shell-reality.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

console.log('shell reality pins (셸은 현실, 설정은 의도)\n')

const nav = read('onboarding/public/js/nav.js')
const settings = read('onboarding/public/js/settings.js')
const settingsHtml = read('onboarding/public/settings.html')
const main = read('main.cjs')
const server = read('onboarding/http-server.cjs')

// ── the reality source exists end to end ────────────────────────────────────
check('main.cjs records the child birth config at the spawn moment',
  /agentSupervisorPid = child\.pid[\s\S]{0,900}lastSpawnInfo = \{/.test(main))
check('...and spawn-info rides agentControls', main.includes('spawnInfo: () => lastSpawnInfo'))
check('http-server serves GET /api/agent/spawn-info', server.includes("'/api/agent/spawn-info'"))

// ── the shell reads reality, never config ───────────────────────────────────
check('nav.js fills model/effort from spawn-info', nav.includes("api('/api/agent/spawn-info')") && nav.includes('renderRealityDetails'))
check('nav.js NEVER writes cfg.MODEL into the model slot (the forbidden class)',
  !/nav-status-model'\)\.textContent = cfg\./.test(nav) && !nav.includes("textContent = cfg.MODEL"))
check('nav.js no longer hand-writes previousModel after a mute revert',
  !nav.includes('textContent = s.previousModel'))
check('a state transition refetches the birth record (restart = new child)',
  /state !== lastPolledState.*refreshSpawnInfo/.test(nav.replace(/\n/g, ' ')))
check('stopped agents show BLANK model, not config',
  nav.includes("running && spawnInfo ? (spawnInfo.model || '') : ''"))

// ── autonomy visibility (red-team fold #3, scoped to the TRUE claim) ────────
check('autonomy badge renders in the shell when AUTONOMY=yes', nav.includes('autonomyBadge') && nav.includes('nav-status-autonomy'))
check('stop-confirm carries the autonomy note ONLY as "stops with it"',
  nav.includes('stopConfirmAutonomyNote') && !/wake|다시 깨/.test(nav))
const copy = read('onboarding/public/js/copy.js')
// First draft of this pin convicted a CODE COMMENT (which quotes the
// forbidden claim in order to forbid it) -- wrong defendant #5 this week.
// The pin's target is the user-facing STRING VALUE, so match the value line.
check('...and the copy states the cycle STOPS with the agent (never the wake lie)',
  copy.includes("stops with it") && !/stopConfirmAutonomyNote: [^\n]*wake/.test(copy))

// ── settings apply-state line (red-team fold #1) ────────────────────────────
check('settings.html has the apply-state mount', settingsHtml.includes('set-apply-state'))
check('settings.js compares intent (selects) against reality (spawn-info)',
  settings.includes('renderApplyState') && settings.includes("api('/api/agent/spawn-info')"))
check('the FAILED state surfaces the refusal detail next to the picker',
  settings.includes('applyFailed(status.detail'))
check('a change follows the settle instead of leaving a stale line',
  settings.includes('settleApplyState()'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
