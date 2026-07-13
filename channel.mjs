#!/usr/bin/env node
// channel.mjs — minimal Discord MCP channel server for a single portable agent.
//
// Flow:
//   Discord message (home channel) -> MCP notification -> Claude Code
//   Claude "reply"/"read_channel_history" tool call -> discord.js -> Discord
//
// Trimmed from MAGI's channels/base-channel.mjs (4000-line, multi-agent,
// voice/B2B/lounge-aware) down to: one agent, one home channel, three tools.

import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
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

// ── DATA_HOME (agent-lifecycle fix, 2026-07-03, hardening item E1) ─────────
// Resolved EXPLICITLY here rather than trusting process.cwd(). Previously,
// LIVENESS_MARKER_PATH was `path.join(process.cwd(), '.agent-live')`, which
// only worked because .mcp.json's agent-channel entry happens to set
// cwd: DATA_HOME (see onboarding/http-server.cjs's ensureMcpJsonAgentName())
// -- a coincidence, not a guarantee. Any future change to how this process
// gets spawned (different cwd, a manual `node channel.mjs` from elsewhere)
// would silently write the marker to the wrong place, and the reader
// (http-server.cjs's GET /api/agent/status, which computes DATA_HOME
// independently, see its own DATA_HOME constant) would never see it --
// permanent false "connecting". The packaged Electron path always sets
// AGENT_DATA_HOME explicitly (main.cjs's spawnRealAgentChild()) to the
// exact fixed path http-server.cjs's own DATA_HOME constant computes, so
// the two can't drift THERE regardless of the fallback below.
//
// Fallback (AGENT_DATA_HOME unset) matches run.sh's OWN MEM resolution
// EXACTLY -- `MEM="${AGENT_DATA_HOME:-$HOME/Documents/$AGENT_NAME}"`, same
// env var, same formula, keyed by AGENT_NAME (not a fixed literal) --
// FIXED here (code-review pass, 2026-07-03) after two real bugs an
// independent review caught in the first version of this fix, which used
// a fixed `~/Documents/Scheherazade` fallback:
//   1. `npm start` (package.json's "start": "node channel.mjs") runs this
//      file directly with no AGENT_DATA_HOME set. A fixed fallback meant
//      local dev would read/write the SAME marker files
//      (DATA_HOME/.agent-live, .agent-failed.json) the real packaged,
//      onboarded app uses at ~/Documents/Scheherazade -- corrupting
//      production liveness/failure state from a dev run. (Confirmed this
//      exact failure mode once already during this fix's own verification
//      pass, on scripts/test-liveness-marker.mjs -- see that file's own
//      comment -- and initially only guarded there, not here.) Now, with
//      no AGENT_DATA_HOME, it resolves to ~/Documents/agent (AGENT_NAME's
//      own default, line above) instead -- nowhere near the real app's
//      fixed path, so a `npm start` dev run can no longer collide with it.
//   2. This fallback used to disagree with run.sh's OWN fallback for the
//      exact same no-AGENT_DATA_HOME case (a standalone/non-Electron CLI
//      deployment) -- run.sh writes its own write_failure()/clear_failure()
//      markers to $HOME/Documents/$AGENT_NAME, channel.mjs was writing its
//      markers to a DIFFERENT fixed directory. Now identical.
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', AGENT_NAME)

// ── liveness + failure markers (agent-lifecycle fix, 2026-07-03) ───────────
// Declared here, before the DISCORD_TOKEN/HOME_CHANNEL_ID guards below, so a
// missing-token FATAL exit can itself write a failure marker instead of
// just dying into run.sh's restart loop with nothing but a stderr line --
// see Critical B.
const LIVENESS_MARKER_PATH = path.join(DATA_HOME, '.agent-live')
const LIVENESS_HEARTBEAT_MS = 60_000 // http-server.cjs's LIVENESS_FRESH_MS (150s) tolerates one missed beat
const FAILURE_MARKER_PATH = path.join(DATA_HOME, '.agent-failed.json')

// Atomic write (temp file + rename): matches run.sh's own write_failure()
// (code-review pass, 2026-07-03 -- that function's own comment explicitly
// calls out atomic-write as necessary "so main.cjs's poller never reads a
// half-written file"; this one shares the exact same consumer
// (pollFailureMarker()) and file, and a plain writeFile() here left a real,
// if self-healing, window where a 3s poll tick landing mid-write would hit
// a JSON.parse error on a truncated read). fs.rename is atomic on the same
// filesystem, which a temp file in the same directory always is.
async function atomicWriteJson(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n')
  await fs.rename(tmpPath, filePath)
}

async function writeLivenessMarker() {
  const payload = { status: 'live', lastHeartbeat: new Date().toISOString(), pid: process.pid }
  await atomicWriteJson(LIVENESS_MARKER_PATH, payload)
}

// Critical B (agent-lifecycle model-divergent review, 2026-07-03): a bad/
// revoked Discord token or a missing-token boot used to just exit this
// process into run.sh's own restart loop with no on-disk signal beyond
// stderr -- main.cjs's agent-status.cjs never saw it, so the onboarding UI
// stayed on "connecting" forever. This marker is the distinct failure
// signal main.cjs's failure-marker poller (see main.cjs's
// pollFailureMarker()) surfaces as setAgentStatus('failed', code, reason)
// within a bounded time. Shares its DATA_HOME/.agent-failed.json path +
// JSON shape with run.sh's own restart-ladder failure write (see run.sh's
// run_loop() / write_failure()) so main.cjs only needs to poll one file
// regardless of which layer -- the bash restart loop, or this process's
// own login failure -- detected the problem first.
//
// `code` (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1): the stable
// machine-readable cause main.cjs's pollFailureMarker() relays into
// setAgentStatus(). Every current call site below passes 'discord_token_bad'
// EXCEPT the missing-HOME_CHANNEL_ID guard, which is a distinct config gap
// (not the bot token itself, and there's no dedicated code for it in the
// enum) -- it passes 'unknown' rather than mislabeling it as a token
// problem. Defaults to 'unknown' if a future call site forgets to pass one,
// so this never silently emits a marker with no code field at all.
async function writeFailureMarker(reason, code = 'unknown') {
  const payload = { status: 'failed', reason, code, since: new Date().toISOString(), pid: process.pid }
  await atomicWriteJson(FAILURE_MARKER_PATH, payload)
}

if (!DISCORD_TOKEN) {
  const reason = 'DISCORD_BOT_TOKEN not set. Check .env (or the .mcp.json env block).'
  process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
  await writeFailureMarker(reason, 'discord_token_bad').catch((err) =>
    process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${err.message}\n`)
  )
  process.exit(1)
}
if (!HOME_CHANNEL_ID) {
  const reason = 'HOME_CHANNEL_ID not set. Check .env (or the .mcp.json env block).'
  process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
  // Not 'discord_token_bad' -- this is a missing channel ID, not a bad/
  // missing bot token, and the cause-code enum has no dedicated code for
  // it. 'unknown' (the writeFailureMarker default) is the honest choice.
  await writeFailureMarker(reason).catch((err) =>
    process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${err.message}\n`)
  )
  process.exit(1)
}

// ── Local-time timestamps ───────────────────────────────────────────────────
// new Date().toISOString() is UTC; the model reads this as "now", so it needs
// an explicit local-time offset. Was hardcoded KST (+9) -- Mino 07-13
// click-test: "하드코딩하지말고 시스템 시간 가져와라". Offset now comes from
// the system timezone, so the app is correct wherever the user runs it.
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],
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
Use "send_file_to_discord" (channelId, filePath, comment?) to upload a local file (image, document, etc.) to the channel -- "reply" is text-only.
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
    name: 'send_file_to_discord',
    description: 'Upload a local file (image, document, etc.) to a Discord channel. Use this for attachments -- the reply tool is text-only.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        filePath: { type: 'string', description: 'Full local path of the file to upload' },
        comment: { type: 'string', description: 'Optional message text sent with the file' },
      },
      required: ['channelId', 'filePath'],
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
const SendFileArgs = z.object({ channelId: z.string().min(1), filePath: z.string().min(1), comment: z.string().optional() })
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
    clearThinking(channelId).catch((err) => log('thinking reaction clear failed:', err.message))
    return { content: [{ type: 'text', text: `sent to ${channelId} (${chunks.length} message${chunks.length > 1 ? 's' : ''})` }] }
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
    // Discord's default bot upload cap is 10 MiB -- fail here with a clear
    // message instead of letting the API return an opaque 40005.
    const MAX_UPLOAD = 10 * 1024 * 1024
    if (stat.size > MAX_UPLOAD) {
      return { content: [{ type: 'text', text: `file too large for Discord upload: ${(stat.size / 1024 / 1024).toFixed(1)}MB (limit 10MB)` }], isError: true }
    }
    const ch = await fetchTextChannel(parsed.channelId)
    const msg = await ch.send({
      content: parsed.comment || '',
      files: [{ attachment: filePath, name: path.basename(filePath) }],
      allowedMentions: SAFE_MENTIONS,
    })
    clearThinking(parsed.channelId).catch((err) => log('thinking reaction clear failed:', err.message))
    const urls = [...msg.attachments.values()].map((a) => a.url)
    return { content: [{ type: 'text', text: `file sent to ${parsed.channelId}: ${path.basename(filePath)}${urls.length ? `\nCDN URL: ${urls.join('\n')}` : ''}` }] }
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
        timestamp: localISO(m.createdTimestamp),
        attachments: [...m.attachments.values()].map((a) => a.url),
      }))
    return { content: [{ type: 'text', text: JSON.stringify({ channelId, count: result.length, messages: result }, null, 2) }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

// ── Discord event handlers ──────────────────────────────────────────────────
// (LIVENESS_MARKER_PATH / writeLivenessMarker() / FAILURE_MARKER_PATH /
// writeFailureMarker() are declared up near the DATA_HOME/config block above
// -- moved there, 2026-07-03, so the DISCORD_TOKEN/HOME_CHANNEL_ID FATAL
// guards can call writeFailureMarker() before exiting. GET
// /api/agent/status polls the liveness marker's freshness to gate the
// onboarding wizard's Step 5 success screen on REAL Discord-level liveness,
// not just the ONBOARDING_COMPLETE flag flip.)
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

// ── Thinking indicator (Mino 07-13 click-test feedback: MAGI-style 🤔
// reaction while the agent composes, removed when the reply lands, plus a
// one-shot typing indicator for the instant cue). Both are best-effort --
// a failed reaction must never block message forwarding. ─────────────────
const THINKING_EMOJI = '🤔'
const pendingThinking = new Map() // channelId -> Set<messageId>

function addThinking(message) {
  message.channel.sendTyping().catch(() => {})
  message
    .react(THINKING_EMOJI)
    .then(() => {
      if (!pendingThinking.has(message.channelId)) pendingThinking.set(message.channelId, new Set())
      pendingThinking.get(message.channelId).add(message.id)
    })
    .catch((err) => log('thinking reaction add failed:', err.message))
}

async function clearThinking(channelId) {
  const msgSet = pendingThinking.get(channelId)
  if (!msgSet || msgSet.size === 0) return
  pendingThinking.delete(channelId)
  for (const msgId of msgSet) {
    try {
      const ch = await fetchTextChannel(channelId)
      const msg = await ch.messages.fetch(msgId)
      const reaction = msg.reactions.cache.get(THINKING_EMOJI)
      if (reaction) await reaction.users.remove(discord.user.id)
    } catch (err) {
      log('thinking reaction remove failed:', err.message)
    }
  }
}

discord.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return
    if (!message.channel.isDMBased() && message.channelId !== HOME_CHANNEL_ID) return

    addThinking(message)

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
        meta: { sender, channelId: message.channelId, authorId: message.author.id, timestamp: localNow() },
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
    // Critical B: a bad/revoked bot token fails here fast (Discord's REST
    // gateway rejects it in seconds, not a 12h hang) -- write the distinct
    // failure marker so main.cjs's poller surfaces this as
    // setAgentStatus('failed', 'discord_token_bad', reason) instead of the
    // UI sitting on "connecting" forever while run.sh's __loop keeps
    // restarting this process. Same code as the missing-token guard above
    // -- same user-facing action either way: fix the Discord bot token.
    const reason = `discord.login failed: ${err.message}`
    process.stderr.write(`[${AGENT_NAME}] FATAL: ${reason}\n`)
    await writeFailureMarker(reason, 'discord_token_bad').catch((markerErr) =>
      process.stderr.write(`[${AGENT_NAME}] also failed to write failure marker: ${markerErr.message}\n`)
    )
    process.exit(1)
  }
}

export { writeLivenessMarker, LIVENESS_MARKER_PATH, writeFailureMarker, FAILURE_MARKER_PATH, DATA_HOME }

if (isMainModule) {
  await boot()
}
