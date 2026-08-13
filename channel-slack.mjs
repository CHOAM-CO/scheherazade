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
import {
  installStdoutHygiene, resolveDataHome, localISO, localNow,
  createMarkerStore, createLastChannelStore, createOutboundResolver, createBootAnnouncer,
  createRoutineStore, ROUTINE_TOOL, handleRoutineTool, startRoutineTicker, routineInjectContent,
  createInboundNotifier, createOutboundDedup,
} from './channel-runtime.mjs'
// Always-on in-app chat (2026-08-05): hosted alongside Slack; import is
// side-effect-safe (isMainModule guard) -- full rationale in channel.mjs.
import {
  LOCAL_CHANNEL_ID, handleToolCall as handleLocalToolCall, startLocalChatSurface,
} from './channel-local.mjs'

// ── stdout hygiene (channel-runtime) ───────────────────────────────────────
// Installed before anything else runs -- MCP stdout is JSON-RPC only.
const log = installStdoutHygiene()

// ── config (hard constraint #3) ─────────────────────────────────────────────
// channel.mjs has ONE token (DISCORD_BOT_TOKEN); Slack Socket Mode needs TWO
// (a bot token for Web API calls, an app-level token for the WS handshake).
// dotenv load is the same mechanism ('dotenv/config' side-effect import,
// line 1) -- .env / .mcp.json env block, same as channel.mjs.
const AGENT_NAME = process.env.AGENT_NAME || 'agent'
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
const HOME_CHANNEL_ID = process.env.HOME_CHANNEL_ID

// ── DATA_HOME + markers (channel-runtime) ──────────────────────────────────
// Same marker files as every backend on purpose -- backends are not meant to
// run concurrently for the same AGENT_NAME/DATA_HOME (Discord OR Slack is
// wired via .mcp.json, not both), so the supervisor polls one contract
// regardless of which transport is live.
const DATA_HOME = resolveDataHome(AGENT_NAME)
const markers = createMarkerStore({ dataHome: DATA_HOME })
const routineStore = createRoutineStore({ dataHome: DATA_HOME, log: (...a) => log(...a) })
const { LIVENESS_MARKER_PATH, FAILURE_MARKER_PATH, LIVENESS_HEARTBEAT_MS } = markers
const writeLivenessMarker = () => markers.writeLiveness()

// `ext` (Slack-specific extension): channel.mjs has one token so
// 'discord_token_bad' never needs to say WHICH token. Slack has two (bot
// xoxb / app xapp) that fail through completely different code paths
// (auth.test vs Socket Mode's apps.connections.open), so the marker needs a
// discriminator. Per the marker store's extension rule it rides under
// `ext: { token: 'bot' | 'app' }` -- the base shape never grows new
// top-level fields.
const writeFailureMarker = (reason, code = 'unknown', ext = undefined) => markers.writeFailure(reason, code, ext)

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
// HOME_CHANNEL_ID is OPTIONAL since DM-default mode (2026-08-04, Mino "홈채널
// 방식 말고 DM 기본 방식으로 바꾸자"): with no home channel the conversation
// binds to whoever DMs the bot (message.im events; lastInboundChannelId +
// the persisted last-channel store carry the reply target from there). A
// configured home channel still works as an ADDITIONAL surface -- the gate
// in handleInboundMessage accepts home-channel messages AND DMs.
if (!HOME_CHANNEL_ID) {
  log('HOME_CHANNEL_ID not set -- DM-default mode: the conversation binds to whoever DMs the bot. (A home channel can still be connected later in Channels.)')
}

// Local-time timestamps (localISO/localNow) come from channel-runtime.mjs.

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

// ── Current-conversation channel tracking (channel.mjs parity) ─────────────
let lastInboundChannelId = null

// ── Persisted last-conversation channel (channel-runtime) ──────────────────
const lastChannelStore = createLastChannelStore({ dataHome: DATA_HOME, log })

// ── Conversation activity clock (channel.mjs parity) ───────────────────────
let lastActivityMs = Date.now()

// Outbound target resolution (channel-runtime): resolve() returns
// {target, note} where target is the Slack channel ID STRING -- the handle
// every Web API call takes. fetchSlackChannelId verifies reachability via
// conversations.info and hands back the id. Ladder, fail-closed semantics,
// and opts test seams (fetchFn/lastId/homeId) live in createOutboundResolver.
const GUIDANCE =
  'Do not invent channel ids -- omit channelId to target the current conversation, then call the tool again.'

async function fetchSlackChannelId(channelId) {
  const ch = await fetchSlackChannel(channelId)
  return ch.id || channelId
}

const resolveOutboundChannel = createOutboundResolver({
  fetchTarget: fetchSlackChannelId,
  getLastInboundId: () => lastInboundChannelId,
  homeId: HOME_CHANNEL_ID,
  guidance: GUIDANCE,
})

// GPT-loop guard (2026-08-04, Mino field report) -- see createOutboundDedup.
const checkOutboundDup = createOutboundDedup({ log })

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
Slack messages arrive as: <channel source="${AGENT_NAME}" sender="..." channelId="..." authorId="..." timestamp="..." messageTs="..." threadTs="...">content</channel> (messageTs = that message's raw Slack ts; threadTs present only when the message is inside a thread)
Reply with the "reply" tool. channelId is optional -- omit it and the message goes to the current conversation channel. Never invent a channelId; only pass one when replying to a DIFFERENT channel than the one that messaged you. A channelId you DO pass is honored exactly or the call fails: an unresolvable one sends nothing anywhere, it is never quietly redirected.
Threading: inbound Slack messages carry messageTs (and threadTs when the message is already inside a thread). To reply in a thread under the message that called you, pass thread_ts = that message's threadTs if present, else its messageTs. When someone talks to you INSIDE a thread, always reply into that thread (thread_ts = threadTs) -- answering a thread at top level strands the conversation. Never invent a thread_ts.
Use "send_file_to_discord" (filePath, comment?, channelId?) to upload a local file (image, document, etc.) to Slack -- "reply" is text-only.
Use "read_channel_history" (channelId, limit, after?, before?, thread_ts?) to look back through the Slack channel. after/before each accept a Slack message ts or an ISO date. Channel reads return only TOP-LEVEL messages -- thread replies never appear in them. To read a thread (parent + all replies), pass thread_ts; when someone talks to you inside a thread, read that thread FIRST (thread_ts = the inbound threadTs) so you see the conversation you are joining.
The app's own chat window is ALSO always connected: its messages arrive with channelId="in-app". Reply to those with channelId "in-app" exactly -- never route an in-app conversation to a Slack channel or vice versa. The "react" tool (one emoji on the user's bubble) works only for the in-app window.`
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
        thread_ts: { type: 'string', description: 'OPTIONAL Slack thread parent ts (e.g. "1786414183.323289"). Pass the inbound message\'s threadTs (if present) or messageTs to reply in a thread under that message. Omit for a top-level channel message. Never invent this value.' },
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
        thread_ts: { type: 'string', description: 'OPTIONAL Slack thread parent ts. Same semantics as the reply tool -- upload lands in that thread.' },
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
        thread_ts: { type: 'string', description: 'OPTIONAL thread parent ts. Pass it to read a THREAD (parent + all replies) -- without it you get only the channel\'s top-level messages, never thread replies. When called inside a thread, pass the inbound threadTs here to see the earlier conversation.' },
      },
      required: ['channelId'],
    },
  },
  {
    // In-app-only (the local chat surface this backend hosts) -- see
    // channel.mjs's twin definition.
    name: 'react',
    description: "Attach one emoji to the user's message bubble in the app's chat window (in-app conversations only). Use it when acknowledgment needs no words.",
    inputSchema: {
      type: 'object',
      properties: {
        emoji: { type: 'string', description: 'A single emoji, e.g. 👍 or ❤️' },
        targetSeq: { type: 'number', description: "OPTIONAL transcript seq of the message to react to (visible in read_channel_history with channelId 'in-app'). Defaults to the user's latest in-app message." },
        channelId: { type: 'string', description: 'OPTIONAL; only "in-app" is valid here.' },
      },
      required: ['emoji'],
    },
  },
  ROUTINE_TOOL,
]

// Local-surface routing, twin of channel.mjs's: deterministic on the "in-app"
// channelId; react has no other valid surface.
const LOCAL_ROUTED_TOOLS = new Set(['reply', 'send_file_to_discord', 'read_channel_history', 'react'])
function isLocalCall(name, args) {
  if (!LOCAL_ROUTED_TOOLS.has(name)) return false
  if (name === 'react') return true
  return Boolean(args && args.channelId === LOCAL_CHANNEL_ID)
}

// thread_ts: Slack ts format only ("1786414183.323289"). Validated here so a
// hallucinated/ISO value fails loud at the tool boundary with a message that
// names the fix, instead of surfacing as a raw Slack API error (or worse,
// whatever Slack's lenient parsing decides it means).
const SLACK_TS_RE = /^\d{10}\.\d{6}$/
const threadTsField = z.string().regex(SLACK_TS_RE, 'thread_ts must be a Slack message ts like "1786414183.323289"').optional()
const ReplyArgs = z.object({ channelId: z.string().min(1).optional(), text: z.string().min(1), thread_ts: threadTsField })
const SendFileArgs = z.object({ channelId: z.string().min(1).optional(), filePath: z.string().min(1), comment: z.string().optional(), thread_ts: threadTsField })
const ReadHistoryArgs = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  thread_ts: threadTsField,
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
async function sendReply({ channelId, text, thread_ts: threadTs }, opts = {}) {
  const post = opts.postMessage || ((args) => slackWeb.chat.postMessage(args))
  const { target: targetId, note } = await resolveOutboundChannel(channelId, opts)
  const chunks = chunkText(text)
  // threadTs: every chunk goes to the same thread -- a multi-chunk reply
  // must not straddle thread and top-level.
  for (const chunk of chunks) await post({ channel: targetId, text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) })
  lastActivityMs = Date.now() // delivered reply = live conversation (mirrors channel.mjs)
  // delivered_channel= line: same machine-readable delivery receipt
  // convention as channel.mjs (stop-reply-guard greps this exact token).
  return `sent to ${targetId}${threadTs ? ` (thread ${threadTs})` : ''} (${chunks.length} message${chunks.length > 1 ? 's' : ''})${note ? `\n${note}` : ''}\ndelivered_channel=${targetId}`
}

async function sendFile({ channelId, filePath, comment, thread_ts: threadTs }, opts = {}) {
  const upload = opts.uploadFile || ((args) => slackWeb.files.uploadV2(args))
  const fsMod = opts.fs || fs
  const resolvedPath = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath
  try {
    await fsMod.stat(resolvedPath)
  } catch {
    return { isError: true, text: `file not found: ${resolvedPath}` }
  }
  const { target: targetId, note } = await resolveOutboundChannel(channelId, opts)
  const result = await upload({ channel_id: targetId, file: resolvedPath, filename: path.basename(resolvedPath), initial_comment: comment || '', ...(threadTs ? { thread_ts: threadTs } : {}) })
  const urls = (result?.files || []).map((f) => f.permalink || f.url_private).filter(Boolean)
  return { isError: false, text: `file sent to ${targetId}: ${path.basename(resolvedPath)}${urls.length ? `\nURL: ${urls.join('\n')}` : ''}${note ? `\n${note}` : ''}\ndelivered_channel=${targetId}` }
}

async function readHistory({ channelId, limit, after, before, thread_ts: threadTs }, opts = {}) {
  // thread_ts (0.1.4, PO item #2): conversations.history returns only
  // top-level messages (a thread's replies never appear in it, only the
  // parent) -- so an agent called INSIDE a thread could answer in-thread
  // (0.1.3) but could not read what the thread had already said. With
  // thread_ts, conversations.replies returns the parent + every reply.
  const historyFn = opts.history || ((args) => (threadTs ? slackWeb.conversations.replies(args) : slackWeb.conversations.history(args)))
  const resolveSender = opts.resolveSender || resolveSenderName
  const fetchOpts = { channel: channelId, limit: limit || 50, ...(threadTs ? { ts: threadTs } : {}) }
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
      // threadTs on a top-level row = "this message HAS a thread" (read it
      // by passing thread_ts); inside a replies read it names the parent.
      ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
    })
  }
  return { channelId, ...(threadTs ? { threadTs } : {}), count: result.length, messages: result }
}

// design-0020 (headless topology): ONE inbound seam. Ingest-POST to
// headless-lane when its endpoint file exists (the -p lane, where the MCP
// notification below is a black hole -- probe 5); MCP dev-channels
// notification otherwise (attach topology, interactive claude).
const notifyInbound = createInboundNotifier({
  dataHome: DATA_HOME,
  mcpNotify: (params) => mcp.notification({ method: 'notifications/claude/channel', params }),
  log,
})

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  // In-app chat rides along on every backend (2026-08-05): "in-app" is the
  // local surface's constant id, disjoint from Slack's C/D/G-prefixed ids.
  // Before the zod parses below on purpose (see channel.mjs).
  if (isLocalCall(name, args)) return handleLocalToolCall(name, args)

  if (name === 'reply') {
    const { channelId, text, thread_ts } = ReplyArgs.parse(args || {})
    // GPT-loop guard (2026-08-04): identical text to the same target within
    // the window is NOT re-posted; the receipt tells the model so. Returned
    // as a NORMAL result, never isError -- an error result invites exactly
    // the retry this exists to stop. See createOutboundDedup.
    // thread_ts is part of the dedup key: the same text to the same channel
    // but a DIFFERENT thread is a legitimate second send, not a loop.
    const dup = checkOutboundDup(`${channelId || 'current'}${thread_ts ? `#${thread_ts}` : ''}`, text)
    if (dup.duplicate) return { content: [{ type: 'text', text: dup.receipt }] }
    const resultText = await sendReply({ channelId, text, thread_ts })
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

  if (name === 'routine') return handleRoutineTool(routineStore, args)

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
  // file_share passes through (0.1.4): a Slack message with an attached
  // file arrives AS subtype 'file_share', so the blanket subtype filter was
  // dropping every image message before the download path could ever run --
  // the other half of the "슬랙 이미지 fallback 안 됨" report (the first
  // half being that no download path existed). bot_message still passes
  // here because isBotEvent handles it; everything else (message_changed,
  // message_deleted, channel_join, ...) stays ignored.
  return Boolean(event?.subtype) && event.subtype !== 'bot_message' && event.subtype !== 'file_share'
}

// ── Inbound image attachments (0.1.4 — Discord/Telegram parity) ────────────
// channel.mjs downloads Discord attachments to tmp and injects
// "[image attachment(s) -- local path(s), open with Read tool: ...]".
// Slack had NO inbound file handling at all (field report 2026-08-11: "슬랙
// 이미지 fallback 동작 안 함" — there was nothing to fall back to). Slack
// specifics vs the Discord twin: files ride on event.files[] with mimetype/
// url_private, and url_private REQUIRES the bot token in an Authorization
// header — an unauthenticated GET returns an HTML login page with HTTP 200,
// which is why the content-type check below is load-bearing, not paranoia.
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const IMAGE_MIME_SET = new Set(Object.values(IMAGE_MIME))
// 0.1.4 (PO item #4): text documents + PDFs join images. kind decides the
// marker -- 'text' is safe for ANY lane to Read; 'image'/'pdf' are
// vision-gated (Read renders PDF pages as images).
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml'])
const TMP_IMAGE_DIR = path.join(os.tmpdir(), `agent-portable-${AGENT_NAME}`)
const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // same cap as channel.mjs downloadBuffer

// Lane vision verdict, channel-side (0.1.4). Mirrors the onboarding
// server's laneVision POLICY (first-party yes / default no / YES-list
// exception) but from the channel process's vantage: PROVIDER is not in
// this env (run.sh exports MODEL only), so first-party is detected by model
// name. Default-'no' is the fail-safe: the worst case is telling a
// vision-capable unlisted model to be honest about an image it could have
// read; the old worst case (Read invitation on a non-vision lane) poisoned
// the transcript with an image block the provider 400s on every turn.
// Gemma caption parity for Slack needs an authenticated local endpoint
// (readProviderKey is Electron-safeStorage-only) -- deferred, 0.1.5.
const VISION_YES_MODELS = new Set(['kimi-k2.7-code', 'kimi-k3', 'kimi-k2.6', 'gemma4', 'qwen3.5', 'minimax-m3', 'mistral-large-3'])
function laneHasVision(model = process.env.MODEL || '') {
  const base = String(model).replace(/:.*$/, '')
  // /^gpt-\d/, NOT /^gpt/: first-party codex ids are gpt-<digit> (gpt-5.5,
  // gpt-5.6-codex). A bare /^gpt/ also matched gpt-oss -- an ollama-lane
  // open-weight model with NO vision (library pills: tools/thinking only,
  // checked 2026-08-13 when it became a default row) -- and a false 'yes'
  // here is the poisoned-transcript case this gate exists to prevent.
  if (/^claude/.test(base) || /^gpt-\d/.test(base)) return true
  return VISION_YES_MODELS.has(base)
}

function imageMarker(localPaths, hasVision = laneHasVision(), noun = 'image') {
  if (hasVision) return `[${noun} attachment(s) -- local path(s), open with Read tool: ${localPaths.join(', ')}]`
  return `[${noun} attachment(s) saved at: ${localPaths.join(', ')} -- NOTE: the current model cannot view ${noun}s. Do NOT open them with the Read tool (the ${noun === 'PDF' ? 'rendered pages break' : 'image block breaks'} this model's calls); tell the user honestly that you cannot see ${noun}s on the current model.]`
}

function textFileMarker(localPaths) {
  return `[file attachment(s) -- local path(s), open with Read tool: ${localPaths.join(', ')}]`
}

function extractSlackFiles(event) {
  const found = []
  for (const f of event?.files || []) {
    if (!f || !f.url_private) continue
    const ext = (f.name || '').toLowerCase().match(/\.\w+$/)?.[0] || ''
    if ((f.mimetype && IMAGE_MIME_SET.has(f.mimetype)) || IMAGE_MIME[ext]) {
      found.push({ url: f.url_private, mime: f.mimetype || IMAGE_MIME[ext], kind: 'image', ext: ext || '.png' })
    } else if (f.mimetype === 'application/pdf' || ext === '.pdf') {
      found.push({ url: f.url_private, mime: 'application/pdf', kind: 'pdf', ext: '.pdf' })
    } else if (TEXT_EXT.has(ext) || (f.mimetype || '').startsWith('text/')) {
      found.push({ url: f.url_private, mime: f.mimetype || 'text/plain', kind: 'text', ext: ext || '.txt' })
    }
  }
  return found
}

// Back-compat shape used by existing tests/callers: images only.
function extractSlackImages(event) {
  return extractSlackFiles(event).filter((f) => f.kind === 'image').map(({ url, mime }) => ({ url, mime }))
}

async function downloadSlackImageToTmp(url, mime, opts = {}, extHint) {
  const fetchFn = opts.fetchFn || fetch
  const token = opts.token || SLACK_BOT_TOKEN
  try {
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ct = String(res.headers.get('content-type') || '')
    // Auth failure disguise: Slack serves an HTML login page with 200 when
    // the Authorization header is missing/wrong. Never save that as a .png.
    // (Legit .html attachments are not on the accepted-type list anyway.)
    if (ct.startsWith('text/html')) throw new Error('got HTML (auth failed?)')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('too large')
    await fs.mkdir(TMP_IMAGE_DIR, { recursive: true })
    const ext = extHint ? extHint.replace(/^\./, '')
      : mime?.includes('png') ? 'png' : mime?.includes('webp') ? 'webp' : mime?.includes('gif') ? 'gif' : 'jpg'
    const dest = path.join(TMP_IMAGE_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
    await fs.writeFile(dest, buf)
    return dest
  } catch (err) {
    log(`slack file download failed (${url}): ${err.message}`)
    return null
  }
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
  const notify = opts.notify || (notifyInbound)
  const resolveSender = opts.resolveSender || resolveSenderName

  if (isBotEvent(event) || isIgnorableSubtype(event)) return { skipped: true, reason: 'bot_or_subtype' }
  // DM-default (2026-08-04, Mino): DMs to the bot (channel_type 'im',
  // message.im event -- needs im:history + the event subscription in the
  // app manifest) are ALWAYS accepted; a configured home channel is an
  // additional surface on top. The original home-channel-only scoping
  // ("hard constraint #2") applies only to non-DM channels: any other
  // channel/group the bot happens to be in stays ignored.
  const isDm = event.channel_type === 'im'
  if (!isDm && event.channel !== HOME_CHANNEL_ID) return { skipped: true, reason: 'not_home_channel_or_dm' }

  lastInboundChannelId = event.channel
  lastChannelStore.persist(event.channel)
  lastActivityMs = Date.now()

  const sender = await resolveSender(event.user, opts)
  const text = (event.text || '').trim()
  // Attachments -> local tmp paths, same convention as channel.mjs
  // (Discord) :757 -- markers per kind (image/PDF vision-gated, text files
  // always Read-safe). Failed downloads degrade to the text-only message,
  // never block delivery.
  const attachments = extractSlackFiles(event)
  const download = opts.downloadImage || downloadSlackImageToTmp
  const byKind = { image: [], pdf: [], text: [] }
  for (const f of attachments) {
    const p = await download(f.url, f.mime, opts, f.ext)
    if (p) byKind[f.kind].push(p)
  }
  let content = text ? text : '[empty message]'
  const markers = []
  if (byKind.image.length) markers.push(opts.imageMarker ? opts.imageMarker(byKind.image) : imageMarker(byKind.image))
  if (byKind.pdf.length) markers.push(opts.imageMarker ? opts.imageMarker(byKind.pdf) : imageMarker(byKind.pdf, laneHasVision(), 'PDF'))
  if (byKind.text.length) markers.push(textFileMarker(byKind.text))
  if (markers.length) {
    const marker = markers.join('\n')
    content = text ? `${text}\n${marker}` : marker
  }
  // messageTs/threadTs (2026-08-11, Mino): expose the raw Slack ts so the
  // agent can thread replies. threadTs is set only when the inbound message
  // itself lives in a thread -- reply targeting rule: use threadTs when
  // present (stay in the existing thread), else messageTs (start a thread
  // under the message that called you). ISO timestamp alone cannot identify
  // a thread parent; chat.postMessage needs the ts string verbatim.
  const meta = {
    sender, channelId: event.channel, authorId: event.user || event.bot_id || '', timestamp: localNow(),
    messageTs: event.ts || '', threadTs: event.thread_ts || '',
  }

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
    // We ack BEFORE handling (Slack punishes slow acks with redelivery
    // storms), so a failure here means Slack will never redeliver and the
    // message is GONE for the agent (red-team 2026-08-04 #1). Post a
    // visible failure receipt so the sender knows to re-send -- best-effort.
    log('message handler error, inbound message lost for the agent:', err.message)
    if (event?.channel) {
      slackWeb.chat
        .postMessage({ channel: event.channel, text: '메시지 전달에 실패했어요 (에이전트 재시작 중일 수 있어요). 잠시 후 다시 보내주세요.' })
        .catch((e) => log('failure receipt post failed:', e.message))
    }
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

// Routines: 'connected' refires on every Socket Mode reconnect, so the
// ticker takes the same once-guard as the heartbeat. Optional-feature
// contract: a broken ticker degrades to a log line.
let routineTickerStarted = false
function startRoutineTickerOnce() {
  if (routineTickerStarted) return
  routineTickerStarted = true
  try {
    startRoutineTicker({
      store: routineStore,
      fire: (r) => notifyInbound({
          content: routineInjectContent(r),
          // DM-default mode has no HOME_CHANNEL_ID -- stamp the live
          // conversation channel so the routine's reply lands somewhere real.
          meta: { sender: 'SYSTEM', channelId: HOME_CHANNEL_ID || lastInboundChannelId || '', authorId: '', timestamp: localNow() },
        }),
      log,
    })
  } catch (err) {
    log(`routine ticker failed to start (feature disabled this session): ${err.message}`)
  }
}

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
  startRoutineTickerOnce()
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

// ── Boot ping (channel-runtime) ─────────────────────────────────────────────
// Same announce unit, marker protocol, throttle, and fallback ladder as every
// backend (createBootAnnouncer, channel-runtime.mjs) -- only the Slack IO is
// wired here. The announce target is the channel ID string, verified
// reachable via conversations.info before the direct send.
const announceBoot = createBootAnnouncer({
  dataHome: DATA_HOME,
  homeId: HOME_CHANNEL_ID,
  lastChannelStore,
  fetchTarget: fetchSlackChannelId,
  idOf: (channelId) => channelId,
  sendText: (channelId, text) => slackWeb.chat.postMessage({ channel: channelId, text }),
  notify: notifyInbound,
  log,
  noun: 'channel',
})

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

  // Always-on in-app chat surface, fail-soft (see channel.mjs's twin block).
  try {
    const surface = await startLocalChatSurface({ notify: (n) => notifyInbound(n.params), log })
    process.stdin.on('end', surface.stop)
    process.stdin.on('close', surface.stop)
  } catch (err) {
    log(`in-app chat surface failed to start (chat page off this session): ${err.message}`)
  }

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
  ReplyArgs, SLACK_TS_RE,
  extractSlackImages, extractSlackFiles, downloadSlackImageToTmp, laneHasVision, imageMarker, textFileMarker,
  toSlackTs,
  resolveSenderName,
  validateBotToken, validateAppToken,
}

if (isMainModule) {
  await boot()
}
