// channel-local.mjs — in-app chat counterpart to channel.mjs (the Discord MCP
// channel). Same contract, same tool names, same notification method; the only
// thing that changes is the wire: instead of a Discord gateway there is a
// loopback HTTP listener that the app's own chat page talks to.
//
//   inbound:  POST /in  -> mcp.notification('notifications/claude/channel')
//   outbound: `reply` tool -> outbound queue -> GET /out (the page polls)
//
// WHY THIS EXISTS: before it, every way to talk to the agent went through a
// third-party messenger. A new user had to create a bot application, mint a
// token, clear 2FA, flip a privileged intent and invite the bot to a server
// BEFORE exchanging one message, and the wizard's "do this later" escape ended
// setup with an agent they could not reach. This backend removes the third
// party from the critical path; Discord/Slack/Telegram become the upgrade you
// choose when you want the agent on your phone, not the toll you pay to start.
//
// TOOL NAMES ARE FROZEN, INCLUDING THE WRONG-LOOKING ONE. `reply`,
// `send_file_to_discord` and `read_channel_history` are matched as exact
// strings by the allowlist in onboarding/templates/claude-settings.local.json
// and by every PreToolUse hook. `send_file_to_discord` keeps its Discord
// flavor here even though nothing about this backend is Discord: renaming it
// yields a silently unapproved tool and dead hooks, which fails as silence
// rather than as an error (http-server.cjs:576-581, same reason Slack and
// Telegram kept it).

import 'dotenv/config'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  installStdoutHygiene, resolveDataHome, localNow,
  createMarkerStore,
} from './channel-runtime.mjs'

const log = installStdoutHygiene()

const AGENT_NAME = process.env.AGENT_NAME || 'agent'
const DATA_HOME = resolveDataHome(AGENT_NAME)
const markers = createMarkerStore({ dataHome: DATA_HOME })

// The one conversation this backend has. Discord/Slack/Telegram carry real
// platform ids here; there is exactly one local chat, so the id is a constant
// rather than a value to invent per message. Kept non-empty and stable so the
// meta shape stays identical to the other backends and downstream consumers
// (hooks, note cadence, journals) need no local-only branch.
export const LOCAL_CHANNEL_ID = 'in-app'

// Bounded so a long unattended run cannot grow without limit. The page polls
// by sequence number, so trimming the head only costs a client that has been
// away longer than MAX_QUEUE messages -- it resyncs to the oldest retained
// sequence rather than silently missing messages in the middle.
export const MAX_QUEUE = 500

// ── outbound queue ────────────────────────────────────────────────────────
// `reply` appends here; GET /out drains by sequence. Sequence numbers are
// monotonic across trims ON PURPOSE: a client holding seq=N must be able to
// tell "nothing new yet" from "you fell behind and lost some", and array
// indices cannot express that.
let seq = 0
let queue = []

export function enqueueOutbound(text, { now = () => Date.now() } = {}) {
  seq += 1
  queue.push({ seq, role: 'agent', text: String(text), ts: now() })
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  return seq
}

export function readOutbound(since = 0) {
  const from = Number(since) || 0
  const items = queue.filter((m) => m.seq > from)
  const oldestRetained = queue.length ? queue[0].seq : seq
  // `missed` is the honest answer to "did I lose anything": true when the
  // caller's cursor is older than everything we still hold. Without it a
  // client that slept through a trim would see a normal-looking response and
  // silently skip messages.
  return { items, latest: seq, missed: from > 0 && from < oldestRetained - 1 }
}

export function resetQueueForTest() { seq = 0; queue = [] }

// ── MCP server ────────────────────────────────────────────────────────────
const INSTRUCTIONS = `You are ${AGENT_NAME}. The user talks to you in the app's own chat window.

Reply with the "reply" tool. There is exactly one conversation here, so channelId is unnecessary -- omit it. Everything you send with "reply" appears in the chat window; anything you write outside a tool call does not reach the user.`

const mcp = new Server(
  { name: AGENT_NAME, version: '1.0.0' },
  { capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} }, instructions: INSTRUCTIONS },
)

const TOOLS = [
  {
    name: 'reply',
    description: 'Send a message to the user in the app chat window. This is the only way to reach them.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send' },
        channelId: { type: 'string', description: 'OPTIONAL and unnecessary here -- there is one conversation. Accepted so the tool surface matches the other channel backends.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'send_file_to_discord',
    // Name deliberately unchanged -- see the header. Nothing here is Discord.
    description: 'Attach a local file to the chat window. Use this for files -- the reply tool is text-only.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Full local path of the file to attach' },
        comment: { type: 'string', description: 'OPTIONAL text to send with the file' },
        channelId: { type: 'string', description: 'OPTIONAL and unnecessary here.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'read_channel_history',
    description: 'Read recent messages from this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent messages to return (default 30)' },
        channelId: { type: 'string', description: 'OPTIONAL and unnecessary here.' },
      },
      required: [],
    },
  },
]

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name === 'reply') {
    const text = args && args.text
    if (typeof text !== 'string' || text.trim() === '') {
      return { content: [{ type: 'text', text: 'reply failed: text is required' }], isError: true }
    }
    const n = enqueueOutbound(text)
    return { content: [{ type: 'text', text: `sent (#${n})` }] }
  }
  if (name === 'send_file_to_discord') {
    const filePath = args && args.filePath
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { content: [{ type: 'text', text: 'send failed: filePath is required' }], isError: true }
    }
    // Deliberately reported as a path, not uploaded: the chat page is served
    // from this machine, so a path IS the file. Copying bytes through the
    // queue would be a second storage design with nothing asking for it yet.
    const comment = args.comment ? `${args.comment}\n` : ''
    const n = enqueueOutbound(`${comment}[file] ${filePath}`)
    return { content: [{ type: 'text', text: `sent (#${n})` }] }
  }
  if (name === 'read_channel_history') {
    const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 30))
    const recent = queue.slice(-limit)
    return { content: [{ type: 'text', text: JSON.stringify(recent, null, 1) }] }
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
})

// ── inbound: HTTP -> notification ─────────────────────────────────────────
export async function deliverInbound(text, { notify, now = localNow } = {}) {
  const content = String(text || '').trim() || '[empty message]'
  await notify({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: { sender: 'user', channelId: LOCAL_CHANNEL_ID, authorId: 'local-user', timestamp: now() },
    },
  })
  return content
}

// ── loopback HTTP listener ────────────────────────────────────────────────
// Bound to 127.0.0.1 with a per-run bearer token. Loopback alone is not
// access control on a shared machine -- any local process could otherwise
// post messages as the user, and the agent has tools. The token is written
// next to the port in DATA_HOME, which only this user can read.
export function createRequestHandler({ notify, token, onInbound = () => {} }) {
  return async function handle(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      // Host check before anything else: a DNS-rebinding target resolves to
      // 127.0.0.1 but arrives with a foreign Host header.
      const host = String(req.headers.host || '')
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
        return send(403, { error: 'bad host' })
      }
      if (url.pathname === '/health') return send(200, { ok: true, agent: AGENT_NAME })

      const auth = String(req.headers.authorization || '')
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const a = Buffer.from(presented)
      const b = Buffer.from(token)
      const authed = a.length === b.length && crypto.timingSafeEqual(a, b)
      if (!authed) return send(401, { error: 'unauthorized' })

      if (url.pathname === '/out' && req.method === 'GET') {
        return send(200, readOutbound(url.searchParams.get('since')))
      }
      if (url.pathname === '/in' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 100_000) return send(413, { error: 'too large' })
        }
        let parsed
        try { parsed = JSON.parse(body || '{}') } catch { return send(400, { error: 'bad json' }) }
        const text = parsed && parsed.text
        if (typeof text !== 'string' || !text.trim()) return send(400, { error: 'text required' })
        const delivered = await deliverInbound(text, { notify })
        onInbound(delivered)
        return send(202, { ok: true })
      }
      return send(404, { error: 'not found' })
    } catch (err) {
      log('request handler error:', err.message)
      try { send(500, { error: 'internal' }) } catch { /* response already gone */ }
    }
  }
}

export async function writePortFile(dataHome, payload) {
  const file = path.join(dataHome, 'local-channel.json')
  await fs.mkdir(dataHome, { recursive: true })
  // 0600: the file carries the bearer token.
  await fs.writeFile(file, JSON.stringify(payload, null, 1), { mode: 0o600 })
  return file
}

// ── boot ──────────────────────────────────────────────────────────────────
// Same "am I the entry point" guard as the other backends, for the same
// reason: scripts/test-local-channel.mjs imports this file to exercise its
// exported functions without connecting real stdio or binding a port.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

async function boot() {
  await mcp.connect(new StdioServerTransport())
  log(`MCP server up (${AGENT_NAME})`)

  const token = crypto.randomBytes(32).toString('hex')
  const handler = createRequestHandler({
    notify: (n) => mcp.notification(n),
    token,
  })
  const server = http.createServer((req, res) => { handler(req, res) })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    // Port 0 = let the OS pick. The app spawns claude which spawns this, so a
    // fixed port would collide across two installs and there is nothing to
    // gain from guessing one; the real port goes in the file below.
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await writePortFile(DATA_HOME, { port, token, pid: process.pid, startedAt: localNow() })
  log(`in-app chat listening on 127.0.0.1:${port}`)

  markers.writeLiveness()
  setInterval(() => markers.writeLiveness(), markers.LIVENESS_HEARTBEAT_MS).unref()
}

if (isMainModule) {
  boot().catch((err) => {
    process.stderr.write(`[${AGENT_NAME}] FATAL: ${err.message}\n`)
    markers.writeFailure(err.message, 'boot_failed')
    process.exit(1)
  })
}
