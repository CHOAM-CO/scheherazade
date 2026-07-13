// E2E over the REAL http server -- the autonomous cycle's consent surface.
// Run: node scripts/test-autonomy-e2e.cjs
//
// Module fixtures do not prove the wire. They also do not prove the thing this
// file exists to prove: that a TEST RUN CANNOT WRITE INTO THE USER'S REAL
// CONFIG. http-server.cjs hardcoded DATA_HOME until tonight, and no test had
// ever POSTed to a config-writing route, so the first one to do so (this one,
// flipping a consent flag) would have flipped it in ~/Documents/Scheherazade
// for real. That assertion is at the bottom and it is not decoration.
const fs = require('fs'), os = require('os'), path = require('path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-autonomy-e2e-'))
process.env.AGENT_DATA_HOME = tmp
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')
// Point the token meter at a scratch transcript tree, not the real one.
const PROJECTS = path.join(tmp, 'projects')
fs.mkdirSync(PROJECTS, { recursive: true })
process.env.SCHEHERAZADE_PROJECTS_ROOT = PROJECTS

const REAL_CONFIG = path.join(os.homedir(), 'Documents', 'Scheherazade', '.agent-config')
const realConfigBefore = fs.existsSync(REAL_CONFIG) ? fs.readFileSync(REAL_CONFIG, 'utf8') : null

;(async () => {
  const ROOT = path.join(__dirname, '..')
  const { createOnboardingServer } = require(path.join(ROOT, 'onboarding', 'http-server.cjs'))
  const budget = require(path.join(ROOT, 'autonomy', 'budget.cjs'))

  const srv = await createOnboardingServer()
  const port = srv.address ? srv.address().port : (srv.server && srv.server.address().port)
  const base = `http://127.0.0.1:${port}`
  let pass = 0, fail = 0
  const chk = (n, c, d) => { if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) } }

  const page = await (await fetch(`${base}/settings`)).text()
  const m = page.match(/name="onboard-token" content="([a-f0-9]+)"/)
  chk('the settings page carries an onboard token', Boolean(m))
  const token = m ? m[1] : ''
  const post = (body) => fetch(`${base}/api/autonomy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-onboard-token': token },
    body: JSON.stringify(body),
  })

  console.log('\n-- it ships OFF')
  {
    const r = await fetch(`${base}/api/autonomy`)
    chk('GET /api/autonomy is 200', r.status === 200, r.status)
    const a = await r.json()
    chk('consent defaults to OFF -- nothing turns it on for the user', a.enabled === false, JSON.stringify(a.enabled))
    chk('a default window exists', typeof a.windowStart === 'string' && /^\d{2}:\d{2}$/.test(a.windowStart), a.windowStart)
    chk('a default cap exists and is not zero', a.cap > 0, a.cap)
    chk('no cycle has run', a.lastCycle === null)
  }

  console.log('\n-- the meter, through the wire')
  {
    const a = await (await fetch(`${base}/api/autonomy`)).json()
    // No transcripts exist in the scratch tree yet -> the meter is BLIND, and
    // the API must say so rather than reporting a comfortable zero.
    chk('a blind meter reports ok:false (not "0 tokens used")', a.today && a.today.ok === false, JSON.stringify(a.today))
    chk('and it says why', typeof a.today.reason === 'string' && a.today.reason.length > 0, a.today && a.today.reason)
    chk('a blind meter never reports a total (a 0 would read as "you spent nothing")',
      a.today.total === undefined, JSON.stringify(a.today))
  }
  {
    // Now give it a real transcript with real usage rows, the way the CLI does.
    const dir = path.join(PROJECTS, budget.slugForCwd(tmp))
    fs.mkdirSync(dir, { recursive: true })
    const now = new Date()
    const row = JSON.stringify({
      type: 'assistant', cwd: tmp, timestamp: now.toISOString(),
      message: { usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 } },
    })
    fs.writeFileSync(path.join(dir, 'live.jsonl'), row + '\n')
    budget.resetCache()

    const a = await (await fetch(`${base}/api/autonomy`)).json()
    chk('with transcripts present, the meter measures', a.today.ok === true, JSON.stringify(a.today))
    chk('and the number is the RAW sum, cache reads included (3500)', a.today.total === 3500, a.today.total)
    // TODAY and THE CAP are different measurements and must not be conflated:
    // today includes the owner's own chatting; the cap is enforced per NIGHT.
    chk('today\'s total is reported separately from the per-night cap',
      typeof a.cap === 'number' && a.today.total !== a.cap)
  }

  console.log('\n-- consent is a mutation, and mutations need the token')
  {
    const r = await fetch(`${base}/api/autonomy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    chk('POST without the token is REFUSED (403)', r.status === 403, r.status)
    const a = await (await fetch(`${base}/api/autonomy`)).json()
    chk('...and consent is still off', a.enabled === false)
  }

  console.log('\n-- turning it on, and the validation that guards it')
  {
    const r = await post({ enabled: true, windowStart: '23:00', windowEnd: '05:00', cap: 1234567 })
    chk('POST with the token succeeds', r.status === 200, r.status)
    const a = await (await fetch(`${base}/api/autonomy`)).json()
    chk('consent is on', a.enabled === true)
    chk('a midnight-wrapping window is accepted (23:00-05:00 is a normal night)', a.windowStart === '23:00' && a.windowEnd === '05:00')
    chk('the cap round-trips', a.cap === 1234567, a.cap)
  }
  {
    const r = await post({ windowStart: '2am' })
    chk('a malformed window is 400, not silently ignored', r.status === 400, r.status)
    const a = await (await fetch(`${base}/api/autonomy`)).json()
    chk('...and the old window survives', a.windowStart === '23:00')
  }
  {
    const r = await post({ windowStart: '03:00', windowEnd: '03:00' })
    chk('a zero-length window is 400 (it would silently never run)', r.status === 400, r.status)
  }
  {
    const r = await post({ cap: -5 })
    chk('a negative cap is 400', r.status === 400, r.status)
  }
  {
    const r = await post({ cap: 0 })
    chk('a cap of 0 is accepted -- it means OFF, and there is no unlimited', r.status === 200, r.status)
    const a = await (await fetch(`${base}/api/autonomy`)).json()
    chk('...and it round-trips as 0', a.cap === 0, a.cap)
    const budgetAtZero = budget.budgetState(tmp, 0, new Date(), null)
    chk('...and the meter refuses to run at cap 0', budgetAtZero.mayRun === false, JSON.stringify(budgetAtZero))
  }
  {
    const r = await post({ enabled: false })
    chk('consent can be withdrawn', r.status === 200)
    const a = await (await fetch(`${base}/api/autonomy`)).json()
    chk('...and it is off', a.enabled === false)
  }

  console.log('\n-- the config was written to the SCRATCH home, not the user\'s')
  {
    const scratchConfig = path.join(tmp, '.agent-config')
    chk('scratch .agent-config exists', fs.existsSync(scratchConfig))
    const text = fs.existsSync(scratchConfig) ? fs.readFileSync(scratchConfig, 'utf8') : ''
    chk('and it holds the autonomy fields', /AUTONOMY=/.test(text), text.slice(0, 200))
    chk('the cap is stored under the per-NIGHT name', /AUTONOMY_TOKEN_CAP=/.test(text), text.slice(0, 300))

    const realAfter = fs.existsSync(REAL_CONFIG) ? fs.readFileSync(REAL_CONFIG, 'utf8') : null
    chk('THE REAL USER CONFIG WAS NOT TOUCHED BY THIS TEST', realAfter === realConfigBefore,
      realConfigBefore === null ? 'a real config was CREATED by a test run' : 'a real config was MODIFIED by a test run')
  }

  await new Promise((r) => (srv.close ? srv.close(r) : (srv.server && srv.server.close(r))))
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
