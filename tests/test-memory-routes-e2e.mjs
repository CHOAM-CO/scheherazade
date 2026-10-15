#!/usr/bin/env node
// test-memory-routes-e2e.mjs -- the memory-group HTTP routes over the REAL
// server (issue #9, PR-1). Module fixtures do not prove the wire: route
// order, the auth gate, and the JSON shape live here and nowhere else (same
// rationale as test-journal-e2e.cjs, which covers only the journal pair --
// until this file, the category-table, pointer, and session-events routes
// had NO real-server coverage at all, and PR-1 is exactly the change that
// rewired their internals, so this is the PR that owes the coverage).
//
// Hermetic on purpose: HOME points at a fixture home BEFORE anything is
// imported, because POST /api/memory/import walks os.homedir() (pointer
// scan). The test must never read the developer's real dotfiles, and the
// scan result must be deterministic (exactly one fixture CLAUDE.md).
//
// Run: node tests/test-memory-routes-e2e.mjs

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-memroutes-'))

const fixtureHome = path.join(tmp, 'home')
fs.mkdirSync(path.join(fixtureHome, '.claude'), { recursive: true })
fs.writeFileSync(
  path.join(fixtureHome, '.claude', 'CLAUDE.md'),
  '# Fixture Memory\n\nnot a secret, just a heading to point at\n',
)
process.env.HOME = fixtureHome
// USERPROFILE too, or this is not hermetic on Windows: os.homedir() reads
// USERPROFILE there and ignores HOME entirely, so the scan walked the REAL
// home and found 200 files instead of the single fixture CLAUDE.md
// (2026-08-04 win suite). Setting both keeps one code path for both platforms.
process.env.USERPROFILE = fixtureHome
process.env.AGENT_DATA_HOME = path.join(tmp, 'data')
fs.mkdirSync(process.env.AGENT_DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')

// require() AFTER the env block above -- http-server reads AGENT_DATA_HOME
// and the service reads SCHEHERAZADE_MEMORY_DB at module load, once.
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createOnboardingServer, SERVER_TOKEN } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
// Same URL shape http-server's own dynamic import uses, so this is the SAME
// module instance (and the same singleton connection) the routes run on.
const service = await import(pathToFileURL(path.join(ROOT, 'memory', 'service.mjs')).href)

let pass = 0
let fail = 0
const chk = (n, c, d) => {
  if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) }
}

// A populated sibling with colliding ids must never feed the editable own panel.
const siblingHome = path.join(tmp, 'Scheherazade-sibling')
fs.mkdirSync(siblingHome)
fs.writeFileSync(path.join(siblingHome, '.agent-config'), 'PROFILE=sibling\nDISPLAY_NAME=Sibling\n')
const siblingFile = path.join(siblingHome, 'memory.db')
const siblingDb = new DatabaseSync(siblingFile)
siblingDb.exec(service.DDL)
const siblingFact = service.memoryWrite(siblingDb, { table: 'user_facts', data: { subject: 'user', predicate: 'game', value: 'sibling Minecraft', source_session: 'fixture' } })
service.memoryWrite(siblingDb, { table: 'open_threads', data: { summary: 'sibling thread', opened_session: 'fixture' } })
service.memoryWrite(siblingDb, { table: 'preferences', data: { key: 'sibling preference', value: 'sibling short', source_session: 'fixture' } })
service.memoryWrite(siblingDb, { table: 'corrections', data: { what_was_wrong: 'sibling wrong', correct_behavior: 'sibling right', corrected_session: 'fixture' } })
siblingDb.exec("INSERT INTO journal_entries(date,body,created_at,updated_at) VALUES('2026-10-15','sibling journal','2026-10-15','2026-10-15')")
siblingDb.close()
const siblingBytes = fs.readFileSync(siblingFile)

const srv = await createOnboardingServer()
const port = srv.server.address().port
const base = `http://127.0.0.1:${port}`

try {
  // The token the way the browser gets it: injected into the page head.
  // Token from the module export (2026-08-07): the page-scrape this used is
  // the closed bypass — bare HTML 403s now (pinned in route-dispatch-e2e).
  const token = SERVER_TOKEN
  const auth = { 'x-onboard-token': token }

  for (const table of ['user_facts', 'open_threads', 'preferences', 'corrections']) {
    const result = await (await fetch(`${base}/api/memory/${table}`, { headers: auth })).json()
    chk(`empty own ${table} excludes sibling rows`, result.rows.length === 0 && result.ownerProfile === 'data')
  }
  const emptyEvents = await (await fetch(`${base}/api/memory/session-events`, { headers: auth })).json()
  chk('empty own session feed excludes sibling audit events', emptyEvents.events.length === 0 && emptyEvents.date === null)
  const pending = await (await fetch(`${base}/api/pending-signal`, { headers: auth })).json()
  chk('own pending count excludes sibling corrections', pending.sources.corrections === 0)
  const emptyJournal = await (await fetch(`${base}/api/journal`, { headers: auth })).json()
  chk('own journal excludes sibling journal', emptyJournal.rows.length === 0)
  const siblingPanel = await (await fetch(`${base}/api/memory/siblings?search=sibling`, { headers: auth })).json()
  chk('sibling block alone contains all five sibling categories', siblingPanel.siblings[0].material.count === 5 && siblingPanel.siblings[0].material.rows.length === 5)
  const merged = service.query({ table: 'user_facts' })
  chk('agent query remains merged with provenance', merged.rows.length === 1 && merged.rows[0].owner_profile === 'Scheherazade-sibling')
  chk('agent recall remains merged with provenance', service.recallMaterial({ topic: 'Minecraft' }).user_facts.some(row => row.owner_profile === 'Scheherazade-sibling'))
  const missingOwnDelete = await fetch(`${base}/api/memory/user_facts/${siblingFact.id}`, { method: 'DELETE', headers: auth })
  chk('deleting sibling-only id returns 404, not 500', missingOwnDelete.status === 404)
// Seed one category row through the service API -- the same code path the
// routes use, so what the wire returns below is a genuine read-back.
const seeded = service.write({
  table: 'user_facts',
  data: { subject: 'user', predicate: 'name', value: 'e2e-probe', source_session: 'sess-e2e' },
})
chk('seed write landed (service API, singleton connection)', seeded.mode === 'insert' && seeded.id > 0, JSON.stringify(seeded))

  chk('fixture deliberately collides own and sibling ids', seeded.id === siblingFact.id)
  const ownFeed = await (await fetch(`${base}/api/memory/session-events`, { headers: auth })).json()
  chk('colliding session preview resolves only own row', ownFeed.events.length === 1 && ownFeed.events[0].preview?.value === 'e2e-probe')
  const foreignDelete = await fetch(`${base}/api/memory/user_facts/${seeded.id}?owner_profile=Scheherazade-sibling`, { method: 'DELETE', headers: auth })
  chk('sibling-scoped delete cannot delete colliding own id', foreignDelete.status === 400 && service.queryOwn({ table: 'user_facts' }).rows[0].value === 'e2e-probe')
  for (const operation of ['remove', 'confirm', 'write']) {
    assert.throws(() => service[operation]({ table: 'user_facts', id: seeded.id, owner_profile: 'Scheherazade-sibling', data: { id: seeded.id, value: 'wrong owner' } }), error => error.code === 'sibling_read_only')
    chk(`sibling-scoped ${operation} is rejected before own-id lookup`, service.queryOwn({ table: 'user_facts' }).rows[0].value === 'e2e-probe')
  }
  chk('sibling database bytes unchanged by reads and rejected mutations', fs.readFileSync(siblingFile).equals(siblingBytes))

  // ── the 2026-08-04 boundary: reads are gated too ──────────────────────────
  const noTokRead = await fetch(`${base}/api/memory/user_facts`)
  chk('GET /api/memory/user_facts without a token is REFUSED (the whole point of the 08-04 gate)', noTokRead.status === 403, noTokRead.status)

  // ── category-table GET + the not-a-category-table refusal ────────────────
  const g1 = await fetch(`${base}/api/memory/user_facts`, { headers: auth })
  chk('GET /api/memory/user_facts is 200', g1.status === 200, g1.status)
  const facts = await g1.json()
  chk('returns the seeded row', facts.table === 'user_facts' && Array.isArray(facts.rows) && facts.rows.some((r) => r.id === seeded.id && r.value === 'e2e-probe'), JSON.stringify(facts))

  const g2 = await fetch(`${base}/api/memory/imported_pointers`, { headers: auth })
  chk('GET /api/memory/imported_pointers is 400 (pointers must never render as a memory category)', g2.status === 400, g2.status)
  const g3 = await fetch(`${base}/api/memory/journal_entries`, { headers: auth })
  chk('GET /api/memory/journal_entries is 400 (a day is not a memory table row)', g3.status === 400, g3.status)

  // ── auth gate on every mutating route in the group ───────────────────────
  const noTok1 = await fetch(`${base}/api/memory/user_facts/${seeded.id}`, { method: 'DELETE' })
  chk('DELETE row without a token is REFUSED', noTok1.status === 403, noTok1.status)
  const noTok2 = await fetch(`${base}/api/memory/import`, { method: 'POST' })
  chk('POST /api/memory/import without a token is REFUSED (the scan is consent-gated)', noTok2.status === 403, noTok2.status)
  const noTok3 = await fetch(`${base}/api/memory/pointers`, { method: 'DELETE' })
  chk('DELETE /api/memory/pointers without a token is REFUSED', noTok3.status === 403, noTok3.status)

  // ── pointer scan: import -> list -> clear, all over the wire ─────────────
  const imp = await fetch(`${base}/api/memory/import`, { method: 'POST', headers: auth })
  chk('POST /api/memory/import with the token is 200', imp.status === 200, imp.status)
  const impBody = await imp.json()
  chk('import found the fixture CLAUDE.md (hermetic HOME, deterministic scan)', impBody.ok === true && impBody.written === 1, JSON.stringify(impBody))
  chk('import returns coverage for every configured source (found-nothing included)', Array.isArray(impBody.coverage) && impBody.coverage.length >= 3, JSON.stringify(impBody.coverage))

  const pl = await fetch(`${base}/api/memory/pointers`, { headers: auth })
  chk('GET /api/memory/pointers is 200', pl.status === 200, pl.status)
  const plBody = await pl.json()
  chk('the pointer row is there, with provenance and the real path', plBody.rows.length === 1 && plBody.rows[0].source_tool === 'claude-code' && plBody.rows[0].path.endsWith('CLAUDE.md'), JSON.stringify(plBody.rows))
  chk('the pointer topic is headings-only (WHERE, never WHAT)', String(plBody.rows[0].topic).includes('Fixture Memory') && !String(plBody.rows[0].topic).includes('not a secret'), JSON.stringify(plBody.rows[0].topic))

  const clr = await fetch(`${base}/api/memory/pointers`, { method: 'DELETE', headers: auth })
  chk('DELETE /api/memory/pointers with the token is 200', clr.status === 200, clr.status)
  const plAfter = await (await fetch(`${base}/api/memory/pointers`, { headers: auth })).json()
  chk('the index is really gone (undoable privacy is not privacy)', plAfter.rows.length === 0, JSON.stringify(plAfter.rows))

  // ── row delete: wire success, audit trail, and fail-loud on a dead id ────
  const del = await fetch(`${base}/api/memory/user_facts/${seeded.id}`, { method: 'DELETE', headers: auth })
  chk('DELETE row with the token is 200', del.status === 200, del.status)
  const afterDel = await (await fetch(`${base}/api/memory/user_facts`, { headers: auth })).json()
  chk('the row is really gone', !afterDel.rows.some((r) => r.id === seeded.id), JSON.stringify(afterDel.rows))
  const audit = service.queryOwn({ table: 'memory_events', filter: { event: 'delete', row_id: seeded.id } })
  chk('the delete left its audit row (action auditable, content gone)', audit.count === 1, JSON.stringify(audit))

  const del404 = await fetch(`${base}/api/memory/user_facts/999999`, { method: 'DELETE', headers: auth })
  chk('deleting a nonexistent id fails LOUD over the wire (no silent 200)', del404.status >= 400, del404.status)

  // ── session events: shape over the real wire ─────────────────────────────
  const se = await fetch(`${base}/api/memory/session-events`, { headers: auth })
  chk('GET /api/memory/session-events is 200', se.status === 200, se.status)
  const seBody = await se.json()
  chk('session-events has the {date, events[]} shape (collapse semantics are test-session-feed.mjs\'s pin, not this one)', Array.isArray(seBody.events) && ('date' in seBody), JSON.stringify(seBody).slice(0, 200))

  // ── "What I remember" (Dreaming feature, 2026-08-16) ─────────────────────
  const noTokSummary = await fetch(`${base}/api/memory/summary`)
  chk('GET /api/memory/summary without a token is REFUSED', noTokSummary.status === 403, noTokSummary.status)

  const absent = await fetch(`${base}/api/memory/summary`, { headers: auth })
  chk('GET /api/memory/summary is 200 even when memory-summary.md does not exist yet', absent.status === 200, absent.status)
  const absentBody = await absent.json()
  chk('absent file reports {exists:false}, not a 404 (consolidation just hasn\'t run yet)', absentBody.exists === false, JSON.stringify(absentBody))

  const summaryMd = '# What I remember\n\n## About the user\n\n- likes tests that actually run\n'
  fs.writeFileSync(path.join(process.env.AGENT_DATA_HOME, 'memory-summary.md'), summaryMd)
  const present = await fetch(`${base}/api/memory/summary`, { headers: auth })
  chk('GET /api/memory/summary is 200 once the file exists', present.status === 200, present.status)
  const presentBody = await present.json()
  chk('returns the markdown verbatim', presentBody.exists === true && presentBody.markdown === summaryMd, JSON.stringify(presentBody).slice(0, 200))
  chk('updatedISO is a real, parseable timestamp', typeof presentBody.updatedISO === 'string' && Number.isFinite(Date.parse(presentBody.updatedISO)), presentBody.updatedISO)
} finally {
  srv.server.close()
  service.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
