// permission-probes.cjs — permission-state probes, one table per platform
// (docs/permission-visibility-design.md; the internal proposal §P0, adopted
// 2026-07-15; the per-platform split is design-0023 P4).
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
// WHAT design-0023 P4 CHANGED, AND WHY. Everything above was written for one
// platform — the file's first line used to say "macOS permission-state
// probes" — and the panel was then hidden wholesale off macOS by a single
// `permissionsPanel: isMac` in platform.cjs. For TCC that is the right
// ANSWER and the wrong SHAPE: from outside, "we looked at Linux and there is
// nothing to probe" and "nobody ever wrote the branch" are the same thing,
// which is exactly the mac-else class of bug P4 exists to end. So the probe
// list is a TABLE keyed by platform, every platform has a row, and the
// Windows row is an EXPLICIT EMPTY LIST WITH ITS REASON WRITTEN DOWN — not
// an absent branch. The rule platform.cjs enforces holds here too: nothing
// is probed, and nothing is granted, by falling into an else. An unknown
// platform gets an empty list, never macOS's.
//
// Deps are injected for tests (fake fs/exec/electron); production callers
// pass the real ones. probeAutomation is separated from probeAll because an
// Automation probe SENDS an Apple event, which can pop the macOS consent
// dialog — that must only ever happen on an explicit user click, never on a
// status poll. `platform` is injected the same way (default process.platform)
// so all three tables are drivable from one host.

'use strict'

const DEEPLINK_BASE = 'x-apple.systempreferences:com.apple.preference.security'

// class -> Settings pane anchor, macOS row. SIP/sudo deliberately absent:
// there is no pane that fixes them, and offering a button that opens the
// wrong pane is the misroute P1's layer-split exists to prevent.
//
// This is the DARWIN row of DEEP_LINKS_BY_PLATFORM below and stays exported
// under its historical name for the callers that already had it. Anything
// that SERVES a payload must go through deepLinksFor(platform) instead —
// a Linux status response carrying x-apple.systempreferences: URLs would be
// the same lie in JSON that "this Mac" was in prose.
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

// sudo — two truthful tiers (the owner 2026-08-19 11:22: the row read Denied on a
// machine where onboarding had already collected and stored the admin
// password — the probe only knew about tier 1):
//   1. `sudo -n true` rc 0 -> passwordless sudo works right now.
//   2. else, if the app's askpass lane is armed (SUDO_ENABLED=yes AND a
//      sudo-pass blob in the vault) -> granted with kind 'stored': `sudo -A`
//      works through the app. Store-time verification is a safeStorage
//      round-trip, NOT a sudo run, so whether the password itself is RIGHT
//      is only proven by probeSudoVerified below (explicit click) — the row
//      says which tier it is via `kind` instead of flattening the difference.
// "sudo ran and exited nonzero" (execFileSync sets err.status) with no
// stored-key tier means a password would be required. Anything else —
// ENOENT, timeout kill, or an error with NO exit status (the probe
// machinery itself broke) — is "cannot measure", never a denial reading.
// sudoState is injected by the caller ({enabled, hasStored}); absent state
// degrades to tier-1-only, which is the pre-2026-08-19 behavior.
//
// NOT a macOS probe, and never was: `sudo`, the askpass helper and the whole
// stored-key lane are POSIX. platform.cjs already says so (`sudo: isMac ||
// isLinux`), so this function is the darwin AND the linux row of the table
// below, unchanged, running the same two tiers on both.
function probeSudo({ execFileSync, sudoState }) {
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'pipe', timeout: 3000 })
    return row('sudo', true, 'heuristic', { detail: 'passwordless' })
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.killed)) return row('sudo', 'indeterminate', 'heuristic', { detail: String(err.code || 'timeout') })
    if (sudoState && sudoState.enabled && sudoState.hasStored) {
      return row('sudo', true, 'stored', { detail: 'admin password stored in app; sudo -A via askpass' })
    }
    if (err && typeof err.status === 'number') return row('sudo', false, 'heuristic')
    return row('sudo', 'indeterminate', 'heuristic', { detail: String(err && err.message).slice(0, 120) })
  }
}

// sudo verify — EXPLICIT-TRIGGER ONLY (same contract as probeAutomation):
// actually runs `sudo -k -A true` through the app's askpass helper. `-k`
// drops the cached timestamp first so a stale grant cannot fake a pass —
// this is a real test of the STORED password. Never called from a status
// poll: a wrong stored password would write a PAM auth failure to the
// system log on every poll tick.
//
// Platform-gated like probeAutomation: on a host whose table has no sudo row
// (Windows — UAC, no askpass, nothing to verify) this must not shell out at
// all. `sudo` is not on PATH there, so the un-gated version would have
// answered ENOENT -> indeterminate, which is true but says "we tried" about
// a lane that does not exist here.
function probeSudoVerified({ execFileSync, askpassPath, env, platform = process.platform }) {
  if (!supports(platform, 'sudo')) {
    return row('sudo', 'indeterminate', 'heuristic', { detail: `no sudo lane on ${platform} — nothing to verify` })
  }
  try {
    execFileSync('sudo', ['-k', '-A', 'true'], {
      stdio: 'pipe', timeout: 15000,
      env: { ...(env || process.env), SUDO_ASKPASS: askpassPath },
    })
    return row('sudo', true, 'verified', { detail: 'sudo -A ran with the stored password just now' })
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.killed)) return row('sudo', 'indeterminate', 'heuristic', { detail: String(err.code || 'timeout') })
    if (err && typeof err.status === 'number') {
      return row('sudo', false, 'verified', { detail: 'sudo -A failed — stored password wrong, sudo disabled in settings, or askpass helper missing' })
    }
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

// keyring (Linux) — the desktop Secret Service that Electron safeStorage
// encrypts against. THE ONLY NON-MAC PROBE WITH A REAL WALL BEHIND IT.
//
// Why this is a permission row and not a nice-to-have: on Linux safeStorage
// is libsecret over org.freedesktop.secrets. With no keyring daemon running
// (a fresh WSL/Wayland/headless-ish box, or one where the login keyring was
// never unlocked) Chromium's OSCrypt falls back to the `basic_text` backend
// and the app's whole credential vault — every provider key, the Discord
// token, the stored sudo password — is either refused outright or
// obfuscated rather than encrypted. http-server.cjs's storeProviderKey
// already knows this: its refusal message on Linux says "this needs a
// running keyring, e.g. gnome-keyring or kwallet". Before this row, the user
// met that sentence for the first time at the moment they pasted an API key.
// This is the same information, one screen earlier, which is the entire
// point of the checklist.
//
// Two tiers, same shape as probeSudo's:
//   1. OFFICIAL — Electron's own safeStorage. getSelectedStorageBackend() is
//      Linux-only and names the backend Chromium picked; 'basic_text' is the
//      no-real-keyring case, 'unknown' is unknown and stays indeterminate.
//      isEncryptionAvailable() is the second half: a named backend the app
//      still cannot encrypt against is a denial, not a pass.
//   2. HEURISTIC — no safeStorage handle (dev-serve-ui.mjs, tests, any
//      non-Electron caller): ask the session bus whether anyone owns
//      org.freedesktop.secrets. One gdbus call, no side effects, ~20ms. No
//      gdbus, no session bus, or any other surprise => indeterminate. A
//      missing gdbus is NOT evidence of a missing keyring.
// Never a fabricated false in either tier.
function probeLinuxKeyring({ safeStorage, execFileSync, env }) {
  if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
    try {
      const available = safeStorage.isEncryptionAvailable() === true
      let backend = null
      if (typeof safeStorage.getSelectedStorageBackend === 'function') {
        backend = String(safeStorage.getSelectedStorageBackend() || '') || null
      }
      if (backend === 'unknown') {
        return row('keyring', 'indeterminate', 'official', { detail: 'Electron reports the password store as "unknown"' })
      }
      if (backend === 'basic_text') {
        // Named explicitly rather than folded into "unavailable": this is
        // the state where writes may SUCCEED and still not be encrypted.
        return row('keyring', false, 'official', { detail: 'no keyring service — safeStorage fell back to basic_text (not real encryption)' })
      }
      return row('keyring', available, 'official', { detail: backend || (available ? 'safeStorage reports encryption available' : 'safeStorage reports encryption unavailable') })
    } catch (err) {
      return row('keyring', 'indeterminate', 'official', { detail: String(err && err.message).slice(0, 120) })
    }
  }
  try {
    const out = String(execFileSync('gdbus', [
      'call', '--session',
      '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner',
      'org.freedesktop.secrets',
    ], { stdio: 'pipe', timeout: 3000, env: env || process.env }))
    if (/true/.test(out)) return row('keyring', true, 'heuristic', { detail: 'org.freedesktop.secrets has an owner on the session bus' })
    if (/false/.test(out)) return row('keyring', false, 'heuristic', { detail: 'nothing owns org.freedesktop.secrets on the session bus' })
    return row('keyring', 'indeterminate', 'heuristic', { detail: out.trim().slice(0, 120) })
  } catch (err) {
    return row('keyring', 'indeterminate', 'heuristic', { detail: String(err && (err.code || err.message)).slice(0, 120) })
  }
}

// ── the per-platform probe table ──────────────────────────────────────────
//
// One entry per probe:
//   class    the row id; must have a label in copy.js permsClassNames, or
//            the page skips it (unknown class = nothing honest to call it).
//   poll     the function a STATUS POLL may run: side-effect-free, no
//            dialogs, no auth attempts. null = this class exists but cannot
//            be measured without an explicit user click.
//   explicit which explicit-probe lane can DEEPEN this row on a click
//            ('automation' | 'sudo'), or null. The page reads this off the
//            row instead of hardcoding a class list, which is what it did
//            before: `r.class === 'automation' ? ... : r.class === 'sudo'`
//            in the renderer, and a client-side synthesized automation row
//            appended to every status response no matter the host.
//   when     optional predicate on the produced row — the explicit button
//            renders only if it returns true. sudo's Check runs the stored
//            password; offering it where there is no stored password is a
//            button that can only fail, the same misroute the missing SIP
//            pane button exists to avoid.
//
// panelMode is what platform.cjs's `permissionsPanel` becomes: false when
// the list is empty, otherwise a name for WHICH kind of panel this is, so
// the page can tell a TCC host (Full Disk Access card in the wizard, deep
// links into System Settings) from a POSIX one without asking the platform
// id again.
const PROBE_TABLE = {
  // macOS: TCC end to end, plus the two POSIX rows (sudo) and the one fixed
  // system condition (SIP). Unchanged from the pre-P4 list except that
  // automation is now a declared row rather than something the browser
  // invented after the fetch.
  darwin: {
    panelMode: 'tcc',
    deepLinks: DEEP_LINKS,
    probes: [
      { class: 'fda', poll: probeFda, explicit: null },
      { class: 'screen', poll: probeScreen, explicit: null },
      { class: 'accessibility', poll: probeAccessibility, explicit: null },
      { class: 'sudo', poll: probeSudo, explicit: 'sudo', when: (r) => r.kind === 'stored' || r.kind === 'verified' },
      { class: 'sip', poll: probeSip, explicit: null },
      // No poll BY DESIGN: the probe sends an Apple event and can pop the
      // consent dialog, so it fires from its own button and nowhere else.
      // The row still ships as 'indeterminate' so the class is visible in
      // the checklist (and in permission-status.json, where the session-start
      // hook counts only granted===false as a wall, so an unmeasured row
      // cannot become a false alarm).
      { class: 'automation', poll: null, kind: 'heuristic', explicit: 'automation' },
    ],
  },

  // Windows: DELIBERATELY EMPTY. This row is the point of the table — it is
  // an answer, not a gap.
  //
  // There is no TCC analogue: no Full Disk Access, no Screen Recording
  // grant, no Accessibility trust list, no Automation consent, no SIP. sudo
  // does not exist either (elevation is UAC, per-process at launch, and the
  // askpass helper is a bash script — platform.cjs sudo: false).
  // safeStorage is DPAPI, which is always available to the logged-in user
  // and has no daemon to be missing, so the keyring row below has no
  // Windows twin.
  //
  // Candidates considered and REFUSED, each for a stated reason rather than
  // by omission:
  //   - Defender Controlled Folder Access. A real wall in principle: DATA_HOME
  //     is under ~/Documents, exactly the tree CFA guards, and a blocked app
  //     gets EACCES on write. Refused because by the time this panel renders,
  //     the server has already written .agent-config, the memory DB and
  //     permission-status.json into that directory — the probe could only
  //     ever report the success we can already see, and a row that is
  //     structurally incapable of saying "no" is decoration.
  //   - "Run as administrator" / UAC elevation state. Nothing in the app
  //     asks for elevation, so a row would answer a question no feature asks.
  //   - Firewall rules for the loopback onboarding server. The page issuing
  //     the probe is itself served by that server; if it were blocked there
  //     would be no page.
  win32: { panelMode: false, deepLinks: {}, probes: [] },

  // Linux: NOT empty. Two rows, both with a feature behind them.
  //
  // Candidates considered and REFUSED:
  //   - xdotool / wmctrl / ImageMagick `import` for window capture (the one
  //     the design doc floats: "Windowshot on Linux (xdotool/import) =
  //     optional, last"). It IS probed on Linux — as platform.cjs's
  //     `windowCapture`, which resolves the enumerator and the capture path
  //     and gates the windowshot skill seed on the answer. Refused HERE
  //     because that would be a second source of truth for one boolean, and
  //     because it is a different KIND of fact: every other row in this panel
  //     is a grant the user goes somewhere and gives (or a fixed system
  //     condition), while this one is "a package is not installed", which the
  //     app already answers through the capability table and the install
  //     pages. Note the mac row named `screen` is not the counter-example it
  //     looks like: that is the Screen Recording TCC grant, not "is
  //     screencapture on disk".
  //   - AppArmor's unprivileged-userns restriction (Ubuntu 24.04's
  //     kernel.apparmor_restrict_unprivileged_userns, the sysctl that makes
  //     Electron AppImages need --no-sandbox). Refused for the same reason
  //     as Windows CFA: the app is running, so it is already past that wall,
  //     and the row could never read anything but "fine" on a machine where
  //     anyone can see it.
  //   - SELinux/Flatpak portals. Not a lane this build uses at all.
  //   - A `csrutil`-shaped "is the system immutable" info row. There is no
  //     single Linux fact that answers it and inventing one would be the
  //     fabricated-reading failure this file exists to prevent.
  linux: {
    panelMode: 'posix',
    deepLinks: {}, // no OS Settings deep-link scheme exists; the fixes are shell/desktop-session work
    probes: [
      { class: 'sudo', poll: probeSudo, explicit: 'sudo', when: (r) => r.kind === 'stored' || r.kind === 'verified' },
      { class: 'keyring', poll: probeLinuxKeyring, explicit: null },
    ],
  },
}

// An unrecognised platform gets the EMPTY table, never darwin's. Same rule
// as platform.cjs: no capability is granted by falling into an else.
const EMPTY_ENTRY = Object.freeze({ panelMode: false, deepLinks: {}, probes: [] })
function entryFor(platform) {
  return PROBE_TABLE[platform] || EMPTY_ENTRY
}

// The class ids this platform probes at all, in render order.
function probeClassesFor(platform) {
  return entryFor(platform).probes.map((p) => p.class)
}

// Does this platform probe this class? Used by the explicit-trigger probes
// so a click that reaches the wrong host answers "not a lane here" instead
// of shelling out to a binary that is not supposed to exist.
function supports(platform, cls) {
  return entryFor(platform).probes.some((p) => p.class === cls)
}

// The deep links to SERVE for this platform. Empty everywhere but darwin —
// Windows Settings' ms-settings: scheme has no privacy pane matching any row
// we probe (we probe none), and Linux has no cross-desktop scheme at all.
function deepLinksFor(platform) {
  return entryFor(platform).deepLinks
}

// What platform.cjs's `permissionsPanel` reads. false when there is nothing
// to show — so "hide the panel" is DERIVED from the empty list rather than
// hand-maintained beside it and left to drift.
function panelModeFor(platform) {
  const entry = entryFor(platform)
  return entry.probes.length > 0 ? entry.panelMode : false
}

// The prompt-free table for one platform. One broken probe must never take
// down the rest — each is independently caught above, and this wrapper
// catches even a synchronous surprise so /api/permissions/status can never
// 500 into a blank card (a blank reads as "all fine", the one lie this
// feature exists to kill).
//
// The catch keeps the probe's own class rather than reporting 'unknown':
// the page skips rows it has no label for, so an 'unknown' row DISAPPEARED
// from the checklist — the failure mode was a silently shorter list, which
// reads exactly like "that permission is fine".
function probeAll(deps) {
  const { platform = process.platform } = deps || {}
  const probes = entryFor(platform).probes
  return probes.map((p) => {
    let r
    if (p.poll) {
      try {
        r = p.poll(deps)
      } catch (err) {
        r = row(p.class, 'indeterminate', p.kind || 'heuristic', { detail: String(err && err.message) })
      }
    } else {
      r = row(p.class, 'indeterminate', p.kind || 'heuristic', { detail: 'not measured on a status poll — use the explicit check' })
    }
    // The row carries its own explicit-probe lane, so the renderer needs no
    // per-class knowledge. `when` is evaluated against the produced row, not
    // guessed by the page.
    if (p.explicit && (!p.when || p.when(r) === true)) r.explicit = p.explicit
    return r
  })
}

// Automation — per-target, EXPLICIT-TRIGGER ONLY (sends a real Apple event;
// may pop the consent dialog — which is the desired behavior on a user
// click: the dialog IS how the grant happens). -1743 = denied, -1712 =
// timeout (indeterminate — target app busy/unresponsive proves nothing,
// same caveat P1 ships), success = granted.
//
// Platform-gated: the route that reaches here is registered on every host
// (route tables are not per-platform), so a POST from a Linux page would
// otherwise run `osascript` and report ENOENT. "There is no Automation
// concept on this platform" and "the osascript binary is missing" are
// different sentences and the row says which one it is.
function probeAutomation(target, { execFileSync, platform = process.platform }) {
  if (!supports(platform, 'automation')) {
    return row('automation', 'indeterminate', 'heuristic', { target: String(target || ''), detail: `no Apple-event automation on ${platform}` })
  }
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

module.exports = {
  probeAll,
  probeAutomation,
  probeSudoVerified,
  DEEP_LINKS,
  PROBE_TABLE,
  probeClassesFor,
  deepLinksFor,
  panelModeFor,
  supports,
}
