#!/usr/bin/env node
// test-receipt-ledger.mjs — pins design 0017: the receipt ledger writer
// (post-bash-receipt-ledger.mjs) and the rumination gate's evidence branch
// (pre-reply-rumination-gate.mjs v1.2).
// Run: node tests/test-receipt-ledger.mjs
//
// Both hooks run as REAL child processes with payloads piped to stdin and a
// sandboxed AGENT_DATA_HOME — the same execution shape production uses.
// Mirrors test-local-channel.mjs's assert()/pass/fail convention.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER_HOOK = path.join(ROOT, 'hooks', 'post-bash-receipt-ledger.mjs')
const GATE_HOOK = path.join(ROOT, 'hooks', 'pre-reply-rumination-gate.mjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

function freshHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sched-receipt-${tag}-`))
}

function runHook(hookPath, payload, home, extraEnv = {}) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, AGENT_DATA_HOME: home, ...extraEnv },
    encoding: 'utf8',
  })
  return r
}

function ledgerRows(home) {
  const p = path.join(home, '.gates', 'receipt-ledger.jsonl')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function bashPayload(cmd, respOverride) {
  return {
    tool_name: 'Bash',
    tool_input: { command: cmd },
    tool_response: respOverride,
  }
}

// Gate verdict: allow = exit 0 with empty stdout; deny = exit 0 with a
// permissionDecision:'deny' JSON on stdout; fail-loud = exit 2.
function gateVerdict(home, text) {
  const r = runHook(GATE_HOOK, {
    tool_name: 'mcp__agent-channel__reply',
    tool_input: { text },
  }, home)
  if (r.status === 2) return { kind: 'fail-loud', stderr: r.stderr }
  const out = (r.stdout || '').trim()
  if (!out) return { kind: 'allow' }
  const parsed = JSON.parse(out)
  return { kind: 'deny', reason: parsed.hookSpecificOutput.permissionDecisionReason }
}

console.log('\n1. ledger writer: success rows and failure rows')
{
  const home = freshHome('writer')
  runHook(LEDGER_HOOK, bashPayload('echo ok', { stdout: 'ok', stderr: '' }), home)
  runHook(LEDGER_HOOK, bashPayload('npm test', { stdout: 'boom\nExit code 1', stderr: 'ERR' }), home)
  runHook(LEDGER_HOOK, bashPayload('curl x', 'transfer failed\nExit code: 22'), home)
  runHook(LEDGER_HOOK, bashPayload('sleep 999', { stdout: '', interrupted: true }), home)
  const rows = ledgerRows(home)
  assert(rows.length === 4, 'one row per Bash result')
  assert(rows[0].failed === false && !('tail' in rows[0]), 'clean output -> success row, no tail')
  assert(rows[1].failed === true && rows[1].marker === 'exit 1', '"Exit code 1" in object resp -> failed row')
  assert(rows[1].tail.includes('boom'), 'failed row carries the output tail')
  assert(rows[2].failed === true && rows[2].marker === 'exit 22', 'string resp + "Exit code: N" variant -> failed row')
  assert(rows[3].failed === true && rows[3].marker === 'interrupted', 'interrupted -> failed row')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n2. ledger writer: scope and kill switch')
{
  const home = freshHome('scope')
  runHook(LEDGER_HOOK, { tool_name: 'Read', tool_input: {}, tool_response: 'x' }, home)
  assert(ledgerRows(home).length === 0, 'non-Bash tools never write rows')
  runHook(LEDGER_HOOK, bashPayload('echo', { stdout: '' }), home, { SCHEHERAZADE_RECEIPT_LEDGER: '0' })
  assert(ledgerRows(home).length === 0, 'kill switch (SCHEHERAZADE_RECEIPT_LEDGER=0) writes nothing')
  runHook(LEDGER_HOOK, '{not json', home)
  assert(ledgerRows(home).length === 0, 'garbage stdin exits silently (fail-open)')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n3. ledger writer: rotation drops ledger AND cursor together')
{
  const home = freshHome('rotate')
  const gates = path.join(home, '.gates')
  fs.mkdirSync(gates, { recursive: true })
  fs.writeFileSync(path.join(gates, 'receipt-ledger.jsonl'), 'x'.repeat(1024 * 1024 + 10))
  fs.writeFileSync(path.join(gates, 'receipt-ledger.cursor'), '123')
  runHook(LEDGER_HOOK, bashPayload('echo', { stdout: 'hi' }), home)
  const rows = ledgerRows(home)
  assert(rows.length === 1, 'over-cap ledger is dropped before the new row lands')
  assert(!fs.existsSync(path.join(gates, 'receipt-ledger.cursor')), 'cursor is dropped with it (the two never disagree)')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n4. evidence branch: a failed command bounces a claim-free reply ONCE, with the receipt')
{
  const home = freshHome('evidence')
  runHook(LEDGER_HOOK, bashPayload('npm run build', { stdout: 'nope\nExit code 1' }), home)
  const v1 = gateVerdict(home, '오늘 날씨 좋네요~') // no claim wording at all
  assert(v1.kind === 'deny', 'unacknowledged failure denies even a claim-free reply')
  assert(v1.kind === 'deny' && v1.reason.includes('npm run build') && v1.reason.includes('exit 1'),
    'the bounce names the command and the exit marker (specific, not blind)')
  const v2 = gateVerdict(home, '빌드가 실패해서 확인 중이에요.')
  assert(v2.kind === 'allow', 'the retry inside the window passes (one bounce, consumed)')
  const v3 = gateVerdict(home, '다른 얘기 한 줄')
  assert(v3.kind === 'allow', 'judged rows are never re-litigated (cursor advanced on the allowed retry)')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n5. evidence branch: rows created between bounce and retry are part of the judged evidence')
{
  const home = freshHome('recheck')
  runHook(LEDGER_HOOK, bashPayload('deploy.sh', { stdout: 'Exit code 7' }), home)
  assert(gateVerdict(home, '아무 주장 없음').kind === 'deny', 'first reply bounces on the failure')
  // The agent re-runs the command to check — it fails AGAIN before the retry.
  runHook(LEDGER_HOOK, bashPayload('deploy.sh', { stdout: 'Exit code 7' }), home)
  assert(gateVerdict(home, '배포가 계속 실패하고 있어').kind === 'allow', 'retry passes despite the newer failed row')
  assert(gateVerdict(home, '후속 한 줄').kind === 'allow', 'and that newer row was consumed by the retry stamp, not re-bounced')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n6. evidence branch: success-only turns never bounce')
{
  const home = freshHome('clean')
  runHook(LEDGER_HOOK, bashPayload('echo one', { stdout: 'one' }), home)
  runHook(LEDGER_HOOK, bashPayload('echo two', { stdout: 'two' }), home)
  assert(gateVerdict(home, '두 개 다 처리했어요').kind === 'deny',
    'claim wording still bounces once (CLASS_A regression intact)')
  assert(gateVerdict(home, '두 개 다 처리했어요').kind === 'allow', 'claim retry passes (existing machinery intact)')
  assert(gateVerdict(home, '평범한 한 줄').kind === 'allow', 'success-only evidence alone never denies')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n7. claim branch without any ledger still works (no ledger file = no evidence, not an error)')
{
  const home = freshHome('noledger')
  assert(gateVerdict(home, '메일 보냈어요').kind === 'deny', 'CLASS_A denies with no ledger present')
  assert(gateVerdict(home, '메일 보냈어요').kind === 'allow', 'and the bounce consume still works')
  assert(gateVerdict(home, '질문 하나요?').kind === 'allow', 'interrogatives still pass')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('\n8. source pins: template wiring + additive migration exist (same-commit rule)')
{
  const template = fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'claude-settings.local.json'), 'utf8')
  assert(template.includes('post-bash-receipt-ledger.mjs'), 'seeded template wires the ledger hook')
  const render = fs.readFileSync(path.join(ROOT, 'onboarding', 'harness-render.cjs'), 'utf8')
  const ledgerIdx = render.indexOf("const LEDGER_HOOK = 'post-bash-receipt-ledger.mjs'")
  const translatorIdx = render.indexOf("const TRANSLATOR_HOOK = 'post-bash-permission-translator.mjs'")
  assert(ledgerIdx > 0, 'harness-render carries the LEDGER_HOOK additive migration')
  assert(translatorIdx > 0 && ledgerIdx > translatorIdx,
    'ledger migration runs after the translator block (which normalizes hooks.PostToolUse)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
