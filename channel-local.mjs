// channel-local.mjs — in-app chat counterpart to channel.mjs (the Discord MCP
// channel). Same contract, same tool names, same notification method; the only
// thing that changes is the wire: instead of a Discord gateway there is a
// loopback HTTP listener that the app's own chat page talks to.
//
//   inbound:  POST /in  -> notifyInbound (design-0020: ingest-POST to the
//             headless lane when .ingest-endpoint.json exists, MCP
//             dev-channels notification as the attach-topology fallback)
//             -> transcript (role 'user', recorded only once delivered)
//   outbound: `reply` tool -> transcript (role 'agent')
//   reactions: POST /react (user taps an emoji on a bubble) -> notification
//             ("[reaction] ..." -- the agent SEES it, MAGI-style, but is not
//             obliged to answer it); `react` tool (agent puts an emoji on the
//             user's bubble). Both land in the transcript as kind:'reaction'
//             items pointing at their target's seq, so a reload replays them.
//   presence: GET /out carries state.awaitingReplySince -- the ts of the
//             oldest user message nothing agent-authored (message OR
//             reaction) has followed. The page derives BOTH DM affordances
//             from this one value: "read" (delivered into the agent process
//             -- entries only exist post-delivery) and "typing" (delivered,
//             no agent response landed yet).
//   the page: GET /out drains the transcript by cursor and replays it in
//             full on every load -- the queue IS the conversation record
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
import { unlinkSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  installStdoutHygiene, resolveDataHome, localNow,
  createMarkerStore, createBootAnnouncer,
  createRoutineStore, ROUTINE_TOOL, handleRoutineTool, startRoutineTicker, routineInjectContent,
  createInboundNotifier, createOutboundDedup,
} from './channel-runtime.mjs'

const log = installStdoutHygiene()

const AGENT_NAME = process.env.AGENT_NAME || 'agent'
const DATA_HOME = resolveDataHome(AGENT_NAME)
const markers = createMarkerStore({ dataHome: DATA_HOME })
// User-requested scheduled prompts, shared logic in channel-runtime.
// Ticker starts in boot(); tool surface is wired into handleToolCall.
const routineStore = createRoutineStore({ dataHome: DATA_HOME, log })

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

// ── transcript queue ──────────────────────────────────────────────────────
// BOTH sides of the conversation, in arrival order: `reply` appends role
// 'agent', a delivered /in message appends role 'user'. GET /out drains by
// sequence. This is the transcript the page replays on every load — before
// user messages lived here (v0.0.31), they existed only as DOM nodes in the
// page that sent them, so any navigation erased the user's half of the
// conversation and any reply that landed while the page was away was
// swallowed by the reload's cursor seed (Mino's 07-30 repro, both symptoms).
// Sequence numbers are monotonic across trims ON PURPOSE: a client holding
// seq=N must be able to tell "nothing new yet" from "you fell behind and
// lost some", and array indices cannot express that.
let seq = 0
let queue = []

// ── transcript persistence ────────────────────────────────────────────────
// The queue IS the conversation record (see header) -- but until 2026-08-04
// it lived only in this process, so every app relaunch erased the whole chat
// (Mino: "앱 닫았다가 열면 인앱챗 대화내용 날아감"). Persisted to one JSON
// file in DATA_HOME, restored once at boot, rewritten after every push.
//
// OPT-IN, not automatic: tests import this module to exercise the queue, and
// a module-level side effect would write their fixture chatter into the real
// user's DATA_HOME. boot() enables it; imports get the old in-memory-only
// behavior unchanged.
//
// seq is restored monotonic ON PURPOSE: a page holding a cursor across an app
// restart must keep the same "nothing new" / "you fell behind" semantics it
// had within one process lifetime.
//
// Fail-soft both ways: a missing/corrupt file starts an empty transcript, a
// failed write logs and keeps the chat alive. Losing persistence must never
// cost the user the live conversation.
const TRANSCRIPT_BASENAME = 'chat-transcript.json'
let transcriptFile = null
let transcriptWritePromise = null
let transcriptDirty = false

async function writeTranscriptOnce() {
  // Captured once: resetQueueForTest() can null transcriptFile while a write
  // is in flight, and a half-made write must finish against the path it
  // started with (or not at all), never against null.
  const file = transcriptFile
  if (!file) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  // temp + rename, same reason as atomicWriteJson (channel-runtime): a
  // reader landing mid-write must never parse a truncated file. 0600 like
  // the port file -- this is the full conversation content.
  const tmp = `${file}.${process.pid}.tmp`
  // Activity items are NOT persisted: "running npm test" is presence, not
  // conversation -- replaying yesterday's command chatter into a fresh boot
  // would be noise wearing a transcript costume. seq stays as-is; the
  // cursor contract already tolerates gaps.
  const durable = queue.filter((m) => m.kind !== 'activity')
  await fs.writeFile(tmp, JSON.stringify({ seq, queue: durable }, null, 1), { mode: 0o600 })
  await fs.rename(tmp, file)
}

// Returns a promise that resolves only once the CURRENT queue state is on
// disk -- callers arriving mid-write mark it dirty and share the same
// promise, whose drain loop rewrites until nothing changed underneath it.
// (First draft returned early on the in-flight write; the test's await then
// raced the rename and stat'd a file that wasn't there yet.)
//
// Resolves to a BOOLEAN: true when the last write reached disk, false when it
// threw. The `reply` receipt gates on this so "sent" never out-promises the
// durable record (2026-08-13 fix, below). No transcriptFile (tests, or
// persistence not yet enabled) resolves true: nothing to persist, nothing to
// lose across a restart.
export function flushTranscript() {
  if (!transcriptFile) return Promise.resolve(true)
  if (transcriptWritePromise) { transcriptDirty = true; return transcriptWritePromise }
  transcriptWritePromise = (async () => {
    let ok = true
    do {
      transcriptDirty = false
      try {
        await writeTranscriptOnce()
        ok = true
      } catch (err) {
        ok = false
        log(`transcript persist failed (chat stays live, history at risk): ${err.message}`)
      }
    } while (transcriptDirty)
    transcriptWritePromise = null
    return ok
  })()
  return transcriptWritePromise
}

export async function enableTranscriptPersistence({ dataHome = DATA_HOME } = {}) {
  transcriptFile = path.join(dataHome, TRANSCRIPT_BASENAME)
  try {
    const raw = JSON.parse(await fs.readFile(transcriptFile, 'utf8'))
    if (Number.isFinite(raw.seq) && Array.isArray(raw.queue)) {
      queue = raw.queue.filter((m) => m && Number.isFinite(m.seq)).slice(-MAX_QUEUE)
      // max() over both: raw.seq is the truth, but a file from a crashed
      // mid-write generation may carry seq older than its own tail item.
      seq = Math.max(raw.seq, ...queue.map((m) => m.seq), 0)
      return { restored: queue.length }
    }
  } catch { /* first run, or corrupt: empty transcript beats a dead channel */ }
  return { restored: 0 }
}

function push(item) {
  seq += 1
  queue.push({ seq, ...item })
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  // fire-and-forget: enqueue stays synchronous (its callers and tests treat
  // it that way), and flushTranscript() self-serializes concurrent calls.
  flushTranscript()
  return seq
}

function enqueue(role, text, now) {
  return push({ kind: 'message', role, text: String(text), ts: now() })
}

export function enqueueOutbound(text, { now = () => Date.now() } = {}) {
  return enqueue('agent', text, now)
}

// Called ONLY after deliverInbound resolves: a message the agent never
// received must not appear in the transcript as if it had been.
export function enqueueInbound(text, { now = () => Date.now() } = {}) {
  return enqueue('user', text, now)
}

// A reaction is a transcript item too -- `text` mirrors the emoji so any
// consumer that doesn't know the kind (an older page, a raw dump) still
// shows something true instead of an empty bubble.
export function enqueueReaction(role, emoji, targetSeq, { now = () => Date.now() } = {}) {
  return push({ kind: 'reaction', role, emoji: String(emoji), targetSeq, text: String(emoji), ts: now() })
}

// An activity item is what the agent is DOING right now ("Install package
// dependencies"), pushed by the PreToolUse hook via POST /activity. Stolen
// from Codex's item/started (docs/codex-architecture-review-2026-08-04.md
// §7): the delta stream is worth little on non-streaming surfaces, but
// "started" alone kills the silent-minutes problem. Rides the existing
// queue -- no transport change, the page's cursor drain picks it up like
// any other item.
export function enqueueActivity(label, { now = () => Date.now() } = {}) {
  return push({ kind: 'activity', role: 'agent', text: String(label), ts: now() })
}

// The one presence value (see header). Asymmetric on purpose (live catch,
// 07-30 dev-harness screenshot): a USER reaction is skipped -- a tap is not
// a question awaiting an answer -- but an AGENT reaction counts as the agent
// having spoken. The react tool exists precisely as a valid whole response;
// leaving the typing dots up after the agent answered with an emoji shows
// activity that is not happening.
export function transcriptState() {
  let since = null
  for (let i = queue.length - 1; i >= 0; i--) {
    const m = queue[i]
    if (m.kind === 'reaction' && m.role === 'user') continue
    // An activity item is evidence of WORK, not an answer: "running npm
    // test" must not clear the awaiting state the way a reply does, or the
    // read/typing affordances would claim the user's question was handled
    // by a command starting.
    if (m.kind === 'activity') continue
    if (m.role !== 'user') break
    since = m.ts
  }
  return { awaitingReplySince: since }
}

export function readOutbound(since = 0) {
  const from = Number(since) || 0
  const items = queue.filter((m) => m.seq > from)
  const oldestRetained = queue.length ? queue[0].seq : seq
  // `missed` is the honest answer to "did I lose anything": true when the
  // caller's cursor is older than everything we still hold. Without it a
  // client that slept through a trim would see a normal-looking response and
  // silently skip messages.
  return { items, latest: seq, missed: from > 0 && from < oldestRetained - 1, state: transcriptState() }
}

export function resetQueueForTest() { seq = 0; queue = []; transcriptFile = null }

// ── MCP server ────────────────────────────────────────────────────────────
const INSTRUCTIONS = `You are ${AGENT_NAME}. The user talks to you in the app's own chat window.

Reply with the "reply" tool. There is exactly one conversation here, so channelId is unnecessary -- omit it. Everything you send with "reply" appears in the chat window; anything you write outside a tool call does not reach the user.

When the user's message needs acknowledgment but no words -- "고마워", "ㅇㅋ", something you simply agree with -- you can use the "react" tool instead: one emoji lands on their message bubble, like a messenger DM reaction. When the user reacts to YOUR message you'll see "[reaction] ...": that is a signal, not a question. Answer it only when you actually have something to add; staying silent after a reaction is normal.`

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
  {
    name: 'react',
    description: "Attach one emoji to the user's message bubble, like a messenger DM reaction. Use it when acknowledgment needs no words; it is not a substitute for an answer that needs content.",
    inputSchema: {
      type: 'object',
      properties: {
        emoji: { type: 'string', description: 'A single emoji, e.g. 👍 or ❤️' },
        targetSeq: { type: 'number', description: "OPTIONAL transcript seq of the message to react to (seqs are visible in read_channel_history). Defaults to the user's latest message." },
        channelId: { type: 'string', description: 'OPTIONAL and unnecessary here.' },
      },
      required: ['emoji'],
    },
  },
  ROUTINE_TOOL,
]

// Explicit targetSeq may point at any retained MESSAGE (reacting to a
// reaction is turtles); the default is the user's latest message -- the
// thing the agent is most plausibly nodding at.
function findReactionTarget(targetSeq) {
  if (targetSeq !== undefined && targetSeq !== null) {
    const n = Number(targetSeq)
    return queue.find((m) => m.seq === n && m.kind !== 'reaction') || null
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    const m = queue[i]
    if (m.kind !== 'reaction' && m.role === 'user') return m
  }
  return null
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

// Exported so tests exercise the real tool logic without connecting a
// transport; the MCP handler below is a thin shell around this.
// GPT-loop guard (2026-08-04, Mino field report) -- see createOutboundDedup
// (channel-runtime.mjs). Single fixed key: this backend has exactly one
// conversation surface (the in-app chat page).
const checkOutboundDup = createOutboundDedup({ log })

export async function handleToolCall(name, args) {
  if (name === 'reply') {
    const text = args && args.text
    if (typeof text !== 'string' || text.trim() === '') {
      return { content: [{ type: 'text', text: 'reply failed: text is required' }], isError: true }
    }
    // Identical text within the window is NOT re-queued; the receipt tells
    // the model so. Normal result, never isError -- an error invites exactly
    // the retry this exists to stop.
    const dup = checkOutboundDup('local', text)
    if (dup.duplicate) return { content: [{ type: 'text', text: dup.receipt }] }
    const n = enqueueOutbound(text)
    // Wait for the durable write before reporting "sent". enqueueOutbound only
    // puts the item in the in-memory queue and kicks a fire-and-forget flush;
    // returning the receipt at that point told the model "sent" while the
    // bytes were still in flight. Teardown (stdin EOF -> immediate
    // process.exit in boot()) could then abandon the write AND drop the memory
    // queue, losing a reply the model believed it had delivered -- and on
    // restart the transcript restore has nothing to replay. Length-correlated
    // because a larger payload widens the write window teardown can land in
    // (Mino field report, Windows v0.1.7: msgs >=1KB lost 3/3; a short one
    // lost too when teardown or a Windows rename-lock caught the window).
    // Awaiting here closes the race: by the time "sent" returns, the item is
    // on disk, so it survives any subsequent teardown.
    const durable = await flushTranscript()
    // delivered_channel= line: machine-readable delivery receipt, same
    // contract as the platform backends (channel.mjs L354 note). The local
    // surface never emitted one, so hooks/stop-reply-guard.mjs had only its
    // lower-authority tool-args fallback for in-app replies (red-team
    // 2026-08-05 P1-4).
    const receipt = `sent (#${n})\ndelivered_channel=${LOCAL_CHANNEL_ID}`
    // If the disk write failed, the item is still live in memory (the page
    // will render it while this process lives), but we must NOT claim a
    // durable "sent": say so, so the model does not treat a restart-fragile
    // message as safely delivered.
    return { content: [{ type: 'text', text: durable ? receipt : `${receipt}\nwarning: not yet saved to disk -- history at risk if the app closes now` }] }
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
    return { content: [{ type: 'text', text: `sent (#${n})\ndelivered_channel=${LOCAL_CHANNEL_ID}` }] }
  }
  if (name === 'read_channel_history') {
    const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 30))
    const recent = queue.slice(-limit)
    return { content: [{ type: 'text', text: JSON.stringify(recent, null, 1) }] }
  }
  if (name === 'react') {
    const emoji = typeof (args && args.emoji) === 'string' ? args.emoji.trim() : ''
    // Length cap, not an allowlist: the agent may pick its emoji, but a
    // paragraph riding the reaction lane would be a reply wearing a costume.
    if (!emoji || emoji.length > 16) {
      return { content: [{ type: 'text', text: 'react failed: emoji is required (one short emoji)' }], isError: true }
    }
    const target = findReactionTarget(args && args.targetSeq)
    if (!target) {
      return { content: [{ type: 'text', text: 'react failed: no message to react to (targetSeq not found, or the user has not written yet)' }], isError: true }
    }
    const n = enqueueReaction('agent', emoji, target.seq)
    return { content: [{ type: 'text', text: `reacted ${emoji} to #${target.seq} (#${n})` }] }
  }
  if (name === 'routine') return handleRoutineTool(routineStore, args)
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => handleToolCall(req.params.name, req.params.arguments))

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

// The user's emoji tap reaches the agent the way MAGI fleet reactions do:
// injected as a bracketed line the model can see and choose to ignore. The
// "[reaction]" prefix is LOAD-BEARING -- stop-reply-guard exempts triggers
// that start with it, so a tap never drafts the agent into a forced
// "고마워요" (a DM reaction is a signal, not a question). Same meta shape as
// deliverInbound: no local-only branch for downstream consumers.
export async function deliverReaction(emoji, target, { notify, now = localNow } = {}) {
  const preview = String(target.text || '').replace(/\s+/g, ' ').slice(0, 80)
  const content = `[reaction] user put ${emoji} on your message: "${preview}"`
  await notify({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: { sender: 'user', channelId: LOCAL_CHANNEL_ID, authorId: 'local-user', timestamp: now() },
    },
  })
  return content
}

// User-side reactions are a fixed menu (the two Mino named), so the emoji
// arriving over HTTP is an enum member, never free text riding into the
// agent's context.
export const USER_REACTIONS = ['👍', '❤️']

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
        // Into the transcript only AFTER the notification resolved -- and as
        // `delivered` (the normalized content), so the record shows exactly
        // what the agent was handed. A failed deliverInbound throws past
        // this line: the client gets its error and keeps the input text, and
        // the transcript never claims a delivery that didn't happen.
        enqueueInbound(delivered)
        onInbound(delivered)
        return send(202, { ok: true })
      }
      if (url.pathname === '/activity' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 10_000) return send(413, { error: 'too large' })
        }
        let parsed
        try { parsed = JSON.parse(body || '{}') } catch { return send(400, { error: 'bad json' }) }
        const label = typeof (parsed && parsed.label) === 'string' ? parsed.label.trim() : ''
        if (!label) return send(400, { error: 'label required' })
        // Length cap: this is a status line, not a second message lane. The
        // sender (pre-tool-activity.mjs) already truncates; enforcing here
        // keeps a crafted request honest too.
        enqueueActivity(label.slice(0, 160))
        // No notification: activity is FOR the page. The agent already
        // knows what it is doing.
        return send(202, { ok: true })
      }
      if (url.pathname === '/react' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 10_000) return send(413, { error: 'too large' })
        }
        let parsed
        try { parsed = JSON.parse(body || '{}') } catch { return send(400, { error: 'bad json' }) }
        const emoji = parsed && parsed.emoji
        if (!USER_REACTIONS.includes(emoji)) return send(400, { error: 'unknown emoji' })
        const n = Number(parsed && parsed.targetSeq)
        // Only agent messages are reactable from the page (the UI offers the
        // buttons there and nowhere else); enforcing it here keeps a crafted
        // request from decorating the user's own bubbles.
        const target = queue.find((m) => m.seq === n && m.kind !== 'reaction' && m.role === 'agent')
        if (!target) return send(404, { error: 'no reactable message with that seq' })
        // Same delivered-then-recorded order as /in: a reaction the agent
        // never saw must not appear in the transcript as if it had been seen.
        await deliverReaction(emoji, target, { notify })
        enqueueReaction('user', emoji, target.seq)
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

// ── always-on surface (2026-08-05, colleague via Mino: "슬랙/디코/텔레그램
// 이랑 인앱챗을 스위칭하는 방식이 아니라 인앱챗 기본 + 채널 하나 방식") ────
// The whole local chat surface — transcript restore, loopback HTTP listener,
// port file — as one bootable unit that a PLATFORM backend hosts alongside
// its own transport, so in-app chat works no matter which messenger is the
// active CHANNEL_BACKEND. Routing back out is deterministic: the host
// intercepts tool calls whose channelId is LOCAL_CHANNEL_ID and hands them
// to this module's handleToolCall — no model judgment involved beyond
// passing back the channelId it was given, which is the existing contract.
//
// The host owns process lifecycle: call stop() from its own shutdown path
// (stdin EOF guard) so the port file dies with the process. Fail-soft at the
// call site — a surface that cannot bind must cost the platform channel
// nothing but a log line.
export async function startLocalChatSurface({ notify, log: slog = log } = {}) {
  const { restored } = await enableTranscriptPersistence()
  slog(`in-app transcript restored: ${restored} item(s)`)
  const token = crypto.randomBytes(32).toString('hex')
  const handler = createRequestHandler({ notify, token })
  const server = http.createServer((req, res) => { handler(req, res) })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    // Port 0 = OS-picked; the real port goes in the file (see boot()'s note).
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const portFilePath = await writePortFile(DATA_HOME, { port, token, pid: process.pid, startedAt: localNow() })
  slog(`in-app chat listening on 127.0.0.1:${port}`)
  const stop = () => { try { unlinkSync(portFilePath) } catch { /* already gone */ } }
  return { port, portFilePath, stop }
}

// ── boot ──────────────────────────────────────────────────────────────────
// Same "am I the entry point" guard as the other backends, for the same
// reason: scripts/test-local-channel.mjs imports this file to exercise its
// exported functions without connecting real stdio or binding a port.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

async function boot() {
  await mcp.connect(new StdioServerTransport())
  log(`MCP server up (${AGENT_NAME})`)

  // The surface unit restores the transcript BEFORE anything can enqueue
  // (boot announce appends a greeting below; it must land after yesterday's
  // messages, not instead of them), binds the loopback listener (port 0 =
  // OS-picked: the app spawns claude which spawns this, so a fixed port
  // would collide across two installs), and writes the port file.
  const surface = await startLocalChatSurface({ notify: (n) => notifyInbound(n.params) })

  // Parent-death guard (found live, 2026-07-30: a killed parent left this
  // process orphaned and the chat page said "listening" while notifications
  // went into a dead pipe). stdin EOF is the one signal every parent sends
  // by dying -- the MCP transport reads stdin but does NOT exit on its end,
  // so without this an orphan keeps /health green, keeps 202-ing messages,
  // and silently drops them: the exact deliver-then-lose failure this
  // backend exists to remove. Delete the port file first so the proxy reads
  // an honest not_running instead of probing a corpse.
  // Drain any in-flight/pending transcript write before dying. Without this,
  // stdin-EOF teardown called process.exit synchronously and abandoned the
  // write kicked by the last enqueue -- losing an item that was already
  // acknowledged. `reply` now awaits its own flush, but the inbound (user
  // message), reaction, and boot-announce paths enqueue fire-and-forget and
  // their HTTP handlers return before the write lands; a teardown right after
  // one of those would drop the user's own half of the conversation. The guard
  // makes the double-signal ('end' then 'close') drain exactly once.
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try { await flushTranscript() } catch { /* logged inside flush; die anyway */ }
    surface.stop()
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)

  markers.writeLiveness()
  setInterval(() => markers.writeLiveness(), markers.LIVENESS_HEARTBEAT_MS).unref()

  // Routines: optional-feature contract (same as the other backends) -- a
  // broken ticker degrades to a log line, never takes the channel down.
  try {
    startRoutineTicker({
      store: routineStore,
      fire: (r) => notifyInbound({
          content: routineInjectContent(r),
          meta: { sender: 'SYSTEM', channelId: LOCAL_CHANNEL_ID, authorId: '', timestamp: localNow() },
        }),
      log,
    })
  } catch (err) {
    log(`routine ticker failed to start (feature disabled this session): ${err.message}`)
  }

  // Boot announce, same unit as the other backends (channel-runtime): direct
  // line into the queue -> ts advance -> greeting inject to the model. For a
  // fresh onboarding this IS "setup ends at the agent's first message" -- the
  // wizard lands the user on /chat and the first thing the pane shows is the
  // agent arriving. The queue always exists, so fetchTarget cannot fail and
  // the last-channel fallback can never engage (the stub load is honest: home
  // never being unreachable means it is never consulted).
  const announceBoot = createBootAnnouncer({
    dataHome: DATA_HOME,
    homeId: LOCAL_CHANNEL_ID,
    lastChannelStore: { load: async () => null, persist: () => {} },
    fetchTarget: async () => ({ id: LOCAL_CHANNEL_ID }),
    idOf: (t) => t.id,
    sendText: (t, text) => { enqueueOutbound(text) },
    notify: notifyInbound,
    log,
    noun: 'chat',
  })
  announceBoot().catch((err) => log(`boot announce failed: ${err.message}`))
}

if (isMainModule) {
  boot().catch((err) => {
    process.stderr.write(`[${AGENT_NAME}] FATAL: ${err.message}\n`)
    markers.writeFailure(err.message, 'boot_failed')
    process.exit(1)
  })
}
