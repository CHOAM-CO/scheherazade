// tcc-probe.cjs — macOS TCC (Transparency, Consent, and Control) folder-
// permission trigger for Documents/Downloads/Desktop (the owner directive,
// 2026-07-05: onboarding must grab read+write to all three; the app
// process must actually TOUCH each folder so macOS raises its native
// permission prompt -- listing an NSXFolderUsageDescription string in
// package.json's build.mac.extendInfo alone does NOT trigger a TCC prompt;
// macOS only asks the first time a process actually performs a file
// operation (open/read/write/readdir) inside one of the protected
// directories -- Documents/Downloads/Desktop/iCloud Drive/etc are TCC-gated
// on modern macOS the same way Contacts/Calendars are).
//
// Electron-free by design (see provider-env.cjs's own header comment for the
// exact same reasoning that applies here): main.cjs cannot be
// `require()`d directly outside a running Electron main process (it calls
// `app.requestSingleInstanceLock()` at module top level), so any logic that
// should be unit-testable has to live in its own plain-CommonJS file and get
// `require()`d BY main.cjs, not embedded IN it.
//
// Contract: `probeUserFolders({ homedir, log })` -> per-folder result
// summary object, e.g.:
//   { Documents: { folder, granted: true },
//     Downloads: { folder, granted: false, error: 'EPERM: ...' },
//     Desktop:   { folder, granted: true } }
//
// FAIL LOUD but NEVER THROW: a denied/missing folder is logged (via the
// injected `log`) with the folder path and the underlying error, but must
// never crash app startup -- TCC denial is an expected, recoverable steady
// state (user can deny once, retry, or fix it later in System Settings ->
// Privacy & Security), not a fatal condition for the rest of the app.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Fixed, obviously-scheherazade-owned name so a user (or Finder) who
// stumbles on it mid-probe can tell at a glance what it is; deleted again
// immediately after the read succeeds, in every code path that reaches that
// far (success or read/delete failure -- see probeOneFolder below).
const PROBE_FILENAME = '.scheherazade-tcc-probe'
const PROBE_CONTENTS = 'scheherazade tcc probe -- safe to delete\n'

// The 3 folders the owner's directive names. Order matters only for log
// readability (Documents first, matching the existing
// NSDocumentsFolderUsageDescription's precedent as "the one that already
// worked").
const USER_FOLDERS = ['Documents', 'Downloads', 'Desktop']

/**
 * probeOneFolder(folderPath, log) -> { folder, granted, error? }
 *
 * Write -> read -> delete a tiny probe file inside `folderPath`. Never
 * throws: every failure (folder doesn't exist, TCC denial -> EPERM/EACCES,
 * anything else) is caught and returned as `{ granted: false, error }`
 * instead of propagating.
 */
function probeOneFolder(folderPath, log) {
  const probePath = path.join(folderPath, PROBE_FILENAME)
  try {
    fs.writeFileSync(probePath, PROBE_CONTENTS)
    fs.readFileSync(probePath, 'utf8')
    fs.unlinkSync(probePath)
    log(`[tcc-probe] granted: ${folderPath}`)
    return { folder: folderPath, granted: true }
  } catch (err) {
    // Fail-loud logging (not a throw) -- see this file's header comment.
    // Covers both "TCC denied" (EPERM/EACCES) and any other unexpected
    // failure (folder missing, read-only filesystem, etc) with the same
    // shape, since the caller only needs to know "did we get in or not" plus
    // enough detail to diagnose which.
    log(`[tcc-probe] DENIED/FAILED: ${folderPath} -- ${err && err.message ? err.message : err}`)
    return { folder: folderPath, granted: false, error: err && err.message ? err.message : String(err) }
  }
}

/**
 * probeUserFolders({ homedir, log }) -> { Documents, Downloads, Desktop }
 *
 * `homedir` -- injected (not read via os.homedir() internally) so this stays
 * unit-testable against a scratch directory instead of the real user's home.
 * `log` -- injected logging function (defaults to a no-op if omitted/not a
 * function), so callers can route this into their own fail-loud console
 * logging (see main.cjs's wiring at app.whenReady()).
 *
 * Idempotent and safe to call on every boot: each folder gets a fresh
 * write->read->delete, leaving no residue on success, and never throws
 * regardless of how many (or all) of the 3 folders are denied/missing.
 */
function probeUserFolders({ homedir, log } = {}) {
  const doLog = typeof log === 'function' ? log : () => {}
  const results = {}
  for (const name of USER_FOLDERS) {
    const folderPath = path.join(homedir, name)
    try {
      results[name] = probeOneFolder(folderPath, doLog)
    } catch (err) {
      // Defense in depth -- probeOneFolder() itself never throws today, but
      // this outer guard means a future change to it that accidentally
      // reintroduces a throw still can't crash app startup, matching this
      // file's own "NEVER throw" contract at the probeUserFolders level too.
      doLog(`[tcc-probe] DENIED/FAILED (unexpected): ${folderPath} -- ${err && err.message ? err.message : err}`)
      results[name] = { folder: folderPath, granted: false, error: err && err.message ? err.message : String(err) }
    }
  }
  return results
}

module.exports = {
  probeUserFolders,
  USER_FOLDERS,
  PROBE_FILENAME,
}
