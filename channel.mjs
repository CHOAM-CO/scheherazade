#!/usr/bin/env node
// channel.mjs — minimal Discord MCP channel server for a single portable agent.
//
// Flow:
//   Discord message (home channel) -> MCP notification -> Claude Code
//   Claude "reply"/"read_channel_history" tool call -> discord.js -> Discord
//
// Trimmed from MAGI's channels/base-channel.mjs (4000-line, multi-agent,
// voice/B2B/lounge-aware) down to: one agent, one home channel, two tools.

import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client, GatewayIntentBits, Events } from 'discord.js'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// ── stdout hygiene ─────────────────────────────────────────────────────────
// MCP stdio transport reserves stdout exclusively for JSON-RPC. Any stray
// console output there corrupts the stream, so every console method is
// rerouted to stderr before anything else runs.
function safeJson(v) { try { return JSON.stringify(v) } catch { return String(v) } }
for (const [method, prefix] of [['log', ''], ['info', ''], ['debug', ''], ['warn', '[WARN] '], ['error', '[ERR] ']]) {
  console[method] = (...args) => {
    process.stderr.write(`${prefix}${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}\n`)
  }
}
const log = (...args) => console.log(...args)

// ── config ───────────────────────────────────────────────────────────────
const AGENT_NAME = process.env.AGENT_NAME || 'agent'
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN
const HOME_CHANNEL_ID = process.env.HOME_CHANNEL_ID

if (!DISCORD_TOKEN) {
  process.stderr.write(`[${AGENT_NAME}] FATAL: DISCORD_BOT_TOKEN not set. Check .env (or the .mcp.json env block).\n`)
  process.exit(1)
}
if (!HOME_CHANNEL_ID) {
  process.stderr.write(`[${AGENT_NAME}] FATAL: HOME_CHANNEL_ID not set. Check .env (or the .mcp.json env block).\n`)
  process.exit(1)
}

// ── KST timestamps ──────────────────────────────────────────────────────────
// new Date().toISOString() is UTC; the model reads this as "now", so it needs
// to be explicit KST (UTC+9), not silently off by up to 9 hours.
function kstISO(ms = Date.now()) {
  return new Date(ms + 9 * 3600_000).toISOString().replace('Z', '+09:00')
}
function kstWeekday(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Seoul' }).format(new Date(ms))
}
const kstNow = () => `${kstISO()} (${kstWeekday()})`

// ── safe mentions — block @everyone/@here on every send ────────────────────
const SAFE_MENTIONS = { parse: ['users', 'roles'] }

// ── image attachments -> /tmp ───────────────────────────────────────────────
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const IMAGE_MIME_SET = new Set(Object.values(IMAGE_MIME))
const TMP_IMAGE_DIR = `/tmp/agent-portable-${AGENT_NAME}`

function extractImages(message) {
  const found = []
  for (const att of message.attachments.values()) {
    if (att.contentType && IMAGE_MIME_SET.has(att.contentType)) { found.push({ url: att.url, mime: att.contentType }); continue }
    const ext = (att.name || '').toLowerCase().match(/\.\w+$/)?.[0]
    if (ext && IMAGE_MIME[ext]) found.push({ url: att.url, mime: IMAGE_MIME[ext] })
  }
  return found
}

function downloadBuffer(url, maxBytes = 20 * 1024 * 1024, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('too many redirects'))
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    proto.get(url, { timeout: 15_000 }, (res) => {
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

async function downloadImageToTmp(url, mime) {
  try {
    const buf = await downloadBuffer(url)
    await fs.mkdir(TMP_IMAGE_DIR, { recursive: true })
    const ext = mime?.includes('png') ? 'png' : mime?.includes('webp') ? 'webp' : mime?.includes('gif') ? 'gif' : 'jpg'
    const dest = path.join(TMP_IMAGE_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
    await fs.writeFile(dest, buf)
    return dest
  } catch (err) {
    log(`image download failed (${url}): ${err.message}`)
    return null
  }
}

// ── Discord message ID / ISO date -> snowflake (for history before/after) ──
const DISCORD_EPOCH = 1420070400000n
function toSnowflake(v) {
  if (!v) return undefined
  if (/^\d{17,20}$/.test(v)) return v
  const ms = Date.parse(v)
  if (Number.isNaN(ms)) return undefined
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString()
}

// ── Discord client ──────────────────────────────────────────────────────────
// MessageContent is a privileged intent — enable it under the bot's
// Developer Portal page (Bot tab -> Privileged Gateway Intents) or every
// incoming message.content arrives empty.
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

async function fetchTextChannel(channelId) {
  const ch = await discord.channels.fetch(channelId)
  if (!ch || !ch.isTextBased()) throw new Error(`channel ${channelId} not found or not text-based`)
  return ch
}

// ── MCP server ───────────────────────────────────────────────────────────
const DEFAULT_INSTRUCTIONS = `You are ${AGENT_NAME}.
Discord messages arrive as: <channel source="${AGENT_NAME}" sender="..." channelId="..." authorId="..." timestamp="...">content</channel>
Reply with the "reply" tool, passing the same channelId back.
Image attachments are downloaded locally; the notification includes the local file path(s) -- open with the Read tool.
Use "read_channel_history" (channelId, limit, after?, before?) to look back through the channel. after/before each accept a Discord message ID or an ISO date.`
const INSTRUCTIONS = process.env.CHANNEL_INSTRUCTIONS || DEFAULT_INSTRUCTIONS

const mcp = new Server(
  { name: AGENT_NAME, version: '1.0.0' },
  { capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} }, instructions: INSTRUCTIONS },
)

const TOOLS = [
  {
    name: 'reply',
    description: 'Send a message to a Discord channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        text: { type: 'string', description: 'Message text to send' },
      },
      required: ['channelId', 'text'],
    },
  },
  {
    name: 'read_channel_history',
    description: 'Read recent message history from a Discord channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        limit: { type: 'number', description: 'Number of messages to return (default 50, max 100)' },
        after: { type: 'string', description: 'Only messages after this point -- Discord message ID or ISO date' },
        before: { type: 'string', description: 'Only messages before this point -- Discord message ID or ISO date' },
      },
      required: ['channelId'],
    },
  },
]

const ReplyArgs = z.object({ channelId: z.string().min(1), text: z.string().min(1) })
const ReadHistoryArgs = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
})

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === 'reply') {
    const { channelId, text } = ReplyArgs.parse(args || {})
    const ch = await fetchTextChannel(channelId)
    const chunks = []
    for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900))
    for (const chunk of chunks) await ch.send({ content: chunk, allowedMentions: SAFE_MENTIONS })
    return { content: [{ type: 'text', text: `sent to ${channelId} (${chunks.length} message${chunks.length > 1 ? 's' : ''})` }] }
  }

  if (name === 'read_channel_history') {
    const { channelId, limit, after, before } = ReadHistoryArgs.parse(args || {})
    const ch = await fetchTextChannel(channelId)
    const fetchOpts = { limit: limit || 50 }
    const afterSf = toSnowflake(after)
    const beforeSf = toSnowflake(before)
    if (afterSf) fetchOpts.after = afterSf
    else if (beforeSf) fetchOpts.before = beforeSf
    const msgs = await ch.messages.fetch(fetchOpts)
    const result = [...msgs.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => ({
        id: m.id,
        author: m.member?.displayName || m.author.username,
        authorId: m.author.id,
        content: m.content,
        timestamp: kstISO(m.createdTimestamp),
        attachments: [...m.attachments.values()].map((a) => a.url),
      }))
    return { content: [{ type: 'text', text: JSON.stringify({ channelId, count: result.length, messages: result }, null, 2) }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

// ── liveness marker (agent-lifecycle fix, 2026-07-03, PART 4) ──────────────
// Written to DATA_HOME (== process.cwd() here: .mcp.json's agent-channel
// entry sets cwd: DATA_HOME, see onboarding/http-server.cjs's
// ensureMcpJsonAgentName()) on the discord.js ClientReady event, and
// refreshed as a heartbeat afterward. onboarding/http-server.cjs's GET
// /api/agent/status polls this file's freshness to gate the onboarding
// wizard's Step 5 success screen on REAL Discord-level liveness, not just
// the ONBOARDING_COMPLETE flag flip (which only proves the token validated,
// not that the agent ever actually connected).
const LIVENESS_MARKER_PATH = path.join(process.cwd(), '.agent-live')
const LIVENESS_HEARTBEAT_MS = 60_000 // http-server.cjs's LIVENESS_FRESH_MS (150s) tolerates one missed beat

async function writeLivenessMarker() {
  const payload = { status: 'live', lastHeartbeat: new Date().toISOString(), pid: process.pid }
  await fs.writeFile(LIVENESS_MARKER_PATH, JSON.stringify(payload, null, 2) + '\n')
}

// ── Discord event handlers ──────────────────────────────────────────────────
discord.once(Events.ClientReady, (c) => {
  log(`Discord ready as ${c.user.tag}`)
  writeLivenessMarker().catch((err) => log(`liveness marker write failed: ${err.message}`))
  // .unref() -- this heartbeat must never be the reason the process stays
  // alive; it should only run while everything else keeps it alive anyway.
  setInterval(() => {
    writeLivenessMarker().catch((err) => log(`liveness heartbeat write failed: ${err.message}`))
  }, LIVENESS_HEARTBEAT_MS).unref()
})
discord.on(Events.Error, (err) => log('Discord client error:', err.message))

discord.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return
    if (message.channelId !== HOME_CHANNEL_ID) return

    const localPaths = []
    for (const img of extractImages(message)) {
      const p = await downloadImageToTmp(img.url, img.mime)
      if (p) localPaths.push(p)
    }

    let content = message.content || ''
    if (localPaths.length) content += `\n[image attachment(s) -- local path(s), open with Read tool:\n${localPaths.join('\n')}]`
    if (!content.trim()) content = '[empty message]'

    const sender = message.member?.displayName || message.author.username

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: { sender, channelId: message.channelId, authorId: message.author.id, timestamp: kstNow() },
      },
    })
  } catch (err) {
    log('MessageCreate handler error:', err.message)
  }
})

// ── boot ─────────────────────────────────────────────────────────────────
// Guarded behind an "am I the entry point" check (agent-lifecycle fix,
// 2026-07-03) so this file can be `import`-ed by a test harness (see
// scripts/test-liveness-marker.mjs) to exercise writeLivenessMarker()
// without also connecting real stdio/MCP transport or attempting a real
// Discord login -- mirrors memory/smoke.mjs's existing convention of
// setting env vars before importing a script that has module-scope side
// effects. When run directly (`node channel.mjs`, or as spawned by the
// claude CLI per .mcp.json), this still boots exactly as before.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

async function boot() {
  await mcp.connect(new StdioServerTransport())
  log(`MCP server up (${AGENT_NAME})`)

  try {
    await discord.login(DISCORD_TOKEN)
  } catch (err) {
    process.stderr.write(`[${AGENT_NAME}] FATAL: discord.login failed: ${err.message}\n`)
    process.exit(1)
  }
}

export { writeLivenessMarker, LIVENESS_MARKER_PATH }

if (isMainModule) {
  await boot()
}
