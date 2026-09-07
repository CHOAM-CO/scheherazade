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
// AND, since design-0023 P4, the per-platform table:
//   6. Every platform has a ROW. Windows' row is an empty list, which is an
//      ANSWER; an unknown platform gets that same empty list and never
//      darwin's. Nothing is probed by falling into an else.
//   7. The platform is INJECTED, so all three tables run from this Mac --
//      every call below names its platform. A test that let probeAll default
//      to process.platform would assert darwin's table on a Mac and Linux's
//      on Linux, i.e. it would go red for the first time on the box we have
//      the least ability to debug on.
//   8. permissionsPanel in platform.cjs IS the probe list ("does this
//      platform have anything to check"), not a hand-kept boolean beside it.
//   9. The page's labels and its explicit-probe route registry cover exactly
//      what the table can emit -- a class with no label is silently DROPPED
//      by the renderer, which reads as "that permission is fine".
//
// Run: node tests/test-permission-probes.mjs

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.join(import.meta.dirname, '..')
const probes = require(path.join(ROOT, 'onboarding', 'permission-probes.cjs'))
const {
  probeAll, probeAutomation, probeSudoVerified, DEEP_LINKS,
  PROBE_TABLE, probeClassesFor, deepLinksFor, panelModeFor, supports,
} = probes

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const throwWith = (code) => { const e = new Error(code || 'boom'); if (code) e.code = code; throw e }
const byClass = (rows, cls) => rows.find((r) => r.class === cls)
// Every probeAll call in this file names its platform; MAC is just the noise
// floor of darwin deps so the interesting dep is the only thing that varies.
const MAC = { platform: 'darwin' }

// ── darwin: the original five prompt-free probes, unchanged ───────────────

// Fully-granted machine
{
  const rows = probeAll({
    ...MAC,
    readFileSync: () => Buffer.from('plist'),
    execFileSync: (cmd) => (cmd === 'csrutil' ? 'System Integrity Protection status: enabled.' : ''),
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
  })
  check('all-granted: 6 rows (five polled + the declared automation row)', rows.length === 6, `got ${rows.length}`)
  check('fda granted + needsRelaunch (TCC caches at launch)', byClass(rows, 'fda').granted === true && byClass(rows, 'fda').needsRelaunch === true)
  check('screen granted, official, live (no relaunch)', byClass(rows, 'screen').granted === true && byClass(rows, 'screen').kind === 'official' && byClass(rows, 'screen').needsRelaunch === false)
  check('accessibility granted official', byClass(rows, 'accessibility').granted === true && byClass(rows, 'accessibility').kind === 'official')
  check('sudo granted heuristic', byClass(rows, 'sudo').granted === true && byClass(rows, 'sudo').kind === 'heuristic')
  check('sip enabled reads as info row', byClass(rows, 'sip').granted === true && byClass(rows, 'sip').kind === 'info')
}

// Fully-denied machine
{
  const rows = probeAll({
    ...MAC,
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
    ...MAC,
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
    ...MAC,
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
    rows = probeAll({ ...MAC, readFileSync: undefined, execFileSync: undefined, systemPreferences: undefined })
  } catch { threw = true }
  check('probeAll never throws even with no deps', !threw && Array.isArray(rows) && rows.length === 6)
  check('hostile deps -> all indeterminate, none fabricated', rows.every((r) => r.granted === 'indeterminate'))
  // The guard that keeps /api/permissions/status off 500 also has to keep the
  // ROW: an 'unknown'-classed row has no label in copy.js, so the renderer
  // drops it and the checklist just gets shorter -- which reads as "granted".
  check('a broken probe keeps its own class (a dropped row reads as granted)',
    rows.map((r) => r.class).join(',') === probeClassesFor('darwin').join(','),
    rows.map((r) => r.class).join(','))
}

// SIP garbage output -> indeterminate
{
  const rows = probeAll({
    ...MAC,
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
  const ok = probeAutomation('System Events', { ...MAC, execFileSync: () => '3' })
  check('automation success -> granted with target', ok.granted === true && ok.target === 'System Events')

  const denied = probeAutomation('Finder', { ...MAC, execFileSync: () => { const e = new Error('x'); e.stderr = 'Not authorized to send Apple events to Finder. (-1743)'; throw e } })
  check('automation -1743 -> denied', denied.granted === false)

  const timeout = probeAutomation('Finder', { ...MAC, execFileSync: () => { const e = new Error('x'); e.stderr = 'AppleEvent timed out. (-1712)'; throw e } })
  check('automation -1712 -> indeterminate, denial not proven', timeout.granted === 'indeterminate' && /1712/.test(timeout.detail))

  const weird = probeAutomation('Finder', { ...MAC, execFileSync: () => throwWith('ENOENT') })
  check('automation probe breakage -> indeterminate', weird.granted === 'indeterminate')

  let seenArgs = null
  probeAutomation('Evil" to do shell script "rm -rf ~', { ...MAC, execFileSync: (_cmd, args) => { seenArgs = args; return '' } })
  check('automation target quotes stripped (arg injection guard)', seenArgs && !seenArgs[1].includes('"Evil" to'), seenArgs && seenArgs[1])

  const dflt = probeAutomation(undefined, { ...MAC, execFileSync: () => '1' })
  check('automation default target is System Events', dflt.target === 'System Events')
}


// ── sudo tiers (2026-08-19: stored-key lane, Mino 11:22 "키 긁어서 있으면 Granted") ──
{
  const throwStatus = () => { const e = new Error('sudo: a password is required'); e.status = 1; throw e }

  const base = {
    ...MAC,
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
  const ok = probeSudoVerified({ ...MAC, execFileSync: (_c, args, opts) => { seenArgs = args; seenEnv = opts.env; return '' }, askpassPath: '/tmp/ap.sh', env: { PATH: '/x' } })
  check('probeSudoVerified success -> granted kind=verified', ok.granted === true && ok.kind === 'verified')
  check('probeSudoVerified uses -k (drops cached timestamp, tests the STORED password)', seenArgs && seenArgs.includes('-k') && seenArgs.includes('-A'))
  check('probeSudoVerified injects SUDO_ASKPASS', seenEnv && seenEnv.SUDO_ASKPASS === '/tmp/ap.sh')

  const bad = probeSudoVerified({ ...MAC, execFileSync: () => { const e = new Error('auth fail'); e.status = 1; throw e }, askpassPath: '/tmp/ap.sh' })
  check('probeSudoVerified auth failure -> denied kind=verified (honest negative)', bad.granted === false && bad.kind === 'verified')

  const broke = probeSudoVerified({ ...MAC, execFileSync: () => throwWith('ENOENT'), askpassPath: '/tmp/ap.sh' })
  check('probeSudoVerified machinery breakage -> indeterminate, never a denial', broke.granted === 'indeterminate')
}


// ══ design-0023 P4: the per-platform table ════════════════════════════════

// The matrix, spelled out rather than derived. A derivation would agree with
// any bug in the module -- same discipline as tests/test-platform.mjs.
{
  const MATRIX = {
    //          classes                                              panel     deepLink keys
    darwin: [['fda', 'screen', 'accessibility', 'sudo', 'sip', 'automation'], 'tcc', ['fda', 'screen', 'accessibility', 'automation']],
    win32: [[], false, []],
    linux: [['sudo', 'keyring'], 'posix', []],
  }
  for (const [platform, [classes, panel, links]] of Object.entries(MATRIX)) {
    check(`${platform}: probe classes`, JSON.stringify(probeClassesFor(platform)) === JSON.stringify(classes), JSON.stringify(probeClassesFor(platform)))
    check(`${platform}: panel mode`, panelModeFor(platform) === panel, JSON.stringify(panelModeFor(platform)))
    check(`${platform}: deep link keys`, JSON.stringify(Object.keys(deepLinksFor(platform)).sort()) === JSON.stringify([...links].sort()), JSON.stringify(Object.keys(deepLinksFor(platform))))
  }
  check('every platform has a ROW in the table (an empty list is an answer, an absent branch is not)',
    ['darwin', 'win32', 'linux'].every((p) => Object.prototype.hasOwnProperty.call(PROBE_TABLE, p)))
  // The Windows row must be EMPTY ON PURPOSE, not empty because someone
  // deleted its probes: it carries panelMode false, so the panel disappears
  // through the same derivation every other platform uses.
  check('win32 row exists and is deliberately empty', PROBE_TABLE.win32.probes.length === 0 && PROBE_TABLE.win32.panelMode === false)
  // An empty list must switch the panel off even if a panelMode were left
  // behind on the row -- the derivation, not the constant, is the answer.
  check('panelModeFor derives from the LIST, not from panelMode alone',
    panelModeFor('darwin') === PROBE_TABLE.darwin.panelMode && panelModeFor('win32') === false)
}

// An unrecognised platform gets the empty table, never darwin's.
{
  for (const alien of ['sunos', 'aix', 'freebsd', '', undefined, null]) {
    check(`unknown platform ${JSON.stringify(alien)} -> no probes, no panel, no links`,
      probeClassesFor(alien).length === 0 && panelModeFor(alien) === false && Object.keys(deepLinksFor(alien)).length === 0)
  }
  const rows = probeAll({ platform: 'sunos', readFileSync: () => Buffer.from('x'), execFileSync: () => 'enabled', systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true } })
  check('an unknown platform runs NO probe even with a fully-granted fake host', rows.length === 0)
}

// Windows: nothing is probed, and nothing is touched to find that out.
{
  const hostile = {
    platform: 'win32',
    readFileSync: () => { throw new Error('should not be called on win32') },
    execFileSync: () => { throw new Error('should not be called on win32') },
    systemPreferences: { getMediaAccessStatus: () => { throw new Error('nope') }, isTrustedAccessibilityClient: () => { throw new Error('nope') } },
  }
  let rows = null
  let threw = false
  try { rows = probeAll(hostile) } catch { threw = true }
  check('win32 probeAll returns an empty list and spawns nothing', !threw && Array.isArray(rows) && rows.length === 0)
  check('win32 supports() knows it has no classes', !supports('win32', 'sudo') && !supports('win32', 'fda') && !supports('win32', 'keyring'))
}

// Linux: sudo (the same POSIX probe mac uses) + the keyring.
{
  const linuxSudoOk = probeAll({
    platform: 'linux',
    execFileSync: (cmd) => { if (cmd === 'sudo') return ''; throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' },
  })
  check('linux: two rows, sudo + keyring', linuxSudoOk.length === 2 && byClass(linuxSudoOk, 'sudo') && byClass(linuxSudoOk, 'keyring'))
  check('linux: no mac class leaked in', !['fda', 'screen', 'accessibility', 'sip', 'automation'].some((c) => byClass(linuxSudoOk, c)))
  check('linux: passwordless sudo -> granted (the same two-tier probe, not a mac-only one)', byClass(linuxSudoOk, 'sudo').granted === true)
  check('linux: gnome_libsecret + encryption available -> keyring granted, official', byClass(linuxSudoOk, 'keyring').granted === true && byClass(linuxSudoOk, 'keyring').kind === 'official')

  // The whole reason the row exists: basic_text is the state where the vault
  // is NOT encrypted. It must read as a denial with the backend named, not
  // as a bland "unavailable".
  const basic = probeAll({ platform: 'linux', execFileSync: () => '', safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' } })
  check('linux: basic_text backend -> keyring denied', byClass(basic, 'keyring').granted === false)
  check('linux: basic_text denial names the backend', /basic_text/.test(byClass(basic, 'keyring').detail || ''))

  // Electron says "unknown" -> we say "cannot measure". Never a denial.
  const unknown = probeAll({ platform: 'linux', execFileSync: () => '', safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'unknown' } })
  check('linux: unknown backend -> indeterminate, never a fabricated denial', byClass(unknown, 'keyring').granted === 'indeterminate')

  // A named backend the app still cannot encrypt against is a real denial.
  const namedButDead = probeAll({ platform: 'linux', execFileSync: () => '', safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'kwallet6' } })
  check('linux: named backend but isEncryptionAvailable false -> denied', byClass(namedButDead, 'keyring').granted === false)

  // safeStorage that throws (called before app ready, API gone) is a broken
  // meter, not a verdict.
  const boom = probeAll({ platform: 'linux', execFileSync: () => '', safeStorage: { isEncryptionAvailable: () => { throw new Error('not ready') } } })
  check('linux: safeStorage throwing -> indeterminate', byClass(boom, 'keyring').granted === 'indeterminate')
}

// Linux keyring, tier 2: no Electron handle -> the session-bus heuristic.
{
  const gdbus = (out) => (cmd, args) => {
    if (cmd === 'sudo') { const e = new Error('needs a password'); e.status = 1; throw e }
    if (cmd !== 'gdbus') throw Object.assign(new Error('unexpected'), { code: 'ENOENT' })
    if (!args.includes('org.freedesktop.secrets')) throw new Error('probe asked the wrong bus name')
    return out
  }
  const yes = probeAll({ platform: 'linux', execFileSync: gdbus('(true,)\n') })
  check('linux, no safeStorage: secrets name owned -> granted, marked heuristic', byClass(yes, 'keyring').granted === true && byClass(yes, 'keyring').kind === 'heuristic')

  const no = probeAll({ platform: 'linux', execFileSync: gdbus('(false,)\n') })
  check('linux, no safeStorage: nothing owns org.freedesktop.secrets -> denied', byClass(no, 'keyring').granted === false)

  const garbage = probeAll({ platform: 'linux', execFileSync: gdbus('who knows\n') })
  check('linux: unparseable gdbus output -> indeterminate', byClass(garbage, 'keyring').granted === 'indeterminate')

  const noGdbus = probeAll({ platform: 'linux', execFileSync: () => throwWith('ENOENT') })
  check('linux: no gdbus on the box -> indeterminate (a missing tool is not a missing keyring)', byClass(noGdbus, 'keyring').granted === 'indeterminate')

  const nothing = probeAll({ platform: 'linux' })
  check('linux with NO deps at all: still two rows, both indeterminate, no throw',
    nothing.length === 2 && nothing.every((r) => r.granted === 'indeterminate'))
}

// The explicit-trigger lanes ride on the ROW, so the page needs no class list.
{
  const armed = probeAll({
    ...MAC,
    readFileSync: () => Buffer.from('p'),
    execFileSync: (cmd) => { if (cmd === 'sudo') { const e = new Error('x'); e.status = 1; throw e } return 'enabled' },
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
    sudoState: { enabled: true, hasStored: true },
  })
  check('darwin: automation row is declared by the table, not synthesized by the page',
    byClass(armed, 'automation') && byClass(armed, 'automation').granted === 'indeterminate' && byClass(armed, 'automation').explicit === 'automation')
  check('sudo with a stored key offers the explicit check', byClass(armed, 'sudo').explicit === 'sudo')

  const unarmed = probeAll({
    ...MAC,
    readFileSync: () => Buffer.from('p'),
    execFileSync: (cmd) => { if (cmd === 'sudo') { const e = new Error('x'); e.status = 1; throw e } return 'enabled' },
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
  })
  check('sudo with NO stored key offers NO check (a button that can only fail is a misroute)',
    byClass(unarmed, 'sudo').explicit === undefined)
  check('polled rows with no explicit lane carry none', ['fda', 'screen', 'accessibility', 'sip'].every((c) => byClass(unarmed, c).explicit === undefined))

  const linux = probeAll({ platform: 'linux', execFileSync: (cmd) => { if (cmd === 'sudo') { const e = new Error('x'); e.status = 1; throw e } return '(true,)' }, sudoState: { enabled: true, hasStored: true } })
  check('linux: the sudo verify lane is offered there too (askpass is POSIX, not mac)', byClass(linux, 'sudo').explicit === 'sudo')
  check('linux: keyring has no explicit lane (nothing to deepen with a click)', byClass(linux, 'keyring').explicit === undefined)
}

// Explicit probes reached on the wrong host: the route table is not
// per-platform, so a POST can arrive anywhere. It must answer "no such lane
// here" without shelling out.
{
  let called = false
  const spy = () => { called = true; return '' }
  const autoLinux = probeAutomation('Finder', { platform: 'linux', execFileSync: spy })
  check('probeAutomation on linux -> indeterminate, nothing spawned', autoLinux.granted === 'indeterminate' && called === false)
  check('...and it says WHY (no Apple events here), not "osascript missing"', /automation on linux/i.test(autoLinux.detail || ''), autoLinux.detail)

  called = false
  const autoWin = probeAutomation('Finder', { platform: 'win32', execFileSync: spy })
  check('probeAutomation on win32 -> indeterminate, nothing spawned', autoWin.granted === 'indeterminate' && called === false)

  called = false
  const sudoWin = probeSudoVerified({ platform: 'win32', execFileSync: spy, askpassPath: 'C:\\x\\ap.sh' })
  check('probeSudoVerified on win32 -> indeterminate, nothing spawned (UAC is not a sudo lane)', sudoWin.granted === 'indeterminate' && called === false)

  const sudoLinux = probeSudoVerified({ platform: 'linux', execFileSync: () => '', askpassPath: '/tmp/ap.sh' })
  check('probeSudoVerified on linux runs for real (the askpass helper is a bash script)', sudoLinux.granted === true && sudoLinux.kind === 'verified')
}

// ── the two things outside this file that have to agree with the table ────

// platform.cjs: permissionsPanel IS the probe list, per platform.
{
  const { capabilities } = require(path.join(ROOT, 'onboarding', 'platform.cjs'))
  const mk = (platform) => capabilities({
    platform,
    arch: 'x64',
    env: {},
    home: platform === 'win32' ? 'C:\\Users\\t' : '/home/t',
    dataHome: platform === 'win32' ? 'C:\\Users\\t\\d' : '/home/t/d',
    existsSync: () => false,
    accessSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    hasTmux: () => false,
  })
  for (const platform of ['darwin', 'win32', 'linux']) {
    const table = mk(platform)
    check(`${platform}: platform.cjs permissionsPanel === panelModeFor (one source, not two)`,
      table.permissionsPanel === panelModeFor(platform), `${JSON.stringify(table.permissionsPanel)} vs ${JSON.stringify(panelModeFor(platform))}`)
    check(`${platform}: the panel is on exactly when there is something to check`,
      Boolean(table.permissionsPanel) === (probeClassesFor(platform).length > 0))
    check(`${platform}: the capability rides clientView (the page reads it from the meta tag)`,
      table.clientView().permissionsPanel === table.permissionsPanel)
  }
  // The distinction the wizard depends on: Linux HAS a panel and has no TCC
  // in it, so a truthiness gate would put a Full Disk Access card there.
  check('linux panel is truthy but is NOT tcc (the wizard FDA card keys off the value)',
    Boolean(mk('linux').permissionsPanel) === true && mk('linux').permissionsPanel !== 'tcc')
}

// The page: a label for every class, a route for every explicit lane.
{
  const read = (f) => fs.readFileSync(path.join(ROOT, 'onboarding', 'public', 'js', f), 'utf8')
  const copySrc = read('copy.js')
  const settingsSrc = read('settings.js')
  const wizardSrc = read('wizard.js')

  // copy.js is browser JS; give it the two globals it reads and nothing else
  // (same evaluation trick tests/test-setup-token-copy.mjs uses).
  const evalCopy = (platform) => {
    const win = {}
    const doc = { querySelector: (q) => (q.includes('host-platform') ? { getAttribute: () => platform } : null) }
    return new Function('window', 'document', `${copySrc}\nreturn window`)(win, doc)
  }
  const names = evalCopy('darwin').COPY.settings.permsClassNames
  const everyClass = [...new Set(Object.values(PROBE_TABLE).flatMap((e) => e.probes.map((p) => p.class)))]
  for (const cls of everyClass) {
    check(`copy.js labels the "${cls}" row (an unlabelled row is DROPPED by the renderer, which reads as granted)`,
      typeof names[cls] === 'string' && names[cls].length > 0)
  }
  const everyLane = [...new Set(Object.values(PROBE_TABLE).flatMap((e) => e.probes.map((p) => p.explicit).filter(Boolean)))]
  for (const lane of everyLane) {
    check(`settings.js has a route for the "${lane}" explicit lane`,
      new RegExp(`${lane}:\\s*'/api/permissions/`).test(settingsSrc))
  }
  check('settings.js no longer synthesizes an automation row client-side',
    !/r\.class === 'automation'/.test(settingsSrc) && !/all\.push\(\{ class: 'automation'/.test(settingsSrc))
  check('settings.js reads the explicit lane off the row instead of a hardcoded class list',
    /EXPLICIT_PROBE_ROUTES\[r\.explicit\]/.test(settingsSrc))
  check('settings.js says something when the list is empty (a blank panel reads as all-granted)',
    /permsNone/.test(settingsSrc) && /permsNone/.test(copySrc))
  check('wizard.js gates the FDA card on the tcc MODE, not on "the panel exists"',
    /permissionsPanel === 'tcc'/.test(wizardSrc))

  // The panel note must not tell a Linux user what macOS allows.
  check('copy.js permsNote is per-platform: no macOS in the linux/win renders',
    !/macOS/.test(evalCopy('linux').COPY.settings.permsNote) && !/macOS/.test(evalCopy('win32').COPY.settings.permsNote))
  check('...and darwin keeps its own sentence', /macOS/.test(evalCopy('darwin').COPY.settings.permsNote))
}

// The server seam: /api/permissions/status must never 500, and the platform
// must be BOUND rather than assumed.
{
  // The route calls probeAll with whatever it has. No argument, a null, a
  // junk platform -- none of it may throw, because the throw lands as a 500
  // and a blank permissions card reads as "everything is fine".
  for (const [label, call] of [
    ['no argument at all', () => probeAll()],
    ['a null deps bag', () => probeAll(null)],
    ['an empty deps bag', () => probeAll({})],
    ['a junk platform', () => probeAll({ platform: 12345 })],
  ]) {
    let threw = false
    let rows = null
    try { rows = call() } catch { threw = true }
    check(`probeAll(${label}) does not throw (the route's 500 guard)`, !threw && Array.isArray(rows))
    if (rows) check(`probeAll(${label}) fabricates nothing`, rows.every((r) => r.granted === 'indeterminate' || typeof r.granted === 'boolean'))
  }

  const serverSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  const routeSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'permissions.cjs'), 'utf8')
  // The route bodies are platform-blind on purpose; http-server binds the
  // host once, where HOST already exists. If a future edit made the route
  // require this module directly, the binding would be bypassed in silence
  // and every non-mac host would run darwin's table again.
  check('the route still goes through the injected permissionProbes (not its own require)',
    /permissionProbes\.probeAll\(/.test(routeSrc) && !/require\('\.\.\/permission-probes\.cjs'\)/.test(routeSrc))
  check('http-server binds the host platform into probeAll', /probeAll\(\{ platform: HOST\.id/.test(serverSrc))
  check('http-server serves the host row of the deep links, not the darwin constant',
    /DEEP_LINKS: permissionProbesModule\.deepLinksFor\(HOST\.id\)/.test(serverSrc))
  check('the explicit lanes are bound to the host platform too',
    /probeAutomation\(target, \{ platform: HOST\.id/.test(serverSrc) && /probeSudoVerified\(\{ platform: HOST\.id/.test(serverSrc))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
