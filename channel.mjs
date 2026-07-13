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
  startShutdownRequestWatcher()
  startAutonomyWatcher()
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
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
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
        },
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

async function readAgentConfigFile() {
  // Read on every poll, never cached: the settings page can flip consent or
  // the cap at any moment, and a cached "yes" would keep spending after the
  // user said stop. Config is the shell-style KEY="value" file run.sh sources.
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
  const tmp = `${AUTONOMY_STATE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, AUTONOMY_STATE_PATH)
}

function startAutonomyWatcher() {
  const budgetMod = require(path.join(MODULE_DIR, 'autonomy', 'budget.cjs'))
  const cycleMod = require(path.join(MODULE_DIR, 'autonomy', 'cycle.cjs'))

  setInterval(async () => {
    if (autonomyInFlight) return
    autonomyInFlight = true
    try {
      const config = await readAgentConfigFile()
      const state = await readAutonomyState()

      // The cheap exit, and it is narrower than it looks. It used to be just
      // "AUTONOMY !== yes -> return", which meant that turning consent OFF
      // mid-night made this watcher fall SILENT -- and a silent watcher does
      // not stop the agent, because the agent was told once to work and is
      // running its own loop. Withdrawal has to be able to speak. So we only
      // skip when there is nothing outstanding: no cycle, or a cycle already
      // stopped AND already briefed.
      const consented = String(config.AUTONOMY || '').toLowerCase() === 'yes'
      const settled = !state || !state.cycleDay ||
        (state.stoppedDay === state.cycleDay && state.briefDay === state.cycleDay)
      if (!consented && settled) return

      const cap = Number(config.AUTONOMY_TOKEN_CAP || config.AUTONOMY_DAILY_TOKEN_CAP || budgetMod.DEFAULT_DAILY_CAP)
      const decision = cycleMod.decideAutonomy({
        now: new Date(),
        config,
        state,
        // sinceMs anchors the cap to THE NIGHT: cycle.cjs hands us the start of
        // the running cycle (or null if none has begun). Measuring per calendar
        // day handed a 23:00-05:00 night a second full budget at midnight.
        readBudget: (sinceMs) => budgetMod.budgetState(DATA_HOME, cap, new Date(), sinceMs),
      })

      if (decision.action === 'none') {
        // Persist skip bookkeeping (why the night was quiet) without noise.
        if (decision.nextState) await writeAutonomyState(decision.nextState)
        return
      }

      // The wording is a contract with stop-reply-guard (start/stop must carry
      // a SKIP_PATTERN, brief must not), so it is chosen next to the decision
      // that produced it, not here. cycle.cjs owns both; the tests assert both.
      const content = cycleMod.injectFor(decision)
      if (!content) return

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: { sender: 'SYSTEM', channelId: HOME_CHANNEL_ID, authorId: '', timestamp: localNow() },
        },
      })
      // State advances only on SUCCESSFUL delivery -- same reasoning as the
      // shutdown watcher's dedup marker. Advancing first would turn one
      // transient notification failure into "the brief was never sent and we
      // recorded that it was", which is exactly the class of lie this whole
      // build is about.
      await writeAutonomyState(decision.nextState)
      log(`autonomy: ${decision.action} -- ${decision.reason}`)
    } catch (err) {
      log(`autonomy watcher error (will retry next poll): ${err.message}`)
    } finally {
      autonomyInFlight = false
    }
  }, AUTONOMY_POLL_MS).unref()
}

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
