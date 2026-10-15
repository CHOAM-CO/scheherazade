import assert from 'node:assert/strict'
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
const ctx = { profileHome: home, DATA_HOME: dataHome,
  getElectron: () => ({ app: { getPath: () => appData }, shell: { trashItem: async p => { trashed.push(p); fs.renameSync(p, `${p}.trashed`) } } }),
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
  ok('lists historic default', (await request('GET', '/api/profiles')).body.profiles[0].isDefault)
  for (const name of ['default', '../bad', 'BAD', '', 'a'.repeat(25)]) ok(`reject ${name}`, (await request('POST', '/api/profiles', { name })).status === 400)
  const created = await request('POST', '/api/profiles', { name: 'work' })
  ok('creates profile', created.body.profile.name === 'work' && !created.body.profile.running)
  const named = created.body.profile.dataHome
  ok('writes PROFILE', fs.readFileSync(path.join(named, '.agent-config'), 'utf8') === 'PROFILE=work\n')
  ok('creates userData', fs.existsSync(path.join(appData, 'scheherazade-work')))
  ok('create never spawns', spawned.length === 0)
  ok('named opens', (await request('POST', '/api/profiles/work/open')).body.ok)
  ok('named exact spawn contract', JSON.stringify(spawned[0].args) === '["--profile","work"]' && spawned[0].options.detached && spawned[0].child.unreferenced)
  ok('default opens', (await request('POST', '/api/profiles/default/open')).body.ok)
  ok('default no profile argv', spawned[1].args.length === 0)
  ok('default env untainted', !('AGENT_DATA_HOME' in spawned[1].options.env) && !('ELECTRON_RUN_AS_NODE' in spawned[1].options.env))
  ok('duplicate rejected', (await request('POST', '/api/profiles', { name: 'work' })).status === 400)
  fs.writeFileSync(path.join(named, '.agent-config'), 'PROFILE=work\nDISPLAY_NAME=Worker\n')
  fs.writeFileSync(path.join(named, '.agent.pid'), String(process.pid))
  const list = (await request('GET', '/api/profiles')).body
  ok('display label and live pid', list.current === '' && list.profiles.find(p => p.name === 'work').displayName === 'Worker' && list.profiles.find(p => p.name === 'work').running)
  ok('running delete refused', (await request('DELETE', '/api/profiles/work')).status === 409)
  ok('default delete refused', (await request('DELETE', '/api/profiles/default')).status === 400)
  fs.writeFileSync(path.join(named, '.agent.pid'), '999999999')
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
  routes = createRoutes({ ...ctx, profilePlatform: 'win32', getElectron: () => ({ app: { getPath: key => key === 'desktop' ? home : appData }, shell: { writeShortcutLink: (file, operation, options) => { shortcutLink = options; return true } } }) })
  await request('POST', '/api/profiles/default/shortcut')
  ok('windows default plain shortcut', shortcutLink.args === '')
  await request('POST', '/api/profiles/work/shortcut')
  ok('windows named shortcut', shortcutLink.args === '--profile work')
  routes = createRoutes(ctx)
  ok('stopped deletion succeeds', (await request('DELETE', '/api/profiles/work')).body.ok)
  ok('both directories trashed', trashed.includes(named) && trashed.includes(path.join(appData, 'scheherazade-work')))
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`test-profiles-routes: pass=${pass} fail=0`)
