#!/usr/bin/env node
// test-agent-status-read.mjs — unit test for http-server.cjs's READ side of
// agent liveness: computeAgentStatus() + isMarkerFresh() + the connecting-
// timeout backstop. Written for the sleep/wake false-fail fix (2026-08-15,
// Mino field report: window backgrounded 1-2h -> mac sleeps -> heartbeat
// marker goes stale -> old code synthesized failed:timeout for an agent
// that had been live for hours and was about to heartbeat again).
//
// Companion to scripts/test-liveness-marker.mjs, which covers the WRITE
// side (channel.mjs) and explicitly left this half untested.
//
// Run: node scripts/test-agent-status-read.mjs
//
// AGENT_DATA_HOME MUST point at a throwaway temp dir BEFORE http-server.cjs
// is required (same guard test-liveness-marker.mjs carries): DATA_HOME and
// LIVENESS_MARKER_PATH are resolved at module scope, and without this the
// test would read/write the user's real ~/Documents/Scheherazade.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-status-read-'))
process.env.AGENT_DATA_HOME = tmpDir

const require = createRequire(import.meta.url)
const { computeAgentStatus } = require(path.join(import.meta.dirname, '..', 'onboarding', 'http-server.cjs'))
const { setAgentStatus } = require(path.join(import.meta.dirname, '..', 'onboarding', 'agent-status.cjs'))

const MARKER = path.join(tmpDir, '.agent-live')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`PASS  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}`) }
}

function writeMarker({ ageMs, pid }) {
  fs.writeFileSync(MARKER, JSON.stringify({
    pid: pid ?? process.pid,
    lastHeartbeat: new Date(Date.now() - ageMs).toISOString(),
  }))
}

function setConnectingSince(ageMs) {
  // setAgentStatus('connecting') stamps `since` = now; the tests need an
  // AGED `since`, and there is no public knob for that. getAgentStatus()
  // hands back the module-singleton object itself (same shared-reference
  // design main.cjs and http-server.cjs rely on), so age it by direct
  // mutation -- with a guard that hard-exits if agent-status.cjs ever
  // switches to returning copies, so this test fails loud instead of
  // silently testing the wrong `since`.
  const mod = require(path.join(import.meta.dirname, '..', 'onboarding', 'agent-status.cjs'))
  setAgentStatus('connecting')
  const snap = mod.getAgentStatus()
  snap.since = new Date(Date.now() - ageMs).toISOString()
  if (mod.getAgentStatus().since !== snap.since) {
    console.log('SKIP-HARD: getAgentStatus returns copies; cannot age `since` from outside')
    process.exit(2)
  }
}

// ── case 1: connecting, no marker, past TIMEOUT_MS -> failed:timeout ──────
setConnectingSince(5 * 60_000) // spawned 5 min ago
fs.rmSync(MARKER, { force: true })
{
  const s = computeAgentStatus()
  assert(s.state === 'failed' && s.code === 'timeout', 'never-live spawn past timeout -> failed:timeout')
}

// ── case 2: fresh marker -> live (and pid-alive gate holds) ────────────────
writeMarker({ ageMs: 10_000 })
{
  const s = computeAgentStatus()
  assert(s.state === 'live', 'fresh marker -> live')
}

// ── case 3 (THE 2026-08-15 BUG): was live after spawn, marker now stale
// (sleep/wake) -> must stay connecting, NOT failed:timeout ─────────────────
setConnectingSince(3 * 3600_000)     // spawned 3h ago...
writeMarker({ ageMs: 2 * 3600_000 }) // ...heartbeat until mac slept 2h ago
{
  const s = computeAgentStatus()
  assert(s.state === 'connecting', `stale-after-live marker -> connecting (got ${s.state}${s.code ? ':' + s.code : ''})`)
}

// ── case 4: marker heartbeat OLDER than the current spawn attempt (prior
// generation's marker) -> proves nothing about THIS spawn -> failed:timeout ─
writeMarker({ ageMs: 10 * 60_000 }) // heartbeat 10 min ago...
setConnectingSince(5 * 60_000)      // ...but this spawn attempt is 5 min ago
{
  const s = computeAgentStatus()
  assert(s.state === 'failed' && s.code === 'timeout', 'pre-spawn marker does not rescue a never-live spawn')
}

// ── case 5: dead-pid fresh-timestamp marker is not "live" (Fix D pin) ──────
writeMarker({ ageMs: 10_000, pid: 999999999 })
setConnectingSince(30_000) // within TIMEOUT_MS -> connecting, not failed yet
{
  const s = computeAgentStatus()
  assert(s.state === 'connecting', 'dead-pid marker never reads live; pre-timeout stays connecting')
}

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
