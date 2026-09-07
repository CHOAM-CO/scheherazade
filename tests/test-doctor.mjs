#!/usr/bin/env node
// test-doctor.mjs -- source pins on the prerequisite doctor (2026-08-06,
// 0.67 clean-mac feedback: on a machine with no claude CLI the agent was
// silently dead -- "실패해도 되는데 원인은 알아야지"). Wiring pins, not
// behavior tests: the client files run in a browser; what CAN be enforced
// from node is that the load-bearing lines exist.
//
// The two truths the doctor must never drift from:
//  1. The claude-cli row runs the SAME resolver the spawn gate uses
//     (agentControls.claudeCliInfo), so the card and the spawn verdict
//     cannot disagree.
//  2. Provider readiness comes from computeAvailableProviders(), the same
//     single source of truth the model-swap gate uses.
//
// Run: node tests/test-doctor.mjs

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

console.log('prerequisite doctor pins (0.67 clean-mac feedback)\n')

console.log('1. route (onboarding-meta.cjs)')
const meta = read('onboarding/routes/onboarding-meta.cjs')
check('GET /api/doctor route exists', meta.includes("pathname === '/api/doctor'"))
{
  const h = meta.slice(meta.indexOf("pathname === '/api/doctor'"))
  const handler = h.slice(0, h.indexOf('match: (pathname)', 10) === -1 ? h.length : h.indexOf('match: (pathname)', 10))
  check('claude-cli row uses the spawn gate resolver (claudeCliInfo)', handler.includes('claudeCliInfo'))
  check('provider readiness uses computeAvailableProviders', handler.includes('computeAvailableProviders()'))
  check('provider comes from the live agent config', handler.includes('readAgentConfig().PROVIDER'))
  check("row present pin: info.status === 'found'", handler.includes("info.status === 'found'"))
  check('install command rides the row', handler.includes('installCommand: info.installCommand'))
}

console.log('\n2. engine-page card (connectors.html)')
const html = read('onboarding/public/connectors.html')
for (const id of ['conn-doctor', 'conn-doctor-label', 'conn-doctor-recheck', 'conn-doctor-rows',
  'conn-doctor-install-field', 'conn-doctor-install-cmd', 'conn-doctor-install-copy', 'conn-doctor-docs']) {
  check(`carries #${id}`, html.includes(`id="${id}"`))
}

console.log('\n3. renderer (connectors.js)')
const conn = read('onboarding/public/js/connectors.js')
check('renderDoctor fetches /api/doctor', /renderDoctor[\s\S]{0,400}api\('\/api\/doctor'\)/.test(conn))
check('init() renders the doctor card', /renderDoctor\(\)\.catch/.test(conn))
{
  const fn = conn.slice(conn.indexOf('async function renderDoctor'), conn.indexOf('async function init'))
  check('install field shows ONLY for a missing claude-cli row',
    /row\.id === 'claude-cli' && !row\.present && row\.installCommand/.test(fn))
  check('docs button uses the house window.open pattern',
    fn.includes("window.open(row.docsUrl, '_blank', 'noopener')"))
  check('copy uses the clipboard+toast pattern (logs.js precedent)',
    fn.includes('navigator.clipboard.writeText') && fn.includes('showToast(C.doctorInstallCopied)'))
  check('status renders as a dot chip, not a bare sentence', fn.includes('setChip(meta'))
}

console.log('\n4. nav failure cause (nav.js)')
const nav = read('onboarding/public/js/nav.js')
check('skeleton carries #nav-status-cause', nav.includes('id="nav-status-cause"'))
check('poll passes the FULL status object, not just the state word',
  nav.includes('renderAgentStatus(result.state, result)'))
check('cause is filled from status.detail on failed',
  /state === 'failed' && status \? \(status\.detail \|\| status\.code \|\| ''\) : ''/.test(nav))
check('full text rides the title attr (truncation honesty)', nav.includes('cause.title = text'))

console.log('\n5. copy keys (copy.js)')
const copy = read('onboarding/public/js/copy.js')
for (const key of ['doctorLabel', 'doctorNote', 'doctorRecheck', 'doctorRowClaudeCli', 'doctorRowCredential',
  'doctorPresent', 'doctorMissing', 'doctorCredentialFix', 'doctorInstallHint', 'doctorInstallCopy',
  'doctorInstallCopied', 'doctorDocs']) {
  check(`copy carries ${key}`, copy.includes(`${key}:`))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
