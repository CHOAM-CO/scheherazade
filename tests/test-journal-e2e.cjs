// E2E over the REAL http server. Module fixtures do not prove the wire:
// route order, the auth gate, and the JSON shape live here and nowhere else.
const fs = require('fs'), os = require('os'), path = require('path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-e2e-'))
process.env.AGENT_DATA_HOME = tmp
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')

;(async () => {
  const { createOnboardingServer, SERVER_TOKEN } = require(path.join(__dirname, '..', 'onboarding', 'http-server.cjs'))
  const memmod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'memory', 'server.mjs')).href)
  const db = memmod.initDb()
  memmod.journalWrite(db, { date: '2026-07-12', body: '어제의 나' })
  memmod.journalWrite(db, { date: '2026-07-13', body: '<img src=x onerror=alert(1)>' })
  db.close()

  const srv = await createOnboardingServer()
  const port = srv.address ? srv.address().port : (srv.server && srv.server.address().port)
  const base = `http://127.0.0.1:${port}`
  let pass = 0, fail = 0
  const chk = (n, c, d) => { if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) } }

  // Token from the module export (2026-08-07): the page-scrape this used is
  // the closed bypass — bare HTML 403s now (pinned in route-dispatch-e2e).
  const tok = SERVER_TOKEN
  const getAuth = { 'x-onboard-token': tok }

  const gNoTok = await fetch(`${base}/api/journal`)
  chk('GET /api/journal without a token is REFUSED (reads gated since 2026-08-04)', gNoTok.status === 403, gNoTok.status)

  const g = await fetch(`${base}/api/journal`, { headers: getAuth })
  chk('GET /api/journal is 200 (not swallowed by the :table matcher)', g.status === 200, g.status)
  const data = await g.json()
  chk('returns rows', Array.isArray(data.rows) && data.rows.length === 2)
  chk('newest first', data.rows[0].date === '2026-07-13', data.rows[0] && data.rows[0].date)
  chk('gaps array present (honest coverage)', Array.isArray(data.gaps))
  chk('body reaches the client RAW (so the UI must use textContent, and does)', data.rows[0].body.includes('<img'))

  const d1 = await fetch(`${base}/api/journal/2026-07-12`, { method: 'DELETE' })
  chk('DELETE without a token is REFUSED', d1.status === 403, d1.status)

  // Token from the module export (2026-08-07; scrape path is the closed bypass).
  const token = SERVER_TOKEN

  const d2 = await fetch(`${base}/api/journal/2026-07-12`, { method: 'DELETE', headers: { 'x-onboard-token': token } })
  chk('DELETE with the token succeeds', d2.status === 200, d2.status)

  const after = await (await fetch(`${base}/api/journal`, { headers: getAuth })).json()
  chk('the day is really gone', after.rows.length === 1 && after.rows[0].date === '2026-07-13', JSON.stringify(after.rows.map(r => r.date)))

  const bad = await fetch(`${base}/api/journal/not-a-date`, { method: 'DELETE', headers: { 'x-onboard-token': token } })
  chk('a malformed date does not match the delete route', bad.status !== 200, bad.status)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})().catch(e => { console.error('E2E ERROR:', e.message); process.exit(1) })
