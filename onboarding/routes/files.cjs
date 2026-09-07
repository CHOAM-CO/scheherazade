// onboarding/routes/files.cjs -- recently-touched-files routes (group 14,
// 같이보기 batch 2026-08-19: the owner "세라가 최근에 건드린 파일들 리스트도 볼
// 수 있게").
//
// Reads the JSONL that hooks/post-tool-file-ledger.mjs appends (one row per
// Write/Edit/MultiEdit/NotebookEdit result) and answers one question: what
// has the agent touched lately? Read-only over DATA_HOME/.gates; a missing
// or torn ledger is an empty list, never an error page — the ledger is
// advisory by contract and this reader inherits that.
//
// Same binding rules as every route group: bodies only, deps bound ONCE
// from staticCtx, no requires back into http-server.cjs.
'use strict'

const MAX_ROWS = 200

function createRoutes(staticCtx) {
  const { fs, path, sendJson, DATA_HOME } = staticCtx

  // Parse one ledger file into rows; unparseable lines are skipped (a torn
  // tail from a mid-append crash must not take down the listing).
  function readLedgerFile(p) {
    let text
    try {
      text = fs.readFileSync(p, 'utf8')
    } catch {
      return []
    }
    const rows = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r && typeof r.path === 'string' && typeof r.ts === 'number') rows.push(r)
      } catch { /* torn line */ }
    }
    return rows
  }

  return [
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/files/recent',
      handler: async (req, res, callCtx) => {
        const ledger = path.join(DATA_HOME, '.gates', 'file-ledger.jsonl')
        // .1 first so the live file's newer duplicates win the dedupe below.
        const rows = [...readLedgerFile(`${ledger}.1`), ...readLedgerFile(ledger)]
        // Dedupe by path keeping the LATEST touch; count touches so the
        // panel can say "edited 12 times this session" instead of 12 rows.
        const byPath = new Map()
        for (const r of rows) {
          const prev = byPath.get(r.path)
          if (!prev) byPath.set(r.path, { path: r.path, ts: r.ts, tool: r.tool, touches: 1, failed: r.failed === true })
          else {
            prev.touches += 1
            if (r.ts >= prev.ts) { prev.ts = r.ts; prev.tool = r.tool; prev.failed = r.failed === true }
          }
        }
        const out = [...byPath.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_ROWS)
        sendJson(res, 200, { rows: out, ledgerExists: fs.existsSync(ledger) || fs.existsSync(`${ledger}.1`) })
        return
      },
    },
    // Open one of the listed files with the OS default app — a list you
    // cannot open things from is a screenshot. Guard: only paths the ledger
    // actually contains can be opened (the ledger is the allowlist), so this
    // never becomes an open-anything endpoint for the settings page.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/files/open',
      handler: async (req, res, callCtx) => {
        const body = await staticCtx.readJsonBody(req)
        const target = typeof body.path === 'string' ? body.path : ''
        const ledger = path.join(DATA_HOME, '.gates', 'file-ledger.jsonl')
        const known = new Set([...readLedgerFile(`${ledger}.1`), ...readLedgerFile(ledger)].map((r) => r.path))
        if (!target || !known.has(target)) {
          sendJson(res, 400, { error: 'path is not in the recent-files ledger' })
          return
        }
        if (!fs.existsSync(target)) {
          sendJson(res, 404, { error: 'file no longer exists on disk' })
          return
        }
        const { shell } = staticCtx.getElectron()
        const errMsg = await shell.openPath(target) // resolves '' on success
        if (errMsg) {
          sendJson(res, 500, { error: errMsg })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
