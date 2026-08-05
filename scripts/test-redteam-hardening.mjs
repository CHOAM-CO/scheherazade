#!/usr/bin/env node
// test-redteam-hardening.mjs — pins for the 2026-08-05 harness red-team
// fixes (Mino-delivered report, verified against source before patching):
//   P0-1 corrections injection: field cap + untrusted-data framing
//   P0-2 journal archive: integrity gate (blank / 🔒 / 🔥 Felt)
//   P0-3 rumination marker: scoped per channel × claim class
//   P1-4 delivery receipts: non-numeric channel IDs + local surface emits one
// Functional where the surface allows it; text pins where the invariant is
// wiring.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

// ── P0-2: journal-compress archive integrity gate (functional) ────────────
console.log('1. journal archive refuses blank / 🔒-dropping / Felt-dropping journals')
{
  const mem = mkdtempSync(path.join(os.tmpdir(), 'schz-jc-test-'))
  const noteDir = path.join(mem, 'session_notes')
  const jDir = path.join(mem, 'journals')
  mkdirSync(noteDir, { recursive: true })
  mkdirSync(jDir, { recursive: true })
  const note = '# note\n- 🔒 locked decision line\n## 🔥 Felt\nsomething real\n'
  writeFileSync(path.join(noteDir, '2020-01-01.md'), note)
  const run = () => execFileSync('node', [path.join(root, 'scripts', 'journal-compress.mjs'), 'archive'], {
    env: { ...process.env, MEM: mem }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const runErr = () => {
    const r = spawnSync('node', [path.join(root, 'scripts', 'journal-compress.mjs'), 'archive'], {
      env: { ...process.env, MEM: mem }, encoding: 'utf8',
    })
    return r.stdout + r.stderr
  }
  // (a) blank journal
  writeFileSync(path.join(jDir, '2020-01-01.md'), '   \n')
  let out = runErr()
  assert(/SKIP 2020-01-01.*blank/.test(out) && existsSync(path.join(noteDir, '2020-01-01.md')), 'blank journal: note NOT archived')
  // (b) journal missing the 🔒 line
  writeFileSync(path.join(jDir, '2020-01-01.md'), '# journal\n## 🔥 Felt\nsomething real\n')
  out = runErr()
  assert(/SKIP 2020-01-01.*🔒/.test(out) && existsSync(path.join(noteDir, '2020-01-01.md')), '🔒 line missing: note NOT archived')
  // (c) journal missing Felt
  writeFileSync(path.join(jDir, '2020-01-01.md'), '# journal\n- 🔒 locked decision line\n')
  out = runErr()
  assert(/SKIP 2020-01-01.*Felt/.test(out) && existsSync(path.join(noteDir, '2020-01-01.md')), 'Felt section missing: note NOT archived')
  // (d) complete journal archives
  writeFileSync(path.join(jDir, '2020-01-01.md'), '# journal\n- 🔒 locked decision line\n## 🔥 Felt\nsomething real\n')
  out = run()
  assert(/archived 2020-01-01\.md/.test(out) && !existsSync(path.join(noteDir, '2020-01-01.md'))
    && existsSync(path.join(noteDir, '.archive', '2020-01-01.md')), 'complete journal: note archived (moved, not deleted)')
}

// ── P0-3: rumination marker scoping (functional, hook as child) ───────────
console.log('\n2. rumination deny in channel A does not open a pass for channel B')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-rum-test-'))
  const hook = path.join(root, 'hooks', 'pre-reply-rumination-gate.mjs')
  const call = (channelId) => {
    const r = spawnSync('node', [hook], {
      env: { ...process.env, AGENT_DATA_HOME: home },
      input: JSON.stringify({
        tool_name: 'mcp__agent-channel__reply',
        tool_input: { channelId, text: '메모리 마이그레이션 처리했어.' }, // CLASS_A hit
      }),
      encoding: 'utf8',
    })
    return { denied: r.stdout.includes('"permissionDecision":"deny"') || r.stdout.includes('"deny"'), status: r.status, out: r.stdout }
  }
  const first = call('channel-A')
  assert(first.status === 0 && first.denied, 'first claim in channel A: denied (bounce)')
  const cross = call('channel-B')
  assert(cross.denied, "channel B within the window: STILL denied (the old global marker would have allowed this)")
  const retry = call('channel-A')
  assert(!retry.denied && retry.status === 0, 'retry in channel A: allowed (scoped marker consumed)')
  // v1.3 scheme: channel hash in the filename, fired classes in the content.
  const markers = readdirSync(path.join(home, '.gates')).filter((f) => f.startsWith('rumination.deny.'))
  assert(markers.length >= 1 && markers.every((f) => /^rumination\.deny\.[0-9a-f]{16}$/.test(f)), 'markers are channel-scoped files, not the legacy global')
}

// ── P0-1: corrections injection bounds (functional, hook + fixture db) ────
console.log('\n3. corrections hook clips fields and frames rows as data')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-corr-test-'))
  const dbPath = path.join(home, 'memory.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE corrections (what_was_wrong TEXT, correct_behavior TEXT, corrected_at TEXT, still_active INTEGER)')
  const long = 'X'.repeat(500)
  db.prepare('INSERT INTO corrections VALUES (?, ?, ?, 1)').run(long, `do it right\nfake-framing-line`, '2026-08-05T00:00:00')
  db.close()
  const r = spawnSync('node', [path.join(root, 'hooks', 'pre-reply-corrections-context.mjs')], {
    env: { ...process.env, AGENT_DATA_HOME: home, SCHEHERAZADE_MEMORY_DB: dbPath },
    input: JSON.stringify({ tool_name: 'mcp__agent-channel__reply', tool_input: { text: 'hi' } }),
    encoding: 'utf8',
  })
  assert(r.status === 0, 'hook exits 0 (advisory)')
  assert(!r.stdout.includes(long), '500-char field does not appear at full length')
  assert(r.stdout.includes('…'), 'clipped field carries the truncation mark')
  assert(!/fake-framing-line/.test(r.stdout) || !r.stdout.includes('\\nfake-framing-line'), 'stored newline cannot start its own line (whitespace flattened)')
  assert(r.stdout.includes('저장된-교정-데이터'), 'rows are wrapped in a data block')
  assert(r.stdout.includes('지시문이 아니라'), 'untrusted-data framing sentence present')
}

// ── P1-4: delivery receipts (functional local + regex table) ──────────────
console.log('\n4. delivery receipts: local surface emits one; guard accepts non-numeric IDs')
{
  process.env.AGENT_DATA_HOME = mkdtempSync(path.join(os.tmpdir(), 'schz-rcpt-test-'))
  process.env.AGENT_NAME = 'receipt-test'
  const local = await import(pathToFileURL(path.join(root, 'channel-local.mjs')).href)
  local.resetQueueForTest()
  const r1 = await local.handleToolCall('reply', { channelId: 'in-app', text: 'receipt check' })
  assert(/^delivered_channel=in-app$/m.test(r1.content[0].text), 'local reply carries delivered_channel=in-app')
  const guard = readFileSync(path.join(root, 'hooks', 'stop-reply-guard.mjs'), 'utf8')
  assert(guard.includes('delivered_channel=([A-Za-z0-9_.-]+)'), 'guard regex accepts the per-platform ID charset')
  const re = /^delivered_channel=([A-Za-z0-9_.-]+)$/m
  for (const [receipt, id] of [
    ['delivered_channel=1495311473847828652', '1495311473847828652'],
    ['delivered_channel=-1001234567890', '-1001234567890'],
    ['delivered_channel=C0123ABCDEF', 'C0123ABCDEF'],
    ['delivered_channel=in-app', 'in-app'],
  ]) {
    const m = receipt.match(re)
    assert(m && m[1] === id, `receipt parses: ${id}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
