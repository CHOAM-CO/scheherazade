// permission-probes.cjs — macOS permission-state probes for the P0 checklist
// (docs/permission-visibility-design.md; 춘식3 proposal §P0, adopted 2026-07-15).
//
// Every probe answers one question: "if the agent tries this class of work
// RIGHT NOW, does it hit a wall?" Three hard facts shape everything here
// (inherited from the FDA onboarding block, http-server.cjs 2026-07-07):
//
//   1. Most TCC classes have NO official status API (Apple DTS: "attempt the
//      operation and handle the error") — those probes are HEURISTIC and say
//      so in their row (`kind`), so the UI can render ❓ instead of lying
//      with a clean ✅/❌.
//   2. TCC caches at process launch for file-access classes — a grant is
//      invisible to THIS process until app relaunch (`needsRelaunch`).
//      getMediaAccessStatus / isTrustedAccessibilityClient read live state.
//   3. When a probe itself breaks, the row is 'indeterminate' — NEVER a
//      fabricated false. A meter that fails must say "cannot measure", not
//      invent a reading (same rule the autonomy token meter ships under;
//      the fleet's usage-monitor false-recovery incident is the ancestor).
//
// Deps are injected for tests (fake fs/exec/electron); production callers
// pass the real ones. probeAutomation is separated from probeAll because an
// Automation probe SENDS an Apple event, which can pop the macOS consent
// dialog — that must only ever happen on an explicit user click, never on a
// status poll.

'use strict'

const DEEPLINK_BASE = 'x-apple.systempreferences:com.apple.preference.security'

// class -> Settings pane anchor. SIP/sudo deliberately absent: there is no
// pane that fixes them, and offering a button that opens the wrong pane is
// the misroute P1's layer-split exists to prevent.
const DEEP_LINKS = {
  fda: `${DEEPLINK_BASE}?Privacy_AllFiles`,
  screen: `${DEEPLINK_BASE}?Privacy_ScreenCapture`,
  accessibility: `${DEEPLINK_BASE}?Privacy_Accessibility`,
  automation: `${DEEPLINK_BASE}?Privacy_Automation`,
}

// One row per probe. granted: true | false | 'indeterminate'.
function row(cls, granted, kind, extra = {}) {
  return { class: cls, granted, kind, needsRelaunch: false, ...extra }
}

// FDA — heuristic file read, verbatim from the 2026-07-07 onboarding block:
// TimeMachine.plist over TCC.db (the latter false-negatives on
// 700-permission systems). ENOENT is NOT a denial — a machine without the
// plist proves nothing, so it reads 'indeterminate' rather than a fabricated
// false (readFileSync throws the same shape either way; errno tells them apart).
function probeFda({ readFileSync }) {
  try {
    readFileSync('/Library/Preferences/com.apple.TimeMachine.plist')
    return row('fda', true, 'heuristic', { needsRelaunch: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return row('fda', 'indeterminate', 'heuristic', { needsRelaunch: true, detail: 'probe file missing on this machine' })
    // Real fs denials carry an errno code (EPERM/EACCES). An error WITHOUT
    // one means the probe machinery itself broke (e.g. dep missing) --
    // that's "cannot measure", never a denial reading.
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return row('fda', false, 'heuristic', { needsRelaunch: true })
    return row('fda', 'indeterminate', 'heuristic', { needsRelaunch: true, detail: String(err && (err.code || err.message)).slice(0, 120) })
  }
}

// Screen Recording — official Electron API, live state.
function probeScreen({ systemPreferences }) {
  try {
    const s = systemPreferences.getMediaAccessStatus('screen')
    if (s === 'granted') return row('screen', true, 'official')
    if (s === 'denied' || s === 'restricted') return row('screen', false, 'official')
    return row('screen', 'indeterminate', 'official', { detail: s }) // 'not-determined' etc.
  } catch (err) {
    return row('screen', 'indeterminate', 'official', { detail: String(err && err.message) })
  }
}

// Accessibility — official Electron API. `false` arg = query WITHOUT
// prompting (the prompting variant belongs to an explicit user action, and
// today no flow needs it).
function probeAccessibility({ systemPreferences }) {
  try {
    return row('accessibility', systemPreferences.isTrustedAccessibilityClient(false) === true, 'official')
  } catch (err) {
    return row('accessibility', 'indeterminate', 'official', { detail: String(err && err.message) })
  }
}

// sudo — `sudo -n true`: rc 0 means passwordless sudo is available right
// now. "sudo ran and exited nonzero" (execFileSync sets err.status) means a
// password would be required. Anything else — ENOENT, timeout kill, or an
// error with NO exit status (the probe machinery itself broke) — is
// "cannot measure", never a denial reading.
function probeSudo({ execFileSync }) {
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'pipe', timeout: 3000 })
    return row('sudo', true, 'heuristic')
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.killed)) return row('sudo', 'indeterminate', 'heuristic', { detail: String(err.code || 'timeout') })
    if (err && typeof err.status === 'number') return row('sudo', false, 'heuristic')
    return row('sudo', 'indeterminate', 'heuristic', { detail: String(err && err.message).slice(0, 120) })
  }
}

// SIP — informational only. There is no toggle to offer (csrutil lives in
// Recovery), so the row exists purely so the checklist can say "고정 조건"
// instead of the agent rediscovering it one EPERM at a time.
function probeSip({ execFileSync }) {
  try {
    const out = String(execFileSync('csrutil', ['status'], { stdio: 'pipe', timeout: 3000 }))
    if (/enabled/i.test(out)) return row('sip', true, 'info')
    if (/disabled/i.test(out)) return row('sip', false, 'info')
    return row('sip', 'indeterminate', 'info', { detail: out.trim().slice(0, 120) })
  } catch (err) {
    return row('sip', 'indeterminate', 'info', { detail: String(err && err.message).slice(0, 120) })
  }
}

// The prompt-free table. One broken probe must never take down the rest —
// each is independently caught above, and this wrapper catches even a
// synchronous surprise so /api/permissions/status can never 500 into a
// blank card (a blank reads as "all fine", the one lie this feature exists
// to kill).
function probeAll(deps) {
  const probes = [probeFda, probeScreen, probeAccessibility, probeSudo, probeSip]
  return probes.map((p) => {
    try {
      return p(deps)
    } catch (err) {
      return row('unknown', 'indeterminate', 'heuristic', { detail: String(err && err.message) })
    }
  })
}

// Automation — per-target, EXPLICIT-TRIGGER ONLY (sends a real Apple event;
// may pop the consent dialog — which is the desired behavior on a user
// click: the dialog IS how the grant happens). -1743 = denied, -1712 =
// timeout (indeterminate — target app busy/unresponsive proves nothing,
// same caveat P1 ships), success = granted.
function probeAutomation(target, { execFileSync }) {
  const t = String(target || 'System Events')
  try {
    execFileSync('osascript', ['-e', `tell application "${t.replace(/"/g, '')}" to count windows`], { stdio: 'pipe', timeout: 10000 })
    return row('automation', true, 'heuristic', { target: t })
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || '')
    if (/-1743|Not authorized to send Apple events/i.test(msg)) return row('automation', false, 'heuristic', { target: t })
    if (/-1712/.test(msg)) return row('automation', 'indeterminate', 'heuristic', { target: t, detail: 'timeout (-1712) — denial not proven' })
    return row('automation', 'indeterminate', 'heuristic', { target: t, detail: msg.trim().slice(0, 120) })
  }
}

module.exports = { probeAll, probeAutomation, DEEP_LINKS }
