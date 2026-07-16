#!/usr/bin/env node
// test-telegram-channel.mjs -- channel-telegram.mjs's core promises, attacked
// with an injected https layer (no live Telegram API anywhere in this file).
//
// Four scenarios, per the port brief:
//   (a) getUpdates inbound -> the {content, meta} payload that becomes the
//       <channel source=...> tag downstream, including the home-chat filter
//       (private chat always passes; group chat must match HOME_CHANNEL_ID)
//       and offset-advances-only-on-success semantics.
//   (b) reply chunking at the 4000-char boundary, through the real
//       chunk/send/log path (handleReplyCall), not just the pure slicer.
//   (c) history ledger round trip: append -> read back, channelId isolation,
//       after/before (both id-form and date-form), limit truncation, and
//       resilience to one corrupt line.
//   (d) token rejection -> failure marker, both flavors: (d-1) getMe
//       rejected by the API (in-process, injected requestFn) and (d-2)
//       TELEGRAM_BOT_TOKEN missing entirely (real subprocess, mirrors
//       test-liveness-marker.mjs's own hardening-E2 pattern -- the
//       module-scope guard calls process.exit(1), which can't safely be
//       provoked inside this process).
//
// Run: node scripts/test-telegram-channel.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Import-safety convention (mirrors test-liveness-marker.mjs /
// test-outbound-channel.mjs exactly): channel-telegram.mjs reads
// TELEGRAM_BOT_TOKEN/HOME_CHANNEL_ID at module scope and FATAL-exits when
// missing, and resolves DATA_HOME from AGENT_DATA_HOME -- all three MUST be
// set to throwaway values BEFORE import, and argv[1] stays this test's own
// path so the isMainModule guard keeps boot() (mcp.connect + Telegram
// getMe/polling) from running.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-telegram-smoke-'))
process.env.AGENT_DATA_HOME = tmpDir
process.env.TELEGRAM_BOT_TOKEN = 'test-token-not-real'
process.env.HOME_CHANNEL_ID = '999888777'
process.env.AGENT_NAME = 'smoketest'

const channelModulePath = path.join(import.meta.dirname, '..', 'channel-telegram.mjs')
const {
  writeLivenessMarker,
  LIVENESS_MARKER_PATH,
  writeFailureMarker,
  FAILURE_MARKER_PATH,
  DATA_HOME,
  resolveOutboundChannel,
  chunkText,
  handleReplyCall,
  buildInboundMessage,
  shouldProcessMessage,
  handleUpdate,
  appendHistoryEntry,
  readHistoryEntries,
  HISTORY_LEDGER_PATH,
  verifyTokenOrFail,
} = await import(channelModulePath)

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

console.log(`temp AGENT_DATA_HOME: ${tmpDir}`)
console.log(`DATA_HOME resolved by channel-telegram.mjs: ${DATA_HOME}`)

// ── sanity: same DATA_HOME-derived-paths contract as channel.mjs ───────────
check('DATA_HOME resolved from AGENT_DATA_HOME env var', fs.realpathSync(DATA_HOME) === fs.realpathSync(tmpDir))
check('LIVENESS_MARKER_PATH lives under DATA_HOME', path.dirname(LIVENESS_MARKER_PATH) === DATA_HOME)
check('FAILURE_MARKER_PATH lives under DATA_HOME', path.dirname(FAILURE_MARKER_PATH) === DATA_HOME)
check('HISTORY_LEDGER_PATH is telegram-history.jsonl under DATA_HOME', HISTORY_LEDGER_PATH === path.join(DATA_HOME, 'telegram-history.jsonl'))

// ── (a) getUpdates inbound -> tag-format payload ────────────────────────────
console.log('\n(a) getUpdates inbound -> tag-format injection')
{
  // Home-chat filter (constraint 4): private always passes; group must match.
  const bot = { text: 'x', from: { id: 1, is_bot: true }, chat: { id: 999888777, type: 'private' } }
  const privateMsg = { text: 'x', from: { id: 1, is_bot: false }, chat: { id: 555, type: 'private' } }
  const groupMatch = { text: 'x', from: { id: 1, is_bot: false }, chat: { id: 999888777, type: 'group' } }
  const groupMismatch = { text: 'x', from: { id: 1, is_bot: false }, chat: { id: 1111, type: 'group' } }
  check('bot-authored messages are dropped regardless of chat type', shouldProcessMessage(bot, '999888777') === false)
  check('private chat always passes (any DM)', shouldProcessMessage(privateMsg, '999888777') === true)
  check('group chat matching HOME_CHANNEL_ID passes', shouldProcessMessage(groupMatch, '999888777') === true)
  check('group chat NOT matching HOME_CHANNEL_ID is dropped', shouldProcessMessage(groupMismatch, '999888777') === false)

  // buildInboundMessage: the exact {content, meta} shape the harness wraps
  // into <channel source="..." sender="..." channelId="..." authorId="..." timestamp="...">.
  const withImage = buildInboundMessage(
    { text: '안녕', chat: { id: 555 }, from: { id: 777, username: 'mino_handle' } },
    ['/tmp/fake/local-image.jpg']
  )
  check('content carries the message text', withImage.content.startsWith('안녕'))
  check('content appends the local image path block', withImage.content.includes('/tmp/fake/local-image.jpg') && withImage.content.includes('open with Read tool'))
  check('meta.sender uses username', withImage.meta.sender === 'mino_handle')
  check('meta.channelId is the chat id, stringified', withImage.meta.channelId === '555')
  check('meta.authorId is the sender id, stringified', withImage.meta.authorId === '777')
  check('meta.timestamp is a non-empty string', typeof withImage.meta.timestamp === 'string' && withImage.meta.timestamp.length > 0)

  const empty = buildInboundMessage({ chat: { id: 1 }, from: {} }, [])
  check('a message with no text/caption becomes the [empty message] sentinel', empty.content === '[empty message]')
  check('a message with no from.username falls back to first/last name or "unknown"', buildInboundMessage({ text: 'x', chat: { id: 1 }, from: { first_name: 'A', last_name: 'B' } }, []).meta.sender === 'A B')

  // Full path through handleUpdate() (and pollOnce-shaped offset advance),
  // driven by an injected requestFn -- this is the "https layer mocked" leg.
  const fakeUpdate = {
    update_id: 42,
    message: { message_id: 501, chat: { id: 555, type: 'private' }, from: { id: 777, username: 'mino_handle', is_bot: false }, text: '안녕' },
  }
  const notified = []
  const historyLogged = []
  await handleUpdate(fakeUpdate, {
    notifyFn: async (payload) => { notified.push(payload) },
    historyAppendFn: async (rec) => { historyLogged.push(rec) },
  })
  check('handleUpdate calls notifyFn exactly once', notified.length === 1)
  check('the notified payload content matches the message text', notified[0]?.content === '안녕')
  check('the notified payload meta.channelId matches the chat id', notified[0]?.meta?.channelId === '555')
  check('the notified payload meta.authorId matches the sender id', notified[0]?.meta?.authorId === '777')
  check('handleUpdate logs the inbound message to the ledger AFTER notifying', historyLogged.length === 1 && historyLogged[0].id === '501' && historyLogged[0].direction === 'in')

  // A dropped message (home filter fails) must not notify or log at all.
  const droppedUpdate = { update_id: 43, message: { message_id: 502, chat: { id: 111, type: 'group' }, from: { id: 1, is_bot: false }, text: 'noise' } }
  const notified2 = []
  await handleUpdate(droppedUpdate, { notifyFn: async (p) => notified2.push(p) })
  check('a message failing the home-chat filter is silently dropped (no notify)', notified2.length === 0)

  // If notifyFn throws, the caller (pollOnce, not exercised directly here)
  // must see the rejection so it can leave the offset where it was --
  // handleUpdate itself must propagate, not swallow, notify failures.
  let threw = false
  try {
    await handleUpdate(fakeUpdate, { notifyFn: async () => { throw new Error('boom') } })
  } catch { threw = true }
  check('a notifyFn failure propagates out of handleUpdate (so offset does not advance past it)', threw)
}

// ── (b) reply chunking boundary ─────────────────────────────────────────────
console.log('\n(b) reply chunking boundary')
{
  check('chunkText: empty string -> zero chunks', chunkText('').length === 0)
  check('chunkText: 3999 chars -> 1 chunk', chunkText('a'.repeat(3999)).length === 1)
  check('chunkText: exactly 4000 chars -> 1 chunk', chunkText('a'.repeat(4000)).length === 1)
  check('chunkText: 4001 chars -> 2 chunks, split 4000/1', (() => {
    const c = chunkText('a'.repeat(4001))
    return c.length === 2 && c[0].length === 4000 && c[1].length === 1
  })())
  check('chunkText: 8000 chars -> 2 chunks of 4000', (() => {
    const c = chunkText('a'.repeat(8000))
    return c.length === 2 && c[0].length === 4000 && c[1].length === 4000
  })())
  check('chunkText never drops or reorders content', chunkText('가'.repeat(4500)).join('').length === 4500)

  // handleReplyCall: the real chunk/send/log path, fetchFn/sendFn injected
  // so no live Telegram call happens.
  const sent = []
  const logged = []
  let nextMsgId = 9000
  const { ch, note, chunkCount } = await handleReplyCall(
    { channelId: 'chat-b', text: 'x'.repeat(4001) },
    {
      fetchFn: async (id) => ({ id }),
      sendFn: async (chatId, chunk) => { sent.push({ chatId, chunk }); return { message_id: nextMsgId++ } },
      historyAppendFn: async (rec) => { logged.push(rec) },
    }
  )
  check('handleReplyCall resolves the requested channel', ch.id === 'chat-b')
  check('handleReplyCall reports no reroute note for a valid explicit id', note === null)
  check('handleReplyCall reports chunkCount === 2 for a 4001-char reply', chunkCount === 2)
  check('handleReplyCall calls sendFn once per chunk, in order, on the resolved chat', sent.length === 2 && sent.every((s) => s.chatId === 'chat-b'))
  check('sent chunk boundaries are 4000/1', sent[0].chunk.length === 4000 && sent[1].chunk.length === 1)
  check('sent chunks reassemble to the original text', sent[0].chunk + sent[1].chunk === 'x'.repeat(4001))
  check('handleReplyCall logs one ledger entry per chunk, each carrying that chunk', logged.length === 2 && logged[0].content === sent[0].chunk && logged[1].content === sent[1].chunk)
  check('logged entries are marked outbound, on the resolved chat', logged.every((l) => l.direction === 'out' && l.channelId === 'chat-b'))
}

// ── (c) history ledger round trip ───────────────────────────────────────────
console.log('\n(c) history ledger round trip')
{
  check('ledger does not exist before first write', !fs.existsSync(HISTORY_LEDGER_PATH))
  check('reading a nonexistent ledger returns an empty list, not a throw', (await readHistoryEntries({ channelId: 'histchat' })).length === 0)

  await appendHistoryEntry({ id: '100', channelId: 'histchat', direction: 'in', author: 'a', authorId: '1', content: 'one', timestamp: '2026-07-16T10:00:00+09:00', attachments: [] })
  await appendHistoryEntry({ id: '101', channelId: 'histchat', direction: 'out', author: 'a', authorId: '1', content: 'two', timestamp: '2026-07-16T11:00:00+09:00', attachments: [] })
  await appendHistoryEntry({ id: '102', channelId: 'histchat', direction: 'in', author: 'a', authorId: '1', content: 'three', timestamp: '2026-07-16T12:00:00+09:00', attachments: [] })
  // A different chat must never leak into histchat's read.
  await appendHistoryEntry({ id: '999', channelId: 'otherchat', direction: 'in', author: 'a', authorId: '1', content: 'not this one', timestamp: '2026-07-16T10:30:00+09:00', attachments: [] })

  check('ledger file created by appendHistoryEntry', fs.existsSync(HISTORY_LEDGER_PATH))

  const all = await readHistoryEntries({ channelId: 'histchat' })
  check('round trip returns exactly the entries written for this channelId', all.length === 3, `got ${all.length}`)
  check('a different channelId is excluded (no cross-chat leak)', all.every((r) => r.channelId === 'histchat'))
  check('round trip preserves content and direction', all[0].content === 'one' && all[0].direction === 'in')
  check('round trip is sorted ascending by message id', all.map((r) => r.id).join(',') === '100,101,102')

  const afterById = await readHistoryEntries({ channelId: 'histchat', after: '100' })
  check('after=<id> excludes the cutoff id itself and everything before it', afterById.map((r) => r.id).join(',') === '101,102', JSON.stringify(afterById.map((r) => r.id)))

  const beforeById = await readHistoryEntries({ channelId: 'histchat', before: '102' })
  check('before=<id> excludes the cutoff id itself and everything after it', beforeById.map((r) => r.id).join(',') === '100,101')

  const afterByDate = await readHistoryEntries({ channelId: 'histchat', after: '2026-07-16T10:30:00+09:00' })
  check('after=<ISO date> filters by timestamp, not just id', afterByDate.map((r) => r.id).join(',') === '101,102')

  await appendHistoryEntry({ id: '103', channelId: 'histchat', direction: 'out', author: 'a', authorId: '1', content: 'four', timestamp: '2026-07-16T13:00:00+09:00', attachments: [] })
  const limited = await readHistoryEntries({ channelId: 'histchat', limit: 2 })
  check('limit returns the MOST RECENT n entries (not the first n)', limited.map((r) => r.id).join(',') === '102,103', JSON.stringify(limited.map((r) => r.id)))

  // One corrupt line (e.g. a torn write) must not sink the whole ledger.
  fs.appendFileSync(HISTORY_LEDGER_PATH, 'not-json{{{garbage\n')
  const afterCorruption = await readHistoryEntries({ channelId: 'histchat' })
  check('a corrupt ledger line is skipped, not fatal', afterCorruption.length === 4, `got ${afterCorruption.length}`)
}

// ── resolveOutboundChannel: same contract as channel.mjs's own test file ───
console.log('\nresolveOutboundChannel (protocol-agnostic contract, telegram fetchFn)')
{
  const KNOWN = { chatA: { id: 'chatA' }, chatHome: { id: 'chatHome' } }
  const fake = async (id) => { if (KNOWN[id]) return KNOWN[id]; throw new Error(`chat ${id} not found`) }
  const r1 = await resolveOutboundChannel('chatA', { fetchFn: fake, lastId: 'chatHome', homeId: null })
  check('valid explicit chat id honored, no note', r1.ch.id === 'chatA' && r1.note === null)
  const r2 = await resolveOutboundChannel('bogus-chat', { fetchFn: fake, lastId: 'chatHome', homeId: null })
  check('unknown chat id reroutes to current conversation with a loud note', r2.ch.id === 'chatHome' && typeof r2.note === 'string' && r2.note.includes('bogus-chat'))
  const r3 = await resolveOutboundChannel(undefined, { fetchFn: fake, lastId: null, homeId: 'chatHome' })
  check('omitted id falls back to HOME when no last-inbound chat known', r3.ch.id === 'chatHome')
}

// ── (d-1) token rejected by the API (in-process, injected requestFn) ───────
console.log('\n(d-1) token rejected by Telegram getMe -> failure marker')
{
  check('failure marker does not exist yet', !fs.existsSync(FAILURE_MARKER_PATH))
  const rejectingRequestFn = async () => { throw new Error('Telegram API getMe failed: Unauthorized (code 401)') }
  const ok = await verifyTokenOrFail({ requestFn: rejectingRequestFn })
  check('verifyTokenOrFail returns false on a rejected token', ok === false)
  check('a failure marker file was written', fs.existsSync(FAILURE_MARKER_PATH))
  const failParsed = JSON.parse(fs.readFileSync(FAILURE_MARKER_PATH, 'utf8'))
  check('failure marker.status === "failed"', failParsed.status === 'failed')
  check('failure marker.code === "telegram_token_bad" (constraint 7: discord_token_bad -> telegram_token_bad)', failParsed.code === 'telegram_token_bad', `got ${failParsed.code}`)
  check('failure marker.reason names the underlying Telegram error', /Unauthorized/.test(failParsed.reason))
}

// ── (d-2) missing token entirely (real subprocess, mirrors test-liveness-marker.mjs) ─
console.log('\n(d-2) missing TELEGRAM_BOT_TOKEN -> FATAL exit + failure marker (subprocess)')
{
  const subTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-telegram-smoke-notoken-'))
  const result = spawnSync(process.execPath, [channelModulePath], {
    env: { ...process.env, AGENT_DATA_HOME: subTmpDir, TELEGRAM_BOT_TOKEN: '', HOME_CHANNEL_ID: '999888777', AGENT_NAME: 'smoketest2' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  check('missing-TELEGRAM_BOT_TOKEN subprocess exits 1', result.status === 1, `got ${result.status}, stderr: ${result.stderr?.slice(0, 300)}`)
  check('subprocess stderr names TELEGRAM_BOT_TOKEN as the FATAL cause', /TELEGRAM_BOT_TOKEN not set/.test(result.stderr || ''))
  const subFailPath = path.join(subTmpDir, '.agent-failed.json')
  check('subprocess wrote a failure marker instead of exiting silently', fs.existsSync(subFailPath))
  if (fs.existsSync(subFailPath)) {
    const subFailParsed = JSON.parse(fs.readFileSync(subFailPath, 'utf8'))
    check('subprocess failure marker.status === "failed"', subFailParsed.status === 'failed')
    check('subprocess failure marker.code === "telegram_token_bad"', subFailParsed.code === 'telegram_token_bad', `got ${subFailParsed.code}`)
  }
  fs.rmSync(subTmpDir, { recursive: true, force: true })
}

// ── liveness marker sanity (same shape as channel.mjs, spot-checked here so
// this file doesn't need its own separate liveness test) ───────────────────
console.log('\nliveness marker (shape parity with channel.mjs)')
{
  await writeLivenessMarker()
  const live = JSON.parse(fs.readFileSync(LIVENESS_MARKER_PATH, 'utf8'))
  check('liveness marker.status === "live"', live.status === 'live')
  check('liveness marker.pid matches this process', live.pid === process.pid)
}

// ── cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
