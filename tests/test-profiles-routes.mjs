import assert from 'node:assert/strict'
import http from 'node:http'
import siblings from '../sibling-profiles.cjs'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRoutes } from '../onboarding/routes/profiles.cjs'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-profile-test-'))
const appData = path.join(home, 'appdata')
const dataHome = path.join(home, 'Documents', 'Scheherazade')
fs.mkdirSync(dataHome, { recursive: true })
const trashed = []
const spawned = []
const memoryEvents = []
const ctx = { getMemoryService: async () => ({ journalWrite: event => memoryEvents.push(event) }), profileHome: home, DATA_HOME: dataHome,
  profileLiveness: { readCommandLine: () => `${path.resolve('supervisor.mjs')} __loop --profile work`, listCommands: () => [] },
  getElectron: () => ({ app: { isPackaged: true, getPath: () => appData }, shell: { trashItem: async p => { trashed.push(p); fs.renameSync(p, `${p}.trashed`) } } }),
  profileSpawn: (executable, args, options) => {
    const child = new EventEmitter()
    child.unref = () => { child.unreferenced = true }
    spawned.push({ executable, args, options, child })
    queueMicrotask(() => child.emit('spawn'))
    return child
  },
  readJsonBody: async req => req.body, sendJson: (res, status, body) => Object.assign(res, { status, body }),
}
let routes = createRoutes(ctx)
async function request(method, url, body) {
  const route = routes.find(r => r.method === method && r.match(url))
  const res = {}
  await route.handler({ body }, res, {}, route.match(url))
  return res
}
let pass = 0
function ok(label, condition) { assert.ok(condition, label); pass++; console.log(`ok ${label}`) }
try {
  ok('awareness absent alone', siblings.awareness(dataHome).length === 0)
  fs.writeFileSync(path.join(dataHome, '.agent-config'), 'DISPLAY_NAME=Original\nMODEL=example\nDISCORD_TOKEN=secret\n')
  fs.writeFileSync(path.join(dataHome, '.env'), 'CONNECTION_URL=http://local\nAPI_KEY=secret\nPASSWORD=secret\n')
  fs.writeFileSync(path.join(dataHome, 'self_persona.md'), 'persona')
  fs.writeFileSync(path.join(dataHome, 'memory.db'), 'never copy')
  fs.mkdirSync(path.join(dataHome, '.credentials'))
  const copied = await request('POST', '/api/profiles', { name: 'copy' })
  const copyHome = copied.body.profile.dataHome
  ok('copies persona', fs.readFileSync(path.join(copyHome, 'self_persona.md'), 'utf8') === 'persona')
  ok('filters config tokens', fs.readFileSync(path.join(copyHome, '.agent-config'), 'utf8') === 'DISPLAY_NAME=Original\nMODEL=example\nPROFILE=copy\n')
  ok('filters env secrets', fs.readFileSync(path.join(copyHome, '.env'), 'utf8') === 'CONNECTION_URL=http://local\n')
  ok('no memory or credentials', !fs.existsSync(path.join(copyHome, 'memory.db')) && !fs.existsSync(path.join(copyHome, '.credentials')))
  ok('receipt written', JSON.parse(fs.readFileSync(path.join(copyHome, '.profile-copy-receipt.json'))).copied.includes('self_persona.md'))
  ok('settings default enabled', (await request('GET', '/api/profiles/settings')).body.sharedMemoryRead)
  await request('POST', '/api/profiles/settings', { sharedMemoryRead: false })
  ok('settings persists off', !(await request('GET', '/api/profiles/settings')).body.sharedMemoryRead)
  const isolated = await request('POST', '/api/profiles', { name: 'isolated', copyFrom: false })
  ok('copyFrom false only creates fresh config', fs.readFileSync(path.join(isolated.body.profile.dataHome, '.agent-config'), 'utf8') === 'PROFILE=isolated\n' && !fs.existsSync(path.join(isolated.body.profile.dataHome, 'self_persona.md')))
  fs.unlinkSync(path.join(dataHome, '.agent-config'))
  ok('lists historic default', (await request('GET', '/api/profiles')).body.profiles[0].isDefault)
  for (const name of ['default', '../bad', 'BAD', '', 'a'.repeat(25)]) ok(`reject ${name}`, (await request('POST', '/api/profiles', { name })).status === 400)
  fs.mkdirSync(path.join(appData, 'scheherazade-work'), { recursive: true })
  const created = await request('POST', '/api/profiles', { name: 'work' })
  ok('reuses empty userData', fs.existsSync(path.join(appData, 'scheherazade-work')))
  ok('creates profile', created.body.profile.name === 'work' && !created.body.profile.running)
  const named = created.body.profile.dataHome
  ok('writes PROFILE', fs.readFileSync(path.join(named, '.agent-config'), 'utf8') === 'PROFILE=work\n')
  ok('creates userData', fs.existsSync(path.join(appData, 'scheherazade-work')))
  ok('create never spawns', spawned.length === 0)
  ok('named opens', (await request('POST', '/api/profiles/work/open')).body.ok)
  ok('named exact spawn contract', JSON.stringify(spawned[0].args) === '["--profile","work"]' && spawned[0].options.detached && spawned[0].child.unreferenced)
  ok('default opens', (await request('POST', '/api/profiles/default/open')).body.ok)
  ok('default no profile argv', spawned[1].args.length === 0)
  routes = createRoutes({ ...ctx, getElectron: () => ({ app: { isPackaged: false, getAppPath: () => '/development/sera', getPath: () => appData } }) })
  await request('POST', '/api/profiles/work/open')
  assert.deepEqual(spawned[2].args, ['/development/sera', '--profile', 'work'])
  ok('unpackaged real route argv', spawned[2].executable === process.execPath)
  routes = createRoutes(ctx)
  ok('default env untainted', !('AGENT_DATA_HOME' in spawned[1].options.env) && !('ELECTRON_RUN_AS_NODE' in spawned[1].options.env))
  ok('duplicate rejected', (await request('POST', '/api/profiles', { name: 'work' })).status === 400)
  fs.writeFileSync(path.join(named, '.agent-config'), 'PROFILE=work\nDISPLAY_NAME=Worker\n')
  fs.writeFileSync(path.join(named, '.agent.pid'), String(process.pid))
  const list = (await request('GET', '/api/profiles')).body
  ok('display label and live pid', list.current === '' && list.profiles.find(p => p.name === 'work').displayName === 'Worker' && list.profiles.find(p => p.name === 'work').running)
  ok('awareness labels sibling', siblings.awareness(dataHome, ctx.profileLiveness).some(line => line === '다른 세라: Worker (work, 켜짐)'))
  ok('default is sibling of named', siblings.awareness(named).some(line => line.includes('(default, 꺼짐)')))
  ok('say self rejected', (await request('POST', '/api/profiles/default/say', { text: 'hi' })).status === 400)
  ok('say empty rejected', (await request('POST', '/api/profiles/work/say', { text: '  ' })).status === 400)
  ok('say unknown', (await request('POST', '/api/profiles/missing/say', { text: 'hi' })).status === 404)
  const off = await request('POST', '/api/profiles/work/say', { text: 'hi' })
  ok('say off', off.status === 409 && off.body.error === 'profile_off')
  const received = []
  const listener = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(202); res.end('{}')
  })
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  try {
    fs.writeFileSync(path.join(named, 'local-channel.json'), JSON.stringify({ port: listener.address().port, token: 'sibling-test' }))
    ok('say delivered', (await request('POST', '/api/profiles/work/say', { text: 'hello sibling' })).status === 200)
    ok('say tags sender and origin', received[0].url === '/in' && received[0].auth === 'Bearer sibling-test' && received[0].body.from === 'Scheherazade (default)' && received[0].body.sibling === true && received[0].body.text === 'hello sibling')
    await request('POST', '/api/profiles', { name: 'newborn', copyFrom: false })
    ok('creator records profile creation', memoryEvents.at(-1).body === 'Scheherazade(newborn)가 이 컴퓨터에 새로 생겼어')
    ok('sender records talk', memoryEvents.some(event => event.body === '[다른 세라에게 말하기: work] hello sibling'))
    ok('create notifies running sibling once', received.length === 2 && received[1].body.from === '시스템' && received[1].body.text === 'Scheherazade(newborn)가 이 컴퓨터에 새로 생겼어')
  } finally { await new Promise(resolve => listener.close(resolve)) }
  ok('running delete refused', (await request('DELETE', '/api/profiles/work')).status === 409)
  ok('default delete refused', (await request('DELETE', '/api/profiles/default')).status === 400)
  fs.writeFileSync(path.join(named, '.agent.pid'), '999999999')
  routes = createRoutes({ ...ctx, profileLiveness: { listCommands: () => [{ pid: process.pid, command: `${process.execPath} --profile work` }] } })
  ok('window open without agent prevents deletion', (await request('DELETE', '/api/profiles/work')).status === 409)
  const failedTrash = []
  routes = createRoutes({ ...ctx, getElectron: () => ({ app: { getPath: () => appData }, shell: { trashItem: async p => { failedTrash.push(p); throw Error('trash denied') } } }) })
  ok('data home trash failure returns 500', (await request('DELETE', '/api/profiles/work')).status === 500)
  ok('data home failure preserves pairing', failedTrash.length === 1 && failedTrash[0] === named && fs.existsSync(named) && fs.existsSync(path.join(appData, 'scheherazade-work')))
  routes = createRoutes(ctx)
  const shortcut = await request('POST', '/api/profiles/work/shortcut')
  ok('shortcut exists', shortcut.status === 200 && fs.existsSync(shortcut.body.path))
  for (const platform of ['darwin', 'linux']) {
    routes = createRoutes({ ...ctx, profilePlatform: platform })
    const namedShortcut = await request('POST', '/api/profiles/work/shortcut')
    const text = fs.readFileSync(namedShortcut.body.path, 'utf8')
    ok(`${platform} named shortcut argv`, text.includes('--profile work'))
    if (platform === 'darwin') ok('mac shortcut new instance and executable', text.includes('open -n -a Scheherazade') && (fs.statSync(namedShortcut.body.path).mode & 0o777) === 0o755)
    const defaultShortcut = await request('POST', '/api/profiles/default/shortcut')
    ok(`${platform} default plain shortcut`, defaultShortcut.body.ok && !fs.readFileSync(defaultShortcut.body.path, 'utf8').includes('--profile'))
  }
  let shortcutLink
  routes = createRoutes({ ...ctx, profilePlatform: 'win32', getElectron: () => ({ app: { isPackaged: true, getPath: key => key === 'desktop' ? home : appData }, shell: { writeShortcutLink: (file, operation, options) => { shortcutLink = options; return true } } }) })
  await request('POST', '/api/profiles/default/shortcut')
  ok('windows default plain shortcut', shortcutLink.args === '')
  await request('POST', '/api/profiles/work/shortcut')
  ok('windows named shortcut', shortcutLink.args === '--profile work')
  routes = createRoutes(ctx)
  ok('stopped deletion succeeds', (await request('DELETE', '/api/profiles/work')).body.ok)
  assert.deepEqual(trashed, [named, path.join(appData, 'scheherazade-work')])
  ok('both directories trashed', trashed.includes(named) && trashed.includes(path.join(appData, 'scheherazade-work')))
  const leftover = path.join(appData, 'scheherazade-leftover')
  await request('POST', '/api/profiles', { name: 'leftover' })
  const leftoverData = path.join(home, 'Documents', 'Scheherazade-leftover')
  routes = createRoutes({ ...ctx, getElectron: () => ({ app: { getPath: () => appData }, shell: { trashItem: async p => {
    if (p === leftover) throw Error('permission denied')
    fs.renameSync(p, `${p}.trashed`)
  } } }) })
  const partial = await request('DELETE', '/api/profiles/leftover')
  ok('userData trash failure returns 500 and names leftover path', partial.status === 500 && partial.body.error.includes(leftover))
  ok('partial deletion reports actual state', !fs.existsSync(leftoverData) && fs.existsSync(leftover))
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`test-profiles-routes: pass=${pass} fail=0`)
