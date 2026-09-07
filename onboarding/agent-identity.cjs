'use strict'
// onboarding/agent-identity.cjs — identity provenance for a renameable agent.
//
// Born from the identity-bleed bug (2026-08-15, the owner field report): DATA_HOME is
// deliberately fixed and DISPLAY_NAME is user-renameable, so first-person
// records (the journal above all) survive renames with no provenance — the
// live agent read a predecessor's journal and started calling HERSELF by the
// predecessor's name. Design: docs/design-identity-firewall-and-selfops.md.
//
// This module owns exactly one file, DATA_HOME/.agent-identity:
//   { name, since, predecessors: [{ name, from, to }] }
//
// - ensureIdentity() runs at boot (harness refresh): creates the file for
//   installs that predate it, stamped with the CURRENT DISPLAY_NAME. It
//   never guesses names for the past — an install renamed before this
//   feature existed keeps its history untagged (the standing system-prompt
//   identity line covers that residue; see the design doc's backfill
//   reasoning).
// - recordRename() is called by POST /api/settings/rename in the same
//   request that rewrites DISPLAY_NAME: the outgoing name is appended to
//   predecessors and name/since move to the new identity.
//
// Same tmp+rename write discipline as .agent-config (readers in other
// processes; a half-written identity file must be impossible).

const fs = require('node:fs')
const path = require('node:path')

const IDENTITY_BASENAME = '.agent-identity'

function identityPathFor(dataHome) {
  return path.join(dataHome, IDENTITY_BASENAME)
}

function readIdentity(dataHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(identityPathFor(dataHome), 'utf8'))
    if (!parsed || typeof parsed.name !== 'string') return null
    if (!Array.isArray(parsed.predecessors)) parsed.predecessors = []
    return parsed
  } catch {
    return null
  }
}

function writeIdentity(dataHome, identity) {
  const dst = identityPathFor(dataHome)
  const tmp = `${dst}.tmp`
  fs.mkdirSync(dataHome, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n')
  fs.renameSync(tmp, dst)
  return identity
}

// Boot-time: create-if-missing, and keep `name` synced with DISPLAY_NAME.
// A name drift found here WITHOUT a recordRename() having run means the
// config was renamed by something that bypassed the settings route (hand
// edit, older app version): record it as a rename rather than silently
// adopting — provenance is the whole point.
function ensureIdentity(dataHome, currentName) {
  const existing = readIdentity(dataHome)
  if (!existing) {
    return writeIdentity(dataHome, {
      name: currentName,
      since: new Date().toISOString(),
      predecessors: [],
    })
  }
  if (existing.name !== currentName) {
    return recordRename(dataHome, currentName)
  }
  return existing
}

function recordRename(dataHome, newName) {
  const now = new Date().toISOString()
  const existing = readIdentity(dataHome)
  if (!existing) {
    // Renaming with no identity file: nothing recorded about the outgoing
    // name (we refuse to guess), start clean under the new one.
    return writeIdentity(dataHome, { name: newName, since: now, predecessors: [] })
  }
  if (existing.name === newName) return existing
  existing.predecessors.push({ name: existing.name, from: existing.since || null, to: now })
  existing.name = newName
  existing.since = now
  return writeIdentity(dataHome, existing)
}

module.exports = { readIdentity, ensureIdentity, recordRename, identityPathFor, IDENTITY_BASENAME }
