#!/usr/bin/env node
// test-local-surface-routing.mjs — always-on in-app chat (2026-08-05,
// colleague via Mino: "인앱챗 기본 + 채널 하나"). Every platform backend
// hosts channel-local's chat surface and routes tool calls whose channelId
// is "in-app" to channel-local's handleToolCall, deterministically.
//
// Three layers, mirroring how the change is built:
//  1. functional — channel-local's handleToolCall serves the routed calls
//  2. functional — channel.mjs's isLocalCall routing predicate (imported
//     with the dummy-env pattern from test-channel-runtime.mjs)
//  3. text pins on all three platform files for the twin wiring blocks
//     (slack/telegram are not importable without live-ish tokens; the
//     blocks are byte-for-byte twins by construction)

import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Sandbox BEFORE any channel import: channel.mjs writes markers at module
// scope, and channel-local's transcript persistence must never touch a real
// DATA_HOME from a test.
process.env.AGENT_DATA_HOME = mkdtempSync(path.join(os.tmpdir(), 'schz-routing-test-'))
process.env.AGENT_NAME = 'routing-test'
process.env.DISCORD_BOT_TOKEN = 'test-token-not-real'
process.env.HOME_CHANNEL_ID = '123456789012345678'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

const local = await import(path.join(root, 'channel-local.mjs'))
const discord = await import(path.join(root, 'channel.mjs'))

console.log('1. channel-local handleToolCall serves the routed calls (channelId present)')
local.resetQueueForTest()
const r1 = await local.handleToolCall('reply', { channelId: 'in-app', text: 'routed hello' })
assert(!r1.isError && /sent/.test(r1.content[0].text), 'reply with channelId in-app enqueues')
const out = local.readOutbound(0)
assert(out.items.length === 1 && out.items[0].role === 'agent' && out.items[0].text === 'routed hello',
  'the reply landed in the local transcript')
const r2 = await local.handleToolCall('read_channel_history', { channelId: 'in-app', limit: 10 })
assert(!r2.isError && /routed hello/.test(r2.content[0].text), 'read_channel_history with channelId in-app reads the transcript')
// react against the agent's own message is refused (no user message yet) --
// the tool exists and answers coherently rather than crashing.
const r3 = await local.handleToolCall('react', { emoji: '👍' })
assert(r3.isError === true && /no message to react to/.test(r3.content[0].text), 'react without a user message fails honestly')

console.log('\n2. isLocalCall routing predicate (channel.mjs)')
const { isLocalCall } = discord
assert(isLocalCall('reply', { channelId: 'in-app', text: 'x' }) === true, 'reply + in-app routes local')
assert(isLocalCall('reply', { channelId: '123456789012345678', text: 'x' }) === false, 'reply + snowflake stays platform')
assert(isLocalCall('reply', { text: 'x' }) === false, 'reply without channelId stays platform (current-conversation contract)')
assert(isLocalCall('read_channel_history', { channelId: 'in-app' }) === true, 'history + in-app routes local')
assert(isLocalCall('send_file_to_discord', { channelId: 'in-app', filePath: '/tmp/x' }) === true, 'file + in-app routes local')
assert(isLocalCall('react', { emoji: '👍' }) === true, 'react routes local even without channelId (no other surface has reactions)')
assert(isLocalCall('routine', { action: 'list' }) === false, 'routine never routes local (host owns the ticker/store)')
assert(isLocalCall('reply', null) === false, 'null args never routes (and never throws)')

console.log('\n3. twin wiring pins on all three platform backends')
for (const f of ['channel.mjs', 'channel-slack.mjs', 'channel-telegram.mjs']) {
  const t = readFileSync(path.join(root, f), 'utf8')
  assert(/from '\.\/channel-local\.mjs'/.test(t), `${f} imports channel-local`)
  const dispatchIdx = t.indexOf('if (isLocalCall(name, args)) return handleLocalToolCall(name, args)')
  const parseIdx = t.indexOf('ReplyArgs.parse(args')
  assert(dispatchIdx !== -1, `${f} has the routing prologue`)
  assert(parseIdx === -1 || (dispatchIdx !== -1 && dispatchIdx < parseIdx), `${f} routes BEFORE schema parses (local shapes would fail platform zod)`)
  assert(/name: 'react'/.test(t), `${f} exposes the react tool`)
  assert(/startLocalChatSurface\(\{ notify:/.test(t), `${f} boots the local surface`)
  assert(/surface\.stop/.test(t), `${f} unlinks the port file on stdin EOF`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
