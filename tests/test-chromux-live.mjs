import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { gate } = require('../onboarding/chromux-live-gate.cjs')
const { classify, matcher, receive, location, TTL } = require('../onboarding/chromux-live-consent.cjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-live-test-'))
try {
  for (const args of [['snapshot','s'], ['screenshot','s'], ['open','s','--tab','active']]) assert.equal(classify(args), 'read')
  for (const args of [['open','s','https://example.com'], ['open','s','--tab','active','https://example.com'], ['click','s','@1'], ['type','s','x'], ['fill','s','@1','x'], ['press','s','Enter'], ['run','s','x'], ['submit','s'], ['navigate','s','url'], ['eval','s','1'], ['raw','s'], ['unknown']]) assert.equal(classify(args), 'write')
  for (const text of ['응','ㅇㅇ','yes','ok','go','해']) assert.equal(matcher(text), 'yes')
  for (const text of ['ㄴㄴ','아니','no','stop']) assert.equal(matcher(text), 'no')
  for (const text of ['yesterday','okay maybe','perhaps','']) assert.equal(matcher(text), 'other')
  assert.equal(matcher('yes', true), 'other')
  const argv = ['click','helper','--text','구매'], channel = 'c1'
  let reached = 0
  const call = (args = argv, now = 1000) => gate({ home, entry: '', argv: args, channel, now, execute: () => { reached++; return 0 } })
  assert.equal(call(), 4)
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE="true"\n')
  assert.equal(call(), 3); assert.equal(reached, 0)
  assert.equal(call(['open','helper','--tab','active']), 0)
  const ask = () => call(['--ask',JSON.stringify(argv)])
  assert.equal(ask(), 0)
  assert.equal(receive(home,channel,'yes',true,1100), false)
  assert.equal(call(), 3)
  assert.equal(receive(home,'other','yes',false,1100), false)
  assert.equal(receive(home,channel,'yes',false,1100), true)
  assert.equal(call(argv,1200), 0)
  assert.equal(fs.existsSync(location(home,channel,argv)), false)
  assert.equal(call(argv,1200), 3)
  ask(); receive(home,channel,'yes',false,1100)
  assert.equal(call(argv,1100 + TTL + 1), 3)
  ask(); assert.equal(receive(home,channel,'yes',false,1000 + TTL + 1), false)
  assert.equal(call(), 3)
  ask(); receive(home,channel,'no',false,1100); assert.equal(receive(home,channel,'yes',false,1200), false)
  assert.equal(call(), 3)
  assert.equal(call(['--ask','not-json']), 3)
  const fake = path.join(home, 'fake.cjs')
  fs.writeFileSync(fake, `if (process.env.CHROMUX_PROFILE !== 'live') process.exit(9); console.log('EXEC_REACHED')`)
  const script = fileURLToPath(new URL('../onboarding/chromux-live-gate.cjs', import.meta.url))
  const cli = args => spawnSync(process.execPath, [script, home, fake, '--channel', channel, ...args], { encoding: 'utf8' })
  assert.equal(cli(argv).status, 3)
  assert.equal(cli(['snapshot','helper']).stdout.trim(), 'EXEC_REACHED')
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=false\n')
  assert.equal(cli(argv).status, 4)
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=true\n')
  assert.equal(cli(['--ask',JSON.stringify(argv)]).status, 0)
  assert.equal(receive(home,channel,'응',false), true)
  const executed = cli(argv)
  assert.equal(executed.status, 0); assert.equal(executed.stdout.trim(), 'EXEC_REACHED')
  assert.equal(cli(argv).status, 3)
  console.log('PASS: live verb classification, toggle, single-use consent, expiry, human matcher')
} finally { fs.rmSync(home, { recursive: true, force: true }) }
