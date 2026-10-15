import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
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
console.log(`test-profile: pass=${pass} fail=0`)
