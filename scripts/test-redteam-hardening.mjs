#!/usr/bin/env node
// test-redteam-hardening.mjs — pins for the 2026-08-05 harness red-team
// fixes (Mino-delivered report, verified against source before patching):
//   P0-1 corrections injection: field cap + untrusted-data framing
//   P0-2 journal archive: integrity gate (blank / 🔒 / 🔥 Felt)
//   P0-3 rumination marker: scoped per channel × claim class
//   P1-4 delivery receipts: non-numeric channel IDs + local surface emits one
// and the three items DEFERRED to design that day, cleared 2026-08-07:
//   5 tail anchor: stop-reply-guard rescans wider when no trigger is found
//   6 sudo taxonomy: askpass names its failure cause; translator routes each
//   7 boot budget: skills listing capped, reflux card snoozed
//   8 sub-note path normalization: credential guard normalizes before match
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
  const run = () => execFileSync(process.execPath, [path.join(root, 'scripts', 'journal-compress.mjs'), 'archive'], {
    env: { ...process.env, MEM: mem }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const runErr = () => {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'journal-compress.mjs'), 'archive'], {
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
    const r = spawnSync(process.execPath, [hook], {
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
  const r = spawnSync(process.execPath, [path.join(root, 'hooks', 'pre-reply-corrections-context.mjs')], {
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

// ── item 5: tail anchor (functional — the bug was a silent no-op) ─────────
console.log('\n5. stop-reply-guard finds a trigger buried behind a huge tool output')
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'schz-tail-test-'))
  const transcript = path.join(dir, 'transcript.jsonl')
  const trigger = { type: 'user', message: { role: 'user', content: '<channel source="discord" channelId="1495311473847828652">답해줘</channel>' } }
  // ~1.2MB of tool noise AFTER the trigger: past the old 500KB tail entirely.
  const noise = []
  for (let i = 0; i < 60; i++) {
    noise.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(20000) }] } }))
  }
  writeFileSync(transcript, [JSON.stringify(trigger), ...noise].join('\n') + '\n')
  const hook = path.join(root, 'hooks', 'stop-reply-guard.mjs')
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8' })
  assert(r.status === 2, 'guard still BLOCKS when the trigger is past the first tail window (was: silent exit 0)')
  assert(/1495311473847828652/.test(r.stderr || ''), 'the block names the buried trigger channel')

  // The reply is likewise past the window: found, so the turn is allowed.
  const replyCall = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'mcp__agent-channel__reply', input: { channelId: '1495311473847828652' } }] } })
  const replyResult = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'delivered_channel=1495311473847828652' }] } })
  writeFileSync(transcript, [JSON.stringify(trigger), replyCall, replyResult, ...noise].join('\n') + '\n')
  const r2 = spawnSync(process.execPath, [hook], { input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8' })
  assert(r2.status === 0, 'a delivered reply behind the same noise is still recognized (no false block)')

  // No trigger at all anywhere -> still a clean pass, not an escalation loop.
  writeFileSync(transcript, noise.join('\n') + '\n')
  const r3 = spawnSync(process.execPath, [hook], { input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8' })
  assert(r3.status === 0, 'a transcript with no channel trigger exits clean after exhausting the windows')
}

// ── item 6: sudo askpass failure taxonomy ────────────────────────────────
console.log('\n6. askpass names its failure cause; the translator routes each one')
{
  const tpl = readFileSync(path.join(root, 'onboarding', 'templates', 'sudo-askpass.sh'), 'utf8')
  for (const cause of ['cannot reach the app', 'sudo toggle is OFF', 'token mismatch', 'no sudo password stored']) {
    assert(tpl.includes(cause), `askpass helper emits a distinct line for: ${cause}`)
  }
  const hook = path.join(root, 'hooks', 'post-bash-permission-translator.mjs')
  const run = (out) => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sudo -A systemsetup -setremotelogin on' }, tool_response: { stderr: out } }),
      encoding: 'utf8',
    })
    try { return JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || '' } catch { return '' }
  }
  const notRunning = run('askpass: app is not running (no endpoint file at /x)')
  assert(/앱 미실행/.test(notRunning) && /비밀번호를 묻지 말/.test(notRunning), 'app-down is translated as a connection wall, not a password wall')
  const stale = run('askpass: token mismatch (endpoint file is stale)')
  assert(/stale endpoint/.test(stale), 'token mismatch is translated as a stale endpoint')
  const off = run('askpass: sudo toggle is OFF in the app Settings')
  assert(/토글/.test(off), 'toggle-off is translated as a settings toggle')
  const noPw = run('askpass: no sudo password stored in the app vault')
  assert(/미저장/.test(noPw), 'missing vault password is translated as a store-it-first')
  // The 08-05 live incident: a dead lane read as "비밀번호 없이는 실행 불가".
  assert(!/비밀번호 없이는 실행 불가/.test(notRunning), 'the generic password verdict no longer masks a dead askpass lane')
  // ...while the genuine no-askpass sudo wall still translates as before.
  assert(/비밀번호 없이는 실행 불가/.test(run('sudo: a password is required')), 'the real password wall is unchanged')
}

// ── item 7: boot budget ──────────────────────────────────────────────────
console.log('\n7. boot context is capped: skills listing + reflux card snooze')
{
  const mem = mkdtempSync(path.join(os.tmpdir(), 'schz-boot-test-'))
  mkdirSync(path.join(mem, 'skills'), { recursive: true })
  for (let i = 0; i < 30; i++) {
    writeFileSync(path.join(mem, 'skills', `skill-${String(i).padStart(2, '0')}.md`), `---\ntrigger: ${'t'.repeat(400)}\n---\nbody\n`)
  }
  const r = spawnSync(process.execPath, [path.join(root, 'hooks', 'session-start.mjs')], {
    input: '{}', encoding: 'utf8', env: { ...process.env, MEM: mem, AGENT_DATA_HOME: mem },
  })
  const ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || ''
  const listed = ctx.split('\n').filter((l) => /^- skill-\d+\.md:/.test(l))
  assert(listed.length === 20, `skills listing caps at 20 entries (got ${listed.length} of 30 files)`)
  assert(listed.every((l) => l.length < 260), 'each skill line is clipped, not a 400-char trigger dump')
  assert(/\+10 older skill\(s\) not listed/.test(ctx), 'the dropped remainder is STATED, not silently truncated')

  // reflux card: same count within the snooze window prints once, not twice.
  const dbPath = path.join(mem, 'memory.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE corrections (id INTEGER PRIMARY KEY, still_active INTEGER)')
  db.exec('INSERT INTO corrections (still_active) VALUES (1), (1), (1)')
  db.close()
  const card = () => spawnSync(process.execPath, [path.join(root, 'hooks', 'session-start-reflux-card.mjs')], {
    input: '{}', encoding: 'utf8', env: { ...process.env, AGENT_DATA_HOME: mem, SCHEHERAZADE_MEMORY_DB: dbPath },
  }).stdout || ''
  assert(/환류 카드/.test(card()), 'reflux card shows the first time the threshold is met')
  assert(card() === '', 'the identical card is snoozed on the next boot (was: every boot, forever)')
  const db2 = new DatabaseSync(dbPath)
  db2.exec('INSERT INTO corrections (still_active) VALUES (1)')
  db2.close()
  assert(/환류 카드/.test(card()), 'an ESCALATED count breaks the snooze immediately')
}

// ── item 8 sub-note: credential-guard path normalization ─────────────────
console.log('\n8. credential guard normalizes paths before matching')
{
  const hook = path.join(root, 'hooks', 'pre-tool-credential-guard.mjs')
  const run = (input) => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8' })
  const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } })
  assert(bash('cat ~/.claude/".credentials.json"').status === 2, 'quote-split path is blocked')
  assert(bash('cat ~/.cla\\ude/.credentials.json').status === 2, 'backslash-escaped path is blocked')
  assert(bash('cat ~/projects/../.codex/auth.json').status === 2, 'traversal path is blocked')
  assert(bash('cat ~/.claude/././.credentials.json').status === 2, 'redundant /./ segments are blocked')
  assert(run({ tool_name: 'Read', tool_input: { file_path: '~/.codex/auth%2Ejson' } }).status === 2, 'percent-encoded path is blocked')
  assert(bash('cat C:\\Users\\x\\.codex\\auth.json').status === 2, 'windows separators still blocked (both readings tested)')
  assert(bash('cat ~/myrepo/.env').status === 0, 'an ordinary project .env still passes')
  assert(bash('cat ~/notes/auth-notes.md').status === 0, 'a lookalike filename still passes')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
