#!/usr/bin/env node
// test-permission-probes.mjs -- permission-probes.cjs's promises, attacked
// with injected fake fs/exec/electron (no real TCC, no real sudo, nothing
// prompts).
//
// The promises:
//   1. A probe that cannot measure returns 'indeterminate' -- NEVER a
//      fabricated granted/denied (the autonomy-meter honesty contract;
//      ancestor incident: usage-monitor's fabricated 0% reading).
//   2. probeAll never throws and one broken probe never takes down the
//      rest of the table.
//   3. TCC-cached classes carry needsRelaunch; live-state classes don't.
//   4. DEEP_LINKS covers exactly the classes a Settings pane can fix --
//      SIP/sudo absent BY DESIGN (a button to the wrong pane is a misroute).
//   5. probeAutomation separates -1743 (denied) from -1712 (timeout =
//      indeterminate, denial not proven) and strips quotes from the target
//      (osascript arg injection guard).
//
// Run: node tests/test-permission-probes.mjs

import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { probeAll, probeAutomation, probeSudoVerified, DEEP_LINKS } = require(path.join(import.meta.dirname, '..', 'onboarding', 'permission-probes.cjs'))

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const throwWith = (code) => { const e = new Error(code || 'boom'); if (code) e.code = code; throw e }
const byClass = (rows, cls) => rows.find((r) => r.class === cls)

// Fully-granted machine
{
  const rows = probeAll({
    readFileSync: () => Buffer.from('plist'),
    execFileSync: (cmd) => (cmd === 'csrutil' ? 'System Integrity Protection status: enabled.' : ''),
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
  })
  check('all-granted: 5 rows', rows.length === 5, `got ${rows.length}`)
  check('fda granted + needsRelaunch (TCC caches at launch)', byClass(rows, 'fda').granted === true && byClass(rows, 'fda').needsRelaunch === true)
  check('screen granted, official, live (no relaunch)', byClass(rows, 'screen').granted === true && byClass(rows, 'screen').kind === 'official' && byClass(rows, 'screen').needsRelaunch === false)
  check('accessibility granted official', byClass(rows, 'accessibility').granted === true && byClass(rows, 'accessibility').kind === 'official')
  check('sudo granted heuristic', byClass(rows, 'sudo').granted === true && byClass(rows, 'sudo').kind === 'heuristic')
  check('sip enabled reads as info row', byClass(rows, 'sip').granted === true && byClass(rows, 'sip').kind === 'info')
}

// Fully-denied machine
{
  const rows = probeAll({
    readFileSync: () => throwWith('EPERM'),
    execFileSync: (cmd) => {
      if (cmd === 'csrutil') return 'System Integrity Protection status: disabled.'
      // real execFileSync failure shape: process ran, exited nonzero
      const e = new Error('sudo: a password is required')
      e.status = 1
      throw e
    },
    systemPreferences: { getMediaAccessStatus: () => 'denied', isTrustedAccessibilityClient: () => false },
  })
  check('fda EPERM -> denied', byClass(rows, 'fda').granted === false)
  check('screen denied', byClass(rows, 'screen').granted === false)
  check('accessibility denied', byClass(rows, 'accessibility').granted === false)
  check('sudo rc!=0 (ran, password needed) -> denied', byClass(rows, 'sudo').granted === false)
  check('sip disabled -> false info', byClass(rows, 'sip').granted === false)
}

// Broken-meter machine: everything indeterminate, nothing fabricated
{
  const rows = probeAll({
    readFileSync: () => throwWith('ENOENT'),
    execFileSync: () => throwWith('ENOENT'),
    systemPreferences: { getMediaAccessStatus: () => 'not-determined', isTrustedAccessibilityClient: () => { throw new Error('api gone') } },
  })
  check('fda ENOENT -> indeterminate (probe file missing proves nothing)', byClass(rows, 'fda').granted === 'indeterminate')
  check('screen not-determined -> indeterminate', byClass(rows, 'screen').granted === 'indeterminate')
  check('accessibility api throw -> indeterminate', byClass(rows, 'accessibility').granted === 'indeterminate')
  check('sudo ENOENT -> indeterminate (probe broke, not a denial)', byClass(rows, 'sudo').granted === 'indeterminate')
  check('sip exec missing -> indeterminate', byClass(rows, 'sip').granted === 'indeterminate')
  check('no row fabricated a boolean', rows.every((r) => r.granted === 'indeterminate'))
}

// sudo timeout (killed) is a broken probe, not a denial
{
  const rows = probeAll({
    readFileSync: () => Buffer.from(''),
    execFileSync: (cmd) => { if (cmd === 'sudo') { const e = new Error('timeout'); e.killed = true; throw e } return 'enabled' },
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
  })
  check('sudo killed/timeout -> indeterminate', byClass(rows, 'sudo').granted === 'indeterminate')
}

// probeAll survives deps that are entirely missing/hostile
{
  let rows = null
  let threw = false
  try {
    rows = probeAll({ readFileSync: undefined, execFileSync: undefined, systemPreferences: undefined })
  } catch { threw = true }
  check('probeAll never throws even with no deps', !threw && Array.isArray(rows) && rows.length === 5)
  check('hostile deps -> all indeterminate, none fabricated', rows.every((r) => r.granted === 'indeterminate'))
}

// SIP garbage output -> indeterminate
{
  const rows = probeAll({
    readFileSync: () => Buffer.from(''),
    execFileSync: (cmd) => (cmd === 'csrutil' ? 'unexpected words' : ''),
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
  })
  check('sip unparseable output -> indeterminate', byClass(rows, 'sip').granted === 'indeterminate')
}

// DEEP_LINKS: exactly the pane-fixable classes
{
  const keys = Object.keys(DEEP_LINKS).sort()
  check('deep links = fda/screen/accessibility/automation only', JSON.stringify(keys) === JSON.stringify(['accessibility', 'automation', 'fda', 'screen']), keys.join(','))
  check('no sip pane, no sudo pane (misroute guard)', !('sip' in DEEP_LINKS) && !('sudo' in DEEP_LINKS))
  check('links are Settings anchors', Object.values(DEEP_LINKS).every((v) => v.startsWith('x-apple.systempreferences:')))
}

// probeAutomation
{
  const ok = probeAutomation('System Events', { execFileSync: () => '3' })
  check('automation success -> granted with target', ok.granted === true && ok.target === 'System Events')

  const denied = probeAutomation('Finder', { execFileSync: () => { const e = new Error('x'); e.stderr = 'Not authorized to send Apple events to Finder. (-1743)'; throw e } })
  check('automation -1743 -> denied', denied.granted === false)

  const timeout = probeAutomation('Finder', { execFileSync: () => { const e = new Error('x'); e.stderr = 'AppleEvent timed out. (-1712)'; throw e } })
  check('automation -1712 -> indeterminate, denial not proven', timeout.granted === 'indeterminate' && /1712/.test(timeout.detail))

  const weird = probeAutomation('Finder', { execFileSync: () => throwWith('ENOENT') })
  check('automation probe breakage -> indeterminate', weird.granted === 'indeterminate')

  let seenArgs = null
  probeAutomation('Evil" to do shell script "rm -rf ~', { execFileSync: (_cmd, args) => { seenArgs = args; return '' } })
  check('automation target quotes stripped (arg injection guard)', seenArgs && !seenArgs[1].includes('"Evil" to'), seenArgs && seenArgs[1])

  const dflt = probeAutomation(undefined, { execFileSync: () => '1' })
  check('automation default target is System Events', dflt.target === 'System Events')
}


// ── sudo tiers (2026-08-19: stored-key lane, Mino 11:22 "키 긁어서 있으면 Granted") ──
{
  const throwStatus = () => { const e = new Error('sudo: a password is required'); e.status = 1; throw e }

  const base = {
    readFileSync: () => Buffer.from('plist'),
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
  }
  const sudoFails = (cmd) => { if (cmd === 'sudo') throwStatus(); return 'enabled' }

  const stored = probeAll({ ...base, execFileSync: sudoFails, sudoState: { enabled: true, hasStored: true } })
  check('sudo -n fails but askpass lane armed -> granted kind=stored', byClass(stored, 'sudo').granted === true && byClass(stored, 'sudo').kind === 'stored')

  const disabled = probeAll({ ...base, execFileSync: sudoFails, sudoState: { enabled: false, hasStored: true } })
  check('stored key but SUDO_ENABLED=no -> denied (lane disarmed)', byClass(disabled, 'sudo').granted === false)

  const noKey = probeAll({ ...base, execFileSync: sudoFails, sudoState: { enabled: true, hasStored: false } })
  check('enabled but no stored key -> denied', byClass(noKey, 'sudo').granted === false)

  const noState = probeAll({ ...base, execFileSync: sudoFails })
  check('absent sudoState degrades to tier-1-only (pre-2026-08-19 behavior)', byClass(noState, 'sudo').granted === false)

  let seenEnv = null, seenArgs = null
  const ok = probeSudoVerified({ execFileSync: (_c, args, opts) => { seenArgs = args; seenEnv = opts.env; return '' }, askpassPath: '/tmp/ap.sh', env: { PATH: '/x' } })
  check('probeSudoVerified success -> granted kind=verified', ok.granted === true && ok.kind === 'verified')
  check('probeSudoVerified uses -k (drops cached timestamp, tests the STORED password)', seenArgs && seenArgs.includes('-k') && seenArgs.includes('-A'))
  check('probeSudoVerified injects SUDO_ASKPASS', seenEnv && seenEnv.SUDO_ASKPASS === '/tmp/ap.sh')

  const bad = probeSudoVerified({ execFileSync: () => { const e = new Error('auth fail'); e.status = 1; throw e }, askpassPath: '/tmp/ap.sh' })
  check('probeSudoVerified auth failure -> denied kind=verified (honest negative)', bad.granted === false && bad.kind === 'verified')

  const broke = probeSudoVerified({ execFileSync: () => throwWith('ENOENT'), askpassPath: '/tmp/ap.sh' })
  check('probeSudoVerified machinery breakage -> indeterminate, never a denial', broke.granted === 'indeterminate')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
