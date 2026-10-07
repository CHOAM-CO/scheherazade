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
const { setSession, sessionValid, sessionLocation, location, key, SESSION_TTL } = require('../onboarding/chromux-live-consent.cjs')
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
  eq(response.body.paired, true); eq(response.body.agentName, 'Sera fixture'); eq(response.body.sessionConsent, false)
  eq((await call('POST', '/api/quickbar/browse/session-consent', { on: true })).status, 200)
  eq(sessionValid(home, 'in-app'), true)
  const now = Date.now(), argv = ['click', 'helper', '@1']
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=true\n')
  setSession(home, 'in-app', true, now)
  let executions = 0
  const run = (at = now, channel = 'in-app') => gate({ home, argv, channel, now: at, execute: () => { executions++; return 0 } })
  eq(run(), 0); eq(executions, 1); eq(run(now, 'other'), 3)
  eq(run(now + SESSION_TTL), 3)
  fs.writeFileSync(path.join(home, 'consent', 'app-boot-id'), 'next-boot')
  eq(run(), 3)
  setSession(home, 'in-app', true, now)
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=false\n')
  eq(run(), 4)
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=true\n')
  const pendingFile = path.join(home, 'consent', 'pending-' + key('in-app', []) + '.json')
  fs.writeFileSync(pendingFile, '{}')
  fs.writeFileSync(location(home, 'in-app', argv), JSON.stringify({ channel: 'in-app' }))
  fs.writeFileSync(location(home, 'other', argv), JSON.stringify({ channel: 'other' }))
  eq((await call('POST', '/api/quickbar/browse/session-consent', { on: false })).status, 200)
  eq(fs.existsSync(pendingFile), false); eq(fs.existsSync(sessionLocation(home, 'in-app')), false)
  eq(fs.existsSync(location(home, 'in-app', argv)), false); eq(fs.existsSync(location(home, 'other', argv)), true)
  eq((await call('POST', '/api/quickbar/browse/session-consent', { on: 'true' })).status, 400)
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
