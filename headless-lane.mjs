#!/usr/bin/env node
// headless-lane.mjs — the -p (headless stream-json) spawn lane. design-0020.
//
// Replaces run.sh's expect script: instead of driving an interactive TUI
// blind (ANSI scraping, dialog-answering regexes, PTY process groups), this
// lane spawns `claude -p --input-format stream-json --output-format
// stream-json` and owns both pipes:
//
//   stdin  <- user messages, injected as stream-json user events by the
//             ingest HTTP server below (channel backends POST here instead
//             of the dead-in-headless dev-channels MCP notification —
//             probe 5, design-0020)
//   stdout -> structured events: session_id capture for --resume, turn
//             results, compact human log lines to stderr for the supervisor
//
// What this lane deliberately does NOT do:
//   - no TUI dialog handling: -p mode has no trust prompt, no theme picker,
//     no dev-channels warning (probe 1 hit none of them)
//   - no restart/backoff: run.sh's loop stays the supervisor; this process
//     exits with the child's exit code and the loop decides
//   - no transcript/queue logic: that is the channel backend's job
//
// Files (all in $MEM, the DATA_HOME):
//   .ingest-endpoint.json  {port, token} 0600, tmp+rename, rewritten every
//                          lane boot (stale file after quit = dead port,
//                          POSTs fail loud — same contract as
//                          .sudo-askpass-endpoint.json)
//   .headless-session.json {sessionId, ts} 0600 — last live session id;
//                          next boot resumes it (probe 4: --resume in a new
//                          process keeps the conversation)
//
// The injected message format is the <channel …> tag the interactive
// dev-channels lane rendered. The LOAD-BEARING part of that contract is
// stop-reply-guard.mjs's parser: `<channel … channelId="…">body</channel>`
// (hooks/stop-reply-guard.mjs:135). scripts/test-headless-lane.mjs pins the
// rendered shape against that exact regex.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MEM = process.env.MEM
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const MODEL = process.env.MODEL
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || ''
const MCP_CONFIG_FILE = process.env.MCP_CONFIG_FILE || ''

const log = (m) => process.stderr.write(`[headless-lane] ${m}\n`)

// Resolved lazily inside main() -- MEM is unset when this module is merely
// imported (tests import the pure renderers), and a module-level guard here
// killed the import itself (caught 2026-08-04, first syntax check).
const sessionFile = () => path.join(MEM, '.headless-session.json')
const endpointFile = () => path.join(MEM, '.ingest-endpoint.json')

function writeJsonAtomic(file, value, mode) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode })
  fs.renameSync(tmp, file)
}

function readPriorSessionId() {
  try {
    const v = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'))
    return typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : null
  } catch {
    return null
  }
}

// ── the <channel> tag (contract: stop-reply-guard's parser) ────────────────
// `>` matters as much as `<` here: stop-reply-guard scans attributes with
// [^>]*, so a bare `>` inside an attr VALUE truncates the scan before the
// real channelId — a hostile display name could unparse its own message.
const escapeAttr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderChannelTag({ content, meta = {} }) {
  const attrs = [
    `source="${escapeAttr(meta.source || 'agent-channel')}"`,
    `sender="${escapeAttr(meta.sender || 'user')}"`,
    `channelId="${escapeAttr(meta.channelId || 'in-app')}"`,
    `authorId="${escapeAttr(meta.authorId || '')}"`,
    `timestamp="${escapeAttr(meta.timestamp || '')}"`,
  ].join(' ')
  return `<channel ${attrs}>${String(content == null ? '' : content)}</channel>`
}

export function renderUserEvent(payload) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: renderChannelTag(payload) }] },
  }) + '\n'
}

// ── spawn ───────────────────────────────────────────────────────────────────
// PURE function of explicit inputs (existence checks live in main(), where
// env resolution belongs) -- test-supervisor.mjs pins this exact argv as
// the ONE claude argv builder both lanes share by construction.
export function buildArgs({ model, systemPromptFile, mcpConfigFile, resumeId }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--dangerously-skip-permissions',
  ]
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile)
  if (mcpConfigFile) args.push('--strict-mcp-config', '--mcp-config', mcpConfigFile)
  if (resumeId) args.push('--resume', resumeId)
  return args
}

function main() {
  if (!MEM || !MODEL) {
    log('FATAL: MEM and MODEL env vars are required (run.sh exports both)')
    process.exit(78) // EX_CONFIG
  }
  const resumeId = readPriorSessionId()
  const args = buildArgs({
    model: MODEL,
    systemPromptFile: SYSTEM_PROMPT_FILE && fs.existsSync(SYSTEM_PROMPT_FILE) ? SYSTEM_PROMPT_FILE : null,
    mcpConfigFile: MCP_CONFIG_FILE && fs.existsSync(MCP_CONFIG_FILE) ? MCP_CONFIG_FILE : null,
    resumeId,
  })
  log(`spawning: ${CLAUDE_BIN} ${args.join(' ')}`)
  if (resumeId) log(`resuming session ${resumeId}`)

  const child = spawn(CLAUDE_BIN, args, {
    cwd: MEM,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  })

  let childExited = false
  let sawInit = false

  child.on('error', (err) => {
    log(`spawn failed: ${err.message}`)
    process.exit(127)
  })

  // ── stdout: structured events ─────────────────────────────────────────────
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let e
    try { e = JSON.parse(line) } catch {
      if (line.trim()) log(`non-json stdout: ${line.slice(0, 200)}`)
      return
    }
    if (e.type === 'system' && e.subtype === 'init') {
      sawInit = true
      if (typeof e.session_id === 'string' && e.session_id) {
        try {
          writeJsonAtomic(sessionFile(), { sessionId: e.session_id, ts: Date.now() }, 0o600)
        } catch (err) {
          log(`session file write failed (resume degrades to fresh next boot): ${err.message}`)
        }
      }
      log(`init: model=${e.model} session=${e.session_id} mcp=${JSON.stringify((e.mcp_servers || []).map((s) => `${s.name}:${s.status}`))}`)
    } else if (e.type === 'result') {
      log(`turn result: ${e.subtype}${e.is_error ? ' (error)' : ''} turns=${e.num_turns}`)
    } else if (e.type === 'assistant') {
      for (const c of (e.message && e.message.content) || []) {
        if (c.type === 'tool_use') log(`tool: ${c.name}`)
      }
    }
  })

  // ── ingest server ─────────────────────────────────────────────────────────
  const token = randomBytes(32).toString('hex')
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
    if (req.method !== 'POST' || req.url !== '/inbound') return send(404, { error: 'not found' })
    if (!tokenOk(req.headers['x-ingest-token'])) return send(403, { error: 'bad token' })
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024) { req.destroy(); }
    })
    req.on('end', () => {
      let payload
      try { payload = JSON.parse(body) } catch { return send(400, { error: 'invalid json' }) }
      const content = String(payload.content == null ? '' : payload.content).trim()
      if (!content) return send(400, { error: 'content required' })
      if (childExited || !child.stdin.writable) return send(503, { error: 'agent not running' })
      try {
        child.stdin.write(renderUserEvent({ content, meta: payload.meta || {} }))
      } catch (err) {
        log(`stdin write failed: ${err.message}`)
        return send(503, { error: 'stdin write failed' })
      }
      send(200, { ok: true })
    })
  })

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    try {
      writeJsonAtomic(endpointFile(), { port, token }, 0o600)
      log(`ingest endpoint on 127.0.0.1:${port} (token file ${path.basename(endpointFile())})`)
    } catch (err) {
      // Without the endpoint file backends fall back to the MCP notification,
      // which is dead in -p -- that is an agent that can talk but not hear.
      // Loud and fatal: the supervisor loop respawns us for another try.
      log(`FATAL: cannot write ingest endpoint file: ${err.message}`)
      child.kill('SIGTERM')
      process.exitCode = 74 // EX_IOERR
    }
  })

  // ── lifecycle ────────────────────────────────────────────────────────────
  const shutdown = (sig) => {
    log(`${sig} received, stopping child`)
    try { child.stdin.end() } catch { /* already gone */ }
    child.kill('SIGTERM')
    setTimeout(() => { if (!childExited) child.kill('SIGKILL') }, 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  child.on('exit', (code, signal) => {
    childExited = true
    try { fs.unlinkSync(endpointFile()) } catch { /* never written or already gone */ }
    log(`claude exited code=${code} signal=${signal} sawInit=${sawInit}`)
    server.close(() => process.exit(code == null ? 1 : code))
    // If close callbacks hang (open keep-alive sockets), don't wait forever.
    setTimeout(() => process.exit(code == null ? 1 : code), 3_000).unref()
  })
}

// Importable for tests (renderChannelTag / renderUserEvent are pure); the
// lane only runs when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main()
}
