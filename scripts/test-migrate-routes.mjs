#!/usr/bin/env node
// test-migrate-routes.mjs -- /api/migrate/* (onboarding/routes/migrate.cjs,
// design-0022) over the REAL server against a FABRICATED home directory.
// What must hold:
//   - detection finds fabricated tool roots and lists files with sizes;
//   - FORBIDDEN names (auth.json, .credentials.json, .env, ...) never
//     appear in a listing, at any depth, and are reported in skippedPresent;
//   - undetected tools return detected:false and never fabricate a root;
//   - start with a live (fake) lane ingest endpoint delivers ONE [SYSTEM]
//     sweep turn carrying the roots and the DO-NOT-READ list;
//   - start with no lane appends to .headless-pending.json in the exact
//     shape headless-lane's readPending() consumes;
//   - forged/unknown tool ids silently drop; nothing detected -> 400;
//   - the credential-guard hook blocks Read/Bash aimed at credential
//     stores and passes ordinary files (pure process-level pins).
//
// Hermetic: HOME (and USERPROFILE on win32) is redirected BEFORE the server
// module loads (os.homedir() honors $HOME on darwin/linux, USERPROFILE on win).
//
// Run: node scripts/test-migrate-routes.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-migrate-'))

const fixtureHome = path.join(TMP, 'home')
fs.mkdirSync(fixtureHome, { recursive: true })
process.env.HOME = fixtureHome
// os.homedir() reads USERPROFILE on win32 and IGNORES $HOME -- without this
// the detector escapes the fixture and scans the REAL profile (caught on
// magi-win 2026-08-04: real .claude/.codex detected, three assertions red).
if (process.platform === 'win32') process.env.USERPROFILE = fixtureHome
delete process.env.CODEX_HOME
process.env.AGENT_DATA_HOME = path.join(TMP, 'data')
fs.mkdirSync(process.env.AGENT_DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_MEMORY_DB = path.join(TMP, 'memory.db')

// ── fabricate two detectable tools + credential landmines ────────────────
const claudeDir = path.join(fixtureHome, '.claude')
fs.mkdirSync(path.join(claudeDir, 'projects', 'proj-a'), { recursive: true })
fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# global instructions\n')
fs.writeFileSync(path.join(claudeDir, 'projects', 'proj-a', 'sess.jsonl'), '{}\n')
fs.writeFileSync(path.join(claudeDir, '.credentials.json'), 'SECRET-CLAUDE-CRED')
fs.writeFileSync(path.join(fixtureHome, '.claude.json'), 'SECRET-MCP-TOKENS')

const hermesDir = path.join(fixtureHome, '.hermes')
fs.mkdirSync(path.join(hermesDir, 'memories'), { recursive: true })
fs.writeFileSync(path.join(hermesDir, 'SOUL.md'), 'persona\n')
fs.writeFileSync(path.join(hermesDir, 'config.yaml'), 'x: 1\n')
fs.writeFileSync(path.join(hermesDir, 'memories', 'day.md'), 'memory\n')
fs.writeFileSync(path.join(hermesDir, 'auth.json'), 'SECRET-HERMES-AUTH')
fs.writeFileSync(path.join(hermesDir, '.env'), 'SECRET-ENV')

const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createOnboardingServer } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))

let pass = 0
let fail = 0
const chk = (n, c, d) => {
  if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) }
}

const srv = await createOnboardingServer()
const port = srv.server.address().port
const base = `http://127.0.0.1:${port}`

try {
  const page = await (await fetch(`${base}/memory`)).text()
  const m = page.match(/name="onboard-token" content="([a-f0-9]+)"/)
  const auth = { 'x-onboard-token': m ? m[1] : '', 'content-type': 'application/json' }

  // ── detect ────────────────────────────────────────────────────────────
  {
    const body = await (await fetch(`${base}/api/migrate/detect`, { headers: auth })).text()
    const d = JSON.parse(body)
    const byId = Object.fromEntries(d.tools.map((t) => [t.id, t]))
    chk('claude detected with root + files', byId.claude.detected === true && byId.claude.root === claudeDir && byId.claude.files.length >= 2, JSON.stringify(byId.claude))
    chk('hermes detected', byId.hermes.detected === true && byId.hermes.files.some((f) => f.path === 'SOUL.md'))
    chk('codex/opencode/openclaw absent -> detected:false, no root fabricated',
      ['codex', 'opencode', 'openclaw'].every((id) => byId[id].detected === false && !('root' in byId[id])), JSON.stringify([byId.codex, byId.opencode, byId.openclaw]))
    chk('no listing carries a forbidden name', !/auth\.json|\.credentials\.json|\.env/.test(JSON.stringify(d.tools.flatMap((t) => t.files || []))), body.slice(0, 200))
    chk('forbidden files present on disk are reported as skipped', byId.hermes.skippedPresent.length >= 1, JSON.stringify(byId.hermes.skippedPresent))
    chk('no response byte leaks a credential VALUE', !body.includes('SECRET-'), body.slice(0, 200))
  }

  // ── start, lane down -> queued into the pending FIFO ────────────────────
  const pendPath = path.join(process.env.AGENT_DATA_HOME, '.headless-pending.json')
  {
    const r = await fetch(`${base}/api/migrate/start`, { method: 'POST', headers: auth, body: JSON.stringify({ tools: ['claude', 'hermes', 'forged-id'] }) })
    const b = await r.json()
    chk('start with no lane: 202 queued', r.status === 202 && b.ok === true && b.delivery === 'queued', JSON.stringify(b))
    chk('forged id silently dropped from the accepted set', !JSON.stringify(b.tools).includes('forged'), JSON.stringify(b.tools))
    const pend = JSON.parse(fs.readFileSync(pendPath, 'utf8'))
    const entry = pend.at(-1)
    chk('pending entry matches headless-lane readPending shape', typeof entry.content === 'string' && entry.meta && typeof entry.ts === 'number', JSON.stringify(Object.keys(entry)))
    chk('sweep turn is [SYSTEM] and names both roots', entry.content.startsWith('[SYSTEM]') && entry.content.includes(claudeDir) && entry.content.includes(hermesDir))
    chk('sweep turn carries the DO-NOT-READ list', entry.content.includes('auth.json') && entry.content.includes('.credentials.json'))
    fs.rmSync(pendPath, { force: true })
  }

  // ── start, live fake lane -> delivered over the ingest endpoint ─────────
  {
    let got = null
    const fakeLane = http.createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      got = { url: req.url, token: String(req.headers['x-ingest-token'] || ''), body }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise((r) => fakeLane.listen(0, '127.0.0.1', r))
    const lanePort = fakeLane.address().port
    fs.writeFileSync(path.join(process.env.AGENT_DATA_HOME, '.ingest-endpoint.json'),
      JSON.stringify({ port: lanePort, token: 'i'.repeat(64), pid: process.pid }))

    const r = await fetch(`${base}/api/migrate/start`, { method: 'POST', headers: auth, body: JSON.stringify({ tools: ['hermes'] }) })
    const b = await r.json()
    chk('start with a live lane: 202 live', r.status === 202 && b.delivery === 'live', JSON.stringify(b))
    chk('lane received the sweep with the ingest token', got && got.url === '/inbound' && got.token === 'i'.repeat(64))
    const sent = got ? JSON.parse(got.body) : {}
    chk('delivered turn is the [SYSTEM] sweep for exactly the consented tool',
      String(sent.content || '').startsWith('[SYSTEM]') && sent.content.includes(hermesDir) && !sent.content.includes(claudeDir), String(sent.content || '').slice(0, 120))
    chk('meta sender is SYSTEM', sent.meta && sent.meta.sender === 'SYSTEM', JSON.stringify(sent.meta))
    chk('lane-down fallback did not ALSO fire', !fs.existsSync(pendPath))
    await new Promise((r2) => fakeLane.close(r2))
    fs.rmSync(path.join(process.env.AGENT_DATA_HOME, '.ingest-endpoint.json'), { force: true })
  }

  // ── input gates ─────────────────────────────────────────────────────────
  {
    const r1 = await fetch(`${base}/api/migrate/start`, { method: 'POST', headers: auth, body: '{}' })
    chk('start without tools: 400 tools_required', r1.status === 400 && (await r1.json()).reason === 'tools_required')
    const r2 = await fetch(`${base}/api/migrate/start`, { method: 'POST', headers: auth, body: JSON.stringify({ tools: ['codex'] }) })
    chk('start with only-undetected tools: 400 nothing_detected', r2.status === 400 && (await r2.json()).reason === 'nothing_detected')
    const r3 = await fetch(`${base}/api/migrate/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: ['claude'] }) })
    chk('start without the onboard token is refused', r3.status === 403, r3.status)
  }

  // ── credential-guard hook (layer 3) ────────────────────────────────────
  {
    const hook = path.join(ROOT, 'hooks', 'pre-tool-credential-guard.mjs')
    const run = (input) => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8' })
    const blocked = (r) => r.status === 2
    chk('guard blocks Read of ~/.claude/.credentials.json', blocked(run({ tool_name: 'Read', tool_input: { file_path: `${fixtureHome}/.claude/.credentials.json` } })))
    chk('guard blocks Read of ~/.claude.json (MCP tokens)', blocked(run({ tool_name: 'Read', tool_input: { file_path: `${fixtureHome}/.claude.json` } })))
    chk('guard blocks Bash cat of hermes auth', blocked(run({ tool_name: 'Bash', tool_input: { command: 'cat ~/.hermes/auth.json' } })))
    chk('guard blocks keychain reads', blocked(run({ tool_name: 'Bash', tool_input: { command: 'security find-generic-password -s x -w' } })))
    chk('guard blocks openclaw credentials dir', blocked(run({ tool_name: 'Bash', tool_input: { command: 'ls ~/.openclaw/credentials' } })))
    chk('guard PASSES an ordinary project .env-less read', run({ tool_name: 'Read', tool_input: { file_path: `${fixtureHome}/.hermes/SOUL.md` } }).status === 0)
    chk('guard PASSES a project-local .env (only tool-home .env is blocked)', run({ tool_name: 'Read', tool_input: { file_path: '/Users/x/myrepo/.env' } }).status === 0)
    chk('guard fails OPEN on garbage stdin', spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' }).status === 0)
  }
} finally {
  srv.server.close()
  try { (await import('file://' + path.join(ROOT, 'memory', 'service.mjs'))).close() } catch { /* absent in some layouts */ }
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
