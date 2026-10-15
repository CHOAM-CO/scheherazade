import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import vm from 'node:vm'
import profiles from '../profile.cjs'
let pass = 0
const check = (label, fn) => { fn(); pass++; console.log(`ok ${label}`) }
check('default argv unchanged', () => assert.equal(profiles.parseProfile(['app', '--other']), ''))
check('both argv forms', () => { assert.equal(profiles.parseProfile(['--profile', 'work']), 'work'); assert.equal(profiles.parseProfile(['--profile=work']), 'work') })
for (const name of ['', 'default', '../bad', 'A', 'a b', 'a'.repeat(25), undefined]) check(`reject ${name}`, () => assert.throws(() => profiles.validateName(name)))
check('reject missing/duplicate option', () => { assert.throws(() => profiles.parseProfile(['--profile'])); assert.throws(() => profiles.parseProfile(['--profile=a', '--profile=b'])) })
check('default exact historic paths/name', () => assert.deepEqual(profiles.profilePaths('', { home: '/home/test', appData: '/appdata' }), { name: '', dataHome: path.join('/home/test', 'Documents', 'Scheherazade'), userData: path.join('/appdata', 'scheherazade'), agentName: 'scheherazade' }))
check('named paired paths/name', () => assert.deepEqual(profiles.profilePaths('work', { home: '/home/test', appData: '/appdata' }), { name: 'work', dataHome: path.join('/home/test', 'Documents', 'Scheherazade-work'), userData: path.join('/appdata', 'scheherazade-work'), agentName: 'scheherazade-work' }))
check('creation prompt waits for Electron readiness', () => {
  const main = fs.readFileSync(new URL('../main.cjs', import.meta.url), 'utf8')
  const ready = main.indexOf('app.whenReady().then(async () => {')
  assert(main.indexOf('message: `Create profile') > ready)
  assert(main.indexOf('profiles.parseProfile(process.argv)') < main.indexOf("app.setPath('userData'"))
  assert(main.indexOf("app.setPath('userData'") < main.indexOf("require('./onboarding/http-server.cjs')"))
})
// design-0029: execute the actual early main block, including its return paths.
{
  const main = fs.readFileSync(new URL('../main.cjs', import.meta.url), 'utf8')
  const early = main.slice(main.indexOf('const profiles ='), main.indexOf("const { spawn }"))
  for (const name of ['', 'work', 'BAD']) {
    const env = {}
    const paths = []
    let exits = 0
    const app = { getPath: () => '/appdata', setPath: (key, value) => paths.push(value), exit: () => exits++ }
    vm.runInNewContext(`(function(){ ${early} })()`, { app, dialog: { showErrorBox() {} }, process: { argv: name ? ['--profile', name] : [], env },
      require: id => id === './profile.cjs' ? profiles : id === 'node:fs' ? { existsSync: () => false } : undefined })
    check(`early boot pairing ${name || 'default'}`, () => {
      if (name === 'BAD') { assert.equal(exits, 1); assert.deepEqual(paths, []); assert.deepEqual(env, {}) }
      else {
        assert.equal(paths[0], path.join('/appdata', `scheherazade${name ? `-${name}` : ''}`))
        assert.equal(env.SERA_PROFILE, name)
        if (!name) assert.equal(Object.hasOwn(env, 'CHROMUX_HOME'), false)
        else assert.equal(env.AGENT_DATA_HOME, profiles.profilePaths(name, { appData: '/appdata' }).dataHome)
      }
    })
  }
  check('second-instance cannot reach creation/onboarding', () => {
    const lock = main.slice(main.indexOf('const gotSingleInstanceLock'), main.indexOf('// Assigned once the app is ready'))
    let quits = 0
    const result = vm.runInNewContext(`(function(){ ${lock}; return 'continued' })()`, { app: { requestSingleInstanceLock: () => false, quit: () => quits++ } })
    assert.equal(quits, 1); assert.equal(result, undefined)
  })
}
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-pairing-'))
  try {
    const paths = profiles.profilePaths('work', { home, appData: path.join(home, 'appdata') })
    fs.mkdirSync(paths.userData, { recursive: true })
    check('declined create removes only empty userData', () => {
      profiles.cleanupEmptyUserData(paths.userData)
      assert.equal(fs.existsSync(paths.userData), false)
      assert.equal(fs.existsSync(paths.dataHome), false)
    })
    fs.mkdirSync(paths.userData)
    fs.writeFileSync(path.join(paths.userData, 'Local State'), 'keep')
    check('declined create never removes nonempty userData', () => {
      profiles.cleanupEmptyUserData(paths.userData)
      assert.equal(fs.readFileSync(path.join(paths.userData, 'Local State'), 'utf8'), 'keep')
    })
    fs.mkdirSync(paths.dataHome, { recursive: true })
    const config = path.join(paths.dataHome, '.agent-config')
    fs.writeFileSync(config, 'DISPLAY_NAME=Sera\n')
    check('existing seeded config gains PROFILE without clobbering', () => {
      profiles.ensureProfileConfig(paths.dataHome, 'work')
      profiles.ensureProfileConfig(paths.dataHome, 'work')
      assert.equal(fs.readFileSync(config, 'utf8'), 'DISPLAY_NAME=Sera\nPROFILE=work\n')
    })
    fs.writeFileSync(path.join(paths.dataHome, '.agent.pid'), String(process.pid))
    check('real live non-Sera pid is not running', () => assert.equal(profiles.pidAlive(paths.dataHome, { name: 'work' }), false))
    check('EPERM is not a verified Sera', () => assert.equal(profiles.pidAlive(paths.dataHome, { name: 'work', kill: () => { throw Object.assign(Error('denied'), { code: 'EPERM' }) } }), false))
    check('only matching supervisor accepted', () => assert.equal(profiles.pidAlive(paths.dataHome, { name: 'work', readCommandLine: () => `${path.resolve('supervisor.mjs')} __loop --profile work` }), true))
    check('sibling signature rejected', () => assert.equal(profiles.pidAlive(paths.dataHome, { name: 'work', readCommandLine: () => `${path.resolve('supervisor.mjs')} __loop --profile other` }), false))
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}
console.log(`test-profile: pass=${pass} fail=0`)
