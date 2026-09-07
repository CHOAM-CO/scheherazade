#!/usr/bin/env node
// test-file-ledger.mjs — pins the recent-files ledger (같이보기 batch,
// 2026-08-19): writer hook post-tool-file-ledger.mjs + wiring pins.
// Run: node tests/test-file-ledger.mjs
//
// The hook runs as a REAL child process with payloads piped to stdin and a
// sandboxed AGENT_DATA_HOME — same shape as test-receipt-ledger.mjs.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, 'hooks', 'post-tool-file-ledger.mjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

const freshHome = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sched-flt-${tag}-`))
const runHook = (payload, home, extraEnv = {}) => spawnSync(process.execPath, [HOOK], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  env: { ...process.env, AGENT_DATA_HOME: home, ...extraEnv },
  encoding: 'utf8',
})
const readLedger = (home) => {
  try {
    return fs.readFileSync(path.join(home, '.gates', 'file-ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

console.log('1. records file-writing tools, skips everything else')
{
  const home = freshHome('basic')
  for (const [tool, input] of [
    ['Write', { file_path: '/tmp/a.md' }],
    ['Edit', { file_path: '/tmp/a.md' }],
    ['MultiEdit', { file_path: '/tmp/b.md' }],
    ['NotebookEdit', { notebook_path: '/tmp/n.ipynb' }],
    ['Bash', { command: 'ls' }],
    ['Read', { file_path: '/tmp/a.md' }],
  ]) {
    const r = runHook({ tool_name: tool, tool_input: input, tool_response: 'ok' }, home)
    assert(r.status === 0, `${tool}: exits 0`)
  }
  const rows = readLedger(home)
  assert(rows.length === 4, `4 rows recorded (got ${rows.length}) — Bash/Read filtered out`)
  assert(rows.every((r) => typeof r.ts === 'number' && r.path), 'rows carry ts + path')
  assert(rows[3].path === '/tmp/n.ipynb', 'NotebookEdit records notebook_path')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('2. failure marking, honest not hidden')
{
  const home = freshHome('failed')
  runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, tool_response: { interrupted: true } }, home)
  runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, tool_response: 'Error: EACCES' }, home)
  runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, tool_response: 'File created successfully' }, home)
  const rows = readLedger(home)
  assert(rows[0].failed === true, 'interrupted -> failed:true')
  assert(rows[1].failed === true, 'Error:-prefixed string response -> failed:true')
  assert(rows[2].failed === undefined, 'success row carries no failed field')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('3. fail-open contract')
{
  const home = freshHome('failopen')
  assert(runHook('not json{{', home).status === 0, 'garbage stdin exits 0')
  assert(runHook('', home).status === 0, 'empty stdin exits 0')
  assert(runHook({ tool_name: 'Write', tool_input: {} }, home).status === 0, 'missing file_path exits 0')
  assert(readLedger(home).length === 0, 'none of those wrote a row')
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/k' } }, home, { SCHEHERAZADE_FILE_LEDGER: '0' })
  assert(r.status === 0 && readLedger(home).length === 0, 'kill switch: exits 0, writes nothing')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('4. rotation keeps a .1 window (history HAS a consumer)')
{
  const home = freshHome('rotate')
  const gates = path.join(home, '.gates')
  fs.mkdirSync(gates, { recursive: true })
  fs.writeFileSync(path.join(gates, 'file-ledger.jsonl'), `${JSON.stringify({ ts: 1, tool: 'Write', path: '/old' })}\n`.repeat(15000)) // ~630KB > the 512KB cap
  runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/new.md' }, tool_response: 'ok' }, home)
  assert(fs.existsSync(path.join(gates, 'file-ledger.jsonl.1')), 'oversized ledger rotated to .1, not deleted')
  const live = readLedger(home)
  assert(live.length === 1 && live[0].path === '/tmp/new.md', 'fresh ledger starts with the new row')
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('5. source pins: template wiring + additive migration + route binding (same-commit rule)')
{
  const template = fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'claude-settings.local.json'), 'utf8')
  assert(template.includes('post-tool-file-ledger.mjs'), 'template carries the hook')
  const parsed = JSON.parse(template)
  const group = (parsed.hooks.PostToolUse || []).find((g) => g.matcher === 'Write|Edit|MultiEdit|NotebookEdit')
  assert(!!group, 'template has the file-tools matcher group (NOT widened into the Bash group)')
  const render = fs.readFileSync(path.join(ROOT, 'onboarding', 'harness-render.cjs'), 'utf8')
  assert(render.includes("FILE_LEDGER_HOOK = 'post-tool-file-ledger.mjs'"), 'harness-render carries the additive migration (existing installs get the hook)')
  const server = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  assert(server.includes("require('./routes/files.cjs')"), 'files.cjs route group is bound in API_ROUTES')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
