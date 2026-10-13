// Real HTTP auth/static boundaries; no Electron, provider, or live user data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-routes-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.AGENT_DATA_HOME = path.join(tmp, 'data')
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')
fs.mkdirSync(process.env.AGENT_DATA_HOME)
const require = createRequire(import.meta.url)
const { createOnboardingServer, SERVER_TOKEN, bootPathFor } = require('../onboarding/http-server.cjs')
let count = 0, claims = 0, nudgeResult = null, canClaim = false
const received = []
const channel = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer channel-test')
  let text = ''; for await (const chunk of req) text += chunk
  received.push({ path: req.url, body: JSON.parse(text) })
  res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
})
await new Promise(r => channel.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(process.env.AGENT_DATA_HOME, 'local-channel.json'), JSON.stringify({ port: channel.address().port, token: 'channel-test' }))
const companion = {
  snapshot: () => ({ available: true, enabled: false }),
  command: async body => {
    if (body.action !== 'settings') { const e = new Error('bad'); e.code = 'BAD_COMMAND'; throw e }
    return { available: true, enabled: body.enabled === true }
  },
  claimNudge: () => { claims++; return canClaim },
  nudgeResult: value => { nudgeResult = value },
}
const { server, url } = await createOnboardingServer(null, { companion: () => companion })
const auth = { 'X-Onboard-Token': SERVER_TOKEN, 'Content-Type': 'application/json' }
async function test(name, fn) { await fn(); count++; console.log(`ok ${count} - ${name}`) }
try {
  await test('companion GET requires token', async () => assert.equal((await fetch(new URL('/api/companion', url))).status, 403))
  await test('companion POST requires token', async () => assert.equal((await fetch(new URL('/api/companion', url), { method: 'POST', body: '{}' })).status, 403))
  await test('nudge requires token', async () => assert.equal((await fetch(new URL('/api/companion/nudge', url), { method: 'POST', body: '{}' })).status, 403))
  await test('foreign origin rejected even with token', async () => assert.equal((await fetch(new URL('/api/companion', url), { method: 'POST', headers: { ...auth, Origin: 'https://example.com' }, body: '{}' })).status, 403))
  await test('authenticated snapshot reaches controller', async () => assert.deepEqual(await (await fetch(new URL('/api/companion', url), { headers: auth })).json(), { available: true, enabled: false }))
  await test('authenticated settings command reaches controller', async () => assert.equal((await (await fetch(new URL('/api/companion', url), { method: 'POST', headers: auth, body: '{"action":"settings","enabled":true}' })).json()).enabled, true))
  await test('bad native command rejected', async () => assert.equal((await fetch(new URL('/api/companion', url), { method: 'POST', headers: auth, body: '{"action":"execute"}' })).status, 400))
  await test('ineligible nudge cannot inject', async () => { const r = await fetch(new URL('/api/companion/nudge', url), { method: 'POST', headers: auth, body: '{}' }); assert.deepEqual(await r.json(), { injected: false }); assert.equal(received.length, 0) })
  await test('eligible nudge uses fixed SYSTEM path, not caller text', async () => {
    canClaim = true
    fs.appendFileSync(path.join(process.env.AGENT_DATA_HOME, '.agent-config'), 'COMPANION_ENABLED=true\n')
    const r = await fetch(new URL('/api/companion/nudge', url), { method: 'POST', headers: auth, body: '{"content":"UNTRUSTED-CALLER-CONTENT"}' })
    assert.deepEqual(await r.json(), { injected: true }); assert.equal(received[0].path, '/system-turn')
    assert.match(received[0].body.content, /^\[SYSTEM: desktop companion\]/); assert.ok(!received[0].body.content.includes('UNTRUSTED')); assert.equal(nudgeResult, true)
  })
  await test('raw companion HTML cannot scrape token without session cookie', async () => assert.equal((await fetch(new URL('/companion.html', url))).status, 403))
  await test('boot cookie serves companion with normal token injection', async () => {
    const boot = await fetch(new URL(bootPathFor('/companion.html'), url), { redirect: 'manual' })
    const cookie = boot.headers.get('set-cookie').split(';')[0]
    const r = await fetch(new URL('/companion.html', url), { headers: { Cookie: cookie } })
    assert.equal(r.status, 200); const html = await r.text(); assert.match(html, /name="onboard-token"/); assert.match(html, /\/js\/companion.js/)
  })
  await test('companion script is served', async () => assert.equal((await fetch(new URL('/js/companion.js', url))).status, 200))
  await test('renderer has no privileged bridge or HTML interpolation', () => {
    const js = fs.readFileSync(new URL('../onboarding/public/js/companion.js', import.meta.url), 'utf8')
    assert.ok(!/innerHTML|ipcRenderer|require\(/.test(js))
  })
  // The first nudge ran with COMPANION_ENABLED off and never reached the controller.
  await test('only gated nudge attempts reached controller', () => assert.equal(claims, 1))
} finally {
  server.closeAllConnections(); channel.closeAllConnections()
  await Promise.all([new Promise(r => server.close(r)), new Promise(r => channel.close(r))])
  // This tree was created by this test and contains no user data.
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`${count} companion route checks passed`)
