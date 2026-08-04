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
const strikesFile = () => path.join(MEM, '.headless-resume-strikes.json')
const pendingFile = () => path.join(MEM, '.headless-pending.json')

// Conversation rotation (UX red-team 2026-08-04 F3): --resume on every
// recycle means the conversation would otherwise grow forever -- slower
// replies, slower boots, climbing cost, and a 12h boot-greeting turn
// accumulating in one endless thread. `bornTs` is the CONVERSATION's birth
// (preserved across resumes; `ts` is just the last process start and
// refreshes every boot, so it cannot express age). Past the ceiling we
// rotate to a fresh session -- checkpoint files are the continuity bridge,
// exactly as they were for the pre-headless 12h recycle.
const MAX_CONVO_AGE_MS = (Number(process.env.SCHEHERAZADE_MAX_CONVO_HOURS) || 24) * 3600 * 1000

// Stranded-message redelivery (UX red-team 2026-08-04 F4): a recycle can
// land mid-turn -- the user's message reached claude's stdin (chat shows
// "Read") but the answer died with the process, and a --resume does NOT
// restart the turn. The lane keeps a FIFO of user events written to stdin
// that have not yet been paid for by a `result` event; whatever is left at
// boot gets re-injected once (redelivered:true entries are never re-sent a
// second time -- one retry, no loops).
function readPending() {
  try {
    const v = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'))
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
function writePending(list) {
  try {
    if (!list.length) {
      try { fs.unlinkSync(pendingFile()) } catch { /* already gone */ }
      return
    }
    writeJsonAtomic(pendingFile(), list.slice(-20), 0o600)
  } catch (err) {
    log(`pending write failed (a mid-turn recycle could strand this message): ${err.message}`)
  }
}

// Stale-resume recovery (red-team 2026-08-04 #2): a session id whose
// transcript no longer exists could make `claude -p --resume <id>` die
// before ever emitting init, forever, and the generic crash-loop marker
// would misdiagnose it as a bad provider key. Rule: two consecutive
// no-init exits under the SAME resume id -> abandon the id (next boot is
// fresh). A successful init clears the count. tmp+rename like every other
// marker; any read error counts as "no strikes" (never blocks a boot).
function recordExitForResume({ sawInit, resumeId }) {
  if (sawInit) {
    try { fs.unlinkSync(strikesFile()) } catch { /* none recorded */ }
    return
  }
  if (!resumeId) return
  let strikes = 0
  try {
    const v = JSON.parse(fs.readFileSync(strikesFile(), 'utf8'))
    if (v && v.resumeId === resumeId) strikes = Number(v.strikes) || 0
  } catch { /* fresh count */ }
  strikes += 1
  if (strikes >= 2) {
    log(`resume id ${resumeId} died before init ${strikes} times -- abandoning it; next boot starts a FRESH session (old conversation stays on disk, it is just no longer auto-resumed)`)
    try { fs.unlinkSync(sessionFile()) } catch { /* already gone */ }
    try { fs.unlinkSync(strikesFile()) } catch { /* already gone */ }
    return
  }
  try {
    writeJsonAtomic(strikesFile(), { resumeId, strikes }, 0o600)
  } catch (err) {
    log(`strikes write failed (worst case: one extra resume attempt): ${err.message}`)
  }
}

function writeJsonAtomic(file, value, mode) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode })
  fs.renameSync(tmp, file)
}

function readPriorSession() {
  try {
    const v = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'))
    if (typeof v.sessionId !== 'string' || !v.sessionId) return null
    return v
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
  const prior = readPriorSession()
  let resumeId = prior ? prior.sessionId : null
  const priorBornTs = prior && Number(prior.bornTs) ? Number(prior.bornTs) : null
  if (resumeId && priorBornTs && Date.now() - priorBornTs > MAX_CONVO_AGE_MS) {
    const ageH = Math.round((Date.now() - priorBornTs) / 3600_000)
    log(`conversation is ~${ageH}h old (ceiling ${Math.round(MAX_CONVO_AGE_MS / 3600_000)}h) -- rotating to a FRESH session; checkpoint files carry continuity`)
    resumeId = null
  }
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

  // Redeliver messages stranded by a mid-turn recycle (F4). Runs before the
  // ingest server exists, so these precede any new inbound POST in stdin
  // order. Entries already redelivered once are dropped (no retry loops),
  // as is anything older than 48h (stale beyond usefulness).
  {
    const stranded = readPending().filter((ev) => !ev.redelivered && Date.now() - (Number(ev.ts) || 0) < 48 * 3600_000)
    writePending(stranded.map((ev) => ({ ...ev, redelivered: true })))
    if (stranded.length) {
      log(`re-delivering ${stranded.length} message(s) stranded by the previous recycle`)
      for (const ev of stranded) {
        try {
          child.stdin.write(renderUserEvent({
            content: `${ev.content}\n[redelivered: the previous agent process was recycled mid-turn before this message was answered. If a complete reply was already sent, do not repeat it -- otherwise answer now.]`,
            meta: ev.meta || {},
          }))
        } catch (err) {
          log(`redelivery write failed: ${err.message}`)
        }
      }
    }
  }

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
          // bornTs survives resumes (conversation birth); a fresh session --
          // no resume, or rotation above -- starts a new clock.
          const bornTs = resumeId && priorBornTs ? priorBornTs : Date.now()
          writeJsonAtomic(sessionFile(), { sessionId: e.session_id, ts: Date.now(), bornTs }, 0o600)
        } catch (err) {
          log(`session file write failed (resume degrades to fresh next boot): ${err.message}`)
        }
      }
      log(`init: model=${e.model} session=${e.session_id} mcp=${JSON.stringify((e.mcp_servers || []).map((s) => `${s.name}:${s.status}`))}`)
    } else if (e.type === 'result') {
      log(`turn result: ${e.subtype}${e.is_error ? ' (error)' : ''} turns=${e.num_turns}`)
      // One result pays for the oldest pending user event (FIFO). If -p
      // ever batches queued messages into one turn instead, leftovers get
      // one guarded redelivery at next boot -- the redelivery note tells
      // the agent not to answer twice, so the failure mode is a nudge, not
      // a double reply. (Queued-turn semantics are design-0020 open q.1.)
      const p = readPending()
      if (p.length) writePending(p.slice(1))
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
    // Host check before anything else, mirroring channel-local.mjs:447 --
    // a DNS-rebinding target resolves to 127.0.0.1 but arrives with a
    // foreign Host header. Token auth already blocks the actual attack;
    // this keeps the two loopback servers on one security posture
    // (red-team 2026-08-04 #5).
    const host = String(req.headers.host || '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return send(403, { error: 'bad host' })
    }
    if (req.method !== 'POST' || req.url !== '/inbound') return send(404, { error: 'not found' })
    if (!tokenOk(req.headers['x-ingest-token'])) return send(403, { error: 'bad token' })
    let body = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024 && !tooLarge) {
        // Answer with a real 413 BEFORE dropping the socket -- a bare
        // req.destroy() surfaced caller-side as a generic 'fetch failed',
        // indistinguishable from a dead lane (red-team 2026-08-04 #4).
        tooLarge = true
        send(413, { error: 'too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return // 413 already sent
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
      writePending([...readPending(), { content, meta: payload.meta || {}, ts: Date.now() }])
      send(200, { ok: true })
    })
  })

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    try {
      writeJsonAtomic(endpointFile(), { port, token, pid: process.pid }, 0o600)
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
    recordExitForResume({ sawInit, resumeId })
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
