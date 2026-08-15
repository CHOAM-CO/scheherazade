#!/usr/bin/env node
// test-identity-firewall.mjs — the Artaban bug stays dead (2026-08-15).
// Design: docs/design-identity-firewall-and-selfops.md.
//
// WHAT IT PROVES
//   Journal (memory/service.mjs):
//     1. a new entry is stamped with the CURRENT DISPLAY_NAME
//     2. after a rename, a predecessor's entry reads back TAGGED as an
//        inherited record (and `inherited: true`), never as own voice
//     3. an own-name entry reads back untouched (no tag, no flag)
//   Identity file (onboarding/agent-identity.cjs):
//     4. ensureIdentity creates .agent-identity for installs that predate it
//     5. recordRename appends the outgoing name to predecessors
//     6. ensureIdentity detects a config-name drift and records it as a rename
//   Harness (onboarding/harness-render.cjs via http-server exports):
//     7. system_prompt.md carries the standing identity line, and no raw
//        {PREDECESSOR_NOTE}/{UPDATE_BRIEF} placeholder survives rendering
//     8. predecessors listed in .agent-identity are named in the prompt
//     9. update brief: stale .last-briefed-version -> one-time notice block
//        naming both versions; stamp bumps; next render has NO notice
//    10. fresh stamp file -> no notice (an install is not an update)
//
// Run: node scripts/test-identity-firewall.mjs

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

const LIVE_HOME = path.join(os.homedir(), 'Documents', 'Scheherazade')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-identity-'))
if (path.resolve(SANDBOX) === path.resolve(LIVE_HOME)) {
  console.error('refusing to run against the live data home')
  process.exit(2)
}
process.env.AGENT_DATA_HOME = SANDBOX
process.env.SCHEHERAZADE_MEMORY_DB = path.join(SANDBOX, 'memory.db')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`PASS  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}`) }
}

function writeConfig(displayName) {
  fs.writeFileSync(
    path.join(SANDBOX, '.agent-config'),
    `ONBOARDING_COMPLETE="1"\nDISPLAY_NAME="${displayName}"\nTONE="casual"\nPRIMARY_TASK="test"\n`,
  )
}

// ── journal author stamping + inherited tagging ───────────────────────────
writeConfig('Artaban')
const service = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'memory', 'service.mjs')).href)
service.journalWrite({ date: '2026-08-01', body: 'first entry, written as Artaban', session: 't' })

writeConfig('Scheherazade') // the rename
service.journalWrite({ date: '2026-08-15', body: 'written as Scheherazade', session: 't' })

{
  const { rows } = service.journalRead({ from: '2026-08-01', to: '2026-08-15' })
  const old = rows.find((r) => r.date === '2026-08-01')
  const own = rows.find((r) => r.date === '2026-08-15')
  assert(old && old.author === 'Artaban', 'entry is stamped with the writer identity of its day')
  assert(old && old.inherited === true && old.body.startsWith('[inherited record'), 'predecessor entry reads back tagged as inherited')
  assert(old && old.body.includes('"Artaban"'), 'the tag names the predecessor')
  assert(own && own.author === 'Scheherazade' && !own.inherited && !own.body.startsWith('['), 'own entry reads back untouched')
}
service.close()

// ── .agent-identity lifecycle ──────────────────────────────────────────────
const identity = require('../onboarding/agent-identity.cjs')
{
  fs.rmSync(path.join(SANDBOX, '.agent-identity'), { force: true })
  const created = identity.ensureIdentity(SANDBOX, 'Artaban')
  assert(created.name === 'Artaban' && created.predecessors.length === 0, 'ensureIdentity creates the file for pre-feature installs')
  const renamed = identity.recordRename(SANDBOX, 'Scheherazade')
  assert(
    renamed.name === 'Scheherazade' && renamed.predecessors.length === 1 && renamed.predecessors[0].name === 'Artaban',
    'recordRename appends the outgoing name to predecessors',
  )
  const drifted = identity.ensureIdentity(SANDBOX, 'Dunyazade')
  assert(
    drifted.name === 'Dunyazade' && drifted.predecessors.some((p) => p.name === 'Scheherazade'),
    'ensureIdentity records a config-name drift as a rename',
  )
  const onDisk = identity.readIdentity(SANDBOX)
  assert(onDisk && onDisk.predecessors.length === 2, 'provenance survives on disk')
}

// ── harness render: identity line, predecessor note, update brief ─────────
// http-server resolves DATA_HOME from AGENT_DATA_HOME at require time (set
// above, same pattern as test-harness-refresh.mjs).
fs.rmSync(path.join(SANDBOX, '.agent-identity'), { force: true })
writeConfig('Scheherazade')
const server = require('../onboarding/http-server.cjs')
const APP_VERSION = require('../package.json').version
const PROMPT = path.join(SANDBOX, 'system_prompt.md')
const STAMP = path.join(SANDBOX, '.last-briefed-version')

{
  assert(server.refreshHarnessIfOnboarded(), 'harness refresh succeeds in sandbox')
  const prompt = fs.readFileSync(PROMPT, 'utf8')
  assert(prompt.includes('inherited archive from a previous agent'), 'standing identity line is rendered')
  assert(!prompt.includes('{PREDECESSOR_NOTE}') && !prompt.includes('{UPDATE_BRIEF}'), 'no raw placeholder survives rendering')
  assert(!prompt.includes('App update notice'), 'first render after install briefs nothing')
  assert(fs.readFileSync(STAMP, 'utf8').trim() === APP_VERSION, 'first render stamps the current version')
  const id = identity.readIdentity(SANDBOX)
  assert(id && id.name === 'Scheherazade', 'boot refresh (re)creates .agent-identity from config')
}

{
  // predecessor note
  fs.writeFileSync(
    path.join(SANDBOX, '.agent-identity'),
    JSON.stringify({ name: 'Scheherazade', since: '2026-08-15T00:00:00Z', predecessors: [{ name: 'Artaban', from: null, to: '2026-08-15T00:00:00Z' }] }),
  )
  // update brief: pretend last briefed on 0.0.1
  fs.writeFileSync(STAMP, '0.0.1\n')
  assert(server.refreshHarnessIfOnboarded(), 'second refresh succeeds')
  const prompt = fs.readFileSync(PROMPT, 'utf8')
  assert(prompt.includes('Known predecessor identities on this machine: Artaban'), 'predecessor note names Artaban')
  assert(prompt.includes('App update notice') && prompt.includes('from v0.0.1 to v' + APP_VERSION), 'stale stamp renders the one-time update notice')
  assert(fs.readFileSync(STAMP, 'utf8').trim() === APP_VERSION, 'rendering the notice bumps the stamp (respawn-spam latch)')
}

{
  assert(server.refreshHarnessIfOnboarded(), 'third refresh succeeds')
  const prompt = fs.readFileSync(PROMPT, 'utf8')
  assert(!prompt.includes('App update notice'), 'next render briefs nothing (one-time)')
  assert(prompt.includes('Known predecessor identities'), 'predecessor note is standing, not one-time')
}

// ── vector #2: user-global ~/.claude/CLAUDE.md exclusion (2026-08-16) ─────
// The 08-15 firewall guarded the journal; the live magi-win repro showed the
// operative vector was the machine-global user memory file (a retired
// agent's persona) auto-loaded by the claude CLI into every session. The
// migration must append claudeMdExcludes for that one file, idempotently,
// without disturbing user-added patterns.
{
  const SETTINGS = path.join(SANDBOX, '.claude', 'settings.local.json')
  const userClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md')
  server.seedConfigFromTemplates() // boot's settings seed + additive migration
  const s1 = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  assert(Array.isArray(s1.claudeMdExcludes) && s1.claudeMdExcludes.includes(userClaudeMd),
    'refresh appends claudeMdExcludes for the user-global CLAUDE.md')
  const countBefore = s1.claudeMdExcludes.length
  s1.claudeMdExcludes.push('/custom/user/pattern.md')
  fs.writeFileSync(SETTINGS, JSON.stringify(s1, null, 2) + '\n')
  server.seedConfigFromTemplates() // second boot over an edited config
  const s2 = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  assert(s2.claudeMdExcludes.includes('/custom/user/pattern.md'),
    'user-added exclude pattern survives the migration')
  assert(s2.claudeMdExcludes.filter((p) => p === userClaudeMd).length === 1 &&
    s2.claudeMdExcludes.length === countBefore + 1,
    'migration is idempotent (no duplicate entries on re-run)')
}

fs.rmSync(SANDBOX, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
