#!/usr/bin/env node
// channel-telegram.mjs — Telegram counterpart of channel.mjs (the Discord MCP
// channel server). Same shape, same three tools, same marker files, same
// notification contract into Claude Code -- only the wire protocol differs.
//
// Flow:
//   Telegram message (getUpdates long-poll) -> MCP notification -> Claude Code
//   Claude "reply"/"read_channel_history" tool call -> Telegram Bot API (raw
//   https, no SDK -- see "no new deps" below) -> Telegram
//
// Deliberately NOT ported from channel.mjs (out of scope for this file --
// none of these are Telegram protocol concerns, and none were named in the
// port brief): the shutdown-request watcher, the autonomous overnight cycle,
// the session-note cadence reminder, and the 🤔 thinking-reaction indicator.
// All four are generic agent-lifecycle features that would apply equally to
// either backend; porting them here would duplicate logic that belongs in
// one place. If they're wanted on Telegram, that's a follow-up, not a
// Discord/Telegram translation.

import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import {
  installStdoutHygiene, resolveDataHome, localISO, localNow,
  sweepStaleAtomicTmp,
  createMarkerStore, createLastChannelStore, createOutboundResolver, createBootAnnouncer, createMuteStrikeAnnouncer,
  createRoutineStore, ROUTINE_TOOL, handleRoutineTool, startRoutineTicker, routineInjectContent,
  createInboundNotifier, createOutboundDedup,
} from './channel-runtime.mjs'
// Always-on in-app chat (2026-08-05): hosted alongside Telegram; import is
// side-effect-safe (isMainModule guard) -- full rationale in channel.mjs.
import {
  LOCAL_CHANNEL_ID, handleToolCall as handleLocalToolCall, startLocalChatSurface,
} from './channel-local.mjs'

// ── stdout hygiene (channel-runtime) ───────────────────────────────────────
// Installed before anything else runs -- MCP stdout is JSON-RPC only.
const log = installStdoutHygiene()

// ── config ───────────────────────────────────────────────────────────────
const AGENT_NAME = process.env.AGENT_NAME || 'agent'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const HOME_CHANNEL_ID = process.env.HOME_CHANNEL_ID // Telegram chat id (string)

// ── DATA_HOME + markers (channel-runtime) ──────────────────────────────────
// Same marker files as every backend on purpose -- main.cjs/run.sh poll ONE
// contract (.agent-live, .agent-failed.json, .boot-event.json, ...)
// regardless of which channel backend is running.
const DATA_HOME = resolveDataHome(AGENT_NAME)
const markers = createMarkerStore({ dataHome: DATA_HOME })
void sweepStaleAtomicTmp(DATA_HOME, log) // boot hygiene: tmp orphans from unclean shutdowns (never boot-blocking)
const routineStore = createRoutineStore({ dataHome: DATA_HOME, log: (...a) => log(...a) })
const { LIVENESS_MARKER_PATH, FAILURE_MARKER_PATH, LIVENESS_HEARTBEAT_MS } = markers
const writeLivenessMarker = () => markers.writeLiveness()
const writeFailureMarker = (reason, code = 'unknown') => markers.writeFailure(reason, code)

if (!TELEGRAM_BOT_TOKEN) {
  const reason = 'TELEGRAM_BOT_TOKEN not set. Check .env (or the .mcp.json env block).'
  process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
  await writeFailureMarker(reason, 'telegram_token_bad').catch((err) =>
    process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${err.message}\n`)
  )
  process.exit(1)
}
if (!HOME_CHANNEL_ID) {
  const reason = 'HOME_CHANNEL_ID not set. Check .env (or the .mcp.json env block).'
  process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
  // Not 'telegram_token_bad' -- a missing chat id, not a bad/missing bot
  // token, and there's no dedicated code for it. 'unknown' is the honest
  // default (same reasoning as channel.mjs's identical guard).
  await writeFailureMarker(reason).catch((err) =>
    process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${err.message}\n`)
  )
  process.exit(1)
}

// Local-time timestamps (localISO/localNow) come from channel-runtime.mjs.

// ── image attachments -> the OS temp dir (download mechanics are protocol-
// agnostic, so this half is a verbatim mirror of channel.mjs) ──────────────
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const IMAGE_MIME_SET = new Set(Object.values(IMAGE_MIME))
// Separate suffix from channel.mjs's TMP_IMAGE_DIR: only one backend runs
// per agent today, so this doesn't fix a live bug, but it means a future
// dual-backend run can't silently share (and race on) the same download
// cache for free.
const TMP_IMAGE_DIR = path.join(os.tmpdir(), `agent-portable-${AGENT_NAME}-telegram`)

function downloadBuffer(url, maxBytes = 20 * 1024 * 1024, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('too many redirects'))
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15_000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return downloadBuffer(res.headers.location, maxBytes, depth + 1).then(resolve, reject)
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const chunks = []
      let len = 0
      res.on('data', (c) => { len += c.length; if (len > maxBytes) { res.destroy(); reject(new Error('too large')) } else chunks.push(c) })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

// Telegram file URLs embed the FULL bot token as a path segment
// (https://<host>/file/bot<TOKEN>/<path>). Strip it before the URL can ever
// reach a log sink -- the /logs redactor is a backstop, not the first line of
// defense; a credential-bearing URL must not be handed to log() at all.
function sanitizeTelegramUrl(url) {
  return String(url).replace(/\/bot[^/]+\//, '/bot<REDACTED>/')
}

async function downloadImageToTmp(url, mime) {
  try {
    const buf = await downloadBuffer(url)
    await fs.mkdir(TMP_IMAGE_DIR, { recursive: true })
    const ext = mime?.includes('png') ? 'png' : mime?.includes('webp') ? 'webp' : mime?.includes('gif') ? 'gif' : 'jpg'
    const dest = path.join(TMP_IMAGE_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
    await fs.writeFile(dest, buf)
    return dest
  } catch (err) {
    log(`image download failed (${sanitizeTelegramUrl(url)}): ${err.message}`)
    return null
  }
}

// ── Telegram Bot API client (node:https only -- no SDK, no new deps) ───────
// Every call goes through `telegramApi()`, which takes an injectable
// `requestFn` (default: the real https implementation below). This is the
// same test-seam shape as channel.mjs's resolveOutboundChannel(opts.fetchFn)
// -- tests/test-telegram-channel.mjs swaps requestFn to attack getUpdates/
// sendMessage/getChat/getMe logic with canned responses, no live network
// anywhere in that file.
const TELEGRAM_API_HOST = 'api.telegram.org'

function telegramApiRequestReal(method, params, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(params || {}))
    const req = https.request(
      {
        host: TELEGRAM_API_HOST,
        path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: timeoutMs,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let parsed
          try { parsed = JSON.parse(data) } catch (err) { return reject(new Error(`bad JSON from Telegram (${method}): ${err.message}`)) }
          if (!parsed.ok) return reject(new Error(`Telegram API ${method} failed: ${parsed.description || 'unknown error'} (code ${parsed.error_code ?? '?'})`))
          resolve(parsed.result)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`Telegram API ${method} timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function telegramApi(method, params = {}, opts = {}) {
  const requestFn = opts.requestFn || telegramApiRequestReal
  return requestFn(method, params, opts)
}

// sendDocument needs multipart/form-data, hand-assembled (no SDK covers this
// either). Kept separate from telegramApi() above -- it is not a JSON POST.
function buildMultipartBody(fields, filePart, boundary) {
  const CRLF = '\r\n'
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`))
  }
  parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${filePart.name}"; filename="${filePart.filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`))
  parts.push(filePart.data)
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`))
  return Buffer.concat(parts)
}

function telegramSendDocumentReal(chatId, filename, fileBuffer, caption) {
  return new Promise((resolve, reject) => {
    const boundary = `----schedTelegram${Date.now()}${Math.random().toString(16).slice(2)}`
    const body = buildMultipartBody(
      { chat_id: chatId, caption },
      { name: 'document', filename, data: fileBuffer },
      boundary
    )
    const req = https.request(
      {
        host: TELEGRAM_API_HOST,
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        timeout: 30_000,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let parsed
          try { parsed = JSON.parse(data) } catch (err) { return reject(new Error(`bad JSON from Telegram (sendDocument): ${err.message}`)) }
          if (!parsed.ok) return reject(new Error(`Telegram API sendDocument failed: ${parsed.description || 'unknown error'}`))
          resolve(parsed.result)
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function telegramSendDocument(chatId, filename, fileBuffer, caption, opts = {}) {
  const sendFn = opts.sendDocumentFn || telegramSendDocumentReal
  return sendFn(chatId, filename, fileBuffer, caption)
}

async function fetchTelegramChat(chatId, opts = {}) {
  const result = await telegramApi('getChat', { chat_id: chatId }, opts)
  return { id: String(result.id) }
}

// ── Current-conversation chat tracking + outbound resolution ───────────────
// channelId is OPTIONAL on reply/send_file -- omitted -> current conversation
// chat. Resolution (channel-runtime's createOutboundResolver) returns
// {target, note} where target is a Telegram chat object ({id}); ladder,
// fail-closed semantics, and opts test seams live in channel-runtime.mjs.
let lastInboundChannelId = null
// Surface of the last REAL user inbound ('telegram' | 'in-app'). This backend
// hosts both Telegram and the always-on in-app chat window; an omitted-channelId
// reply must route to whichever surface the user last spoke on (H1 in-app-render
// fix, channel.mjs parity). SYSTEM injects to HOME do NOT touch this. Defaults
// 'telegram' (pre-fix behavior before any inbound).
let lastInboundSurface = 'telegram'

const lastChannelStore = createLastChannelStore({ dataHome: DATA_HOME, log })

let lastActivityMs = Date.now()

const GUIDANCE =
  'Do not invent chat ids -- omit channelId to target the current conversation, then call the tool again.'

const resolveOutboundChannel = createOutboundResolver({
  fetchTarget: fetchTelegramChat,
  getLastInboundId: () => lastInboundChannelId,
  homeId: HOME_CHANNEL_ID,
  guidance: GUIDANCE,
})

// GPT-loop guard (2026-08-04, the owner field report) -- see createOutboundDedup.
const checkOutboundDup = createOutboundDedup({ log })

// ── Local history ledger (read_channel_history backing store) ──────────────
// Telegram's Bot API has no history endpoint -- getUpdates only ever hands
// you NEW updates, once, and getChat returns metadata, not messages. So
// every in/out message this process handles gets appended here, and
// read_channel_history reads it back. Honest limitation (stated in the tool
// description below, not just this comment): there is no record of anything
// from before this bot started keeping one.
const HISTORY_LEDGER_PATH = path.join(DATA_HOME, 'telegram-history.jsonl')

async function appendHistoryEntry(record) {
  await fs.appendFile(HISTORY_LEDGER_PATH, JSON.stringify(record) + '\n')
}

// after/before accept EITHER a Telegram message_id (all-digits) OR an ISO
// date -- same dual-format intent as channel.mjs's toSnowflake(), just
// without a snowflake to decode (Telegram message_id carries no timestamp).
function parseCutoff(v) {
  if (v === undefined || v === null || v === '') return null
  if (/^\d+$/.test(v)) return { kind: 'id', value: Number(v) }
  const ms = Date.parse(v)
  if (!Number.isNaN(ms)) return { kind: 'time', value: ms }
  return null
}

async function readHistoryEntries({ channelId, limit = 50, after, before }) {
  let raw
  try {
    raw = await fs.readFile(HISTORY_LEDGER_PATH, 'utf8')
  } catch {
    return [] // no ledger yet = no history yet, not an error
  }
  const afterCut = parseCutoff(after)
  const beforeCut = parseCutoff(before)
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue } // one corrupt line (e.g. torn write) must not sink the whole ledger
    if (String(rec.channelId) !== String(channelId)) continue
    if (afterCut) {
      if (afterCut.kind === 'id' && !(Number(rec.id) > afterCut.value)) continue
      if (afterCut.kind === 'time' && !(Date.parse(rec.timestamp) > afterCut.value)) continue
    }
    if (beforeCut) {
      if (beforeCut.kind === 'id' && !(Number(rec.id) < beforeCut.value)) continue
      if (beforeCut.kind === 'time' && !(Date.parse(rec.timestamp) < beforeCut.value)) continue
    }
    rows.push(rec)
  }
  // Append order should already be chronological, but sort defensively
  // rather than trust it -- cheap, and matches channel.mjs's own explicit
  // sort-after-fetch (Discord's messages.fetch() returns most-recent-first;
  // its handler sorts ascending before returning, same as here).
  rows.sort((a, b) => Number(a.id) - Number(b.id))
  return rows.slice(-limit)
}

// ── MCP server ───────────────────────────────────────────────────────────
const DEFAULT_INSTRUCTIONS = `You are ${AGENT_NAME}.
Telegram messages arrive as: <channel source="${AGENT_NAME}" sender="..." channelId="..." authorId="..." timestamp="...">content</channel>
channelId is the Telegram chat id -- in the normal single-user setup, a private DM with this bot.
Reply with the "reply" tool. channelId is optional -- omit it and the message goes to the current conversation chat. Never invent a channelId; only pass one when replying to a DIFFERENT chat than the one that messaged you. A channelId you DO pass is honored exactly or the call fails: an unresolvable one sends nothing anywhere, it is never quietly redirected.
Image attachments (Telegram photos, or documents sent as images) are downloaded locally; the notification includes the local file path(s) -- open with the Read tool.
Use "send_file_to_discord" (filePath, comment?, channelId?) to upload a local file via Telegram's sendDocument -- "reply" is text-only. (Tool name kept as-is from the Discord original on purpose -- this is the Telegram backend; do not rename, permission allowlists and hooks match this exact name.)
Use "read_channel_history" (channelId, limit, after?, before?) to look back through the chat. This reads a LOCAL ledger, not a Telegram API call -- Telegram's Bot API has no history endpoint. It only covers messages sent/received while this bot was running; there is no record of anything from before. after/before each accept a Telegram message_id or an ISO date.
The app's own chat window is ALSO always connected: its messages arrive with channelId="in-app". Reply to those with channelId "in-app" exactly -- never route an in-app conversation to a Telegram chat or vice versa. The "react" tool (one emoji on the user's bubble) works only for the in-app window.`
const INSTRUCTIONS = process.env.CHANNEL_INSTRUCTIONS || DEFAULT_INSTRUCTIONS

const mcp = new Server(
  { name: AGENT_NAME, version: '1.0.0' },
  { capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} }, instructions: INSTRUCTIONS }
)

// Tool names/schemas are pinned to channel.mjs's exactly -- settings.local.json
// allowlists and PreToolUse hooks match mcp__agent-channel__reply etc. by
// name. Only the description text changes, to describe Telegram reality.
const TOOLS = [
  {
    name: 'reply',
    description: 'Send a message to the user via Telegram. Goes to the current conversation chat unless a channelId is explicitly given.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send' },
        channelId: { type: 'string', description: 'OPTIONAL Telegram chat ID. Omit to send to the current conversation chat. Never guess or invent this value.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'send_file_to_discord',
    description: 'Upload a local file (image, document, etc.) via Telegram sendDocument. Use this for attachments -- the reply tool is text-only. Goes to the current conversation chat unless a channelId is explicitly given.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Full local path of the file to upload' },
        comment: { type: 'string', description: 'Optional caption sent with the file' },
        channelId: { type: 'string', description: 'OPTIONAL Telegram chat ID. Omit to send to the current conversation chat. Never guess or invent this value.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'read_channel_history',
    description: 'Read recent message history from a Telegram chat, from a LOCAL ledger (Telegram\'s Bot API has no history endpoint). Only covers messages seen while this bot was running.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Telegram chat ID' },
        limit: { type: 'number', description: 'Number of messages to return (default 50, max 100)' },
        after: { type: 'string', description: 'Only messages after this point -- Telegram message_id or ISO date' },
        before: { type: 'string', description: 'Only messages before this point -- Telegram message_id or ISO date' },
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
function isLocalCall(name, args, surface = lastInboundSurface) {
  if (!LOCAL_ROUTED_TOOLS.has(name)) return false
  if (name === 'react') return true
  // Explicit channelId honored exactly ('in-app' -> local, else platform);
  // omitted channelId follows the last real-inbound surface (H1 fix, channel.mjs parity).
  if (args && args.channelId != null) return args.channelId === LOCAL_CHANNEL_ID
  return surface === 'in-app'
}

const ReplyArgs = z.object({ channelId: z.string().min(1).optional(), text: z.string().min(1) })
const SendFileArgs = z.object({ channelId: z.string().min(1).optional(), filePath: z.string().min(1), comment: z.string().optional() })
const ReadHistoryArgs = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
})

// Outbound chunking: Telegram's hard limit is 4096 chars per sendMessage;
// budgeted to 4000 for safety margin (entity/encoding overhead). Same simple
// slice-loop strategy as channel.mjs (1900-char budget there for Discord's
// 2000 limit) -- no chunk-index headers or reassembly tags, because
// channel.mjs has none either (constraint: mirror the convention that
// exists, don't invent one that doesn't).
function chunkText(text, size = 4000) {
  const chunks = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

// Extracted from the "reply" tool branch so tests/test-telegram-channel.mjs
// can drive the real chunk/send/log path with an injected sendFn instead of
// hitting live Telegram -- same DI shape as resolveOutboundChannel(opts).
async function handleReplyCall({ channelId, text }, opts = {}) {
  const sendFn = opts.sendFn || ((chatId, chunk) => telegramApi('sendMessage', { chat_id: chatId, text: chunk }, opts))
  const historyAppendFn = opts.historyAppendFn || appendHistoryEntry
  const { target, note } = await resolveOutboundChannel(channelId, opts)
  const chunks = chunkText(text)
  for (const chunk of chunks) {
    const result = await sendFn(target.id, chunk)
    await historyAppendFn({
      id: String(result.message_id),
      channelId: String(target.id),
      direction: 'out',
      author: AGENT_NAME,
      authorId: 'bot',
      content: chunk,
      timestamp: localISO(),
      attachments: [],
    })
  }
  lastActivityMs = Date.now() // delivered reply = live conversation
  return { target, note, chunkCount: chunks.length }
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
  // local surface's constant id, disjoint from Telegram's numeric chat ids.
  // Before the zod parses below on purpose (see channel.mjs).
  if (isLocalCall(name, args)) return handleLocalToolCall(name, args)

  if (name === 'reply') {
    const { channelId, text } = ReplyArgs.parse(args || {})
    // GPT-loop guard (2026-08-04): identical text to the same target within
    // the window is NOT re-posted; the receipt tells the model so. Normal
    // result, never isError -- an error invites exactly the retry this
    // exists to stop. See createOutboundDedup (channel-runtime.mjs).
    const dup = checkOutboundDup(channelId || 'current', text)
    if (dup.duplicate) return { content: [{ type: 'text', text: dup.receipt }] }
    const { target, note, chunkCount } = await handleReplyCall({ channelId, text })
    dup.commit() // record the dedup key only AFTER the send succeeded (2026-08-13)
    // delivered_channel= line: machine-readable delivery receipt for
    // hooks/stop-reply-guard.mjs, same fixed format channel.mjs stamps (that
    // guard greps this exact token regardless of which channel backend
    // produced it). The guard's regex accepts a leading minus sign, so a
    // negative Telegram GROUP chat id matches too.
    return { content: [{ type: 'text', text: `sent to ${target.id} (${chunkCount} message${chunkCount > 1 ? 's' : ''})${note ? `\n${note}` : ''}\ndelivered_channel=${target.id}` }] }
  }

  if (name === 'send_file_to_discord') {
    const parsed = SendFileArgs.parse(args || {})
    const filePath = parsed.filePath.startsWith('~') ? path.join(os.homedir(), parsed.filePath.slice(1)) : parsed.filePath
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      return { content: [{ type: 'text', text: `file not found: ${filePath}` }], isError: true }
    }
    // Telegram Bot API's documented multipart upload cap (vs Discord's 10MB
    // default bot cap) -- fail here with a clear message instead of an
    // opaque Telegram error mid-upload.
    const MAX_UPLOAD = 50 * 1024 * 1024
    if (stat.size > MAX_UPLOAD) {
      return { content: [{ type: 'text', text: `file too large for Telegram upload: ${(stat.size / 1024 / 1024).toFixed(1)}MB (limit 50MB)` }], isError: true }
    }
    const { target, note } = await resolveOutboundChannel(parsed.channelId)
    const fileBuffer = await fs.readFile(filePath)
    const filename = path.basename(filePath)
    const result = await telegramSendDocument(target.id, filename, fileBuffer, parsed.comment)
    await appendHistoryEntry({
      id: String(result.message_id),
      channelId: String(target.id),
      direction: 'out',
      author: AGENT_NAME,
      authorId: 'bot',
      content: parsed.comment || '',
      timestamp: localISO(),
      attachments: [filename],
    })
    lastActivityMs = Date.now()
    return { content: [{ type: 'text', text: `file sent to ${target.id}: ${filename}${note ? `\n${note}` : ''}\ndelivered_channel=${target.id}` }] }
  }

  if (name === 'read_channel_history') {
    const { channelId, limit, after, before } = ReadHistoryArgs.parse(args || {})
    const messages = await readHistoryEntries({ channelId, limit: limit || 50, after, before })
    return { content: [{ type: 'text', text: JSON.stringify({ channelId, count: messages.length, messages }, null, 2) }] }
  }

  if (name === 'routine') return handleRoutineTool(routineStore, args)

  throw new Error(`unknown tool: ${name}`)
})

// ── Inbound message handling ────────────────────────────────────────────────
// Discord's isDMBased() (any DM always passes; a guild channel message must
// match HOME_CHANNEL_ID) becomes: a Telegram 'private' chat always passes; a
// group/supergroup/channel message must match HOME_CHANNEL_ID. Same shape:
// the single-user DM channel is unconditionally trusted, anything else must
// name itself as home.
function shouldProcessMessage(message, homeChannelId) {
  if (message?.from?.is_bot) return false
  if (message?.chat?.type === 'private') return true
  return String(message?.chat?.id) === String(homeChannelId)
}

function senderName(message) {
  const f = message.from || {}
  return f.username || [f.first_name, f.last_name].filter(Boolean).join(' ') || 'unknown'
}

// Telegram sends photos pre-transcoded to JPEG as an array of resolutions
// (small -> large); the last entry is the largest. Images sent as an
// uncompressed "document" carry their own mime_type instead.
function extractTelegramImages(message) {
  const found = []
  if (Array.isArray(message.photo) && message.photo.length) {
    found.push({ fileId: message.photo[message.photo.length - 1].file_id, mime: 'image/jpeg' })
  }
  if (message.document?.mime_type && IMAGE_MIME_SET.has(message.document.mime_type)) {
    found.push({ fileId: message.document.file_id, mime: message.document.mime_type })
  }
  return found
}

async function resolveTelegramFileUrl(fileId, opts = {}) {
  const result = await telegramApi('getFile', { file_id: fileId }, opts)
  return `https://${TELEGRAM_API_HOST}/file/bot${TELEGRAM_BOT_TOKEN}/${result.file_path}`
}

// Pure builder: raw Telegram message -> the exact {content, meta} shape
// mcp.notification() sends on. Split out from handleUpdate() so
// tests/test-telegram-channel.mjs can assert the injected tag-format
// payload without a live MCP transport or network call.
function buildInboundMessage(message, localPaths = []) {
  let content = message.text || message.caption || ''
  if (localPaths.length) content += `\n[image attachment(s) -- local path(s), open with Read tool:\n${localPaths.join('\n')}]`
  if (!content.trim()) content = '[empty message]'
  return {
    content,
    meta: {
      sender: senderName(message),
      channelId: String(message.chat.id),
      authorId: String(message.from?.id ?? ''),
      timestamp: localNow(),
    },
  }
}

// opts are test seams (mirrors resolveOutboundChannel's opts): notifyFn
// defaults to the real mcp.notification() call, downloadFn to the real
// getFile+download chain, historyAppendFn to the real ledger append.
async function handleUpdate(update, opts = {}) {
  const notifyFn = opts.notifyFn || (notifyInbound)
  const downloadFn = opts.downloadFn || (async (img) => downloadImageToTmp(await resolveTelegramFileUrl(img.fileId, opts), img.mime))
  const historyAppendFn = opts.historyAppendFn || appendHistoryEntry

  const message = update.message // edited_message intentionally ignored -- channel.mjs only listens to MessageCreate, never MessageUpdate
  if (!message) return
  if (!shouldProcessMessage(message, HOME_CHANNEL_ID)) return

  lastInboundChannelId = String(message.chat.id)
  lastInboundSurface = 'telegram' // real user inbound arrived on Telegram (H1 surface tracking)
  lastChannelStore.persist(lastInboundChannelId)
  lastActivityMs = Date.now()

  const localPaths = []
  for (const img of extractTelegramImages(message)) {
    try {
      const p = await downloadFn(img)
      if (p) localPaths.push(p)
    } catch (err) {
      log(`telegram image resolve/download failed: ${err.message}`)
    }
  }

  const { content, meta } = buildInboundMessage(message, localPaths)

  await notifyFn({ content, meta })

  // Logged AFTER a successful notify, not before: mirrors channel.mjs's own
  // advance-only-on-delivered pattern (its shutdown/autonomy/note-cadence
  // watchers all advance their markers only once the send actually lands).
  // It also keeps a getUpdates retry from double-writing this line -- see
  // pollOnce() below, a retry only happens when notifyFn threw before this
  // point was reached.
  await historyAppendFn({
    id: String(message.message_id),
    channelId: String(message.chat.id),
    direction: 'in',
    author: meta.sender,
    authorId: meta.authorId,
    content,
    timestamp: meta.timestamp,
    attachments: localPaths,
  }).catch((err) => log(`history ledger append failed: ${err.message}`))
}

// ── getUpdates long-poll loop ────────────────────────────────────────────
// offset advances ONLY after handleUpdate() succeeds for that update -- if
// it throws (e.g. mcp.notification failed), offset stays put and Telegram
// redelivers the same update(s) on the next poll (Telegram only stops
// redelivering an update once a LATER offset has been acknowledged). This is
// the same "don't advance the marker past a failed delivery" contract
// channel.mjs uses for its shutdown-request/autonomy/note-cadence watchers,
// applied to Telegram's own ack mechanism instead of a local mtime marker.
let pollingOffset = 0

// Bots start with a possible backlog of updates sent while the process was
// down. Discord's gateway never redelivers messages sent while
// disconnected; to match that ("only react to what happens while live"),
// peek the latest update_id (offset: -1 returns just the most recent one)
// and set the next offset past it, discarding anything older.
async function initializePollingOffset(opts = {}) {
  const updates = await telegramApi('getUpdates', { offset: -1 }, opts)
  if (updates.length) pollingOffset = updates[updates.length - 1].update_id + 1
}

async function pollOnce(opts = {}) {
  const updates = await telegramApi('getUpdates', { offset: pollingOffset, timeout: 50, allowed_updates: ['message'] }, { ...opts, timeoutMs: 60_000 })
  for (const update of updates) {
    await handleUpdate(update, opts)
    pollingOffset = update.update_id + 1
  }
}

async function startPolling(opts = {}) {
  for (;;) {
    try {
      await pollOnce(opts)
    } catch (err) {
      log(`telegram polling error (will retry): ${err.message}`)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
}

// ── Boot ping (channel-runtime) ─────────────────────────────────────────────
// Same announce unit, marker protocol, throttle, and home->persisted-last
// fallback as every backend (createBootAnnouncer, channel-runtime.mjs) --
// only the Telegram IO is wired here.
const announceBoot = createBootAnnouncer({
  dataHome: DATA_HOME,
  homeId: HOME_CHANNEL_ID,
  lastChannelStore,
  fetchTarget: fetchTelegramChat,
  idOf: (chat) => chat.id,
  sendText: (chat, text) => telegramApi('sendMessage', { chat_id: chat.id, text }),
  notify: notifyInbound,
  log,
  noun: 'chat',
})

// Mute visibility in the messenger itself -- see the factory's comment in
// channel-runtime.mjs.
const muteAnnouncer = createMuteStrikeAnnouncer({
  dataHome: DATA_HOME,
  homeId: HOME_CHANNEL_ID,
  lastChannelStore,
  getLastInboundId: () => lastInboundChannelId,
  fetchTarget: fetchTelegramChat,
  sendText: (chat, text) => telegramApi('sendMessage', { chat_id: chat.id, text }),
  log,
})

// ── boot ─────────────────────────────────────────────────────────────────
// Does NOT itself call process.exit() -- boot() does, after checking the
// return value. Keeping the exit call out of this function is what makes it
// testable: tests/test-telegram-channel.mjs injects a rejecting requestFn
// and asserts (return === false) + (failure marker written with
// code 'telegram_token_bad'), with no subprocess and no live network.
async function verifyTokenOrFail(opts = {}) {
  try {
    await telegramApi('getMe', {}, opts)
    return true
  } catch (err) {
    const reason = `Telegram token verification failed: ${err.message}`
    await writeFailureMarker(reason, 'telegram_token_bad').catch((markerErr) =>
      log(`also failed to write failure marker: ${markerErr.message}`)
    )
    return false
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

async function boot() {
  await mcp.connect(new StdioServerTransport())
  log(`MCP server up (${AGENT_NAME})`)

  // Always-on in-app chat surface, fail-soft (see channel.mjs's twin block).
  try {
    const surface = await startLocalChatSurface({ notify: (n) => { lastInboundSurface = 'in-app'; return notifyInbound(n.params) }, log })
    process.stdin.on('end', surface.stop)
    process.stdin.on('close', surface.stop)
  } catch (err) {
    log(`in-app chat surface failed to start (chat page off this session): ${err.message}`)
  }

  const tokenOk = await verifyTokenOrFail()
  if (!tokenOk) {
    // Same user-facing action as channel.mjs's discord.login() failure path:
    // fix the bot token. main.cjs's poller surfaces the marker written above
    // as setAgentStatus('failed', 'telegram_token_bad', reason).
    process.stderr.write(`[${AGENT_NAME}] FATAL: Telegram token rejected -- see ${FAILURE_MARKER_PATH}\n`)
    process.exit(1)
  }

  log(`Telegram ready`)
  writeLivenessMarker().catch((err) => log(`liveness marker write failed: ${err.message}`))
  setInterval(() => {
    writeLivenessMarker().catch((err) => log(`liveness heartbeat write failed: ${err.message}`))
  }, LIVENESS_HEARTBEAT_MS).unref()

  // Routines: optional-feature contract -- a broken ticker degrades to a
  // log line, never takes the channel down.
  try {
    startRoutineTicker({
      store: routineStore,
      fire: (r) => notifyInbound({
          content: routineInjectContent(r),
          meta: { sender: 'SYSTEM', channelId: HOME_CHANNEL_ID, authorId: '', timestamp: localNow() },
        }),
      log,
    })
  } catch (err) {
    log(`routine ticker failed to start (feature disabled this session): ${err.message}`)
  }

  announceBoot().catch((err) => log(`boot announce failed: ${err.message}`))
  muteAnnouncer.start().catch((err) => log(`mute announcer failed to start (feature disabled this session): ${err.message}`))

  await initializePollingOffset().catch((err) => log(`initial getUpdates offset peek failed (starting from 0): ${err.message}`))
  await startPolling() // runs forever; this is the main receive loop
}

export {
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
  telegramApi,
}

if (isMainModule) {
  await boot()
}
