// probe-win-lane.mjs — TWO real claude turns through headless-lane.mjs.
//
// Why this exists: the win suite cannot run the lane E2E (the fake-claude
// shim is a #!/bin/sh script Windows cannot exec, and node refuses shell-less
// .cmd spawns), so those sections SKIP on win32. This probe is the win-side
// receipt: the real lane spawning the real claude, cheap turns.
// Run it deliberately, with a cost reason — never in CI. Runs on Mac too
// (resolves 'claude' via command -v); the second turn's proof is platform-
// generic, the win32 spawn reality is the extra thing a win run confirms.
//
//   node scripts/probe-win-lane.mjs
//   env: PROBE_MODEL (default claude-opus-4-6 — the app's shipped default),
//        PROBE_CLAUDE (default: resolve 'claude' via where.exe / command -v)
//
// PASS = endpoint file appears (ingest server up) + init captured to
// .headless-session.json + TWO `turn result: success` lane logs. The second
// one is the load-bearing proof for the mute-recovery nudge: a user event
// written to the SAME live child AFTER the first turn's `result` already
// landed must be processed as a fresh turn (that IS the nudge's mechanism, and
// the rotation handoff's). If real claude -p stopped reading stdin post-result,
// this stays at one success and the nudge would silently no-op. Artifacts, not
// exit codes.

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-winprobe-'))

let claudeBin = process.env.PROBE_CLAUDE
if (!claudeBin) {
  claudeBin = execSync(process.platform === 'win32' ? 'where claude' : 'command -v claude')
    .toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
}
console.log(`probe: MEM=${MEM}`)
console.log(`probe: CLAUDE_BIN=${claudeBin}`)

// strict + empty MCP config: no servers, no side effects, cheapest turn
const mcp = path.join(MEM, 'empty-mcp.json')
fs.writeFileSync(mcp, '{"mcpServers":{}}')

const lane = spawn(process.execPath, [path.join(ROOT, 'headless-lane.mjs')], {
  env: {
    ...process.env,
    MEM,
    MODEL: process.env.PROBE_MODEL || 'claude-opus-4-6',
    CLAUDE_BIN: claudeBin,
    MCP_CONFIG_FILE: mcp,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const feed = (d) => { out += d; process.stdout.write(d) }
const countSuccess = () => (out.match(/turn result: success/g) || []).length
lane.stdout.on('data', feed)
lane.stderr.on('data', feed)
let laneExited = false
lane.on('exit', (code) => { laneExited = true; console.log(`probe: lane exited code=${code}`) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ep = path.join(MEM, '.ingest-endpoint.json')
{
  const deadline = Date.now() + 30_000
  while (!fs.existsSync(ep) && !laneExited && Date.now() < deadline) await sleep(200)
}
if (!fs.existsSync(ep)) {
  console.log('PROBE FAIL: endpoint file never appeared (lane/ingest server did not come up)')
  lane.kill()
  process.exit(1)
}
console.log('probe: endpoint file up')

const e = JSON.parse(fs.readFileSync(ep, 'utf8'))
const res = await fetch(`http://127.0.0.1:${e.port}/inbound`, {
  method: 'POST',
  headers: { 'x-ingest-token': e.token, 'content-type': 'application/json' },
  body: JSON.stringify({
    // PROBE_CONTENT: override the turn content to reproduce a specific
    // killer message (e.g. the graceful-shutdown [SYSTEM] turn, 129 hunt
    // 2026-08-05). PROBE_SENDER likewise (SYSTEM vs probe).
    content: (process.env.PROBE_CONTENT_FILE && fs.readFileSync(process.env.PROBE_CONTENT_FILE, 'utf8')) ||
      process.env.PROBE_CONTENT ||
      'This is a one-turn pipeline probe. Reply with exactly the single word: WINPROBE-OK',
    meta: { sender: process.env.PROBE_SENDER || 'probe', channelId: 'probe', timestamp: new Date().toISOString() },
  }),
})
console.log(`probe: ingest POST -> ${res.status}`)

// Turn 1 must complete first.
{
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline && !laneExited && countSuccess() < 1) await sleep(500)
}
const turn1 = countSuccess() >= 1
console.log(`probe: turn 1 result-success=${turn1}`)

// Turn 2 — the load-bearing proof for the mute nudge: a SECOND user event
// written to the SAME live child AFTER turn 1's result already landed. If real
// claude keeps reading stdin and processes it as a fresh turn, the nudge's
// injection primitive is real; if it no-ops post-result, this stays at 1.
let turn2 = false
if (turn1) {
  const res2 = await fetch(`http://127.0.0.1:${e.port}/inbound`, {
    method: 'POST',
    headers: { 'x-ingest-token': e.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      content: 'Second turn, injected AFTER the first result. Reply with exactly the single word: WINPROBE-TWO',
      meta: { sender: 'probe', channelId: 'probe', timestamp: new Date().toISOString() },
    }),
  })
  console.log(`probe: turn-2 ingest POST -> ${res2.status}`)
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline && !laneExited && countSuccess() < 2) await sleep(500)
  turn2 = countSuccess() >= 2
}
console.log(`probe: turn 2 (post-result stdin injection) result-success=${turn2}`)

const sess = fs.existsSync(path.join(MEM, '.headless-session.json'))
const errFile = path.join(MEM, '.last-turn-error.json')
if (fs.existsSync(errFile)) console.log(`probe: last-turn-error: ${fs.readFileSync(errFile, 'utf8')}`)
const ok = turn1 && turn2 && sess
console.log(`PROBE ${ok ? 'PASS' : 'FAIL'}: turn1=${turn1} turn2-post-result-inject=${turn2} session-file=${sess}`)
lane.kill('SIGTERM')
process.exit(ok ? 0 : 1)
