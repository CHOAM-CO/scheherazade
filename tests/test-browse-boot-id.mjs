// test-browse-boot-id.mjs -- regression for the 2026-10-07 15:19 "session consent vanished" report.
// Root cause: onboarding/routes/quickbar.cjs wrote DATA_HOME/consent/app-boot-id at route binding,
// i.e. on every require() of onboarding/http-server.cjs. Several tests and tools/test-packaging.mjs
// require it without AGENT_DATA_HOME, so each `npm test` rotated the live app's boot id and
// chromux-live-consent.sessionValid() went false (gate exit 3) while the session file still existed.
// Now: requiring http-server.cjs writes nothing under DATA_HOME/consent, and the gate never reads it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-boot-id-'))
process.env.AGENT_DATA_HOME = home
process.env.HOME = home
try {
  const { setSession, sessionValid } = require('../onboarding/chromux-live-consent.cjs')
  const { gate } = require('../onboarding/chromux-live-gate.cjs')
  fs.mkdirSync(path.join(home, 'consent'), { recursive: true })
  fs.writeFileSync(path.join(home, 'consent', 'app-boot-id'), 'app-boot-1')
  setSession(home, 'in-app', true)
  assert.equal(sessionValid(home, 'in-app'), true)
  require('../onboarding/http-server.cjs')
  require('../onboarding/routes/quickbar.cjs').createRoutes({ fs, path, DATA_HOME: home, sendJson() {}, readAgentConfig: () => ({}), checkForUpdate: async () => ({}), APP_VERSION: '0', log() {} })
  assert.equal(fs.readFileSync(path.join(home, 'consent', 'app-boot-id'), 'utf8'), 'app-boot-1', 'route binding rotated the boot id')
  assert.equal(sessionValid(home, 'in-app'), true)
  fs.writeFileSync(path.join(home, '.agent-config'), 'BROWSE_LIVE=true\n')
  fs.rmSync(path.join(home, 'consent'), { recursive: true, force: true })
  let ran = 0
  assert.equal(gate({ home, argv: ['click', 'helper', '@1'], channel: 'in-app', execute: () => { ran++; return 0 } }), 0)
  assert.equal(ran, 1)
  console.log('PASS: requiring http-server.cjs leaves DATA_HOME/consent alone; gate runs writes with no consent file')
} finally { fs.rmSync(home, { recursive: true, force: true }) }
