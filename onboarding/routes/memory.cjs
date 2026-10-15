// onboarding/routes/memory.cjs -- memory & journal boundary routes (group 8) -- calls memory/service.mjs via getMemoryService, nothing else
// (issue #9 PR-2 route grouping).
//
// Route BODIES ONLY, moved verbatim (comments included) from
// onboarding/http-server.cjs's old handleApi if-chain. Helper functions,
// constants, and mutable singletons STAY in http-server.cjs with exactly one
// owner; this file binds what its bodies need ONCE from staticCtx (one
// destructuring statement, below). Per-call values -- agentControls,
// onOnboardingComplete, the live askpassToken getter -- arrive via callCtx
// on every request (see http-server.cjs handleApi). The returned array's
// order IS the dispatch order and preserves the old chain's intra-group
// order exactly.
// ORDER RULE (real intra-group collision risk): the specific literal blocks
// (/api/memory/session-events, /api/memory/import, /api/memory/pointers) MUST
// stay dispatched BEFORE the /api/memory/:table regex below -- the regex
// ^/api/memory/([a-z_]+)$ would swallow 'import'/'pointers' otherwise.
'use strict'

function createRoutes(staticCtx) {
  const {
    fs, path, sendJson, readJsonBody, getSessionEvents, getMemoryService, CATEGORY_TABLES, DATA_HOME,
  } = staticCtx
  return [
    {
      method: 'GET', match: p => p === '/api/memory/siblings',
      handler: async (req, res) => {
        const service = await getMemoryService()
        const url = new URL(req.url, 'http://localhost')
        sendJson(res, 200, { ok: true, siblings: service.siblingMemory({ search: url.searchParams.get('search') || '' }) })
      },
    },
    {
      method: 'POST', match: p => p === '/api/memory/ai-import',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req, 6 * 1024 * 1024)
          const service = await getMemoryService()
          sendJson(res, 200, service.stageImport(body))
        } catch (err) { sendJson(res, 400, { error: err.message }) }
      },
    },
    {
      method: 'GET', match: p => p === '/api/memory/import-candidates',
      handler: async (req, res) => {
        const service = await getMemoryService()
        sendJson(res, 200, service.listPendingImports({ limit: 200 }))
      },
    },
    {
      method: 'POST', match: p => p === '/api/memory/import-candidates',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const service = await getMemoryService()
          sendJson(res, 200, service.resolveImport(body))
        } catch (err) { sendJson(res, 400, { error: err.message }) }
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/memory/session-events',
      handler: async (req, res, callCtx) => {
        const result = await getSessionEvents()
        sendJson(res, 200, result)
        return
      },
    },
    // ── "What I remember" (Dreaming feature, 2026-08-16) ──────────────────
    // Read-only over DATA_HOME/memory-summary.md, the file
    // procedures/memory-consolidation.md rewrites in full during the
    // nightly schedule turn. Missing file is not an error -- it means
    // consolidation hasn't run yet (fresh install, or autonomy never
    // enabled) -- so this returns 200/{exists:false}, never 404, same
    // "absence is a fact, not a fault" contract as the pointer/journal
    // routes above. Deliberately never writes: this page is a window onto
    // what the agent already wrote for itself, not a place the UI edits.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/memory/summary',
      handler: async (req, res, callCtx) => {
        const summaryPath = path.join(DATA_HOME, 'memory-summary.md')
        let stat
        try {
          stat = fs.statSync(summaryPath)
        } catch {
          sendJson(res, 200, { exists: false })
          return
        }
        const markdown = fs.readFileSync(summaryPath, 'utf8')
        sendJson(res, 200, { exists: true, markdown, updatedISO: stat.mtime.toISOString() })
        return
      },
    },
    // ── pointer index over other tools' local memory (v0.0.4 item d) ──────────
    // Three routes, and the gates live in the HTTP verbs themselves:
    //   POST   /api/memory/import   -- the scan. Runs ONLY here. There is no boot
    //                                  hook and no timer; the user's click IS the
    //                                  consent (the owner gate 1).
    //   GET    /api/memory/pointers -- what we hold, with provenance + coverage.
    //   DELETE /api/memory/pointers -- throw it all away. A privacy feature the
    //                                  user cannot undo is not a privacy feature.
    //
    // Note these are NOT reachable via the /api/memory/:table routes above:
    // imported_pointers is deliberately not in CATEGORY_TABLES, so it can never
    // be rendered as, or mistaken for, one of the agent's own memory categories.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/memory/import',
      handler: async (req, res, callCtx) => {
        const { scanPointers } = require('../../memory/pointer-scan.cjs')
        const service = await getMemoryService()
        const { pointers, coverage } = scanPointers({})
        // Upsert-on-path semantics live in service.importPointers now (re-scan
        // refreshes in place, UNIQUE(path) backs it). One bad row must not abort
        // the whole scan -- failures come back to us, and we log them loud here,
        // invisible to the user, same as before the move.
        const { written, failures } = service.importPointers(pointers)
        for (const f of failures) {
          console.error(`[scheherazade/onboarding] pointer upsert failed for ${f.path}:`, f.error)
        }
        sendJson(res, 200, { ok: true, written, coverage })
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/memory/pointers',
      handler: async (req, res, callCtx) => {
        const { scanPointers: _s, defaultSources } = require('../../memory/pointer-scan.cjs')
        const service = await getMemoryService()
        const { rows } = service.query({ table: 'imported_pointers' })
        // Coverage notes are static per tool; the counts are live from the table.
        // Deliberately does NOT re-scan -- reading the page must never touch the
        // user's files. Opt-in means opt-in.
        const counts = new Map()
        for (const r of rows) counts.set(r.source_tool, (counts.get(r.source_tool) || 0) + 1)
        const coverage = defaultSources().map((s) => ({
          tool: s.tool, label: s.label, note: s.coverage, found: counts.get(s.tool) || 0,
        }))
        sendJson(res, 200, { rows, coverage })
        return
      },
    },
    {
      method: 'DELETE',
      match: (pathname) => pathname === '/api/memory/pointers',
      handler: async (req, res, callCtx) => {
        const service = await getMemoryService()
        service.clearPointers()
        sendJson(res, 200, { ok: true })
        return
      },
    },
    // ── Journal (v0.0.5) ────────────────────────────────────────────────────
    //   GET    /api/journal        -- the timeline. Newest first.
    //   DELETE /api/journal/:date  -- the user erases a day. Only the user can.
    //
    // These sit ABOVE the /api/memory/:table matcher for the same reason the
    // pointer routes do -- but note they are on their own /api/journal prefix, so
    // the collision is structural, not lexical. A day is not a memory table row.
    //
    // HONEST COVERAGE, and this is the load-bearing part: the timeline reports
    // days the agent was ALIVE but wrote NOTHING, as gaps. An empty journal that
    // renders as "nothing happened" is a lie; the truth is "the agent ran and did
    // not write." The user is owed the difference, because only one of those is a
    // bug. (Same rule as the pointer index's found:0 rows.)
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/journal',
      handler: async (req, res, callCtx) => {
        const service = await getMemoryService()
        const { rows } = service.journalRead({ limit: 120 })
        const written = new Set(rows.map((r) => r.date))

        // Days with activity, from the audit log (service.listActiveJournalDays;
        // its UTC-vs-local caveat is documented there).
        let activeDays = []
        try {
          activeDays = service.listActiveJournalDays(120)
        } catch { activeDays = [] }
        const gaps = activeDays.filter((d) => !written.has(d))

        sendJson(res, 200, { rows, gaps })
        return
      },
    },
    {
      method: 'DELETE',
      match: (pathname) => pathname.match(/^\/api\/journal\/(\d{4}-\d{2}-\d{2})$/),
      handler: async (req, res, callCtx, journalDayMatch) => {
        const service = await getMemoryService()
        // Same secure-erase contract as memoryDelete: the bytes go, not just the
        // row (wal_checkpoint lives inside deleteJournalDay).
        const { deleted } = service.deleteJournalDay(journalDayMatch[1])
        sendJson(res, 200, { ok: true, deleted })
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname.match(/^\/api\/memory\/([a-z_]+)$/),
      handler: async (req, res, callCtx, tableMatch) => {
        const table = tableMatch[1]
        if (!CATEGORY_TABLES.includes(table)) {
          sendJson(res, 400, { error: `not a category table: ${table}` })
          return
        }
        const service = await getMemoryService()
        const { rows } = service.query({ table })
        sendJson(res, 200, { table, rows })
        return
      },
    },
    {
      method: 'DELETE',
      match: (pathname) => pathname.match(/^\/api\/memory\/([a-z_]+)\/(\d+)$/),
      handler: async (req, res, callCtx, deleteMatch) => {
        const table = deleteMatch[1]
        const id = Number(deleteMatch[2])
        if (!CATEGORY_TABLES.includes(table)) {
          sendJson(res, 400, { error: `not a deletable table: ${table}` })
          return
        }
        const service = await getMemoryService()
        service.remove({ table, id }) // throws loud on 0-row match -- caught below -> 404/500
        sendJson(res, 200, { ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
