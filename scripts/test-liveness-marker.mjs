#!/usr/bin/env node
// test-liveness-marker.mjs — exercises channel.mjs's writeLivenessMarker()/
// writeFailureMarker() paths (agent-lifecycle fix, 2026-07-03, PART 4 +
// 2026-07-03 model-divergent-review follow-up) against a temp DATA_HOME.
// Run: node scripts/test-liveness-marker.mjs
//
// SCOPE: this only proves the marker-WRITE path (the half channel.mjs owns)
// -- content/shape written to DATA_HOME/.agent-live on ClientReady (and as a
// heartbeat), and DATA_HOME/.agent-failed.json on a missing-token FATAL exit
// (Critical B / hardening E2). It does NOT exercise a real Discord
// connection (needs live gateway creds, out of scope here) or
// http-server.cjs's READ side (computeAgentStatus()/isMarkerFresh()/
// isPidAlive() there don't need Electron to run and could get their own
// unit test the same way this one does, but that's not this task's scope).
//
// IMPORTANT (mirrors memory/smoke.mjs's own convention): channel.mjs reads
// DISCORD_BOT_TOKEN/HOME_CHANNEL_ID from process.env at module scope and
// FATAL-exits if either is missing, and resolves DATA_HOME from
// AGENT_DATA_HOME (falling back to ~/Documents/Scheherazade if unset --
// hardening E1, no more process.cwd() trust) -- env vars MUST be set BEFORE
// importing channel.mjs. AGENT_DATA_HOME in particular MUST be set in this
// test (to a throwaway temp dir), or a run of this test would silently
// write real marker files into the user's actual
// ~/Documents/Scheherazade -- confirmed happened once during this fix's own
// verification pass before this env var was added below; cleaned up, not a
// product bug, but real enough to guard against here permanently.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-liveness-smoke-'))
process.env.AGENT_DATA_HOME = tmpDir
process.env.DISCORD_BOT_TOKEN = 'test-token-not-real'
process.env.HOME_CHANNEL_ID = '123456789012345678'
process.env.AGENT_NAME = 'smoketest'
// argv[1] deliberately left as whatever invoked this test script (NOT
// channel.mjs's own path) so channel.mjs's isMainModule check is false and
// it does not attempt mcp.connect()/discord.login() on import.

const channelModulePath = path.join(import.meta.dirname, '..', 'channel.mjs')
const { writeLivenessMarker, LIVENESS_MARKER_PATH, writeFailureMarker, FAILURE_MARKER_PATH, DATA_HOME } = await import(
  channelModulePath
)

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

console.log(`temp AGENT_DATA_HOME: ${tmpDir}`)
console.log(`DATA_HOME resolved by channel.mjs: ${DATA_HOME}`)
console.log(`LIVENESS_MARKER_PATH resolved by channel.mjs: ${LIVENESS_MARKER_PATH}`)
// realpathSync on both sides: macOS resolves os.tmpdir()'s /tmp through its
// /private/tmp symlink, so a raw string comparison against the pre-resolve
// tmpDir would false-fail on a path-resolution quirk that has nothing to do
// with the code under test.
assert(fs.realpathSync(DATA_HOME) === fs.realpathSync(tmpDir), 'DATA_HOME resolved from AGENT_DATA_HOME env var (hardening E1, not process.cwd())')
assert(
  fs.realpathSync(path.dirname(LIVENESS_MARKER_PATH)) === fs.realpathSync(tmpDir),
  'LIVENESS_MARKER_PATH computed from DATA_HOME (== AGENT_DATA_HOME here)'
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

// ── 3. failure marker write (Critical B / hardening E2) ─────────────────
assert(!fs.existsSync(FAILURE_MARKER_PATH), 'failure marker does not exist before first write')
await writeFailureMarker('smoke-test synthetic failure reason')
assert(fs.existsSync(FAILURE_MARKER_PATH), 'failure marker file created by writeFailureMarker()')
const failParsed = JSON.parse(fs.readFileSync(FAILURE_MARKER_PATH, 'utf8'))
assert(failParsed.status === 'failed', 'failure marker.status === "failed"')
assert(failParsed.reason === 'smoke-test synthetic failure reason', 'failure marker.reason carries the given reason')
assert(typeof failParsed.since === 'string' && !Number.isNaN(Date.parse(failParsed.since)), 'failure marker.since is a valid timestamp')
// ── 3b. cause-code field (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1) ─
assert(failParsed.code === 'unknown', 'failure marker.code defaults to "unknown" when writeFailureMarker() is called with no explicit code')
await writeFailureMarker('smoke-test synthetic failure reason, explicit code', 'discord_token_bad')
const failParsedExplicitCode = JSON.parse(fs.readFileSync(FAILURE_MARKER_PATH, 'utf8'))
assert(failParsedExplicitCode.code === 'discord_token_bad', 'failure marker.code carries an explicitly-passed code ("discord_token_bad")')

// ── 4. real subprocess: missing DISCORD_BOT_TOKEN writes a failure marker ──
// (hardening E2 exact scenario) -- this needs a real child process since
// channel.mjs's module-scope guard calls process.exit(1), which we can't
// safely provoke inside THIS process.
{
  const subTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-liveness-smoke-notoken-'))
  const result = spawnSync(process.execPath, [channelModulePath], {
    env: { ...process.env, AGENT_DATA_HOME: subTmpDir, DISCORD_BOT_TOKEN: '', HOME_CHANNEL_ID: '123456789012345678', AGENT_NAME: 'smoketest2' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert(result.status === 1, `missing-DISCORD_BOT_TOKEN subprocess exits 1 (got ${result.status}, stderr: ${result.stderr?.slice(0, 300)})`)
  assert(/DISCORD_BOT_TOKEN not set/.test(result.stderr || ''), 'subprocess stderr names DISCORD_BOT_TOKEN as the FATAL cause')
  const subFailPath = path.join(subTmpDir, '.agent-failed.json')
  assert(fs.existsSync(subFailPath), `subprocess wrote a failure marker at ${subFailPath} instead of just exiting silently`)
  if (fs.existsSync(subFailPath)) {
    const subFailParsed = JSON.parse(fs.readFileSync(subFailPath, 'utf8'))
    assert(subFailParsed.status === 'failed', 'subprocess failure marker.status === "failed"')
    assert(/DISCORD_BOT_TOKEN/.test(subFailParsed.reason || ''), 'subprocess failure marker.reason names DISCORD_BOT_TOKEN')
    // PIECE 1: the missing-token guard passes 'discord_token_bad' explicitly.
    assert(subFailParsed.code === 'discord_token_bad', `subprocess failure marker.code === "discord_token_bad" (got ${subFailParsed.code})`)
  }
  fs.rmSync(subTmpDir, { recursive: true, force: true })
}

// ── cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
