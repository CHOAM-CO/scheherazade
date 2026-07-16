#!/usr/bin/env node
// test-slack-channel.mjs -- channel-slack.mjs's core promises, attacked with
// injected/mocked Slack SDK clients (no live Socket Mode / Web API call
// anywhere in this file). Mirrors the hand-rolled check()/pass-fail pattern
// used across this repo's other scripts/test-*.mjs (see
// test-outbound-channel.mjs, test-boot-announce.mjs).
//
// Covers, per the task brief:
//   (a) inbound message event -> the <channel source=...> tag's meta shape
//       (content/sender/channelId/authorId/timestamp)
//   (b) bot echo / non-message-subtype filtering
//   (c) reply chunking boundary (4000-char budget)
//   (d) bad bot token vs bad app token -> distinct failure-marker `token`
//       field, same base JSON shape as channel.mjs's writeFailureMarker
// Plus smaller coverage for the liveness gate (hard constraint #6), the
// users.info name cache (hard constraint #8), toSlackTs, and
// resolveOutboundChannel (channel.mjs parity), and a handful of source pins
// for things that are awkward to exercise at runtime (stdout hygiene, exact
// tool names, dependency list).
//
// Run: node scripts/test-slack-channel.mjs

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Import-safety convention (mirrors test-outbound-channel.mjs /
// test-liveness-marker.mjs exactly): channel-slack.mjs reads
// SLACK_BOT_TOKEN/SLACK_APP_TOKEN/HOME_CHANNEL_ID at module scope and
// FATAL-exits when any is missing, and resolves DATA_HOME from
// AGENT_DATA_HOME -- all set to throwaway values BEFORE import. argv[1]
// stays this test's path so the isMainModule guard keeps boot() (mcp.connect
// + auth.test + socketModeClient.start) from ever running.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-slack-smoke-'))
const HOME_ID = 'C_HOME_TEST'
process.env.AGENT_DATA_HOME = tmpDir
process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-real'
process.env.SLACK_APP_TOKEN = 'xapp-test-not-real'
process.env.HOME_CHANNEL_ID = HOME_ID
process.env.AGENT_NAME = 'smoketest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const channelModulePath = path.join(ROOT, 'channel-slack.mjs')
const {
  DATA_HOME, FAILURE_MARKER_PATH,
  resolveOutboundChannel,
  chunkText, REPLY_CHUNK_SIZE,
  handleInboundMessage, isBotEvent, isIgnorableSubtype,
  createLivenessGate,
  sendReply, sendFile, readHistory,
  toSlackTs,
  resolveSenderName,
  validateBotToken, validateAppToken,
} = await import(channelModulePath)

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

console.log('channel-slack.mjs (Socket Mode backend)\n')

// ── (a) inbound message -> tag-format injection ────────────────────────────
console.log('(a) message event -> <channel source=...> tag meta')
{
  let captured = null
  const event = { type: 'message', channel: HOME_ID, user: 'U123', text: 'hello world', ts: '1700000000.000100' }
  const r = await handleInboundMessage(event, {
    resolveSender: async (id) => (id === 'U123' ? 'TestUser' : 'unknown'),
    notify: async (params) => { captured = params },
  })
  check('handler does not report skipped', !r.skipped)
  check('notify() was called exactly once', captured !== null)
  check('content carries the raw message text', captured?.content === 'hello world', captured?.content)
  check('meta.sender resolved via injected resolveSender', captured?.meta?.sender === 'TestUser', captured?.meta?.sender)
  check('meta.channelId is the Slack channel id', captured?.meta?.channelId === HOME_ID, captured?.meta?.channelId)
  check('meta.authorId is the Slack user id', captured?.meta?.authorId === 'U123', captured?.meta?.authorId)
  check('meta.timestamp is a non-empty string', typeof captured?.meta?.timestamp === 'string' && captured.meta.timestamp.length > 0)
}
{
  // empty text -> '[empty message]' placeholder, same convention as channel.mjs
  let captured = null
  const event = { type: 'message', channel: HOME_ID, user: 'U123', text: '   ', ts: '1700000000.000200' }
  await handleInboundMessage(event, { resolveSender: async () => 'TestUser', notify: async (params) => { captured = params } })
  check('whitespace-only text becomes [empty message]', captured?.content === '[empty message]', captured?.content)
}

// ── (b) bot echo / non-message-subtype filtering ────────────────────────────
console.log('\n(b) bot echo + subtype filter')
{
  check('bot_id-bearing event flagged as bot echo', isBotEvent({ bot_id: 'B999' }) === true)
  check('subtype=bot_message flagged as bot echo', isBotEvent({ subtype: 'bot_message' }) === true)
  check('plain human event NOT flagged as bot echo', isBotEvent({ user: 'U1' }) === false)
  check('subtype=message_changed flagged as ignorable', isIgnorableSubtype({ subtype: 'message_changed' }) === true)
  check('subtype=bot_message NOT double-flagged as ignorable (isBotEvent already covers it)', isIgnorableSubtype({ subtype: 'bot_message' }) === false)

  let notifyCalls = 0
  const echo = { type: 'message', channel: HOME_ID, bot_id: 'B999', text: 'echo of my own reply' }
  const r1 = await handleInboundMessage(echo, { notify: async () => { notifyCalls++ } })
  check('bot echo is skipped', r1.skipped === true, JSON.stringify(r1))
  check('bot echo never reaches notify()', notifyCalls === 0)

  const edited = { type: 'message', channel: HOME_ID, subtype: 'message_changed' }
  const r2 = await handleInboundMessage(edited, { notify: async () => { notifyCalls++ } })
  check('message_changed subtype is skipped', r2.skipped === true)
  check('message_changed never reaches notify()', notifyCalls === 0)

  const elsewhere = { type: 'message', channel: 'C_SOME_OTHER_CHANNEL', user: 'U1', text: 'hi' }
  const r3 = await handleInboundMessage(elsewhere, { notify: async () => { notifyCalls++ } })
  check('non-home-channel message is skipped (Slack scope: home channel only)', r3.skipped === true && r3.reason === 'not_home_channel', JSON.stringify(r3))
  check('non-home-channel message never reaches notify()', notifyCalls === 0)
}

// ── (c) reply chunking boundary ─────────────────────────────────────────────
console.log('\n(c) reply chunking boundary (4000-char budget)')
{
  check('budget constant is 4000 per hard constraint #4', REPLY_CHUNK_SIZE === 4000, REPLY_CHUNK_SIZE)
  check('exactly 4000 chars -> 1 chunk', chunkText('a'.repeat(4000)).length === 1)
  check('4001 chars -> 2 chunks', chunkText('a'.repeat(4001)).length === 2)
  const twoFull = chunkText('a'.repeat(8000))
  check('8000 chars -> exactly 2 chunks of 4000', twoFull.length === 2 && twoFull[0].length === 4000 && twoFull[1].length === 4000, twoFull.map((c) => c.length))
  const boundary = chunkText('a'.repeat(4000) + 'b')
  check('the 4001st char starts a NEW chunk, not appended to the first', boundary[0].length === 4000 && boundary[1] === 'b', boundary.map((c) => c.length))
}
{
  // end-to-end: sendReply() must call postMessage once per chunk and report
  // the delivery receipt line the stop-reply-guard greps for.
  const posted = []
  const text = 'x'.repeat(8001) // 3 chunks: 4000 + 4000 + 1
  const result = await sendReply({ channelId: undefined, text }, {
    postMessage: async (args) => { posted.push(args); return { ok: true, ts: '1700000000.000300' } },
    fetchFn: async (id) => ({ id }),
    lastId: null,
    homeId: HOME_ID,
  })
  check('sendReply posts once per chunk (3 for 8001 chars)', posted.length === 3, posted.length)
  check('every post targets the resolved channel', posted.every((p) => p.channel === HOME_ID))
  check('last chunk carries the remainder (1 char)', posted[2].text.length === 1, posted[2].text.length)
  check('result reports the chunk count', result.includes('(3 messages)'), result)
  check('result carries the delivered_channel= receipt line', result.includes(`delivered_channel=${HOME_ID}`), result)
}

// ── (d) bad token -> failure marker distinguishes bot vs app ───────────────
console.log('\n(d) token rejection -> failure marker (bot vs app)')
function readMarker() {
  return JSON.parse(fs.readFileSync(FAILURE_MARKER_PATH, 'utf8'))
}
{
  const r = await validateBotToken({ webClient: { auth: { test: async () => { throw new Error('invalid_auth') } } } })
  check('bad bot token reports ok:false', r.ok === false)
  check('bad bot token result is tagged token:"bot"', r.token === 'bot')
  const marker = readMarker()
  check('failure marker has channel.mjs base shape (status/reason/code/since/pid)', marker.status === 'failed' && typeof marker.reason === 'string' && typeof marker.since === 'string' && typeof marker.pid === 'number')
  check('failure marker code is slack_token_bad', marker.code === 'slack_token_bad', marker.code)
  check('failure marker detail distinguishes the BOT token as the culprit', marker.token === 'bot', marker.token)
}
{
  const r = await validateAppToken({ socketModeClient: { start: async () => { throw new Error('invalid_auth (app-level token)') } } })
  check('bad app token reports ok:false', r.ok === false)
  check('bad app token result is tagged token:"app"', r.token === 'app')
  const marker = readMarker()
  check('failure marker code is slack_token_bad (app path too)', marker.code === 'slack_token_bad', marker.code)
  check('failure marker detail distinguishes the APP token as the culprit', marker.token === 'app', marker.token)
}
{
  const r = await validateBotToken({ webClient: { auth: { test: async () => ({ ok: true }) } } })
  check('good bot token reports ok:true and no token field', r.ok === true && r.token === undefined)
}

// ── liveness gate (hard constraint #6): disconnect must not keep the
// heartbeat looking alive ───────────────────────────────────────────────────
console.log('\n(bonus) liveness gate state machine')
{
  const gate = createLivenessGate()
  check('starts NOT ready (no connection yet)', gate.shouldWrite() === false)
  gate.onConnected()
  check('ready after connected', gate.shouldWrite() === true)
  gate.onDisconnected()
  check('NOT ready after disconnect (heartbeat must not refresh)', gate.shouldWrite() === false)
  gate.onConnected()
  gate.onReconnecting()
  check('NOT ready while reconnecting (still unrecovered)', gate.shouldWrite() === false)
  gate.onConnected()
  check('ready again once reconnect completes', gate.shouldWrite() === true)
}

// ── users.info cache (hard constraint #8) ───────────────────────────────────
console.log('\n(bonus) sender display-name resolution + cache')
{
  let calls = 0
  const usersInfo = async ({ user }) => { calls++; return { user: { profile: { display_name: `Display-${user}` } } } }
  const n1 = await resolveSenderName('U777', { usersInfo })
  const n2 = await resolveSenderName('U777', { usersInfo })
  check('display_name preferred', n1 === 'Display-U777', n1)
  check('second lookup for the same user hits the cache (usersInfo called once)', calls === 1, calls)
  check('cached result is stable', n2 === 'Display-U777', n2)

  const fallback = await resolveSenderName('U_NEWFAIL', { usersInfo: async () => { throw new Error('rate_limited') } })
  check('users.info failure falls back to the raw id, never throws', fallback === 'U_NEWFAIL', fallback)
}

// ── toSlackTs ────────────────────────────────────────────────────────────
console.log('\n(bonus) toSlackTs (after/before -> Slack ts)')
{
  check('already-Slack-ts passes through unchanged', toSlackTs('1700000000.000100') === '1700000000.000100')
  check('ISO date converts to seconds.microseconds', toSlackTs('2023-11-14T22:13:20.000Z') === '1700000000.000000', toSlackTs('2023-11-14T22:13:20.000Z'))
  check('falsy input -> undefined', toSlackTs(undefined) === undefined && toSlackTs('') === undefined)
  check('garbage input -> undefined (never throws)', toSlackTs('not-a-date') === undefined)
}

// ── resolveOutboundChannel (channel.mjs parity) ─────────────────────────────
console.log('\n(bonus) resolveOutboundChannel (anti-confabulation parity with channel.mjs)')
{
  const KNOWN = { c777: { id: 'c777' }, home1: { id: 'home1' } }
  const fakeFetch = async (id) => { if (KNOWN[id]) return KNOWN[id]; throw new Error(`channel ${id} not found`) }

  const r1 = await resolveOutboundChannel('c777', { fetchFn: fakeFetch, lastId: 'home1', homeId: null })
  check('valid explicit id honored, no note', r1.channelId === 'c777' && r1.note === null)

  const r2 = await resolveOutboundChannel('confabulated', { fetchFn: fakeFetch, lastId: 'c777', homeId: null })
  check('unknown explicit id reroutes to current channel with a loud note', r2.channelId === 'c777' && typeof r2.note === 'string' && r2.note.includes('confabulated'))

  const r3 = await resolveOutboundChannel(undefined, { fetchFn: fakeFetch, lastId: 'c777', homeId: 'home1' })
  check('omitted id goes to lastInbound over HOME', r3.channelId === 'c777' && r3.note === null)

  let threw = false
  try { await resolveOutboundChannel('bogus', { fetchFn: fakeFetch, lastId: null, homeId: null }) } catch { threw = true }
  check('no fallback available -> throws (fail loud, never silent)', threw)
}

// ── send_file_to_discord (name locked) + read_channel_history smoke ────────
console.log('\n(bonus) sendFile + readHistory smoke (name/shape only, not exhaustive)')
{
  const missing = await sendFile({ channelId: HOME_ID, filePath: path.join(tmpDir, 'does-not-exist.png') }, {
    fetchFn: async (id) => ({ id }),
  })
  check('missing local file reports isError without ever calling Slack', missing.isError === true && missing.text.includes('file not found'))

  const realFile = path.join(tmpDir, 'upload-me.txt')
  await fsp.writeFile(realFile, 'hello')
  let uploadArgs = null
  const ok = await sendFile({ channelId: undefined, filePath: realFile, comment: 'a file' }, {
    uploadFile: async (args) => { uploadArgs = args; return { files: [{ permalink: 'https://slack.example/f/1' }] } },
    fetchFn: async (id) => ({ id }),
    lastId: HOME_ID,
    homeId: HOME_ID,
  })
  check('uploadV2 called with channel_id + file path + filename', uploadArgs?.channel_id === HOME_ID && uploadArgs?.file === realFile && uploadArgs?.filename === 'upload-me.txt', JSON.stringify(uploadArgs))
  check('sendFile result carries the permalink + delivered_channel receipt', ok.text.includes('https://slack.example/f/1') && ok.text.includes(`delivered_channel=${HOME_ID}`), ok.text)

  const hist = await readHistory({ channelId: HOME_ID, limit: 10 }, {
    history: async () => ({ ok: true, messages: [{ ts: '1700000000.000100', user: 'U1', text: 'hi', files: [] }] }),
    resolveSender: async () => 'TestUser',
  })
  check('readHistory maps messages with resolved author name', hist.count === 1 && hist.messages[0].author === 'TestUser' && hist.messages[0].content === 'hi', JSON.stringify(hist))
}

// ── source pins (hard to exercise at runtime -- pin the literal text) ──────
console.log('\n(bonus) source pins')
{
  const src = fs.readFileSync(channelModulePath, 'utf8')
  check('tool name "reply" unchanged', /name:\s*'reply'/.test(src))
  check('tool name "send_file_to_discord" kept (allowlists match on it)', src.includes("name: 'send_file_to_discord'"))
  check('tool name "read_channel_history" unchanged', src.includes("name: 'read_channel_history'"))
  check('only @slack/socket-mode + @slack/web-api imported (hard constraint #2)', src.includes("from '@slack/socket-mode'") && src.includes("from '@slack/web-api'"))
  check('no discord.js import statement leaked in (mentions in comparison comments are fine)', !src.includes("from 'discord.js'"))
  check('env vars match hard constraint #3', src.includes('SLACK_BOT_TOKEN') && src.includes('SLACK_APP_TOKEN') && src.includes('HOME_CHANNEL_ID') && src.includes('AGENT_NAME'))
  check('dotenv loaded the same way as channel.mjs', src.includes("import 'dotenv/config'"))
  check('stdout hygiene block reroutes console to stderr', src.includes('process.stderr.write') && src.includes("console[method]"))
  check('failure marker reason code is the literal slack_token_bad', src.includes("'slack_token_bad'"))
  check('chat.postMessage used for outbound sends', src.includes('chat.postMessage'))
  check('files.uploadV2 used for file sends', src.includes('files.uploadV2'))
  check('conversations.history used for history reads', src.includes('conversations.history'))

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  check('package.json declares @slack/socket-mode', Boolean(pkg.dependencies?.['@slack/socket-mode']))
  check('package.json declares @slack/web-api', Boolean(pkg.dependencies?.['@slack/web-api']))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
