// test-data-home.mjs -- data-home.cjs, the one DATA_HOME resolver (P3 #4).
// Run: node tests/test-data-home.mjs
//
// The bug this module closes was silent and expensive: a user who set
// AGENT_DATA_HOME moved their config, credentials, notes and lane home -- but
// memory/service.mjs and onboarding/bootstrap.cjs carried hardcoded literals,
// so the DATABASE and the managed binaries stayed in the old home. Nothing
// errored. These are attacks on the precedence and on the two locks (the
// default name, and MEM never reaching the app process).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import profiles from '../profile.cjs'
import { DEFAULT_AGENT_NAME, resolveDataHome, resolveMemoryDb } from '../data-home.cjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const HOME = path.join('/tmp', 'fake-home')
const D = (name) => path.join(HOME, 'Documents', name)

console.log('\n-- precedence: AGENT_DATA_HOME > MEM > ~/Documents/<name>')
{
  ok('AGENT_DATA_HOME wins over MEM',
    resolveDataHome({ env: { AGENT_DATA_HOME: '/a', MEM: '/m' }, home: HOME }) === '/a')
  ok('MEM is the fallback (the lane->hook spelling)',
    resolveDataHome({ env: { MEM: '/m' }, home: HOME }) === '/m')
  ok('neither set -> ~/Documents/Scheherazade (the LOCKED default)',
    resolveDataHome({ env: {}, home: HOME }) === D('Scheherazade'))
  ok('DEFAULT_AGENT_NAME is Scheherazade (decisions.log 114 / HISTORY.md)',
    DEFAULT_AGENT_NAME === 'Scheherazade')
  ok('an explicit agentName follows it (CLI deployments)',
    resolveDataHome({ env: {}, agentName: 'Other', home: HOME }) === D('Other'))
  ok('agentName does NOT override an explicit env home',
    resolveDataHome({ env: { AGENT_DATA_HOME: '/a' }, agentName: 'Other', home: HOME }) === '/a')
  ok('an EMPTY env value is not a home (whitespace-only too)',
    resolveDataHome({ env: { AGENT_DATA_HOME: '', MEM: '   ' }, home: HOME }) === D('Scheherazade'))
  ok('values are trimmed', resolveDataHome({ env: { AGENT_DATA_HOME: ' /a ' }, home: HOME }) === '/a')
}

console.log('\n-- allowMem:false -- a stray MEM must never move the APP process')
{
  // MEM is a dangerously generic name (this repo's own dev machines export one
  // for an unrelated agent). Inside the app it has never been an input, and
  // honouring it would relocate memory.db from under a running install.
  ok('app-side ignores MEM entirely',
    resolveDataHome({ env: { MEM: '/someone/elses/agent' }, home: HOME, allowMem: false }) === D('Scheherazade'))
  ok('app-side still honours AGENT_DATA_HOME',
    resolveDataHome({ env: { AGENT_DATA_HOME: '/a', MEM: '/m' }, home: HOME, allowMem: false }) === '/a')
}

console.log('\n-- memory DB: in the data home, override-able, MEM-proof by default')
{
  ok('db lives in the data home',
    resolveMemoryDb({ env: {}, home: HOME }) === path.join(D('Scheherazade'), 'memory.db'))
  ok('db follows AGENT_DATA_HOME (the whole point -- it used to NOT)',
    resolveMemoryDb({ env: { AGENT_DATA_HOME: '/a' } }) === path.join('/a', 'memory.db'))
  ok('SCHEHERAZADE_MEMORY_DB still wins (smoke/tests point it at a temp file)',
    resolveMemoryDb({ env: { AGENT_DATA_HOME: '/a', SCHEHERAZADE_MEMORY_DB: '/tmp/x.db' } }) === '/tmp/x.db')
  ok('a stray MEM does not move the database',
    resolveMemoryDb({ env: { MEM: '/m' }, home: HOME }) === path.join(D('Scheherazade'), 'memory.db'))
}

console.log('\n-- the copies are gone: no site computes this on its own')
{
  const files = [
    'memory/service.mjs', 'onboarding/http-server.cjs', 'onboarding/bootstrap.cjs',
    'attach-topology.cjs', 'supervisor.mjs', 'channel-runtime.mjs',
    ...fs.readdirSync(path.join(ROOT, 'hooks')).filter((f) => f.endsWith('.mjs')).map((f) => `hooks/${f}`),
  ]
  const hardcoded = /['"]Documents['"]\s*,\s*['"]Scheherazade['"]/
  const perAgent = /join\(os\.homedir\(\),\s*['"]Documents['"]/
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    ok(`${f}: no hand-rolled ~/Documents/... resolution`, !hardcoded.test(src) && !perAgent.test(src))
  }
  // The hooks that used a THIRD spelling (`MEM || cwd`) resolve through the
  // module now -- a hook that writes its ledger into whatever directory the
  // CLI happened to start in is exactly the bug class this closes.
  for (const f of ['hooks/session-start.mjs', 'hooks/checkpoint-nudge.mjs', 'hooks/context-gauge.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    ok(`${f}: no process.cwd() data-home fallback left`, !src.includes('process.cwd()'))
  }
  const httpSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  ok('.mcp.json children carry AGENT_DATA_HOME + SCHEHERAZADE_MEMORY_DB',
    httpSrc.includes('AGENT_DATA_HOME: DATA_HOME') && httpSrc.includes('SCHEHERAZADE_MEMORY_DB: MEMORY_DB_PATH'))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok('data-home.cjs ships (build.files)', pkg.build.files.includes('data-home.cjs'))
  ok('data-home.cjs is unpacked (hooks + supervisor run outside the asar)',
    pkg.build.asarUnpack.includes('data-home.cjs'))
}

// design-0029: data home and Electron userData must stay paired.
for (const name of ['', 'work']) {
  const p = profiles.profilePaths(name, { home: HOME, appData: '/appdata' })
  const suffix = name ? `-${name}` : ''
  ok(`profile ${name || 'default'} data-home mapping`, p.dataHome === D(`Scheherazade${suffix}`))
  ok(`profile ${name || 'default'} userData mapping`, p.userData === path.join('/appdata', `scheherazade${suffix}`))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
