// probe-win-lane.mjs — ONE real claude.exe turn through headless-lane.mjs.
//
// Why this exists: the win suite cannot run the lane E2E (the fake-claude
// shim is a #!/bin/sh script Windows cannot exec, and node refuses shell-less
// .cmd spawns), so those sections SKIP on win32. This probe is the win-side
// receipt: the real lane spawning the real claude.exe, one cheap turn.
// Run it ON the windows box, deliberately, with a cost reason — never in CI.
//
//   node scripts/probe-win-lane.mjs
//   env: PROBE_MODEL (default claude-opus-4-6 — the app's shipped default),
//        PROBE_CLAUDE (default: resolve 'claude' via where.exe)
//
// PASS = endpoint file appears (ingest server up) + init captured to
// .headless-session.json + a `turn result: success` lane log. Artifacts,
// not exit codes.

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
    content: 'This is a one-turn pipeline probe. Reply with exactly the single word: WINPROBE-OK',
    meta: { sender: 'probe', channelId: 'probe', timestamp: new Date().toISOString() },
  }),
})
console.log(`probe: ingest POST -> ${res.status}`)

{
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline && !laneExited &&
    !/turn result: /.test(out)) await sleep(500)
}
const success = /turn result: success/.test(out)
const sess = fs.existsSync(path.join(MEM, '.headless-session.json'))
const errFile = path.join(MEM, '.last-turn-error.json')
if (fs.existsSync(errFile)) console.log(`probe: last-turn-error: ${fs.readFileSync(errFile, 'utf8')}`)
console.log(`PROBE ${success && sess ? 'PASS' : 'FAIL'}: result-success=${success} session-file=${sess}`)
lane.kill('SIGTERM')
process.exit(success && sess ? 0 : 1)
