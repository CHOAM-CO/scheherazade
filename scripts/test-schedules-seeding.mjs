// test-schedules-seeding.mjs -- Dreaming feature (2026-08-16), the seeding
// half. Two separate contracts, both attacked over REAL artifacts:
//   1. hooks/session-start.mjs seeds DATA_HOME/schedules.json with the
//      default memory-consolidation entry -- absence-only, byte-for-byte
//      untouched if the file already exists (user/agent owns it once it's
//      there).
//   2. onboarding/harness-render.cjs renders procedures/memory-consolidation.md
//      into DATA_HOME the same way it renders the other 3 trigger-load
//      procedures (journal-compression.md / persona-reflux.md / madoromi.md).
//
// Same runPorted/tmp shape as scripts/test-hooks-port.mjs (which already
// owns the rest of session-start.mjs's contract) -- this file only adds the
// schedules-seeding assertions test-hooks-port.mjs does not cover, and does
// not duplicate its skill-listing / pending-compression / permission-wall
// coverage.
//
// Run: node scripts/test-schedules-seeding.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

function runSessionStart(mem) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs')],
    { env: { ...process.env, MEM: mem }, encoding: 'utf8' })
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status ?? 1 }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sched-seed-'))

// ── 1. fresh DATA_HOME -> schedules.json seeded ─────────────────────────────
console.log('-- schedules.json seeding: fresh DATA_HOME')
{
  const mem = tmp()
  const r = runSessionStart(mem)
  ok('session-start.mjs exits clean', r.code === 0, `code=${r.code} stderr=${r.stderr}`)
  const schedulesPath = path.join(mem, 'schedules.json')
  ok('schedules.json created', fs.existsSync(schedulesPath))
  let store
  try { store = JSON.parse(fs.readFileSync(schedulesPath, 'utf8')) } catch (err) { store = null; ok('schedules.json parses as JSON', false, err.message) }
  if (store) {
    ok('store version is 1', store.version === 1)
    // 0.2.12: madoromi joins memory-consolidation as a shipped default
    // (Mino 08-23 — dreams never fired on their own before; nothing
    // triggered the cycle CLAUDE.md promised for "idle stretches").
    ok('exactly two seeded entries', Array.isArray(store.schedules) && store.schedules.length === 2, JSON.stringify(store.schedules))
    const entry = Array.isArray(store.schedules) ? store.schedules.find((s) => s && s.id === 'memory-consolidation') : null
    ok('memory-consolidation entry present', !!entry)
    ok('enabled', entry && entry.enabled === true)
    ok('kind is recurring', entry && entry.kind === 'recurring')
    ok('everyMinutes is 1440 (daily)', entry && entry.everyMinutes === 1440)
    ok('window is 03:00-06:00', entry && entry.window === '03:00-06:00')
    ok('prompt points at the procedure file', entry && entry.prompt === 'Read procedures/memory-consolidation.md and follow it.', entry && entry.prompt)
    // Load-bearing: "agent" is the ONLY createdBy that rides the consent gate
    // in cadence/schedule-tick.cjs (isConsented / AUTONOMY=yes) instead of
    // bypassing it -- "system" would fire unsupervised with no consent at all.
    ok('createdBy is "agent" (rides the AUTONOMY=yes consent gate, never bypasses it)', entry && entry.createdBy === 'agent')
    ok('lastRunISO starts null', entry && entry.lastRunISO === null)
    const dream = Array.isArray(store.schedules) ? store.schedules.find((s) => s && s.id === 'madoromi') : null
    ok('madoromi entry present', !!dream)
    ok('madoromi enabled', dream && dream.enabled === true)
    ok('madoromi kind is recurring', dream && dream.kind === 'recurring')
    ok('madoromi everyMinutes is 1440 (daily)', dream && dream.everyMinutes === 1440)
    ok('madoromi window is 13:00-21:00 (first contact lands while the human is awake)', dream && dream.window === '13:00-21:00')
    ok('madoromi prompt names the solo script and the procedure file', dream && /madoromi-solo\.mjs/.test(dream.prompt) && /procedures\/madoromi\.md/.test(dream.prompt), dream && dream.prompt)
    ok('madoromi createdBy is "agent" (same consent gate as memory-consolidation)', dream && dream.createdBy === 'agent')
    ok('madoromi lastRunISO starts null', dream && dream.lastRunISO === null)
  }
  const stray = fs.readdirSync(mem).filter((f) => f.endsWith('.tmp') || f.includes('.tmp-'))
  ok('no stray .tmp files left behind by the atomic write', stray.length === 0, JSON.stringify(stray))
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── 2. existing schedules.json -> byte-for-byte untouched ──────────────────
console.log('-- schedules.json seeding: existing file is never touched')
{
  const mem = tmp()
  fs.mkdirSync(mem, { recursive: true })
  const existing = '{"version":1,"schedules":[{"id":"user-made","kind":"once","enabled":true,"prompt":"hi","createdBy":"user","atISO":"2030-01-01T00:00:00.000Z","lastRunISO":null}]}'
  fs.writeFileSync(path.join(mem, 'schedules.json'), existing)
  const r = runSessionStart(mem)
  ok('session-start.mjs exits clean', r.code === 0, `code=${r.code} stderr=${r.stderr}`)
  const after = fs.readFileSync(path.join(mem, 'schedules.json'), 'utf8')
  ok('existing schedules.json is byte-for-byte untouched (no merge, absence-only seeding)', after === existing)
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── 3. procedure file rendered into DATA_HOME by harness-render.cjs ────────
console.log('-- procedures/memory-consolidation.md is harness-rendered like its 3 siblings')
{
  const srcPath = path.join(ROOT, 'procedures', 'memory-consolidation.md')
  ok('source file exists', fs.existsSync(srcPath))

  const renderSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'harness-render.cjs'), 'utf8')
  ok('the render list (same array as the other 3 procedures) includes memory-consolidation.md',
    /for \(const proc of \[[^\]]*'memory-consolidation\.md'[^\]]*\]\)/.test(renderSrc), 'render list literal not found or missing the entry')

  // Functional proof, not just the source-text pin above: actually run the
  // render (renderAgentSubstrate, the same function onboarding-complete and
  // boot-refresh both call) against a throwaway DATA_HOME and check the
  // rendered file lands with {AGENT_DIR}/{AGENT_NAME}/{MEMORY_DIR} resolved,
  // same as journal-compression.md gets.
  const { createHarnessRender } = require(path.join(ROOT, 'onboarding', 'harness-render.cjs'))
  const mem = tmp()
  const configDir = path.join(mem, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const harness = createHarnessRender({
    log: () => {},
    toUnpackedPath: (p) => p,
    readAgentConfig: () => ({}),
    ensureConfigDir: () => {},
    REPO_ROOT: ROOT,
    AGENT_NAME: 'TestAgent',
    DATA_HOME: mem,
    CONFIG_DIR: configDir,
    AGENT_CONFIG_PATH: path.join(configDir, '.agent-config'),
    ENV_PATH: path.join(configDir, '.env'),
    MCP_JSON_PATH: path.join(configDir, '.mcp.json'),
  })
  harness.renderAgentSubstrate({ displayName: 'TestAgent', tone: 'casual', primaryTask: '' })

  for (const proc of ['journal-compression.md', 'persona-reflux.md', 'madoromi.md', 'memory-consolidation.md']) {
    ok(`${proc} rendered into DATA_HOME/procedures`, fs.existsSync(path.join(mem, 'procedures', proc)))
  }
  const renderedMemCon = fs.readFileSync(path.join(mem, 'procedures', 'memory-consolidation.md'), 'utf8')
  const expected = fs.readFileSync(srcPath, 'utf8')
    .replaceAll('{AGENT_DIR}', ROOT)
    .replaceAll('{AGENT_NAME}', 'TestAgent')
    .replaceAll('{MEMORY_DIR}', mem)
  ok('rendered content matches source with placeholders resolved', renderedMemCon === expected)
  ok('rendered file points at the real journal-compress.mjs path', renderedMemCon.includes(path.join(ROOT, 'scripts', 'journal-compress.mjs')))

  fs.rmSync(mem, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
