#!/usr/bin/env node
// channel-slack.mjs — Slack Socket Mode counterpart to channel.mjs (the
// Discord MCP channel server). Same agent, same three tools, same on-disk
// contracts (liveness marker, failure marker, boot-announce, DATA_HOME) —
// only the wire transport changes. Every mechanism below was pulled from a
// full read of channel.mjs (not guessed); see the comment on each block for
// which Discord mechanism it mirrors and where it necessarily diverges
// because Slack's API shape differs from discord.js's.
//
// Flow:
//   Slack message (home channel) -> MCP notification -> Claude Code
//   Claude "reply"/"send_file_to_discord"/"read_channel_history" tool call
//   -> @slack/web-api -> Slack
//
// Transport: Slack Socket Mode (@slack/socket-mode) for inbound events,
// @slack/web-api's WebClient for every outbound call (chat.postMessage,
// files.uploadV2, conversations.history, conversations.info, users.info,
// auth.test). No other Slack/HTTP dependency is used (hard constraint #2).

import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// autonomy/cadence *.cjs are CommonJS on purpose (see channel.mjs's own
// comment on this same line) -- one implementation, two callers (this file
// and onboarding/http-server.cjs), no second copy of the math.
const require = createRequire(import.meta.url)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ── stdout hygiene ─────────────────────────────────────────────────────────
// Identical to channel.mjs: MCP stdio transport reserves stdout exclusively
// for JSON-RPC (hard constraint #7). Every console method is rerouted to
// stderr before anything else runs, verbatim mechanism.
function safeJson(v) { try { return JSON.stringify(v) } catch { return String(v) } }
for (const [method, prefix] of [['log', ''], ['info', ''], ['debug', ''], ['warn', '[WARN] '], ['error', '[ERR] ']]) {
  console[method] = (...args) => {
    process.stderr.write(`${prefix}${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}\n`)
  }
}
const log = (...args) => console.log(...args)

// ── config (hard constraint #3) ─────────────────────────────────────────────
// channel.mjs has ONE token (DISCORD_BOT_TOKEN); Slack Socket Mode needs TWO
// (a bot token for Web API calls, an app-level token for the WS handshake).
// dotenv load is the same mechanism ('dotenv/config' side-effect import,
// line 1) -- .env / .mcp.json env block, same as channel.mjs.
const AGENT_NAME = process.env.AGENT_NAME || 'agent'
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
const HOME_CHANNEL_ID = process.env.HOME_CHANNEL_ID

// ── DATA_HOME (identical resolution to channel.mjs) ─────────────────────────
// Same formula, same env var, keyed by AGENT_NAME -- see channel.mjs's own
// long comment on this line for why (run.sh's MEM= resolution has to agree).
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', AGENT_NAME)

// ── liveness + failure markers (same paths/shape as channel.mjs) ───────────
// Hard constraint #5: marker path/JSON form identical to channel.mjs. Same
// filenames on purpose -- these two channel backends are not meant to run
// concurrently for the same AGENT_NAME/DATA_HOME (Discord OR Slack is wired
// via .mcp.json, not both), so sharing the marker files is the same contract
// main.cjs's poller already reads, regardless of which transport is live.
const LIVENESS_MARKER_PATH = path.join(DATA_HOME, '.agent-live')
const LIVENESS_HEARTBEAT_MS = 60_000
const FAILURE_MARKER_PATH = path.join(DATA_HOME, '.agent-failed.json')

async function atomicWriteJson(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n')
  await fs.rename(tmpPath, filePath)
}

async function writeLivenessMarker() {
  const payload = { status: 'live', lastHeartbeat: new Date().toISOString(), pid: process.pid }
  await atomicWriteJson(LIVENESS_MARKER_PATH, payload)
}

// `extra` (Slack-specific addition, hard constraint #5): channel.mjs has one
// token so 'discord_token_bad' never needs to say WHICH token. Slack has two
// (bot xoxb / app xapp) that fail through completely different code paths
// (auth.test vs Socket Mode's apps.connections.open), so the marker needs a
// discriminator. Base shape (status/reason/code/since/pid) is unchanged --
// `extra` only ever adds a `token: 'bot' | 'app'` field on top of it.
async function writeFailureMarker(reason, code = 'unknown', extra = {}) {
  const payload = { status: 'failed', reason, code, since: new Date().toISOString(), pid: process.pid, ...extra }
  await atomicWriteJson(FAILURE_MARKER_PATH, payload)
}

if (!SLACK_BOT_TOKEN) {
  const reason = 'SLACK_BOT_TOKEN not set. Check .env (or the .mcp.json env block).'
  process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
  await writeFailureMarker(reason, 'slack_token_bad', { token: 'bot' }).catch((err) =>
    process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${err.message}\n`)
  )
  process.exit(1)
}
if (!SLACK_APP_TOKEN) {
  const reason = 'SLACK_APP_TOKEN not set. Check .env (or the .mcp.json env block).'
  process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
  await writeFailureMarker(reason, 'slack_token_bad', { token: 'app' }).catch((err) =>
    process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${err.message}\n`)
  )
  process.exit(1)
}
if (!HOME_CHANNEL_ID) {
  const reason = 'HOME_CHANNEL_ID not set. Check .env (or the .mcp.json env block).'
  process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
  // Not a token problem -- same 'unknown' default channel.mjs uses for its
  // own missing-HOME_CHANNEL_ID guard.
  await writeFailureMarker(reason).catch((err) =>
    process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${err.message}\n`)
  )
  process.exit(1)
}

// ── Local-time timestamps (verbatim from channel.mjs — generic, not
// Discord-specific) ─────────────────────────────────────────────────────────
function localISO(ms = Date.now()) {
  const d = new Date(ms)
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  const hh = String(Math.trunc(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return new Date(ms + offMin * 60_000).toISOString().replace('Z', `${sign}${hh}:${mm}`)
}
function localWeekday(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(ms))
}
const localNow = () => `${localISO()} (${localWeekday()})`

// ── Slack ts <-> ISO date (Slack analog of channel.mjs's toSnowflake) ──────
// Discord's before/after take a snowflake (encodes a timestamp); Slack's
// conversations.history takes `oldest`/`latest` as ts strings
// ("1234567890.123456"). If the input is already a Slack ts, pass it through;
// otherwise treat it as an ISO date and convert.
function toSlackTs(v) {
  if (!v) return undefined
  if (/^\d+\.\d+$/.test(v)) return v
  const ms = Date.parse(v)
  if (Number.isNaN(ms)) return undefined
  return (ms / 1000).toFixed(6)
}

// ── Slack clients ────────────────────────────────────────────────────────
// WebClient = every outbound call (chat.postMessage, files.uploadV2,
// conversations.history/info, users.info, auth.test). SocketModeClient =
// inbound events only, authenticated with the APP token (xapp) -- it opens
// its own internal WebClient with that token purely to call
// apps.connections.open for the WS handshake URL.
const slackWeb = new WebClient(SLACK_BOT_TOKEN)
const socketModeClient = new SocketModeClient({ appToken: SLACK_APP_TOKEN })

async function fetchSlackChannel(channelId, opts = {}) {
  const wc = opts.webClient || slackWeb
  const resp = await wc.conversations.info({ channel: channelId })
  if (!resp?.ok || !resp.channel) throw new Error(`channel ${channelId} not found or not accessible`)
  return resp.channel
}

// ── Current-conversation channel tracking (same mechanism as channel.mjs's
// 2026-07-15 GLM confabulation fix) ─────────────────────────────────────────
let lastInboundChannelId = null

// ── Persisted last-conversation channel (same mechanism as channel.mjs
// v0.0.17) ───────────────────────────────────────────────────────────────
const LAST_CHANNEL_PATH = path.join(DATA_HOME, '.last-channel')
let persistedLastChannelId = null
function persistLastChannel(channelId) {
  if (!channelId || channelId === persistedLastChannelId) return
  persistedLastChannelId = channelId
  fs.writeFile(LAST_CHANNEL_PATH, channelId).catch((err) => log(`last-channel persist failed: ${err.message}`))
}

// ── Conversation activity clock (same mechanism as channel.mjs v0.0.16) ────
let lastActivityMs = Date.now()

// Same contract as channel.mjs's resolveOutboundChannel: an explicit
// requestedId is honored if reachable and FAILS CLOSED if not (nogabi #7 --
// an explicit destination the caller supplied is never silently swapped);
// an omitted id resolves to the current conversation channel. opts are the same test seam shape (fetchFn/
// lastId/homeId) as channel.mjs's own scripts/test-outbound-channel.mjs.
const GUIDANCE =
  'Do not invent channel ids -- omit channelId to target the current conversation, then call the tool again.'

async function resolveOutboundChannel(requestedId, opts = {}) {
  const fetchFn = opts.fetchFn || fetchSlackChannel
  const lastId = 'lastId' in opts ? opts.lastId : lastInboundChannelId
  const homeId = 'homeId' in opts ? opts.homeId : HOME_CHANNEL_ID
  const fallbackId = lastId || homeId || null
  if (requestedId) {
    try {
      const ch = await fetchFn(requestedId)
      return { channelId: ch.id || requestedId, note: null }
    } catch (err) {
      // FAIL CLOSED on an explicit destination (nogabi issue #7). See the same
      // block in channel.mjs for why the 2026-07-15 reroute is being reversed:
      // its problem was visibility, and visibility comes back through the tool's
      // isError result, not through delivering the payload to another channel.
      const e = new Error(
        `channelId ${requestedId} could not be resolved (${err.message}). Nothing was sent. ${GUIDANCE}`
      )
      e.code = 'OUTBOUND_TARGET_INVALID'
      throw e
    }
  }
  if (!fallbackId) throw new Error('no channelId given and no current conversation channel known yet')
  const ch = await fetchFn(fallbackId)
  return { channelId: ch.id || fallbackId, note: null }
}

// ── User display-name resolution (hard constraint #8) ───────────────────────
// Discord gets a display name for free off the gateway message object
// (message.member?.displayName || message.author.username). Slack's message
// event only carries a user ID; resolving to a human name needs an explicit
// users.info call. Cached by user id so a chatty channel doesn't re-resolve
// the same person on every message.
const userNameCache = new Map()
async function resolveSenderName(userId, opts = {}) {
  if (!userId) return 'unknown'
  if (userNameCache.has(userId)) return userNameCache.get(userId)
  const usersInfo = opts.usersInfo || ((args) => slackWeb.users.info(args))
  try {
    const resp = await usersInfo({ user: userId })
    const name = resp?.user?.profile?.display_name || resp?.user?.real_name || resp?.user?.name || userId
    userNameCache.set(userId, name)
    return name
  } catch (err) {
    log(`users.info resolution failed for ${userId}: ${err.message}`)
    return userId // fail toward SOMETHING visible, never throw the inbound message away over a name lookup
  }
}

// ── MCP server ───────────────────────────────────────────────────────────
// Hard constraint #1: tool names/schemas byte-for-byte identical to
// channel.mjs, including keeping the Discord-named "send_file_to_discord" --
// allowlists/hooks match on the exact name. Only descriptions change to
// describe Slack reality.
const DEFAULT_INSTRUCTIONS = `You are ${AGENT_NAME}.
Slack messages arrive as: <channel source="${AGENT_NAME}" sender="..." channelId="..." authorId="..." timestamp="...">content</channel>
Reply with the "reply" tool. channelId is optional -- omit it and the message goes to the current conversation channel. Never invent a channelId; only pass one when replying to a DIFFERENT channel than the one that messaged you. A channelId you DO pass is honored exactly or the call fails: an unresolvable one sends nothing anywhere, it is never quietly redirected.
Use "send_file_to_discord" (filePath, comment?, channelId?) to upload a local file (image, document, etc.) to Slack -- "reply" is text-only.
Use "read_channel_history" (channelId, limit, after?, before?) to look back through the Slack channel. after/before each accept a Slack message ts or an ISO date.`
const INSTRUCTIONS = process.env.CHANNEL_INSTRUCTIONS || DEFAULT_INSTRUCTIONS

const mcp = new Server(
  { name: AGENT_NAME, version: '1.0.0' },
  { capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} }, instructions: INSTRUCTIONS },
)

const TOOLS = [
  {
    name: 'reply',
    description: 'Send a message to the user on Slack. Goes to the current conversation channel unless a channelId is explicitly given.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send' },
        channelId: { type: 'string', description: 'OPTIONAL Slack channel ID. Omit to send to the current conversation channel. Never guess or invent this value.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'send_file_to_discord',
    description: 'Upload a local file (image, document, etc.) to Slack. Use this for attachments -- the reply tool is text-only. Goes to the current conversation channel unless a channelId is explicitly given.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Full local path of the file to upload' },
        comment: { type: 'string', description: 'Optional message text sent with the file' },
        channelId: { type: 'string', description: 'OPTIONAL Slack channel ID. Omit to send to the current conversation channel. Never guess or invent this value.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'read_channel_history',
    description: 'Read recent message history from a Slack channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack channel ID' },
        limit: { type: 'number', description: 'Number of messages to return (default 50, max 100)' },
        after: { type: 'string', description: 'Only messages after this point -- Slack message ts or an ISO date' },
        before: { type: 'string', description: 'Only messages before this point -- Slack message ts or an ISO date' },
      },
      required: ['channelId'],
    },
  },
]

const ReplyArgs = z.object({ channelId: z.string().min(1).optional(), text: z.string().min(1) })
const SendFileArgs = z.object({ channelId: z.string().min(1).optional(), filePath: z.string().min(1), comment: z.string().optional() })
const ReadHistoryArgs = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
})

// ── Outbound chunking (hard constraint #4: 4000-char budget) ────────────────
// channel.mjs splits at 1900 (Discord's own 2000-char message cap, safety
// margined). Slack's cap is much higher, but the task fixes the budget at
// 4000 explicitly rather than deriving it from Slack's limit -- same
// mechanism (slice loop, no per-chunk tag, just a trailing "(N messages)"
// count in the tool result), different literal size.
const REPLY_CHUNK_SIZE = 4000
function chunkText(text, size = REPLY_CHUNK_SIZE) {
  const chunks = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

// opts.postMessage / opts.fetchFn / opts.lastId / opts.homeId are test seams
// (scripts/test-slack-channel.mjs) -- production call sites pass only the
// tool args and get live module state + the real WebClient.
async function sendReply({ channelId, text }, opts = {}) {
  const post = opts.postMessage || ((args) => slackWeb.chat.postMessage(args))
  const { channelId: targetId, note } = await resolveOutboundChannel(channelId, opts)
  const chunks = chunkText(text)
  for (const chunk of chunks) await post({ channel: targetId, text: chunk })
  lastActivityMs = Date.now() // delivered reply = live conversation (mirrors channel.mjs)
  // delivered_channel= line: same machine-readable delivery receipt
  // convention as channel.mjs (stop-reply-guard greps this exact token).
  return `sent to ${targetId} (${chunks.length} message${chunks.length > 1 ? 's' : ''})${note ? `\n${note}` : ''}\ndelivered_channel=${targetId}`
}

async function sendFile({ channelId, filePath, comment }, opts = {}) {
  const upload = opts.uploadFile || ((args) => slackWeb.files.uploadV2(args))
  const fsMod = opts.fs || fs
  const resolvedPath = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath
  try {
    await fsMod.stat(resolvedPath)
  } catch {
    return { isError: true, text: `file not found: ${resolvedPath}` }
  }
  const { channelId: targetId, note } = await resolveOutboundChannel(channelId, opts)
  const result = await upload({ channel_id: targetId, file: resolvedPath, filename: path.basename(resolvedPath), initial_comment: comment || '' })
  const urls = (result?.files || []).map((f) => f.permalink || f.url_private).filter(Boolean)
  return { isError: false, text: `file sent to ${targetId}: ${path.basename(resolvedPath)}${urls.length ? `\nURL: ${urls.join('\n')}` : ''}${note ? `\n${note}` : ''}\ndelivered_channel=${targetId}` }
}

async function readHistory({ channelId, limit, after, before }, opts = {}) {
  const historyFn = opts.history || ((args) => slackWeb.conversations.history(args))
  const resolveSender = opts.resolveSender || resolveSenderName
  const fetchOpts = { channel: channelId, limit: limit || 50 }
  const afterTs = toSlackTs(after)
  const beforeTs = toSlackTs(before)
  if (afterTs) fetchOpts.oldest = afterTs
  if (beforeTs) fetchOpts.latest = beforeTs
  const resp = await historyFn(fetchOpts)
  const msgs = [...(resp?.messages || [])].sort((a, b) => Number(a.ts) - Number(b.ts))
  const result = []
  for (const m of msgs) {
    const authorId = m.user || m.bot_id || ''
    const author = m.user ? await resolveSender(m.user, opts) : (m.username || m.bot_id || 'unknown')
    result.push({
      id: m.ts,
      author,
      authorId,
      content: m.text || '',
      timestamp: localISO(Math.round(Number(m.ts) * 1000)),
      attachments: (m.files || []).map((f) => f.url_private).filter(Boolean),
    })
  }
  return { channelId, count: result.length, messages: result }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === 'reply') {
    const { channelId, text } = ReplyArgs.parse(args || {})
    const resultText = await sendReply({ channelId, text })
    return { content: [{ type: 'text', text: resultText }] }
  }

  if (name === 'send_file_to_discord') {
    const parsed = SendFileArgs.parse(args || {})
    const r = await sendFile(parsed)
    return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) }
  }

  if (name === 'read_channel_history') {
    const parsed = ReadHistoryArgs.parse(args || {})
    const r = await readHistory(parsed)
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

// ── Bot-echo / non-message-event filtering (hard constraint #2) ────────────
function isBotEvent(event) {
  return Boolean(event?.bot_id) || event?.subtype === 'bot_message'
}
// Slack's events_api 'message' type also fires for edits/deletes/joins/etc.
// via `subtype` (message_changed, message_deleted, channel_join, ...).
// Discord has no analog -- message.author.bot is discord.js's only such
// gate -- because those are different Discord gateway event types entirely.
// None of those subtypes carry a fresh human message in the top-level
// text/user fields, so they're ignored the same way bot echoes are.
function isIgnorableSubtype(event) {
  return Boolean(event?.subtype) && event.subtype !== 'bot_message'
}

// ── Inbound message injection (the <channel source=...> tag mechanism) ─────
// Mirrors channel.mjs's Events.MessageCreate handler: resolve sender name,
// track current-conversation state, then hand {content, meta} to
// mcp.notification -- the MCP client wraps this into the
// <channel source="AGENT_NAME" sender=... channelId=... authorId=...
// timestamp=...>content</channel> tag described in DEFAULT_INSTRUCTIONS
// above. meta field names are IDENTICAL to channel.mjs's (sender/channelId/
// authorId/timestamp) since that tag format is a property of the MCP client,
// not of Discord or Slack.
async function handleInboundMessage(event, opts = {}) {
  const notify = opts.notify || ((params) => mcp.notification({ method: 'notifications/claude/channel', params }))
  const resolveSender = opts.resolveSender || resolveSenderName

  if (isBotEvent(event) || isIgnorableSubtype(event)) return { skipped: true, reason: 'bot_or_subtype' }
  // Hard constraint #2: home-channel message events only -- unlike
  // channel.mjs, which also accepts any DM channel, the Slack backend is
  // scoped to the single home channel per the task's explicit spec.
  if (event.channel !== HOME_CHANNEL_ID) return { skipped: true, reason: 'not_home_channel' }

  lastInboundChannelId = event.channel
  persistLastChannel(event.channel)
  lastActivityMs = Date.now()

  const sender = await resolveSender(event.user, opts)
  const text = (event.text || '').trim()
  const content = text ? text : '[empty message]'
  const meta = { sender, channelId: event.channel, authorId: event.user || event.bot_id || '', timestamp: localNow() }

  await notify({ content, meta })
  return { content, meta }
}

socketModeClient.on('message', async ({ event, ack }) => {
  try {
    await ack()
  } catch (err) {
    log('socket mode ack failed:', err.message)
  }
  try {
    await handleInboundMessage(event)
  } catch (err) {
    log('message handler error:', err.message)
  }
})

// ── Liveness heartbeat gated on ACTUAL connection state (hard constraint #6)
// ────────────────────────────────────────────────────────────────────────
// channel.mjs trusts discord.js's own resume handling and just writes on a
// bare interval once ClientReady has fired once -- Discord's gateway resumes
// silently under the hood, so "ready fired" stays true for the process's
// life in practice. Socket Mode surfaces reconnects as explicit state
// events, and the task is explicit: a disconnect that has not yet recovered
// must NOT keep refreshing the marker (that is a marker lying about being
// alive, the worst failure mode named in the ask). This is a pure state
// machine with no IO, so it can be unit tested without real timers/sockets.
function createLivenessGate() {
  let ready = false
  return {
    onConnected: () => { ready = true },
    onDisconnected: () => { ready = false },
    onReconnecting: () => { ready = false },
    shouldWrite: () => ready,
  }
}
const livenessGate = createLivenessGate()

let heartbeatStarted = false
function startLivenessHeartbeatOnce() {
  if (heartbeatStarted) return
  heartbeatStarted = true
  // .unref() -- same reasoning as channel.mjs: this heartbeat must never be
  // the reason the process stays alive.
  setInterval(() => {
    if (!livenessGate.shouldWrite()) {
      log('liveness heartbeat skipped -- Socket Mode not connected')
      return
    }
    writeLivenessMarker().catch((err) => log(`liveness heartbeat write failed: ${err.message}`))
  }, LIVENESS_HEARTBEAT_MS).unref()
}

socketModeClient.on('connected', () => {
  log(`Slack Socket Mode connected (${AGENT_NAME})`)
  livenessGate.onConnected()
  writeLivenessMarker().catch((err) => log(`liveness marker write failed: ${err.message}`))
  startLivenessHeartbeatOnce()
  announceBoot().catch((err) => log(`boot announce failed: ${err.message}`))
})
socketModeClient.on('disconnected', () => {
  log('Slack Socket Mode disconnected')
  livenessGate.onDisconnected()
})
socketModeClient.on('reconnecting', () => {
  log('Slack Socket Mode reconnecting')
  livenessGate.onReconnecting()
})

// ── Boot ping (same mechanism as channel.mjs v0.0.16 / cadence/boot-announce
// .cjs) ─────────────────────────────────────────────────────────────────
// Reuses the exact same pure rule module and the exact same marker files
// (BOOT_EVENT_PATH consumed on read, BOOT_ANNOUNCE_TS_PATH as the persistent
// throttle) -- only the IO (channel fetch + send) is Slack instead of
// Discord.
const BOOT_EVENT_PATH = path.join(DATA_HOME, '.boot-event.json')
const BOOT_ANNOUNCE_TS_PATH = path.join(DATA_HOME, '.boot-announce-ts.json')

async function readAgentConfigFile() {
  const out = {}
  let text
  try {
    text = await fs.readFile(path.join(DATA_HOME, '.agent-config'), 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

async function announceBoot() {
  let ev = null
  try {
    ev = JSON.parse(await fs.readFile(BOOT_EVENT_PATH, 'utf8'))
  } catch {
    return // no marker: manual `node channel-slack.mjs` dev run, or supervisor didn't write one
  }
  await fs.unlink(BOOT_EVENT_PATH).catch(() => {})

  const bootTick = require(path.join(MODULE_DIR, 'cadence', 'boot-announce.cjs'))
  const config = await readAgentConfigFile()
  let lastAnnounceMs = 0
  try {
    lastAnnounceMs = JSON.parse(await fs.readFile(BOOT_ANNOUNCE_TS_PATH, 'utf8')).lastAnnounceMs || 0
  } catch {}

  const plan = bootTick.planBootAnnounce({ now: Date.now(), event: ev, lastAnnounceMs, config })
  if (plan.skip) {
    log(`boot announce skipped (${plan.reason})`)
    return
  }

  // HOME first, then the persisted last conversation channel -- same
  // fallback order as channel.mjs v0.0.17 (a DM-only/home-deleted install
  // would otherwise have nowhere for the boot ping to land).
  let announceChannelId = null
  try {
    await fetchSlackChannel(HOME_CHANNEL_ID)
    announceChannelId = HOME_CHANNEL_ID
  } catch (homeErr) {
    let lastId = null
    try {
      lastId = (await fs.readFile(LAST_CHANNEL_PATH, 'utf8')).trim()
    } catch {}
    if (lastId && lastId !== HOME_CHANNEL_ID) {
      try {
        await fetchSlackChannel(lastId)
        announceChannelId = lastId
        log(`boot announce: home channel unreachable (${homeErr.message}), using persisted last channel ${lastId}`)
      } catch {}
    }
    if (!announceChannelId) {
      log(`boot announce: no reachable channel (home: ${homeErr.message}; persisted last: ${lastId || 'none'}) -- aborting unit, next restart retries`)
      return
    }
  }
  try {
    await slackWeb.chat.postMessage({ channel: announceChannelId, text: `🔁 [system] 에이전트 세션 ${plan.label} — ${localNow()}` })
  } catch (err) {
    log(`boot announce direct send failed -- aborting this announce unit, next restart retries: ${err.message}`)
    return
  }
  await atomicWriteJson(BOOT_ANNOUNCE_TS_PATH, { lastAnnounceMs: plan.nextLastAnnounceMs }).catch((err) =>
    log(`boot-announce ts write failed (worst case one extra ping next restart): ${err.message}`)
  )
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content:
          `[SYSTEM] 방금 세션이 ${plan.iteration > 1 ? '재시작됐다 (오늘 이 감독 아래 ' + plan.iteration + '번째)' : '시작됐다'}. ` +
          '방금 그 채널에 네 목소리로 짧게 부팅 인사를 남겨라 -- 살아있다는 신호가 목적이니 한두 문장이면 된다. ' +
          '체크포인트에 이어받을 일이 있으면 뭘 이어가는지 한 줄 붙여. ' +
          '그리고 이 세션 내내 지킬 것: 작업 블록에 들어가기 전에 "뭘 시작한다 + 어느 정도 걸릴 것 같다"를 먼저 한 줄로 알리고 시작해라.',
        meta: { sender: 'SYSTEM', channelId: announceChannelId, authorId: '', timestamp: localNow() },
      },
    })
  } catch (err) {
    log(`boot greeting inject failed (direct line already sent): ${err.message}`)
  }
}

// ── Token validation (hard constraint #5: distinguish bot vs app token) ────
// Split into two functions so a test can attack each independently with an
// injected fake client and read back which `token` value landed in the
// failure marker.
async function validateBotToken(opts = {}) {
  const wc = opts.webClient || slackWeb
  try {
    await wc.auth.test()
    return { ok: true }
  } catch (err) {
    const reason = `auth.test failed: ${err.message}`
    await writeFailureMarker(reason, 'slack_token_bad', { token: 'bot' }).catch((markerErr) =>
      process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${markerErr.message}\n`)
    )
    return { ok: false, reason, token: 'bot' }
  }
}
async function validateAppToken(opts = {}) {
  const sc = opts.socketModeClient || socketModeClient
  try {
    await sc.start()
    return { ok: true }
  } catch (err) {
    const reason = `socket mode start failed: ${err.message}`
    await writeFailureMarker(reason, 'slack_token_bad', { token: 'app' }).catch((markerErr) =>
      process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${markerErr.message}\n`)
    )
    return { ok: false, reason, token: 'app' }
  }
}

// ── boot ─────────────────────────────────────────────────────────────────
// Same "am I the entry point" guard as channel.mjs, for the same reason:
// scripts/test-slack-channel.mjs imports this file to exercise its exported
// functions without connecting real stdio/Socket Mode transport.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

async function boot() {
  await mcp.connect(new StdioServerTransport())
  log(`MCP server up (${AGENT_NAME})`)

  // Bot token checked first (auth.test is a plain REST call, fails fast on a
  // revoked/invalid xoxb) -- app token checked second via the actual Socket
  // Mode handshake (apps.connections.open under the hood).
  const botCheck = await validateBotToken()
  if (!botCheck.ok) {
    process.stderr.write(`[${AGENT_NAME}] FATAL: ${botCheck.reason}\n`)
    process.exit(1)
  }
  const appCheck = await validateAppToken()
  if (!appCheck.ok) {
    process.stderr.write(`[${AGENT_NAME}] FATAL: ${appCheck.reason}\n`)
    process.exit(1)
  }
}

export {
  writeLivenessMarker, LIVENESS_MARKER_PATH,
  writeFailureMarker, FAILURE_MARKER_PATH,
  DATA_HOME,
  resolveOutboundChannel,
  chunkText, REPLY_CHUNK_SIZE,
  handleInboundMessage, isBotEvent, isIgnorableSubtype,
  createLivenessGate,
  sendReply, sendFile, readHistory,
  toSlackTs,
  resolveSenderName,
  validateBotToken, validateAppToken,
}

if (isMainModule) {
  await boot()
}
