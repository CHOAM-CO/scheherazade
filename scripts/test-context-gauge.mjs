#!/usr/bin/env node
// test-context-gauge.mjs -- the v0.0.22 context-occupancy instrument,
// attacked at three levels. Context (Mino live test 07-16): a 372K-lane
// agent hit its context ceiling ~1.5h into real use, every turn drowned in
// a 2-3min autocompact pass, and the app had ZERO occupancy visibility (the
// agent terminal is a headless PTY; /context is a CLI-UI command nothing
// can type).
//
// The promises:
//   1. HOOK: hooks/context-gauge.mjs tail-parses the transcript's most
//      recent usage block and atomically writes context-status.json --
//      including through a tail whose first record is truncated garbage.
//   2. NO-CLOBBER: a transcript with no usage yet (fresh session) never
//      blanks a previous snapshot.
//   3. CAP TABLE: http-server's contextCapForModel() returns the receipts-
//      backed caps (claude CLI 2.1.211 binary table / codex-as-api 0.6.3
//      table) and null for unknown ids -- never a guessed number.
//
// Run: node scripts/test-context-gauge.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, 'hooks', 'context-gauge.mjs')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

function runHook(mem, transcriptPath) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: transcriptPath, hook_event_name: 'Stop' }),
    env: { ...process.env, AGENT_DATA_HOME: mem },
    timeout: 15000,
  })
}

function assistantLine(model, usage) {
  return JSON.stringify({ type: 'assistant', message: { model, usage, content: [{ type: 'text', text: 'x' }] } })
}

const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-gauge-'))
const statusPath = path.join(mem, 'context-status.json')

// ── 1. hook: last usage wins, occupancy summed, atomic file lands ──────────
console.log('hook extraction:')
{
  const t = path.join(mem, 't1.jsonl')
  const older = assistantLine('gpt-5.6-luna', { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 })
  const newer = assistantLine('gpt-5.6-luna', { input_tokens: 1000, cache_read_input_tokens: 120000, cache_creation_input_tokens: 4000, output_tokens: 500 })
  fs.writeFileSync(t, [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    older,
    JSON.stringify({ type: 'system', subtype: 'other', text: '"usage" mentioned but no block here' }),
    newer,
    JSON.stringify({ type: 'user', message: { content: 'again' } }),
  ].join('\n') + '\n')
  const r = runHook(mem, t)
  check('hook exits 0', r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(0, 200)}`)
  const snap = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  check('LAST usage block wins', snap.usage.input_tokens === 1000, JSON.stringify(snap.usage))
  check('occupancy = input+cache_read+cache_creation+output', snap.contextTokens === 125500, String(snap.contextTokens))
  check('model captured', snap.model === 'gpt-5.6-luna', String(snap.model))
  check('no tmp file left behind (atomic rename)', !fs.existsSync(`${statusPath}.tmp`))
}

// ── 2. truncated-tail robustness: giant garbage line, then valid entries ───
console.log('tail truncation:')
{
  const t = path.join(mem, 't2.jsonl')
  const giant = JSON.stringify({ type: 'user', message: { content: 'A'.repeat(600 * 1024) } })
  const target = assistantLine('claude-sonnet-5', { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 })
  fs.writeFileSync(t, giant + '\n' + target + '\n')
  const r = runHook(mem, t)
  check('hook exits 0 through truncated tail', r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(0, 200)}`)
  const snap = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  check('usage found past the truncated first record', snap.contextTokens === 10 && snap.model === 'claude-sonnet-5', JSON.stringify({ t: snap.contextTokens, m: snap.model }))
}

// ── 3. no-clobber: usage-free transcript keeps the previous snapshot ───────
console.log('no-clobber on fresh session:')
{
  const before = fs.readFileSync(statusPath, 'utf8')
  const t = path.join(mem, 't3.jsonl')
  fs.writeFileSync(t, JSON.stringify({ type: 'user', message: { content: 'fresh boot, no turns yet' } }) + '\n')
  const r = runHook(mem, t)
  check('hook exits 0 on usage-free transcript', r.status === 0, `status=${r.status}`)
  check('previous snapshot preserved', fs.readFileSync(statusPath, 'utf8') === before)
  const r2 = runHook(mem, path.join(mem, 'nonexistent.jsonl'))
  check('missing transcript: exit 0, snapshot preserved', r2.status === 0 && fs.readFileSync(statusPath, 'utf8') === before)
}

// ── 4. cap table: receipts-backed values only ───────────────────────────────
console.log('cap table:')
{
  const require_ = createRequire(path.join(ROOT, 'package.json'))
  const { contextCapForModel } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
  const cases = [
    ['gpt-5.6-luna', 372000, 'codex-as-api-table'],
    ['gpt-5.6-sol', 372000, 'codex-as-api-table'],
    ['gpt-5.6-terra', 372000, 'codex-as-api-table'],
    ['gpt-5.5', 272000, 'codex-as-api-table'],
    ['claude-fable-5', 1000000, 'claude-cli-table'],
    ['claude-opus-4-8', 1000000, 'claude-cli-table'],
    ['claude-opus-4-6', 1000000, 'claude-cli-table'],
    ['claude-opus-4-6[1m]', 1000000, 'claude-cli-table'],
    ['claude-sonnet-5', 1000000, 'claude-cli-table'],
    ['claude-haiku-4-5', 200000, 'claude-cli-table'],
    ['claude-opus-4-5', 200000, 'claude-cli-table'],
    ['kimi-k2.7-code', null, null],
    [null, null, null],
  ]
  for (const [model, cap, src] of cases) {
    const got = contextCapForModel(model)
    check(`cap(${model}) = ${cap}/${src}`, got.cap === cap && got.capSource === src, JSON.stringify(got))
  }
}

// ── 5. wiring tripwires: template + existing-install migration ─────────────
// Same class as test-hooks-port's BASH_HOOK_PORT check: the "disk updated,
// config frozen" half-update (diagnosed live on Mino's install 07-13) means
// a hook that exists only in the template never reaches existing installs.
console.log('wiring:')
{
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'claude-settings.local.json'), 'utf8'))
  const hasGauge = (groups) => Array.isArray(groups) && groups.some((g) =>
    Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes('context-gauge.mjs')))
  check('template registers gauge on Stop', hasGauge(template.hooks.Stop))
  check('template registers gauge on SessionStart', hasGauge(template.hooks.SessionStart))
  const httpSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  check('http-server carries the gauge additive migration', httpSrc.includes("const GAUGE_HOOK = 'context-gauge.mjs'"))
  check('migration covers BOTH event groups', /hasGaugeIn\(settings\.hooks\.Stop\)/.test(httpSrc) && /hasGaugeIn\(settings\.hooks\.SessionStart\)/.test(httpSrc))
  check('/api/context-status route exists', httpSrc.includes("pathname === '/api/context-status'"))
}

fs.rmSync(mem, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
