#!/usr/bin/env node
// test-liveness-marker.mjs — exercises channel.mjs's writeLivenessMarker()
// path (agent-lifecycle fix, 2026-07-03, PART 4) against a temp cwd.
// Run: node scripts/test-liveness-marker.mjs
//
// SCOPE: this only proves the marker-WRITE path (the half channel.mjs owns)
// -- content/shape written to DATA_HOME/.agent-live on ClientReady, callable
// repeatedly as a heartbeat. It does NOT exercise a real Discord connection
// (needs live gateway creds, out of scope here) or http-server.cjs's READ
// side (computeAgentStatus()/isMarkerFresh() there don't need Electron to
// run and could get their own unit test the same way this one does, but
// that's not this task's scope). Also does not start a real MCP stdio
// session or Discord login -- see channel.mjs's own isMainModule guard,
// which this test relies on to import the file safely.
//
// IMPORTANT (mirrors memory/smoke.mjs's own convention): channel.mjs reads
// DISCORD_BOT_TOKEN/HOME_CHANNEL_ID from process.env at module scope and
// FATAL-exits if either is missing, and computes LIVENESS_MARKER_PATH from
// process.cwd() at module scope -- both env vars and the cwd MUST be set
// BEFORE importing channel.mjs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-liveness-smoke-'))
process.chdir(tmpDir)
process.env.DISCORD_BOT_TOKEN = 'test-token-not-real'
process.env.HOME_CHANNEL_ID = '123456789012345678'
process.env.AGENT_NAME = 'smoketest'
// argv[1] deliberately left as whatever invoked this test script (NOT
// channel.mjs's own path) so channel.mjs's isMainModule check is false and
// it does not attempt mcp.connect()/discord.login() on import.

const channelModulePath = path.join(import.meta.dirname, '..', 'channel.mjs')
const { writeLivenessMarker, LIVENESS_MARKER_PATH } = await import(channelModulePath)

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) {
    pass++
    console.log(`PASS  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label}`)
  }
}

console.log(`temp cwd: ${tmpDir}`)
console.log(`LIVENESS_MARKER_PATH resolved by channel.mjs: ${LIVENESS_MARKER_PATH}`)
// realpathSync on both sides: macOS resolves os.tmpdir()'s /tmp through its
// /private/tmp symlink by the time channel.mjs's process.cwd() reads it
// back, so a raw string comparison against the pre-chdir tmpDir would
// false-fail on a path-resolution quirk that has nothing to do with the
// code under test.
assert(
  fs.realpathSync(path.dirname(LIVENESS_MARKER_PATH)) === fs.realpathSync(tmpDir),
  'LIVENESS_MARKER_PATH computed from process.cwd() at import time'
)
assert(!fs.existsSync(LIVENESS_MARKER_PATH), 'marker does not exist before first write')

// ── 1. first write (simulates ClientReady) ──────────────────────────────
await writeLivenessMarker()
assert(fs.existsSync(LIVENESS_MARKER_PATH), 'marker file created by writeLivenessMarker()')

const firstRaw = fs.readFileSync(LIVENESS_MARKER_PATH, 'utf8')
let firstParsed
try {
  firstParsed = JSON.parse(firstRaw)
  pass++
  console.log('PASS  marker content is valid JSON')
} catch (err) {
  fail++
  console.log(`FAIL  marker content is valid JSON -- threw: ${err.message}`)
}
if (firstParsed) {
  assert(firstParsed.status === 'live', 'marker.status === "live"')
  assert(typeof firstParsed.lastHeartbeat === 'string', 'marker.lastHeartbeat is a string')
  assert(!Number.isNaN(Date.parse(firstParsed.lastHeartbeat)), 'marker.lastHeartbeat parses as a valid date')
  const ageMs = Date.now() - Date.parse(firstParsed.lastHeartbeat)
  assert(ageMs >= 0 && ageMs < 5000, `marker.lastHeartbeat is freshly-now (age=${ageMs}ms)`)
  assert(firstParsed.pid === process.pid, 'marker.pid matches this process (agent-lifecycle fix: same-process write, no forking here)')
}

// ── 2. second write (simulates a heartbeat refresh) advances the timestamp ─
await new Promise((resolve) => setTimeout(resolve, 20))
await writeLivenessMarker()
const secondParsed = JSON.parse(fs.readFileSync(LIVENESS_MARKER_PATH, 'utf8'))
assert(
  Date.parse(secondParsed.lastHeartbeat) > Date.parse(firstParsed.lastHeartbeat),
  'heartbeat refresh advances lastHeartbeat (second write > first write)'
)

// ── cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
