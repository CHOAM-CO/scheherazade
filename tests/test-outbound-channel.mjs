#!/usr/bin/env node
// test-outbound-channel.mjs -- resolveOutboundChannel()'s anti-confabulation
// promises, attacked with fixture fetches (no live Discord API anywhere).
//
// WHY THIS EXISTS (2026-07-15 GLM investigation): on debris-heavy contexts a
// weaker model confabulated reply channelIds (repro: 3/4 calls to a channel
// named "researcher"). The old contract threw on unknown ids and the user saw
// NOTHING. The promises under test:
//   1. A valid explicit channelId is honored exactly (no note).
//   2. An UNKNOWN explicit channelId FAILS CLOSED: it throws, names the id
//      the caller asked for, states that nothing was sent, and tells the
//      caller how to retry. (Changed 2026-07-25, nogabi issue #7. This used
//      to reroute to the current conversation with a loud note; the note was
//      honest but the side effect had already happened in a destination the
//      caller never named. Visibility now comes from the error text, which
//      the SDK returns to the model verbatim as the JSON-RPC error message
//      -- verified in shared/protocol.js's request-rejection path.)
//   3. An omitted channelId goes to the current conversation channel.
//   4. Fallback order is lastInbound > HOME.
//   5. With no fallback available, the original error still throws (fail
//      loud, never fail silent-drop).
//   6. No reroute exists to loop: an explicit id never consults the fallback
//      at all, so the fetch for it is never issued.
//
// Run: node tests/test-outbound-channel.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
// pathToFileURL, not a bare path: on Windows `import('C:\\...')` throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME (node reads 'c:' as a protocol). Six tests
// could not run at all on the win box for this (2026-08-04, first full suite
// run there). Production already does this correctly -- it was only the
// harness, which is exactly the safety net the Windows lane needs most.
const { resolveOutboundChannel } = await import(pathToFileURL(channelModulePath).href)

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
// ({target, note} is the unified resolver contract shared by all three
// backends via channel-runtime.mjs -- target is the Discord channel object.)
{
  const r = await resolveOutboundChannel('777', { fetchFn: fakeFetch, lastId: 'home1', homeId: null })
  check('valid explicit id honored', r.target.id === '777', `got ${r.target?.id}`)
  check('valid explicit id has no note', r.note === null)
}

// 2. unknown explicit id + a perfectly good fallback -> STILL fails closed.
//    The fallback existing is exactly the condition under which the old code
//    delivered anyway, so this is the assertion that pins the fix.
{
  let err = null
  const tried = []
  const trackingFetch = async (id) => { tried.push(id); return fakeFetch(id) }
  try {
    await resolveOutboundChannel('researcher', { fetchFn: trackingFetch, lastId: '777', homeId: null })
  } catch (e) { err = e }
  check('unknown explicit id throws even when a fallback is available', err !== null)
  check('error names the id the caller asked for', !!err && err.message.includes('researcher'))
  check('error states nothing was sent', !!err && /nothing was sent/i.test(err.message))
  check('error tells the caller how to retry', !!err && err.message.includes('omit channelId'))
  check('the fallback channel was never even fetched', !tried.includes('777'), `fetched: ${tried.join(',')}`)
}

// 3. omitted id -> current conversation channel, no note
{
  const r = await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: '777', homeId: 'home1' })
  check('omitted id goes to lastInbound', r.target.id === '777', `got ${r.target?.id}`)
  check('omitted id has no note', r.note === null)
}

// 4. fallback order: lastInbound wins over HOME; HOME used when no lastInbound
{
  const r1 = await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: '777', homeId: 'home1' })
  check('lastInbound beats HOME', r1.target.id === '777')
  const r2 = await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: null, homeId: 'home1' })
  check('HOME used when no lastInbound', r2.target.id === 'home1', `got ${r2.target?.id}`)
  let r3threw = false
  try { await resolveOutboundChannel('bogus', { fetchFn: fakeFetch, lastId: null, homeId: 'home1' }) } catch { r3threw = true }
  check('unknown explicit id does not fall through to HOME either', r3threw)
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

// 6. an explicit id issues exactly ONE fetch: its own. No fallback probing.
{
  const tried = []
  try {
    await resolveOutboundChannel('deadchan', {
      fetchFn: async (id) => { tried.push(id); return fakeFetch(id) },
      lastId: 'home1', homeId: '777',
    })
  } catch { /* expected */ }
  check('explicit id issues exactly one fetch', tried.length === 1, `fetched: ${tried.join(',')}`)
  check('the one fetch was the requested id', tried[0] === 'deadchan')
}

// 7. the omitted-id path is untouched: a broken fallback still throws loudly.
{
  let threw = false
  try { await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: 'also-bogus', homeId: null }) } catch { threw = true }
  check('broken fallback on the omitted path still throws, never silent', threw)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
