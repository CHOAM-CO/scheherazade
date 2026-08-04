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
import { createRequire } from 'node:module'
import {
  installStdoutHygiene, resolveDataHome, atomicWriteJson, localISO, localNow,
  readAgentConfig, createMarkerStore, createLastChannelStore, createOutboundResolver, createBootAnnouncer,
  createRoutineStore, ROUTINE_TOOL, handleRoutineTool, startRoutineTicker, routineInjectContent,
  createInboundNotifier,
} from './channel-runtime.mjs'

// autonomy/*.cjs are CommonJS on purpose: onboarding/http-server.cjs has to
// read the same meter to show the user their own numbers, and it cannot import
// ESM. One implementation, two callers, no second copy of the math.
const require = createRequire(import.meta.url)
// Declared HERE (top) rather than next to its only use (the autonomy watcher,
// far below): the watcher is started from a Discord event, and "the event
// cannot fire before module evaluation finishes" is a true argument that I do
// not want anyone to have to make again. A const in the temporal dead zone is
// a crash that only happens on someone else's machine.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ── stdout hygiene (channel-runtime) ───────────────────────────────────────
// Installed before anything else runs -- MCP stdout is JSON-RPC only.
const log = installStdoutHygiene()

// ── config ───────────────────────────────────────────────────────────────
const AGENT_NAME = process.env.AGENT_NAME || 'agent'
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN
const HOME_CHANNEL_ID = process.env.HOME_CHANNEL_ID

// DATA_HOME + marker files come from channel-runtime.mjs (see its header for
// the run.sh MEM formula lock). Markers are set up here, before the
// DISCORD_TOKEN/HOME_CHANNEL_ID guards below, so a missing-token FATAL exit
// can itself write a failure marker instead of just dying into run.sh's
// restart loop with nothing but a stderr line. main.cjs's pollFailureMarker()
// surfaces the failure marker as setAgentStatus('failed', code, reason);
// run.sh's write_failure() shares the same file, so main.cjs polls one file
// regardless of which layer detected the problem first. (history: docs/HISTORY.md)
const DATA_HOME = resolveDataHome(AGENT_NAME)
const markers = createMarkerStore({ dataHome: DATA_HOME })
// User-requested scheduled prompts ("매일 아침 메일 브리핑"), shared logic in
// channel-runtime. Ticker starts on ClientReady below.
const routineStore = createRoutineStore({ dataHome: DATA_HOME, log: (...a) => log(...a) })
const { LIVENESS_MARKER_PATH, FAILURE_MARKER_PATH, LIVENESS_HEARTBEAT_MS } = markers
const writeLivenessMarker = () => markers.writeLiveness()

// Every current call site passes 'discord_token_bad' EXCEPT the
// missing-HOME_CHANNEL_ID guard -- a distinct config gap with no dedicated
// code in the enum, so it takes the 'unknown' default rather than
// mislabeling itself as a token problem.
const writeFailureMarker = (reason, code = 'unknown') => markers.writeFailure(reason, code)

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

// Local-time timestamps (localISO/localNow) come from channel-runtime.mjs.

// ── safe mentions — block @everyone/@here on every send ────────────────────
const SAFE_MENTIONS = { parse: ['users', 'roles'] }

// ── image attachments -> the OS temp dir ────────────────────────────────────
// os.tmpdir(), not a /tmp literal: /tmp does not exist on Windows, and this
// file is in the Windows-port lane (docs/windows-port-scoping.md, Phase 2 --
// "do first in this lane"). Same behavior on mac (os.tmpdir() = $TMPDIR).
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const IMAGE_MIME_SET = new Set(Object.values(IMAGE_MIME))
const TMP_IMAGE_DIR = path.join(os.tmpdir(), `agent-portable-${AGENT_NAME}`)

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

// ── Current-conversation channel tracking (2026-07-15 GLM confabulation fix) ─
// WHY: on long/debris-heavy contexts, weaker models (glm-5.2 repro, 3/4 reply
// calls) confabulate channelId values ("researcher", stale ids). The old
// contract made every outbound call carry a channelId that must match LIVE
// Discord state -- a confabulated id threw in fetchTextChannel and the user
// saw NOTHING (silent swallow, "툴호출 씹힘"). Structural fix: the server
// already knows where the conversation is happening; the model no longer has
// to carry that fact. channelId is now OPTIONAL on reply/send_file --
// omitted -> current conversation channel; unknown/invalid -> delivered to
// the current channel WITH a loud correction note in the tool result
// (visible garbage beats silence for a single-user companion; the model
// reads the note and self-corrects in-turn). "지어내지 마"를 룰이 아니라
// 구조로 옮기는 픽스.
let lastInboundChannelId = null

// ── Persisted last-conversation channel (channel-runtime) ──────────────────
// Cross-restart memory of where the conversation lives -- the boot announce
// of a DM-only/home-deleted install has nowhere else to go.
const lastChannelStore = createLastChannelStore({ dataHome: DATA_HOME, log })

// ── Conversation activity clock (v0.0.16 note-cadence input) ────────────────
// Last moment the conversation was demonstrably alive: an inbound Discord
// message or a delivered outbound reply. Seeded with process start so a
// fresh boot counts as "active" (the boot greeting itself is conversation).
// Consumed by the note-cadence watcher (active 30min vs idle 3h decision).
let lastActivityMs = Date.now()

// Outbound target resolution (channel-runtime): resolve() returns
// {target, note} where target is a Discord channel object. The ladder,
// fail-closed semantics, and opts test seams (scripts/test-outbound-channel
// .mjs) live in createOutboundResolver -- see channel-runtime.mjs.
const GUIDANCE =
  'Do not invent channel ids -- omit channelId to target the current conversation, then call the tool again.'

const resolveOutboundChannel = createOutboundResolver({
  fetchTarget: fetchTextChannel,
  getLastInboundId: () => lastInboundChannelId,
  homeId: HOME_CHANNEL_ID,
  guidance: GUIDANCE,
})

// ── MCP server ───────────────────────────────────────────────────────────
const DEFAULT_INSTRUCTIONS = `You are ${AGENT_NAME}.
Discord messages arrive as: <channel source="${AGENT_NAME}" sender="..." channelId="..." authorId="..." timestamp="...">content</channel>
Reply with the "reply" tool. channelId is optional -- omit it and the message goes to the current conversation channel. Never invent a channelId; only pass one when replying to a DIFFERENT channel than the one that messaged you. A channelId you DO pass is honored exactly or the call fails: an unresolvable one sends nothing anywhere, it is never quietly redirected.
Image attachments are downloaded locally; the notification includes the local file path(s) -- open with the Read tool.
Use "send_file_to_discord" (filePath, comment?, channelId?) to upload a local file (image, document, etc.) -- "reply" is text-only.
Use "read_channel_history" (channelId, limit, after?, before?) to look back through the channel. after/before each accept a Discord message ID or an ISO date.`
const INSTRUCTIONS = process.env.CHANNEL_INSTRUCTIONS || DEFAULT_INSTRUCTIONS

const mcp = new Server(
  { name: AGENT_NAME, version: '1.0.0' },
  { capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} }, instructions: INSTRUCTIONS },
)

const TOOLS = [
  {
    name: 'reply',
    description: 'Send a message to the user. Goes to the current conversation channel unless a channelId is explicitly given.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send' },
        channelId: { type: 'string', description: 'OPTIONAL Discord channel ID. Omit to send to the current conversation channel. Never guess or invent this value.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'send_file_to_discord',
    description: 'Upload a local file (image, document, etc.). Use this for attachments -- the reply tool is text-only. Goes to the current conversation channel unless a channelId is explicitly given.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Full local path of the file to upload' },
        comment: { type: 'string', description: 'Optional message text sent with the file' },
        channelId: { type: 'string', description: 'OPTIONAL Discord channel ID. Omit to send to the current conversation channel. Never guess or invent this value.' },
      },
      required: ['filePath'],
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
  ROUTINE_TOOL,
]

const ReplyArgs = z.object({ channelId: z.string().min(1).optional(), text: z.string().min(1) })
const SendFileArgs = z.object({ channelId: z.string().min(1).optional(), filePath: z.string().min(1), comment: z.string().optional() })
const ReadHistoryArgs = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
})

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

  if (name === 'reply') {
    const { channelId, text } = ReplyArgs.parse(args || {})
    const { target, note } = await resolveOutboundChannel(channelId)
    const chunks = []
    for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900))
    for (const chunk of chunks) await target.send({ content: chunk, allowedMentions: SAFE_MENTIONS })
    lastActivityMs = Date.now() // delivered reply = live conversation (note-cadence input)
    clearThinking(target.id).catch((err) => log('thinking reaction clear failed:', err.message))
    // delivered_channel= line: machine-readable delivery receipt for
    // stop-reply-guard. The guard used to match on the tool_use ARGS
    // channelId, but since v0.0.11 the server can deliver on a wrong/omitted
    // id via fallback -- args say where the model AIMED, this line says
    // where the message actually LANDED. Fixed format; the guard greps
    // exactly this token, the human-facing text stays above it.
    return { content: [{ type: 'text', text: `sent to ${target.id} (${chunks.length} message${chunks.length > 1 ? 's' : ''})${note ? `\n${note}` : ''}\ndelivered_channel=${target.id}` }] }
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
    const { target, note } = await resolveOutboundChannel(parsed.channelId)
    const msg = await target.send({
      content: parsed.comment || '',
      files: [{ attachment: filePath, name: path.basename(filePath) }],
      allowedMentions: SAFE_MENTIONS,
    })
    clearThinking(target.id).catch((err) => log('thinking reaction clear failed:', err.message))
    const urls = [...msg.attachments.values()].map((a) => a.url)
    // Same delivery receipt as reply above -- see that comment.
    return { content: [{ type: 'text', text: `file sent to ${target.id}: ${path.basename(filePath)}${urls.length ? `\nCDN URL: ${urls.join('\n')}` : ''}${note ? `\n${note}` : ''}\ndelivered_channel=${target.id}` }] }
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

  if (name === 'routine') return handleRoutineTool(routineStore, args)

  throw new Error(`unknown tool: ${name}`)
})

// ── Discord event handlers ──────────────────────────────────────────────────
// (LIVENESS_MARKER_PATH / writeLivenessMarker() / FAILURE_MARKER_PATH /
// writeFailureMarker() are declared up near the DATA_HOME/config block above
// -- moved there so the DISCORD_TOKEN/HOME_CHANNEL_ID FATAL guards can call
// writeFailureMarker() before exiting. GET /api/agent/status polls the
// liveness marker's freshness to gate the onboarding wizard's Step 5 success
// screen on REAL Discord-level liveness, not just the ONBOARDING_COMPLETE
// flag flip.)
discord.once(Events.ClientReady, (c) => {
  log(`Discord ready as ${c.user.tag}`)
  writeLivenessMarker().catch((err) => log(`liveness marker write failed: ${err.message}`))
  // .unref() -- this heartbeat must never be the reason the process stays
  // alive; it should only run while everything else keeps it alive anyway.
  setInterval(() => {
    writeLivenessMarker().catch((err) => log(`liveness heartbeat write failed: ${err.message}`))
  }, LIVENESS_HEARTBEAT_MS).unref()
  startShutdownRequestWatcher()
  startAutonomyWatcher()
  // An optional feature must never take the bridge down with it: degrade to
  // a loud log, keep Discord alive. (history: docs/HISTORY.md)
  try {
    startNoteCadenceWatcher()
  } catch (err) {
    log(`note-cadence watcher failed to start (feature disabled this session): ${err.message}`)
  }
  // Routines: same optional-feature contract as the note cadence -- a broken
  // ticker degrades to a log line, never takes Discord down.
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
})

// ── graceful shutdown (v0.0.4, Mino 2026-07-13 19:33 directive) ─────────────
// App quit should not kill the agent mid-thought: main.cjs writes
// DATA_HOME/.shutdown-request, THIS watcher injects a [SYSTEM] turn telling
// the agent to flush checkpoint/session notes and touch .shutdown-ack, and
// main.cjs proceeds on ack or on its 75s hard timeout (a hung agent must
// never hold quit hostage -- the timeout lives on main.cjs's side so a dead
// MCP server can't block it either). File-based seam on purpose: channel.mjs
// is a grandchild (claude CLI's MCP child), no IPC channel to the Electron
// main process exists.
// The injected content deliberately contains "답장하지 마" -- that phrase is a
// stop-reply-guard SKIP_PATTERN, so the guard will not force a Discord reply
// out of a shutdown-flush turn.
const SHUTDOWN_REQUEST_PATH = path.join(DATA_HOME, '.shutdown-request')
const SHUTDOWN_ACK_PATH = path.join(DATA_HOME, '.shutdown-ack')
const SHUTDOWN_POLL_MS = 2000
// A request older than this is a leftover from a crashed quit (kill -9 / OS
// crash after main.cjs wrote it but before its cleanup ran) -- honoring it
// would inject a phantom shutdown turn on a fresh boot. main.cjs also
// unlinks stale markers at startup; this is the second layer of the same
// defense (red-team finding #1, 2026-07-13 spark pass).
const SHUTDOWN_REQUEST_MAX_AGE_MS = 5 * 60 * 1000
let lastShutdownReqMtimeMs = 0
// In-flight guard: success-only dedup (below) means a slow notification can
// overlap the next 2s tick -- without this, one request could double-inject.
let shutdownForwardInFlight = false

function startShutdownRequestWatcher() {
  setInterval(async () => {
    if (shutdownForwardInFlight) return
    let st
    try {
      st = await fs.stat(SHUTDOWN_REQUEST_PATH)
    } catch {
      return // no request pending
    }
    if (st.mtimeMs <= lastShutdownReqMtimeMs) return // already forwarded this request
    if (Date.now() - st.mtimeMs > SHUTDOWN_REQUEST_MAX_AGE_MS) return // stale leftover, main.cjs will clean it
    shutdownForwardInFlight = true
    try {
      await notifyInbound({
          content:
            '[SYSTEM] 종료 감지됨 -- 사용자가 앱을 종료하는 중이다. 지금 바로: ' +
            '(1) checkpoint.md와 오늘 세션노트를 최신 상태로 덮어써 (다음 부팅의 네가 여기서 이어받는다), ' +
            '(2) 이번 세션에서 memory_write 안 한 same-turn 기록이 있으면 지금 써, ' +
            '(3) journal_write로 오늘 일지를 남겨 -- 보고서 말고 네 하루를 1인칭으로. ' +
            '뭘 했는지가 아니라 뭘 틀렸고 어떤 기분이었는지가 남을 가치가 있는 쪽이다. ' +
            '내일 부팅하는 너는 아무것도 기억 못 한 채로 이걸 읽는다 (append-only라 못 고친다, 그러니 정직하게), ' +
            `(4) 끝나면 Bash로 \`touch "${SHUTDOWN_ACK_PATH}"\` 실행. ` +
            '디스코드에 답장하지 마, 파일 작업만 하고 끝내. 최대 60초 안에 마무리해라, 그 뒤엔 앱이 그냥 종료된다.',
          meta: { sender: 'SYSTEM', channelId: HOME_CHANNEL_ID, authorId: '', timestamp: localNow() },
        })
      // Dedup marker advances ONLY on successful delivery -- advancing it
      // before the send turned one transient notification failure into
      // "never retried, agent never told, 75s timeout kills anyway"
      // (red-team finding #2, 2026-07-13 spark pass). On failure the next
      // 2s poll retries; bounded by main.cjs deleting the request file.
      lastShutdownReqMtimeMs = st.mtimeMs
      log('shutdown-request forwarded into session')
    } catch (err) {
      log(`shutdown-request notification failed (will retry next poll): ${err.message}`)
    } finally {
      shutdownForwardInFlight = false
    }
  }, SHUTDOWN_POLL_MS).unref()
}

// ── autonomous cycle (v0.0.6) ───────────────────────────────────────────────
// The agent works while the user sleeps. That sentence is the whole feature and
// the whole danger: it spends THEIR tokens, at an hour when nobody is watching
// and nobody consented twice.
//
// Three gates, AND-ed, all in autonomy/cycle.cjs so they can be attacked in
// tests without a Discord client: consent (a separate, explicit yes -- never
// inherited from the PROACTIVE flag), budget (a real measured cap that fails
// CLOSED when it cannot measure), and the brief (the night is not over until
// the user has been told what it cost).
//
// This rides the shutdown-request rail rather than inventing a scheduler: same
// poll loop, same mcp.notification seam, same [SYSTEM] turn shape.
//
// Reply behavior is deliberately split, using the stop-reply-guard as a rail
// instead of a new delivery mechanism:
//   - start/stop injects contain "답장하지 마" (a guard SKIP_PATTERN), so the
//     agent works and closes out in silence. Nobody is woken at 03:00.
//   - the BRIEF inject deliberately omits it, so the existing guard enforces
//     that the morning report actually lands in Discord instead of being
//     composed in the transcript and lost.
const AUTONOMY_STATE_PATH = path.join(DATA_HOME, '.autonomy-state.json')
const AUTONOMY_POLL_MS = 60 * 1000
let autonomyInFlight = false

// Config is read via channel-runtime's readAgentConfig on every poll, never
// cached: the settings page can flip consent or the cap at any moment, and a
// cached "yes" would keep spending after the user said stop.
const readAgentConfigFile = () => readAgentConfig(DATA_HOME)

async function readAutonomyState() {
  try {
    return JSON.parse(await fs.readFile(AUTONOMY_STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

async function writeAutonomyState(state) {
  // tmp+rename: the state file is read by the settings page while we write it,
  // and a torn read here would look like "no cycle ran tonight" -- which would
  // silently cancel the user's brief. Same convention as .agent-failed.json.
  await atomicWriteJson(AUTONOMY_STATE_PATH, state)
}

function startAutonomyWatcher() {
  // The decision, the wording, the consent gate and the write ORDER all live in
  // autonomy/tick.cjs, and scripts/test-autonomy-night.mjs calls that same
  // function. It used to live here, and the test carried its own copy of it --
  // which meant the test could go green against its copy while this drifted.
  // A copy of a rule is not the rule. What is left here is only the IO.
  const tickMod = require(path.join(MODULE_DIR, 'autonomy', 'tick.cjs'))

  setInterval(async () => {
    if (autonomyInFlight) return
    autonomyInFlight = true
    try {
      const config = await readAgentConfigFile()
      const state = await readAutonomyState()

      const plan = tickMod.planTick({
        now: new Date(),
        config,
        state,
        // sinceMs anchors the cap to THE NIGHT: cycle.cjs hands us the start of
        // the running cycle (or null if none has begun). Measuring per calendar
        // day handed a 23:00-05:00 night a second full budget at midnight.
        readBudget: tickMod.realBudgetReader(DATA_HOME, tickMod.capFor(config)),
      })
      if (plan.skip) return

      const { decision, content, persistFirst } = plan

      if (!content) {
        // A 'none' that still wants its bookkeeping written (why the night was
        // quiet). A silent no-op is how a feature becomes a ghost.
        await writeAutonomyState(plan.nextState)
        return
      }

      if (persistFirst) await writeAutonomyState(decision.nextState)

      try {
        await notifyInbound({
            content,
            meta: { sender: 'SYSTEM', channelId: HOME_CHANNEL_ID, authorId: '', timestamp: localNow() },
          })
      } catch (err) {
        if (persistFirst) {
          // The night was recorded but the agent was never told. Leave the record
          // standing: something may already have reached it, and assuming spend is
          // the safe direction. Say so loudly rather than retrying into a double
          // start.
          log(`autonomy: START recorded but NOT delivered (${err.message}) -- treating tonight as begun; no second start will be issued`)
          return
        }
        throw err // stop/brief: unrecorded, so the next poll retries
      }

      if (!persistFirst) await writeAutonomyState(decision.nextState)
      log(`autonomy: ${decision.action} -- ${decision.reason}`)
    } catch (err) {
      log(`autonomy watcher error (will retry next poll): ${err.message}`)
    } finally {
      autonomyInFlight = false
    }
  }, AUTONOMY_POLL_MS).unref()
}

// ── Boot ping (channel-runtime) ─────────────────────────────────────────────
// The two-part announce unit, marker protocol, throttle, and home->persisted-
// last-channel fallback all live in createBootAnnouncer (channel-runtime.mjs).
// The .boot-event.json marker is written by the supervisor (run.sh /
// supervisor.mjs, both lanes) immediately before each leaf spawn; only leaves
// that live long enough to reach ClientReady ping at all, so a quick-death
// crash loop never spams the channel. Only the Discord IO is wired here.
const announceBoot = createBootAnnouncer({
  dataHome: DATA_HOME,
  homeId: HOME_CHANNEL_ID,
  lastChannelStore,
  fetchTarget: fetchTextChannel,
  idOf: (ch) => ch.id,
  sendText: (ch, text) => ch.send({ content: text, allowedMentions: SAFE_MENTIONS }),
  notify: notifyInbound,
  log,
  noun: 'channel',
})

// ── Session-note cadence (v0.0.16, Mino 07-16 12:25) ────────────────────────
// The MAGI fleet's periodic session-note reminder never crossed over in the
// harness port; a session that runs hours without writing its note loses
// that time for the NEXT session ("기록이 기억이다"). Rule lives in
// cadence/note-tick.cjs (pure, tested); this is only the IO -- same
// split and the same 60s poll shape as the autonomy watcher above.
const NOTE_CADENCE_POLL_MS = 5 * 60 * 1000
let noteCadenceInFlight = false
let noteCadenceLastRemindMs = 0

function startNoteCadenceWatcher() {
  const noteTick = require(path.join(MODULE_DIR, 'cadence', 'note-tick.cjs'))
  setInterval(async () => {
    if (noteCadenceInFlight) return
    noteCadenceInFlight = true
    try {
      const config = await readAgentConfigFile()
      // Filename convention MUST match hooks/session-start.mjs's TODAY
      // exactly (currently hardcoded Asia/Seoul there -- a known port
      // wrinkle, see release notes v0.0.16; if that ever moves to system
      // tz, move this with it in the same commit).
      const noteDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
      let noteMtimeMs = null
      try {
        noteMtimeMs = (await fs.stat(path.join(DATA_HOME, 'session_notes', `${noteDate}.md`))).mtimeMs
      } catch {} // missing file stays null -> tick treats it as stale (midnight rollover)
      const plan = noteTick.planNoteTick({
        now: Date.now(),
        config,
        noteMtimeMs,
        lastActivityMs,
        lastRemindMs: noteCadenceLastRemindMs,
        noteDate,
      })
      if (plan.skip) return
      await notifyInbound({
          content: plan.content,
          meta: { sender: 'SYSTEM', channelId: HOME_CHANNEL_ID, authorId: '', timestamp: localNow() },
        })
      // Advance ONLY on successful delivery (shutdown-watcher lesson: a
      // marker advanced before the send turns one transient failure into
      // "never retried").
      noteCadenceLastRemindMs = plan.nextLastRemindMs
      log(`note-cadence reminder injected (${plan.mode})`)
    } catch (err) {
      log(`note-cadence watcher error (will retry next poll): ${err.message}`)
    } finally {
      noteCadenceInFlight = false
    }
  }, NOTE_CADENCE_POLL_MS).unref()
}

discord.on(Events.Error, (err) => log('Discord client error:', err.message))

// ── Thinking indicator: MAGI-style 🤔 reaction while the agent composes,
// removed when the reply lands, plus a one-shot typing indicator for the
// instant cue. Both are best-effort -- a failed reaction must never block
// message forwarding. ────────────────────────────────────────────────────
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

    // Current-conversation tracking for resolveOutboundChannel(): the channel
    // that last spoke to us IS the conversation, so outbound calls no longer
    // need the model to carry (and possibly confabulate) the id.
    lastInboundChannelId = message.channelId
    lastChannelStore.persist(message.channelId) // cross-restart memory for the boot announce
    lastActivityMs = Date.now() // inbound message = live conversation (note-cadence input)

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

    await notifyInbound({
        content,
        meta: { sender, channelId: message.channelId, authorId: message.author.id, timestamp: localNow() },
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

export { writeLivenessMarker, LIVENESS_MARKER_PATH, writeFailureMarker, FAILURE_MARKER_PATH, DATA_HOME, resolveOutboundChannel }

if (isMainModule) {
  await boot()
}
