#!/usr/bin/env node
// test-migrate-import.mjs -- memory/migrate-import.cjs (design-0022 §3.1/§4,
// the onboarding wizard's copy-with-receipt import) and its two routes, over
// a FABRICATED home directory holding all five tools plus credential and
// config landmines.
// What must hold:
//   - detection finds each of the five sources at its documented root, and
//     offers only allowlisted files (no config, no credential, no symlink);
//   - an empty HOME finds nothing; a tool home holding only auth.json is not
//     "detected" (nothing to offer, no card);
//   - chat history defaults OFF, instruction/memory/persona defaults ON;
//   - import copies exactly the selected allowlisted files, byte for byte,
//     0600, into DATA_HOME/imported/<tool>/; forged / config / credential
//     paths drop; a file with a key-shaped string is held back by reason;
//   - CLAUDE.md / AGENTS.md land as imported-*.md (never auto-loaded);
//   - the source side is untouched (bytes, presence);
//   - a receipt and the handover marker are written; session-start.mjs
//     turns the marker into one handover line;
//   - the routes: plan lists detected tools only, import re-plans server
//     side, no response carries a secret value, token required.
//
// Hermetic: HOME (and USERPROFILE on win32) is redirected BEFORE the server
// module loads, and every tool relocation variable is cleared.
//
// Run: node tests/test-migrate-import.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-import-'))
const require_ = createRequire(path.join(ROOT, 'package.json'))

const fixtureHome = path.join(TMP, 'home')
fs.mkdirSync(fixtureHome, { recursive: true })
process.env.HOME = fixtureHome
if (process.platform === 'win32') process.env.USERPROFILE = fixtureHome
for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'OPENCLAW_PROFILE']) delete process.env[k]
const DATA = path.join(TMP, 'data')
process.env.AGENT_DATA_HOME = DATA
fs.mkdirSync(DATA, { recursive: true })
process.env.SCHEHERAZADE_MEMORY_DB = path.join(TMP, 'memory.db')

const KEY = 'sk-ant-api03-' + 'Q'.repeat(40)
const put = (rel, body) => {
  const p = path.join(fixtureHome, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

// ── fabricate all five tools ────────────────────────────────────────────
// Claude Code
put('.claude/CLAUDE.md', '# global instructions\nUser is Mino.\n')
put('.claude/rules/style.md', 'short replies\n')
put('.claude/agents/reviewer.md', 'review agent\n')
put('.claude/projects/-Users-x-proj/memory/MEMORY.md', '- prefers dark mode\n')
put('.claude/projects/-Users-x-proj/memory/leak.md', `the key is ${KEY}\n`)
put('.claude/projects/-Users-x-proj/sess-1.jsonl', '{"type":"user"}\n')
put('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_API_KEY: KEY } }))
put('.claude/.credentials.json', 'SECRET-CLAUDE-CRED')
put('.claude.json', 'SECRET-MCP-TOKENS')
const outside = put('outside/private.md', 'SECRET-OUTSIDE')
try { fs.symlinkSync(outside, path.join(fixtureHome, '.claude/projects/-Users-x-proj/memory/linked.md')) } catch { /* no symlink perms (win) */ }
// Codex CLI
put('.codex/AGENTS.md', 'codex global rules\n')
put('.codex/prompts/fix.md', 'fix prompt\n')
put('.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl', '{"type":"session_meta"}\n')
put('.codex/config.toml', `model = "gpt-5"\n[mcp_servers.x.env]\nTOKEN = "${KEY}"\n`)
put('.codex/auth.json', 'SECRET-CODEX-AUTH')
// Hermes
put('.hermes/SOUL.md', 'I am Hermes.\n')
put('.hermes/memories/MEMORY.md', 'env facts\n')
put('.hermes/memories/USER.md', 'user profile\n')
put('.hermes/cron/jobs.json', '[{"schedule":"0 11 * * *","prompt":"briefing"}]\n')
put('.hermes/sessions/session_20260901_1.json', '{}\n')
put('.hermes/config.yaml', 'model: x\n')
put('.hermes/.env', 'OPENAI_API_KEY=SECRET-HERMES-ENV')
put('.hermes/auth.json', 'SECRET-HERMES-AUTH')
put('.hermes/state.db', 'SECRET-STATE')
// OpenCode
put('.config/opencode/AGENTS.md', 'opencode rules\n')
put('.config/opencode/agents/plan.md', 'plan agent\n')
put('.config/opencode/commands/test.md', 'test cmd\n')
put('.config/opencode/opencode.json', JSON.stringify({ provider: { x: { options: { apiKey: KEY } } } }))
// OpenClaw
put('.openclaw/workspace/SOUL.md', 'claw soul\n')
put('.openclaw/workspace/AGENTS.md', 'claw ops\n')
put('.openclaw/workspace/USER.md', 'claw user\n')
put('.openclaw/workspace/IDENTITY.md', 'claw id\n')
put('.openclaw/workspace/MEMORY.md', 'claw memory\n')
put('.openclaw/workspace/memory/2026-09-01.md', 'daily log\n')
put('.openclaw/openclaw.json', '{}')
put('.openclaw/credentials/oauth.json', 'SECRET-CLAW-CRED')

// Snapshot every source file (bytes) to prove the source side is untouched.
const snapshot = new Map()
const snap = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) snap(p)
    else snapshot.set(p, fs.readFileSync(p))
  }
}
snap(fixtureHome)

const mi = require_(path.join(ROOT, 'memory', 'migrate-import.cjs'))

let pass = 0
let fail = 0
const chk = (n, c, d) => {
  if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) }
}

const CONFIG_OR_CRED = /(^|[\\/])(settings\.json|config\.toml|config\.yaml|opencode\.json|openclaw\.json|auth\.json|\.credentials\.json|\.claude\.json|\.env|state\.db|oauth\.json)$/

// ── detection ─────────────────────────────────────────────────────────
{
  const env = {}
  const d = mi.detectSources({ home: fixtureHome, env })
  const byId = Object.fromEntries(d.map((t) => [t.id, t]))
  const expectRoots = {
    claude: path.join(fixtureHome, '.claude'),
    codex: path.join(fixtureHome, '.codex'),
    hermes: path.join(fixtureHome, '.hermes'),
    opencode: path.join(fixtureHome, '.config', 'opencode'),
    openclaw: path.join(fixtureHome, '.openclaw', 'workspace'),
  }
  for (const [id, root] of Object.entries(expectRoots)) {
    chk(`detect: ${id} found at its documented root`, byId[id] && byId[id].detected === true && byId[id].root === root, JSON.stringify(byId[id] && { detected: byId[id].detected, root: byId[id].root }))
  }
  const paths = (id) => (byId[id].items || []).map((i) => i.path.split(path.sep).join('/'))
  chk('detect: claude offers CLAUDE.md, rules, agents, auto memory, transcripts',
    ['CLAUDE.md', 'rules/style.md', 'agents/reviewer.md', 'projects/-Users-x-proj/memory/MEMORY.md', 'projects/-Users-x-proj/sess-1.jsonl'].every((p) => paths('claude').includes(p)), JSON.stringify(paths('claude')))
  chk('detect: codex offers AGENTS.md, prompts, rollouts', ['AGENTS.md', 'prompts/fix.md', 'sessions/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl'].every((p) => paths('codex').includes(p)), JSON.stringify(paths('codex')))
  chk('detect: hermes offers SOUL, memories, cron jobs, sessions', ['SOUL.md', 'memories/MEMORY.md', 'memories/USER.md', 'cron/jobs.json', 'sessions/session_20260901_1.json'].every((p) => paths('hermes').includes(p)), JSON.stringify(paths('hermes')))
  chk('detect: opencode offers AGENTS.md, agents, commands', ['AGENTS.md', 'agents/plan.md', 'commands/test.md'].every((p) => paths('opencode').includes(p)), JSON.stringify(paths('opencode')))
  chk('detect: openclaw offers workspace persona + memory files', ['SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md', 'memory/2026-09-01.md'].every((p) => paths('openclaw').includes(p)), JSON.stringify(paths('openclaw')))
  const all = d.flatMap((t) => (t.items || []).map((i) => i.path))
  chk('detect: no config or credential file is ever offered', !all.some((p) => CONFIG_OR_CRED.test(p)), JSON.stringify(all.filter((p) => CONFIG_OR_CRED.test(p))))
  chk('detect: a symlink is never offered', !all.some((p) => p.endsWith('linked.md')))
  chk('detect: config/credential files present are reported as left in place',
    byId.claude.leftInPlace.some((l) => l.name === 'settings.json') && byId.hermes.leftInPlace.some((l) => l.name === 'auth.json') && byId.codex.leftInPlace.some((l) => l.name === 'config.toml'), JSON.stringify(byId.claude.leftInPlace))
  const kinds = d.flatMap((t) => t.items || [])
  chk('detect: chat history defaults OFF', kinds.filter((i) => i.kind === 'transcript').length >= 3 && kinds.filter((i) => i.kind === 'transcript').every((i) => i.defaultOn === false))
  chk('detect: instruction/memory/persona default ON', kinds.filter((i) => ['instructions', 'memory', 'persona'].includes(i.kind)).every((i) => i.defaultOn === true))
  chk('detect: listing carries no file contents', !JSON.stringify(d).includes('SECRET') && !JSON.stringify(d).includes(KEY))
}

// ── relocation variables are honored ────────────────────────────────────
{
  const alt = path.join(TMP, 'alt-codex')
  fs.mkdirSync(alt, { recursive: true })
  fs.writeFileSync(path.join(alt, 'AGENTS.md'), 'x\n')
  const d = mi.detectSources({ home: path.join(TMP, 'nobody'), env: { CODEX_HOME: alt } })
  chk('detect: CODEX_HOME relocates the codex root', d.find((t) => t.id === 'codex').root === alt && d.find((t) => t.id === 'codex').detected === true)
}

// ── empty HOME finds nothing ──────────────────────────────────────────
{
  const empty = path.join(TMP, 'empty-home')
  fs.mkdirSync(empty, { recursive: true })
  const d = mi.detectSources({ home: empty, env: {} })
  chk('empty HOME: every source detected:false, no root fabricated', d.length === 5 && d.every((t) => t.detected === false && !('root' in t)), JSON.stringify(d))
  const credOnly = path.join(TMP, 'cred-only-home')
  fs.mkdirSync(path.join(credOnly, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(credOnly, '.codex', 'auth.json'), 'SECRET')
  fs.writeFileSync(path.join(credOnly, '.codex', 'config.toml'), 'x=1')
  const c = mi.detectSources({ home: credOnly, env: {} }).find((t) => t.id === 'codex')
  chk('a tool home with only auth.json + config is not detected (nothing to offer)', c.detected === false, JSON.stringify(c))
  const r = mi.runImport({ home: empty, env: {}, dataHome: path.join(TMP, 'data-empty'), selections: { claude: ['CLAUDE.md'] } })
  chk('empty HOME: import copies nothing and writes nothing', r.copied.length === 0 && !fs.existsSync(path.join(TMP, 'data-empty', 'imported')))
}

// ── import (core) ───────────────────────────────────────────────────────
{
  const d = mi.detectSources({ home: fixtureHome, env: {} })
  const selections = {}
  for (const t of d) if (t.detected) selections[t.id] = t.items.filter((i) => i.defaultOn).map((i) => i.path)
  // forged + disallowed entries the UI never offered
  selections.claude.push('settings.json', '.credentials.json', '../.claude.json', '../outside/private.md', path.join('projects', '-Users-x-proj', 'memory', 'linked.md'))
  selections.hermes.push('auth.json', '.env', 'state.db', 'config.yaml')
  selections.bogus = ['x.md']
  const dataHome = path.join(TMP, 'data-core')
  const r = mi.runImport({ home: fixtureHome, env: {}, dataHome, selections, now: Date.parse('2026-09-29T15:30:00Z') })
  const imp = path.join(dataHome, 'imported')

  const copiedRel = r.copied.map((c) => `${c.tool}:${c.path.split(path.sep).join('/')}`)
  chk('import: the default-ON allowlisted files are copied', ['claude:CLAUDE.md', 'claude:rules/style.md', 'claude:projects/-Users-x-proj/memory/MEMORY.md', 'codex:AGENTS.md', 'hermes:SOUL.md', 'hermes:cron/jobs.json', 'opencode:agents/plan.md', 'openclaw:memory/2026-09-01.md'].every((x) => copiedRel.includes(x)), JSON.stringify(copiedRel))
  chk('import: unselected chat history is NOT copied', !copiedRel.some((x) => /\.jsonl$|sessions\//.test(x)), JSON.stringify(copiedRel))
  chk('import: forged, config and credential paths silently drop', !copiedRel.some((x) => CONFIG_OR_CRED.test(x) || /outside|linked|bogus/.test(x)) && !r.heldBack.some((h) => CONFIG_OR_CRED.test(h.path)), JSON.stringify({ copiedRel, held: r.heldBack }))
  chk('import: a file with a key-shaped string is held back by reason', r.heldBack.some((h) => h.tool === 'claude' && h.path.endsWith('leak.md') && h.reason === 'looks_like_secret') && !copiedRel.some((x) => x.endsWith('leak.md')), JSON.stringify(r.heldBack))

  // walk everything written under imported/
  const written = []
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else written.push(p) } }
  walk(imp)
  const blob = written.map((p) => fs.readFileSync(p, 'utf8')).join('\n')
  chk('import: nothing written under imported/ carries a secret value', !blob.includes('SECRET') && !blob.includes(KEY))
  chk('import: CLAUDE.md / AGENTS.md stored as imported-*.md, never under their auto-load name',
    fs.existsSync(path.join(imp, 'claude', 'imported-CLAUDE.md')) && fs.existsSync(path.join(imp, 'codex', 'imported-AGENTS.md')) &&
    !written.some((p) => ['CLAUDE.md', 'AGENTS.md'].includes(path.basename(p))), JSON.stringify(written.map((p) => path.relative(imp, p))))
  chk('import: copies are byte-for-byte', fs.readFileSync(path.join(imp, 'claude', 'imported-CLAUDE.md')).equals(fs.readFileSync(path.join(fixtureHome, '.claude', 'CLAUDE.md'))) &&
    fs.readFileSync(path.join(imp, 'hermes', 'cron', 'jobs.json')).equals(fs.readFileSync(path.join(fixtureHome, '.hermes', 'cron', 'jobs.json'))))
  if (process.platform !== 'win32') {
    const modes = written.filter((p) => !p.endsWith('.handover-pending.json')).map((p) => fs.statSync(p).mode & 0o777)
    chk('import: every copy is 0600', modes.length > 0 && modes.every((m) => m === 0o600), modes.map((m) => m.toString(8)).join(','))
  } else {
    console.log('  n/a  0600 mode check (win32)')
  }
  const receipts = fs.readdirSync(imp).filter((n) => n.startsWith('receipt-'))
  const receipt = receipts.length ? JSON.parse(fs.readFileSync(path.join(imp, receipts[0]), 'utf8')) : null
  chk('import: a receipt lists every copy with its source root', receipt && receipt.copied.length === r.copied.length && receipt.sources.claude === path.join(fixtureHome, '.claude'), receipts)
  const marker = mi.readHandoverMarker(dataHome)
  chk('import: handover marker names the imported tools', marker && ['claude', 'codex', 'hermes', 'opencode', 'openclaw'].every((t) => marker.tools.includes(t)), JSON.stringify(marker))

  // source side untouched
  let intact = true
  for (const [p, bytes] of snapshot) {
    if (!fs.existsSync(p) || !fs.readFileSync(p).equals(bytes)) { intact = false; console.log('    changed:', p) }
  }
  chk('import: every source file still exists with identical bytes', intact)

  // explicit opt-in to chat history copies it
  const r2 = mi.runImport({ home: fixtureHome, env: {}, dataHome, selections: { codex: ['sessions/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl'.split('/').join(path.sep)] } })
  chk('import: chat history copies only when explicitly selected', r2.copied.length === 1 && r2.copied[0].tool === 'codex', JSON.stringify(r2))
}

// ── data home inside a tool root is refused ─────────────────────────────
{
  const inside = path.join(fixtureHome, '.claude', 'nested-data')
  const r = mi.runImport({ home: fixtureHome, env: {}, dataHome: inside, selections: { claude: ['CLAUDE.md'] } })
  chk('import: a data home inside the tool root is refused', r.copied.length === 0 && r.heldBack.some((h) => h.reason === 'overlaps_data_home'), JSON.stringify(r))
  fs.rmSync(inside, { recursive: true, force: true })
}

// ── credential lists stay in sync with routes/migrate.cjs ───────────────
{
  const { FORBIDDEN_NAMES: routeNames } = require_(path.join(ROOT, 'onboarding', 'routes', 'migrate.cjs'))
  chk('FORBIDDEN_NAMES covers every name the sweep route forbids', [...routeNames].every((n) => mi.FORBIDDEN_NAMES.has(n)))
}

// ── session-start hook turns the marker into one handover line ─────────
{
  const runHook = (mem) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs')], {
    input: '{}', encoding: 'utf8', env: { ...process.env, AGENT_DATA_HOME: mem, MEM: mem },
  })
  const withMarker = path.join(TMP, 'data-core')
  const r1 = runHook(withMarker)
  const ctx1 = (() => { try { return JSON.parse(r1.stdout).hookSpecificOutput.additionalContext } catch { return '' } })()
  chk('session-start: marker present -> handover line naming imported/ and the marker', ctx1.includes('Imported data is waiting') && ctx1.includes('imported/hermes/') && ctx1.includes('.handover-pending.json'), (r1.stderr || ctx1).slice(0, 300))
  const clean = path.join(TMP, 'data-clean')
  fs.mkdirSync(clean, { recursive: true })
  const r2 = runHook(clean)
  chk('session-start: no marker -> no handover line', r2.status === 0 && !r2.stdout.includes('Imported data is waiting'), r2.stderr.slice(0, 200))
}

// ── routes over the real server ─────────────────────────────────────────
const { createOnboardingServer, SERVER_TOKEN } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
const srv = await createOnboardingServer()
const base = `http://127.0.0.1:${srv.server.address().port}`
try {
  const auth = { 'x-onboard-token': SERVER_TOKEN, 'content-type': 'application/json' }
  const planRes = await fetch(`${base}/api/migrate/import/plan`, { headers: auth })
  const planText = await planRes.text()
  const plan = JSON.parse(planText)
  chk('route plan: 200, detected tools only', planRes.status === 200 && plan.tools.length === 5 && plan.tools.every((t) => t.detected), planText.slice(0, 200))
  chk('route plan: no secret value in the response', !planText.includes('SECRET') && !planText.includes(KEY))

  const r0 = await fetch(`${base}/api/migrate/import`, { method: 'POST', headers: auth, body: '{}' })
  chk('route import: no selections -> 400 selections_required', r0.status === 400 && (await r0.json()).reason === 'selections_required')
  const rTok = await fetch(`${base}/api/migrate/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selections: { hermes: ['SOUL.md'] } }) })
  chk('route import: without the onboard token -> 403', rTok.status === 403, rTok.status)

  const r = await fetch(`${base}/api/migrate/import`, { method: 'POST', headers: auth, body: JSON.stringify({ selections: { hermes: ['SOUL.md', 'auth.json', '.env'], openclaw: ['USER.md'] } }) })
  const bodyText = await r.text()
  const b = JSON.parse(bodyText)
  chk('route import: copies exactly the allowed selection', r.status === 200 && b.copied.length === 2 && b.copied.every((c) => ['SOUL.md', 'USER.md'].includes(c.path)), bodyText.slice(0, 300))
  chk('route import: files land in DATA_HOME/imported/<tool>/', fs.existsSync(path.join(DATA, 'imported', 'hermes', 'SOUL.md')) && fs.existsSync(path.join(DATA, 'imported', 'openclaw', 'USER.md')) && !fs.existsSync(path.join(DATA, 'imported', 'hermes', 'auth.json')))
  chk('route import: lane down -> handover rides the marker, never the pending FIFO', b.delivery === 'marker' && !fs.existsSync(path.join(DATA, '.headless-pending.json')) && mi.readHandoverMarker(DATA) !== null, JSON.stringify(b))
  chk('route import: response carries no secret value or absolute dest path', !bodyText.includes('SECRET') && !bodyText.includes(DATA))
} finally {
  srv.server.close()
  try { (await import('file://' + path.join(ROOT, 'memory', 'service.mjs'))).close() } catch { /* absent in some layouts */ }
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
