#!/usr/bin/env node
// dsh-lane.mjs -- the dsh flavor of headless-lane.mjs (0.2.1 junction).
//
// Drop-in for the lane seam: everything upstream (channel-local/discord/
// slack/telegram connectors, chat routes, supervisor) keeps its contract:
//   IN : POST 127.0.0.1:<port>/inbound {content, meta} + x-ingest-token,
//        endpoint published at MEM/.ingest-endpoint.json {port, token, pid}
//   OUT: the agent's MCP `reply` tool -- the SAME channel MCP servers from
//        MCP_CONFIG_FILE (claude .mcp.json shape) are handed to dsh's
//        config-level MCP client, so replies flow to channels untouched.
// What changes: instead of `claude -p --input-format stream-json`, we spawn
// a pinned `dsh web --port 0` engine and drive ONE persistent session over
// its gateway (dsh-client.cjs).
//
// Env contract (superset-compatible with headless-lane):
//   MEM                 agent data home = dsh workspace cwd (required)
//   MCP_CONFIG_FILE     claude-format mcpServers JSON (optional)
//   SYSTEM_PROMPT_FILE  persona prose -> dsh persona row (optional)
//   DSH_MODEL           default "glm-5.2:cloud"; DSH_PROVIDER "ollama"
//   DSH_EFFORT          off|low|high|max (default max)
//   OLLAMA_BASE_URL     default http://localhost:11434/v1
//   SCHZ_DSH_BIN        override path to dsh bin.js (default: resolve)
//
// Deliberately NOT ported from headless-lane (first cut): 3-strike
// contamination breaker, mute-gate bookkeeping, model preflight. The
// crash-recovery pending FIFO IS ported (same file, same semantics:
// persist before accept, clear on turn end).

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DshClient, promptAndCollect } = require('./dsh-client.cjs')

const MEM = process.env.MEM
const MCP_CONFIG_FILE = process.env.MCP_CONFIG_FILE || ''
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || ''
const DSH_PROVIDER = process.env.DSH_PROVIDER || 'ollama'
const DSH_MODEL = process.env.DSH_MODEL || 'glm-5.2:cloud'
const DSH_EFFORT = process.env.DSH_EFFORT || 'max'
// 같이보기/vision routing (0.2.1): image markers are captioned by a
// one-shot SIDECAR session on the vision model, and the caption text rides
// into the main session's prompt. NOT a per-turn selectModel switch: dsh
// refuses to select a text-only model on a session whose history holds
// images ("model-unavailable ... does not accept image input", measured
// 2026-08-19), so one image would permanently evict glm from the session.
// The sidecar sends the bytes INLINE as an image part ({type:'image',
// mediaType, data} -- dsh-host-apiproxy sessions.schema.js:222); the main
// session never sees an image and stays on the fast text model.
const DSH_VISION_MODEL = process.env.DSH_VISION_MODEL || 'qwen3.5:cloud'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1'

const log = (m) => process.stdout.write(`[dsh-lane] ${m}\n`)
const errLog = (m) => process.stderr.write(`[dsh-lane] ${m}\n`)

if (!MEM) { errLog('MEM is required'); process.exit(2) }

const endpointFile = () => path.join(MEM, '.ingest-endpoint.json')
const pendingFile = () => path.join(MEM, '.pending-inbound.json')
const dshHome = () => path.join(MEM, '.dsh-lane-home')

function writeJsonAtomic (file, obj, mode) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: mode || 0o600 })
  fs.renameSync(tmp, file)
}
function readPending () {
  try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) } catch { return [] }
}
function writePending (list) {
  try { writeJsonAtomic(pendingFile(), list); return true } catch { return false }
}

// ── patch assembly ──────────────────────────────────────────────────────────
function yamlQuote (s) {
  return JSON.stringify(String(s)) // JSON string is valid YAML scalar
}

function mcpRowsFromClaudeConfig (file) {
  if (!file || !fs.existsSync(file)) return ''
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    errLog(`MCP_CONFIG_FILE unreadable (${e.message}) -- continuing without MCP`)
    return ''
  }
  const servers = cfg && cfg.mcpServers ? cfg.mcpServers : {}
  // NEW rows must ride the `insert` patch verb — a bare {id,name,config}
  // entry is treated as an id-targeted override and warns "entry not found"
  // (cordis-plugin-include lib/index.js:68-93, measured 2026-08-19).
  const rows = []
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') continue
    const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
    if (s.url) {
      rows.push([
        `    - id: mcp-${safe}`,
        `      name: '@deepseek-ai/dsh-mcp-client'`,
        `      config:`,
        `        serverName: ${safe}`,
        `        transport: streamable-http`,
        `        url: ${yamlQuote(s.url)}`
      ].join('\n'))
    } else if (s.command) {
      const lines = [
        `    - id: mcp-${safe}`,
        `      name: '@deepseek-ai/dsh-mcp-client'`,
        `      config:`,
        `        serverName: ${safe}`,
        `        transport: stdio`,
        `        command: ${yamlQuote(s.command)}`
      ]
      if (Array.isArray(s.args) && s.args.length) {
        lines.push(`        args: [${s.args.map(yamlQuote).join(', ')}]`)
      }
      if (s.env && typeof s.env === 'object' && Object.keys(s.env).length) {
        lines.push('        env:')
        for (const [k, v] of Object.entries(s.env)) lines.push(`          ${k}: ${yamlQuote(v)}`)
      }
      lines.push(`        reconnect:`, `          enabled: true`)
      rows.push(lines.join('\n'))
    }
  }
  if (!rows.length) return ''
  return `- insert:\n${rows.join('\n')}`
}

function personaRow () {
  if (!SYSTEM_PROMPT_FILE || !fs.existsSync(SYSTEM_PROMPT_FILE)) return ''
  let text
  try { text = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8') } catch { return '' }
  // Block scalar keeps the prose verbatim; indent every line by 6.
  const indented = text.split('\n').map((l) => `      ${l}`).join('\n')
  return `- id: persona\n  config:\n    text: |\n${indented}`
}

function buildPatch () {
  const efforts = ['off', 'low', 'high', 'max']
    .map((e) => e === 'off' ? '              off:' : `              ${e}: ${e}`).join('\n')
  const base = `- id: agent-default-model
  config:
    provider: ${DSH_PROVIDER}
    model: ${yamlQuote(DSH_MODEL)}
- id: hmr
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      ollama:
        displayName: Ollama (local)
        apiKeyEnv: OLLAMA_API_KEY
        api: openai-completions
        baseURL: ${yamlQuote(OLLAMA_BASE_URL)}
        models:
          - id: glm-5.2:cloud
            name: GLM 5.2 (fast text)
            input: [text]
            contextWindow: 131072
            maxTokens: 16384
            reasoningEfforts:
${efforts}
          - id: qwen3.5:cloud
            name: Qwen 3.5 (vision)
            input: [text, image]
            contextWindow: 131072
            maxTokens: 16384
            reasoningEfforts:
${efforts}
`
  const parts = [base]
  const persona = personaRow()
  if (persona) parts.push(persona)
  const mcp = mcpRowsFromClaudeConfig(MCP_CONFIG_FILE)
  if (mcp) parts.push(mcp)
  const patch = parts.join('\n')
  fs.mkdirSync(dshHome(), { recursive: true })
  const p = path.join(dshHome(), 'lane.patch.yml')
  fs.writeFileSync(p, patch)
  return p
}

function dshBin () {
  if (process.env.SCHZ_DSH_BIN) return process.env.SCHZ_DSH_BIN
  const p = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

// ── engine boot ─────────────────────────────────────────────────────────────
let child = null
let childExited = false

function spawnEngine (patchPath) {
  const env = {
    ...process.env,
    DSH_HOME: dshHome(),
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || 'ollama-local',
    DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED'
  }
  const isElectronNode = !!process.versions.electron
  const args = [...(isElectronNode ? ['--expose-internals'] : []), dshBin(), 'web', '--patch', patchPath, '--port', '0']
  child = spawn(process.execPath, args, { cwd: MEM, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('exit', (code) => {
    childExited = true
    errLog(`dsh engine exited ${code}`)
    // Supervisor owns restarts (same posture as headless-lane): exit so the
    // wrapper's restart loop sees a dead lane instead of a zombie half.
    process.exit(code === 0 ? 0 : 1)
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const onLine = (buf) => {
      const s = buf.toString()
      const m = s.match(/dsh web:\s*(http:\/\/[\d.]+:\d+)/)
      if (m && !settled) { settled = true; resolve(m[1]) }
      const t = s.trim()
      if (t && !/^\s*$/.test(t)) log(`engine: ${t.slice(0, 200)}`)
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('dsh web did not announce a URL in 45s')) } }, 45000)
  })
}

// ── main ────────────────────────────────────────────────────────────────────
async function main () {
  const patch = buildPatch()
  const url = await spawnEngine(patch)
  log(`engine up at ${url}`)
  const client = new DshClient(url)

  const created = await client.createSession({ cwd: MEM })
  const sessionId = created.sessionId || created.id
  log(`session ${sessionId} (cwd=${MEM}, model=${DSH_PROVIDER}/${DSH_MODEL})`)
  try { await client.selectModel(sessionId, DSH_PROVIDER, DSH_MODEL, DSH_EFFORT === 'off' ? undefined : DSH_EFFORT) } catch (e) {
    log(`selectModel skipped: ${e.message.slice(0, 120)}`)
  }

  // File ledger (같이보기 batch parity): under Claude Code this was a
  // PostToolUse hook; dsh has no shell hooks, so the lane sources the SAME
  // JSONL (DATA_HOME/.gates/file-ledger.jsonl, rows {ts,tool,path,failed?})
  // from tool/call + tool/result events. GET /api/files/recent reads it
  // unchanged. dsh file-writing tools: write / edit / str_replace_editor.
  const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
  const LEDGER_DIR = path.join(MEM, '.gates')
  const LEDGER_PATH = path.join(LEDGER_DIR, 'file-ledger.jsonl')
  const MAX_LEDGER_BYTES = 512 * 1024
  const pendingToolPaths = new Map() // callId -> {tool, path}
  function ledgerAppend (row) {
    try {
      fs.mkdirSync(LEDGER_DIR, { recursive: true })
      try {
        if (fs.statSync(LEDGER_PATH).size > MAX_LEDGER_BYTES) fs.renameSync(LEDGER_PATH, `${LEDGER_PATH}.1`)
      } catch {}
      fs.appendFileSync(LEDGER_PATH, JSON.stringify(row) + '\n', 'utf8')
    } catch { /* fail-open, same contract as the hook it replaces */ }
  }

  // ── local-chat presence feed (activity + think, 0.2.1) ────────────────────
  // Under Claude Code the activity feed came from the PreToolUse hook
  // (hooks/pre-tool-activity.mjs); dsh has no shell hooks, so the lane posts
  // the same POST /activity itself from mux events -- and adds kind:'think'
  // (reasoning-delta chunks, flushed paragraph-sized) for the chat page's
  // collapsible Think fold. Same posture as the hook it replaces: bearer
  // token from MEM/local-channel.json read per post (port changes per
  // channel restart), 800ms cap, fail-open -- presence must never wedge the
  // lane. Local backend only, by the same design: the port file only exists
  // while channel-local's surface runs.
  function postPresence (label, kind) {
    let ep
    try {
      ep = JSON.parse(fs.readFileSync(path.join(MEM, 'local-channel.json'), 'utf8'))
    } catch { return }
    const port = Number(ep && ep.port)
    const token = String((ep && ep.token) || '')
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return
    fetch(`http://127.0.0.1:${port}/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(kind === 'think' ? { label, kind: 'think' } : { label }),
      signal: AbortSignal.timeout(800)
    }).catch(() => {})
  }
  // Activity labels mirror pre-tool-activity.mjs's per-tool convention:
  // bash rides its bare command/description, the rest get a short prefix.
  const truncLabel = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  function activityLabelFor (name, args) {
    const a = args || {}
    if (name === 'bash' || name === 'shell') return truncLabel(a.description || a.command || a.cmd)
    if (name === 'fetch' || name === 'web_fetch') return a.url ? `WebFetch: ${truncLabel(a.url)}` : ''
    if (name === 'web_search') return a.query ? `WebSearch: ${truncLabel(a.query)}` : ''
    if (FILE_TOOLS.has(name)) return `${name}: ${truncLabel(a.file_path || a.path || a.notebook_path)}`
    if (name === 'run_code' || name === 'code') return `run_code: ${truncLabel(a.description || (typeof a.code === 'string' ? a.code : ''))}`
    if (String(name || '').startsWith('mcp__')) return '' // channel plumbing (reply etc.) is not user-facing work
    return name ? `${name}${a.description ? `: ${truncLabel(a.description)}` : ''}` : ''
  }
  // Reasoning accumulator: flush to the channel in paragraph-sized pieces
  // (per-delta posts would be one HTTP round trip per token). Flush at
  // ~700 chars or on turn end; cap a runaway turn's total so the fold
  // cannot eat the page.
  let thinkBuf = ''
  let thinkSentThisTurn = 0
  const THINK_FLUSH_AT = 700
  const THINK_TURN_CAP = 20000
  function flushThink (force) {
    const text = thinkBuf.trim()
    if (!text) return
    if (!force && text.length < THINK_FLUSH_AT) return
    thinkBuf = ''
    if (thinkSentThisTurn >= THINK_TURN_CAP) return
    thinkSentThisTurn += text.length
    postPresence(text.slice(0, 3900), 'think')
  }

  // Turn-close accounting: clear pending entries older than the turn end.
  const mux = client.openMux({
    onEvent (sid, event) {
      if (sid !== sessionId || !event) return
      if (event.type === 'turn/end') {
        flushThink(true)
        thinkSentThisTurn = 0
        const now = Date.now()
        writePending(readPending().filter((p) => p.ts > now))
        log(`turn end (${(event.data && event.data.reason && event.data.reason.kind) || '?'})`)
      } else if (event.type === 'assistant/chunk') {
        const c = event.data && event.data.chunk
        if (c && c.type === 'reasoning-delta') {
          thinkBuf += c.text || c.delta || ''
          flushThink(false)
        } else if (c && (c.type === 'text-delta' || c.type === 'finish')) {
          // Visible prose starting means the think block for this step is
          // complete -- flush the remainder so the fold never trails the reply.
          flushThink(true)
        }
      } else if (event.type === 'tool/call') {
        const d = event.data || {}
        log(`tool> ${d.name || '?'}`)
        flushThink(true) // reasoning that led to this call belongs above it
        try {
          const argsForLabel = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments || {})
          const label = activityLabelFor(d.name, argsForLabel)
          if (label) postPresence(label)
        } catch {}
        if (FILE_TOOLS.has(d.name)) {
          try {
            const args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments || {})
            const p = args.file_path || args.path || args.notebook_path
            if (p) pendingToolPaths.set(d.callId, { tool: d.name, path: String(p) })
          } catch {}
        }
      } else if (event.type === 'tool/result') {
        const d = event.data || {}
        // callId sits at data.callId on tool/call but inside
        // data.message.source.callId on tool/result (measured session log).
        const callId = d.callId || (d.message && d.message.source && d.message.source.callId)
        const rec = callId && pendingToolPaths.get(callId)
        if (rec) {
          pendingToolPaths.delete(callId)
          let failed = false
          try {
            const parts = d.message && d.message.content
            if (Array.isArray(parts)) failed = parts.some((c) => c && c.isError === true)
          } catch {}
          const row = { ts: Date.now(), tool: rec.tool, path: rec.path }
          if (failed) row.failed = true
          ledgerAppend(row)
        }
      }
    },
    onClose () { if (!childExited) log('mux closed; events dark until restart') }
  })
  void mux

  // ── image-marker captioning (같이보기 / chat uploads / windowshot) ────────
  // Inbound content carries "[image attached: <path> — …]" marker lines
  // (the Discord/chat-upload convention every surface shares). Under Claude
  // Code the agent Read the path; here a one-shot sidecar session on the
  // vision model describes the file and the marker is rewritten to the
  // SAME caption format the 0.1.x upload route used (chat.js markerFor
  // parses nothing, but the prose contract matters: the main model is told
  // what a vision model saw, never invited to Read a raster it cannot
  // parse). PDF markers become an honest cannot-view note -- known 0.2.1
  // gap (docs/design-0021-dsh-junction.md).
  const IMG_MARKER_RE = /^\[image attached: (.+?)(?: — [^\]]*)?\]$/
  const PDF_MARKER_RE = /^\[PDF attached: (.+?)(?: — [^\]]*)?\]$/
  const RASTER_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
  // 5MB: the gateway's own imageLimits.maxImageBytes (measured rc-7,
  // session.history metadata) -- larger files would be refused downstream.
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  const CAPTION_PROMPT = 'Describe this image thoroughly for someone who cannot see it: overall layout, ALL readable text verbatim, UI elements and their states, numbers, charts, people or objects, and anything unusual. Plain prose, no preamble. Do not use any tools.'
  async function captionImage (mediaType, filePath) {
    const data = fs.readFileSync(filePath).toString('base64')
    const s = await client.createSession({ cwd: MEM })
    const vsid = s.sessionId || s.id
    // Effort low: a caption is transcription, not reasoning -- and the
    // sidecar bills per image, so keep it cheap.
    try { await client.selectModel(vsid, DSH_PROVIDER, DSH_VISION_MODEL, 'low') } catch (e) {
      throw new Error(`vision model select failed: ${e.message}`)
    }
    const acc = await promptAndCollect(client, vsid, [
      { type: 'text', text: CAPTION_PROMPT },
      { type: 'image', mediaType, data, name: path.basename(filePath) }
    ], { timeoutMs: 120000 })
    const text = String(acc.text || '').trim()
    if (!text) throw new Error('vision model returned no text')
    return text
  }
  async function buildPromptContent (content) {
    const lines = []
    for (const line of String(content).split('\n')) {
      const im = line.match(IMG_MARKER_RE)
      if (im) {
        const p = im[1].trim()
        const mediaType = RASTER_EXT[path.extname(p).toLowerCase()]
        let ok = false
        try { ok = Boolean(mediaType) && fs.statSync(p).size <= MAX_IMAGE_BYTES } catch {}
        if (ok) {
          try {
            const caption = await captionImage(mediaType, p)
            // Brackets/newlines stripped, 2000 cap -- the marker must stay
            // one parseable line (mirror of chat.js markerFor's clean).
            const clean = caption.replace(/[\[\]]/g, '').replace(/\s*\n+\s*/g, ' ').slice(0, 2000)
            lines.push(`[image attached: ${p} — this model cannot view images directly; a vision model (${DSH_VISION_MODEL}) described it: "${clean}"]`)
            log(`captioned ${path.basename(p)} (${clean.length} chars)`)
            continue
          } catch (e) { errLog(`caption failed for ${p}: ${e.message.slice(0, 160)}`) }
        }
        lines.push(`[image attached: ${p} — NOTE: this model cannot view images and the vision fallback failed; do not guess the contents, tell the user honestly that you cannot see it]`)
        continue
      }
      const pm = line.match(PDF_MARKER_RE)
      if (pm) {
        lines.push(`[PDF attached: ${pm[1].trim()} — NOTE: this lane cannot view PDFs; do not guess the contents, tell the user honestly]`)
        continue
      }
      lines.push(line)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  // Redeliver anything the previous incarnation accepted but never finished.
  const stale = readPending()
  if (stale.length) {
    log(`redelivering ${stale.length} pending inbound message(s)`)
    for (const p of stale) {
      try { await client.prompt(sessionId, await buildPromptContent(p.content)) } catch (e) { errLog(`redelivery failed: ${e.message}`) }
    }
  }

  // ── ingest server (contract-parity with headless-lane) ────────────────────
  const token = randomBytes(24).toString('hex')
  const tokenBuf = Buffer.from(token)
  const tokenOk = (got) => {
    const gotBuf = Buffer.from(String(got || ''))
    return gotBuf.length === tokenBuf.length && timingSafeEqual(gotBuf, tokenBuf)
  }

  const server = createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const host = String(req.headers.host || '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(403, { error: 'bad host' })
    if (req.method !== 'POST' || req.url !== '/inbound') return send(404, { error: 'not found' })
    if (!tokenOk(req.headers['x-ingest-token'])) return send(403, { error: 'bad token' })
    let body = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024 && !tooLarge) {
        tooLarge = true
        send(413, { error: 'too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      let payload
      try { payload = JSON.parse(body) } catch { return send(400, { error: 'invalid json' }) }
      const content = String(payload.content == null ? '' : payload.content).trim()
      if (!content) return send(400, { error: 'content required' })
      if (childExited) return send(503, { error: 'agent not running' })
      if (!writePending([...readPending(), { content, meta: payload.meta || {}, ts: Date.now() }])) {
        return send(500, { error: 'pending persist failed' })
      }
      buildPromptContent(content)
        .then((parts) => client.prompt(sessionId, parts))
        .then(() => log(`inbound -> session (${content.length} chars, sender=${(payload.meta && payload.meta.sender) || '?'})`))
        .catch((e) => errLog(`prompt failed: ${e.message}`))
      send(200, { ok: true })
    })
  })

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    try {
      writeJsonAtomic(endpointFile(), { port, token, pid: process.pid }, 0o600)
      log(`ingest endpoint on 127.0.0.1:${port}`)
    } catch (e) {
      errLog(`endpoint file write failed: ${e.message}`)
      process.exit(1)
    }
  })

  const shutdown = () => {
    try { if (child && !child.killed) child.kill('SIGTERM') } catch {}
    try { fs.unlinkSync(endpointFile()) } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => { errLog(`boot failed: ${e.message}`); try { if (child) child.kill('SIGTERM') } catch {}; process.exit(1) })
