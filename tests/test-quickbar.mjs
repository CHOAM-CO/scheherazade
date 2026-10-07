import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createRoutes } = require('../onboarding/routes/quickbar.cjs')
const { createService } = require('../onboarding/routes/pending-signal.cjs')
const { createRoutes: settingsRoutes } = require('../onboarding/routes/settings.cjs')
const { gate } = require('../onboarding/chromux-live-gate.cjs')
const { setSession, sessionValid, sessionLocation } = require('../onboarding/chromux-live-consent.cjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbar-test-'))
let count = 0
function eq(actual, expected) { assert.deepEqual(actual, expected); count++ }
const originalFetch = globalThis.fetch
try {
  let config = { BROWSE_LIVE: 'true' }, turn = '', posts = 0, updateForces = []
  const ctx = {
    fs, path, DATA_HOME: home, APP_VERSION: '999.999.999', log: () => {},
    readJsonBody: async req => req.body,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readAgentConfig: () => config, writeAgentConfig: patch => { config = { ...config, ...patch }; return config },
    checkForUpdate: async force => { updateForces.push(force); return { ok: true, latest: '999.999.999', hasUpdate: false } },
    getMemoryService: async () => { throw new Error('No memory database fixture') },
  }
  fs.writeFileSync(path.join(home, 'local-channel.json'), JSON.stringify({ port: 12345, token: 'test-only' }))
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/relay/status')) return { ok: true, json: async () => ({ extensionConnected: true }) }
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ agent: 'Sera fixture' }) }
    posts++; turn = JSON.parse(opts.body).content
    return { status: 202, json: async () => ({ ok: true }) }
  }
  const routes = createRoutes(ctx)
  const call = async (method, url, body, list = routes) => {
    const res = {}; await list.find(r => r.method === method && r.match(url)).handler({ body }, res); return res
  }
  let response = await call('GET', '/api/quickbar/whats-new/status')
  eq(response.status, 200); eq(response.body.unseenNotes, true)
  const pending = createService(ctx)
  const fixture = await pending.readCurrent()
  eq(response.body.pending, pending.pendingOf(fixture.current, pending.readStamp()))
  eq(pending.buildRecital({ corrections: 0, reflux: 0, dreams: 0, checkpoint: 0 }, []), [
    '[system] 밀린 게 있다. .',
    '체크포인트는 최신이다. 이번 턴에 상태가 바뀌면 그때 checkpoint.md를 새로 써라.',
    '살아있는 교정 중에 self_persona.md와 어긋나는 게 있으면 바꿀 문장을 한 줄로 제안해라. 유저가 승인하기 전엔 self_persona.md를 고치지 않는다.',
    '유저에게 아직 못 한 말이나 기억이 부족한 부분은 네가 이미 알고 있는 것만으로 직접 짚어라. 지금 채팅에서 네 목소리로 먼저 말을 걸어라. 뭐가 밀렸는지, 체크포인트와 페르소나를 어떻게 정리했는지, 뭘 고칠 생각인지 짧게.',
  ].join('\n'))
  response = await call('POST', '/api/quickbar/whats-new')
  eq(response.body, { ok: true }); eq(posts, 1)
  eq(turn.includes('Release notes file is missing: release-notes-v999.999.999.md'), true)
  eq(turn.includes(pending.buildRecital(fixture.current, fixture.proposals)), true)
  eq((await call('GET', '/api/quickbar/whats-new/status')).body.unseenNotes, false)
  eq(updateForces.every(x => x === undefined), true)
  fs.unlinkSync(path.join(home, '.gates', 'whats-new.json'))
  globalThis.fetch = async () => { throw new Error('offline') }
  eq((await call('POST', '/api/quickbar/whats-new')).status, 500)
  eq(fs.existsSync(path.join(home, '.gates', 'whats-new.json')), false)
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/relay/status')) return { ok: true, json: async () => ({ extensionConnected: true }) }
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ agent: 'Sera fixture' }) }
    turn = JSON.parse(opts.body).content; return { status: 202, json: async () => ({ ok: true }) }
  }
  response = await call('POST', '/api/quickbar/look-back')
  eq(response.status, 202); eq(turn.includes('WAIT'), true); eq(turn.includes('procedures/memory-consolidation.md'), true)
  response = await call('POST', '/api/quickbar/dream')
  eq(response.status, 202); eq(turn.includes('have not dreamt yet'), true)
  eq(fs.existsSync(path.join(home, '.gates', 'dream-told.json')), false)
  fs.mkdirSync(path.join(home, 'dreams'))
  fs.writeFileSync(path.join(home, 'dreams', '2026-10-06.md'), 'A silver river.')
  fs.writeFileSync(path.join(home, 'dreams', '2026-10-07.md'), 'A moonlit garden.')
  fs.writeFileSync(path.join(home, 'dreams', 'fragments.md'), 'Not a dream: memory candidates.')
  const beforeDream = pending.readStamp()
  response = await call('POST', '/api/quickbar/dream')
  eq(response.status, 202); eq(turn.includes('A moonlit garden.'), true)
  eq(JSON.parse(fs.readFileSync(path.join(home, '.gates', 'dream-told.json'))).lastToldFile, '2026-10-07.md')
  eq(pending.readStamp(), { ...beforeDream, dreams: beforeDream.dreams + 1 })
  await call('POST', '/api/quickbar/dream')
  eq(turn.includes('A silver river.'), true)
  eq(JSON.parse(fs.readFileSync(path.join(home, '.gates', 'dream-told.json'))).lastToldFile, '2026-10-06.md')
  eq(pending.readStamp().dreams, 2)
  await call('POST', '/api/quickbar/dream')
  eq(turn.includes('A rerun'), true); eq(pending.readStamp().dreams, 2)
  const receipt = fs.readFileSync(path.join(home, '.gates', 'dream-told.json'), 'utf8')
  const goodFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  eq((await call('POST', '/api/quickbar/dream')).status, 500)
  eq(fs.readFileSync(path.join(home, '.gates', 'dream-told.json'), 'utf8'), receipt)
  globalThis.fetch = goodFetch
  response = await call('POST', '/api/quickbar/today')
  eq(response.status, 202); eq(turn.includes('calendar/SKILL.md'), true)
  eq(turn.includes('morning-brief'), true); eq(turn.includes('notes/todos'), true)
  eq(turn.includes('not configured'), true)
  response = await call('GET', '/api/quickbar/browse/status')
  eq(response.body.paired, true); eq(response.body.agentName, 'Sera fixture'); eq(response.body.enabled, true)
  eq('sessionConsent' in response.body, false)
  eq(routes.some(r => r.match('/api/quickbar/browse/session-consent')), false)
  // Binding the routes must not touch DATA_HOME/consent: the old app-boot-id write here ran on every
  // require() of http-server.cjs (tests included) and voided the live app's session grant.
  eq(fs.existsSync(path.join(home, 'consent')), false)
  // Gate: BROWSE_LIVE on == every verb runs, no consent file, no ask.
  const argv = ['click', 'helper', '@1']
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=true\n')
  let executions = 0
  const run = (args = argv, channel = 'in-app') => gate({ home, argv: args, channel, execute: () => { executions++; return 0 } })
  eq(run(), 0); eq(executions, 1); eq(run(argv, 'other'), 0)
  eq(run(['--ask', JSON.stringify(argv)]), 0); eq(executions, 2)
  eq(fs.existsSync(path.join(home, 'consent')), false)
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=false\n')
  eq(run(), 4); eq(executions, 2)
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=true\n')
  // Session consent helpers still work on their own, but nothing in the app consults them now.
  const now = Date.now()
  fs.mkdirSync(path.join(home, 'consent'), { recursive: true }); fs.writeFileSync(path.join(home, 'consent', 'app-boot-id'), 'boot-1')
  setSession(home, 'in-app', true, now); eq(sessionValid(home, 'in-app', now), true)
  eq(fs.existsSync(sessionLocation(home, 'in-app')), true)
  setSession(home, 'in-app', false); eq(fs.existsSync(sessionLocation(home, 'in-app')), false)
  const settings = settingsRoutes(ctx)
  response = await call('GET', '/api/settings/browse-live', null, settings)
  eq(response.body.browseLive, true); eq(response.body.extensionPath, path.join(home, 'bin', 'chromux-portable', 'extension'))
  eq((await call('POST', '/api/settings/browse-live', { browseLive: false }, settings)).body, { browseLive: false })
  eq((await call('POST', '/api/settings/browse-live', { browseLive: 'yes' }, settings)).status, 400)
  eq((await call('GET', '/api/settings/browse-live', null, settings)).body.browseLive, false)
  console.log(`${count} passed, 0 failed`)
} finally {
  globalThis.fetch = originalFetch
  fs.rmSync(home, { recursive: true, force: true })
}
