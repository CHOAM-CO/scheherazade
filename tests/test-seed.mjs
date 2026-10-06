import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { preserveSeedBlock, writePersona, setSeedBlock, showSeedStep, seedText } = require('../cadence/seed.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'))
try {
  for (const locked of [false, true]) {
    const block = `<!-- seed:locked=${locked} -->\n**씨앗**: 호기심\n`
    assert.equal(preserveSeedBlock(block + 'old habit', 'new habit'), block + 'new habit')
    assert.equal(preserveSeedBlock(block + 'old habit', `<!-- seed:locked=false -->\n**씨앗**: changed\ntrimmed`), block + 'trimmed')
    assert.equal(preserveSeedBlock(block + 'old habit', block + 'add habit'), block + 'add habit')
  }
  assert.equal(preserveSeedBlock('legacy', 'new'), 'new')
  setSeedBlock(dir, 'care', true)
  const logs = []; writePersona(dir, 'new habit', line => logs.push(line))
  assert.equal(logs.length, 1)
  assert.match(fs.readFileSync(path.join(dir, 'self_persona.md'), 'utf8'), /locked=true.*\n\*\*씨앗\*\*: 돌봄.*\nnew habit/s)
  assert.equal(showSeedStep({}), true)
  assert.equal(showSeedStep({ DISPLAY_NAME: 'old' }), false)
  assert.equal(showSeedStep({ ONBOARDING_COMPLETE: '1' }), false)
  assert.equal(showSeedStep({ SEED: 'care' }), false)
  assert.throws(() => seedText('x\ny'))
  // Execute the actual config reader/writer in isolation, not a mock serializer.
  const source = fs.readFileSync(new URL('../onboarding/http-server.cjs', import.meta.url), 'utf8')
  const read = source.slice(source.indexOf('function readAgentConfig()'), source.indexOf('// Persist the list form'))
  const write = source.slice(source.indexOf('function writeAgentConfig(fields)'), source.indexOf('// ── mute-strike ledger'))
  const context = { fs, AGENT_CONFIG_PATH: path.join(dir, '.agent-config'), ensureConfigDir() {}, shellQuote: v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`') + '"' }
  vm.createContext(context)
  vm.runInContext(read + write, context)
  const fields = { SEED: '함께 "탐색" $ ` \\', SEED_OATH: '2026-10-06T00:00:00.000Z', SEED_OATH_USER: '미노', SEED_OATH_COMPANION: '동료' }
  context.writeAgentConfig(fields)
  for (const [k, v] of Object.entries(fields)) assert.equal(context.readAgentConfig()[k], v)
  console.log('PASS seed preservation, locked log, fresh-only meta and config round-trip')
} finally { fs.rmSync(dir, { recursive: true }) }
