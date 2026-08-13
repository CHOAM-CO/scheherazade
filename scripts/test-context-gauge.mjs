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

function runHook(mem, transcriptPath, { event = 'Stop', sessionId } = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: transcriptPath, hook_event_name: event, session_id: sessionId }),
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

// ── 3. no-clobber + ghost marking: usage-free transcript keeps the previous
// snapshot's NUMBERS but stamps it carriedOver (2026-07-28 live catch: an
// unmarked 133K leftover from the prior session read as "133K at boot").
console.log('no-clobber on fresh session:')
{
  const before = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  const t = path.join(mem, 't3.jsonl')
  fs.writeFileSync(t, JSON.stringify({ type: 'user', message: { content: 'fresh boot, no turns yet' } }) + '\n')
  const r = runHook(mem, t, { event: 'SessionStart', sessionId: 'new-session-b' })
  check('hook exits 0 on usage-free transcript', r.status === 0, `status=${r.status}`)
  const after = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  check('previous numbers preserved (never blanked)',
    after.contextTokens === before.contextTokens && after.ts === before.ts && after.model === before.model)
  check('...but stamped carriedOver with a mark time', after.carriedOver === true && typeof after.carriedAt === 'string')
  const markedText = fs.readFileSync(statusPath, 'utf8')
  const r2 = runHook(mem, path.join(mem, 'nonexistent.jsonl'))
  check('missing transcript: exit 0, snapshot untouched', r2.status === 0 && fs.readFileSync(statusPath, 'utf8') === markedText)
  const r3 = runHook(mem, t, { event: 'SessionStart', sessionId: 'new-session-c' })
  check('re-marking is idempotent (carriedAt not rewritten every boot)',
    r3.status === 0 && fs.readFileSync(statusPath, 'utf8') === markedText)
}

// ── 3b. a real turn clears the ghost: fresh usage overwrites marker ────────
console.log('ghost cleared by first real turn:')
{
  const t = path.join(mem, 't3b.jsonl')
  fs.writeFileSync(t, assistantLine('gpt-5.6-luna', { input_tokens: 500, cache_read_input_tokens: 30000, cache_creation_input_tokens: 2000, output_tokens: 100 }) + '\n')
  const r = runHook(mem, t, { event: 'Stop', sessionId: 'new-session-b' })
  const snap = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  check('first turn overwrites: carriedOver gone', r.status === 0 && snap.carriedOver === undefined)
  check('snapshot carries the session id', snap.sessionId === 'new-session-b')
  check('numbers are the new session\'s', snap.contextTokens === 32600)
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

  // ── dynamic model extraction from the CLI binary (2026-08-13) ─────────
  // Pins both record shapes seen live in the 2.1.x binary, the 1e6 exponent
  // parse (a bare [0-9] capture read window:1e6 as 1 on the first live
  // scan), and the same-id-two-tables conflict (opus-4-6: 1e6 legacy /
  // 200000 new -> largest wins, matching the hand-verified pins).
  {
    const { extractClaudeModelsFromBin } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
    const fake = path.join(mem, "fake-claude-bin")
    fs.writeFileSync(fake, [
      'garbage"claude-opus-4-6",context:{window:1e6,native_1m:!0}garbage',
      '"claude-opus-4-5",context:{window:200000,supports_1m_beta:!0}',
      '{id:"claude-fable-5",family:"fable",display_name:"Fable 5",provider_ids:{first_party:"claude-fable-5"},context:{window:1e6,native_1m:!0}}',
      '{id:"claude-opus-4-6",family:"opus",context:{window:200000}}', // conflicting second table
      '"claude-bogus",context:{window:7}', // sub-1000 = mis-parse, dropped
    ].join('\n'))
    const models = extractClaudeModelsFromBin(fake)
    const byId = Object.fromEntries(models.map((m) => [m.id, m.window]))
    check('legacy-shape record extracted with 1e6 parsed', byId['claude-opus-4-5'] === 200000 && byId['claude-opus-4-6'] === 1000000)
    check('new-shape (id:"...") record extracted', byId['claude-fable-5'] === 1000000)
    check('same-id conflict resolves to the largest window', byId['claude-opus-4-6'] === 1000000)
    check('sub-1000 window dropped as mis-parse', !('claude-bogus' in byId))
    check('missing binary -> [] (static catalog stands)', extractClaudeModelsFromBin(path.join(mem, "nope")).length === 0)
  }

  // ── every model the user can PICK resolves to a cap (2026-08-04) ──────
  // The list above is hand-written, which makes it a THIRD copy of the same
  // fact (connectors.js's MODEL_CATALOG, http-server.cjs's cap table, here) --
  // and copies drift. They already have: contextCapForModel's CLAUDE_1M set
  // names claude-opus-4-7 and claude-sonnet-4-6, and neither exists in the
  // catalog.
  //
  // That direction of drift is harmless -- a dead entry in the fallback set
  // just never matches, and it is deliberately NOT asserted away here,
  // because a user whose config carries an older model id still wants a
  // gauge. The direction that HURTS is the reverse: a model added to the
  // picker with no cap entry. Cap null renders as no gauge at all, so the
  // user picks a model from our own menu and the context meter silently
  // stops working. Nothing today catches that; this does.
  //
  // Source-text read, not import: connectors.js is browser code (it touches
  // `window` at load) and importing it here would fail rather than test.
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'public', 'js', 'connectors.js'), 'utf8')
  const catStart = settingsSrc.indexOf('const MODEL_CATALOG = [')
  const catEnd = settingsSrc.indexOf('\n  ]', catStart)
  check('located MODEL_CATALOG in connectors.js', catStart !== -1 && catEnd > catStart)
  const catalogIds = [...settingsSrc.slice(catStart, catEnd).matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1])
  check(`MODEL_CATALOG scan found rows (${catalogIds.length})`, catalogIds.length >= 5, catalogIds.join(','))

  for (const id of catalogIds) {
    // Ollama and custom-proxy ids are third-party model tags -- we have no
    // receipts for their context windows and the cap table says so by
    // returning null. Asserting a cap for those would be inventing one, which
    // is the opposite of what this cap table is for. Only the two families we
    // have receipts for are required to resolve.
    // gpt-oss is an OLLAMA catalog tag (default row 2026-08-13), not a
    // codex-family id -- same '^gpt' ambiguity channel-slack's laneHasVision
    // hit the same day (see its /^gpt-\d/ comment). Receipts-backed means
    // first-party claude + codex gpt-<digit> only.
    const receiptsBacked = id.startsWith('claude-') || /^gpt-\d/.test(id)
    if (!receiptsBacked) continue
    const got = contextCapForModel(id)
    check(`catalog model '${id}' resolves to a cap (else its gauge silently disappears)`, got.cap !== null, JSON.stringify(got))
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
  // The gauge additive migration (ensureSettingsLocalAdditions) moved to
  // onboarding/harness-render.cjs (issue #9 PR-3) -- same assertions, new home.
  const renderSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'harness-render.cjs'), 'utf8')
  check('harness-render carries the gauge additive migration', renderSrc.includes("const GAUGE_HOOK = 'context-gauge.mjs'"))
  check('migration covers BOTH event groups', /hasGaugeIn\(settings\.hooks\.Stop\)/.test(renderSrc) && /hasGaugeIn\(settings\.hooks\.SessionStart\)/.test(renderSrc))
  // Route bodies moved to onboarding/routes/agent-lifecycle.cjs (issue #9 PR-2).
  const lifecycleSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'agent-lifecycle.cjs'), 'utf8')
  check('/api/context-status route exists', lifecycleSrc.includes("pathname === '/api/context-status'"))
}

fs.rmSync(mem, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
