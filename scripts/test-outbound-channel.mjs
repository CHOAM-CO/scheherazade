#!/usr/bin/env node
// test-outbound-channel.mjs -- resolveOutboundChannel()'s anti-confabulation
// promises, attacked with fixture fetches (no live Discord API anywhere).
//
// WHY THIS EXISTS (2026-07-15 GLM investigation): on debris-heavy contexts a
// weaker model confabulated reply channelIds (repro: 3/4 calls to a channel
// named "researcher"). The old contract threw on unknown ids and the user saw
// NOTHING. The promises under test:
//   1. A valid explicit channelId is honored exactly (no note).
//   2. An UNKNOWN explicit channelId is rerouted to the current conversation
//      channel WITH a loud note naming both ids -- visible correction beats
//      silent swallow.
//   3. An omitted channelId goes to the current conversation channel.
//   4. Fallback order is lastInbound > HOME.
//   5. With no fallback available, the original error still throws (fail
//      loud, never fail silent-drop).
//   6. Reroute never loops: fallback === requested rethrows.
//
// Run: node scripts/test-outbound-channel.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Import-safety convention (mirrors test-liveness-marker.mjs exactly):
// channel.mjs reads DISCORD_BOT_TOKEN/HOME_CHANNEL_ID at module scope and
// FATAL-exits when missing, and resolves DATA_HOME from AGENT_DATA_HOME --
// all three MUST be set to throwaway values BEFORE import, and argv[1] stays
// this test's path so the isMainModule guard keeps boot() (mcp.connect +
// discord.login) from running.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-outbound-smoke-'))
process.env.AGENT_DATA_HOME = tmpDir
process.env.DISCORD_BOT_TOKEN = 'test-token-not-real'
process.env.HOME_CHANNEL_ID = '123456789012345678'
process.env.AGENT_NAME = 'smoketest'

const channelModulePath = path.join(import.meta.dirname, '..', 'channel.mjs')
const { resolveOutboundChannel } = await import(channelModulePath)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// Fixture fetch: knows exactly two channels.
const KNOWN = { '777': { id: '777' }, 'home1': { id: 'home1' } }
async function fakeFetch(id) {
  if (KNOWN[id]) return KNOWN[id]
  throw new Error(`channel ${id} not found or not text-based`)
}

// 1. valid explicit id -> honored, no note
{
  const r = await resolveOutboundChannel('777', { fetchFn: fakeFetch, lastId: 'home1', homeId: null })
  check('valid explicit id honored', r.ch.id === '777', `got ${r.ch?.id}`)
  check('valid explicit id has no note', r.note === null)
}

// 2. unknown explicit id + lastInbound -> rerouted with loud note
{
  const r = await resolveOutboundChannel('researcher', { fetchFn: fakeFetch, lastId: '777', homeId: null })
  check('confabulated id rerouted to current channel', r.ch.id === '777', `got ${r.ch?.id}`)
  check('reroute note names the bad id', typeof r.note === 'string' && r.note.includes('researcher'))
  check('reroute note names the delivered id', typeof r.note === 'string' && r.note.includes('777'))
}

// 3. omitted id -> current conversation channel, no note
{
  const r = await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: '777', homeId: 'home1' })
  check('omitted id goes to lastInbound', r.ch.id === '777', `got ${r.ch?.id}`)
  check('omitted id has no note', r.note === null)
}

// 4. fallback order: lastInbound wins over HOME; HOME used when no lastInbound
{
  const r1 = await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: '777', homeId: 'home1' })
  check('lastInbound beats HOME', r1.ch.id === '777')
  const r2 = await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: null, homeId: 'home1' })
  check('HOME used when no lastInbound', r2.ch.id === 'home1', `got ${r2.ch?.id}`)
  const r3 = await resolveOutboundChannel('bogus', { fetchFn: fakeFetch, lastId: null, homeId: 'home1' })
  check('unknown id reroutes to HOME when no lastInbound', r3.ch.id === 'home1', `got ${r3.ch?.id}`)
}

// 5. no fallback available -> throws (fail loud)
{
  let threw = false
  try { await resolveOutboundChannel('bogus', { fetchFn: fakeFetch, lastId: null, homeId: null }) } catch { threw = true }
  check('unknown id with no fallback throws', threw)
  let threw2 = false
  try { await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: null, homeId: null }) } catch { threw2 = true }
  check('omitted id with no fallback throws', threw2)
}

// 6. fallback === requested -> rethrows original error (no reroute loop)
{
  let threw = false
  try { await resolveOutboundChannel('deadchan', { fetchFn: fakeFetch, lastId: 'deadchan', homeId: null }) } catch { threw = true }
  check('fallback identical to requested rethrows', threw)
}

// 7. fallback itself unknown -> throws from the fallback fetch (still loud)
{
  let threw = false
  try { await resolveOutboundChannel('bogus', { fetchFn: fakeFetch, lastId: 'also-bogus', homeId: null }) } catch { threw = true }
  check('broken fallback still throws, never silent', threw)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
