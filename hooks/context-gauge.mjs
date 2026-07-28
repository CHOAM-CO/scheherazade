#!/usr/bin/env node
// context-gauge.mjs -- Stop + SessionStart hook: context-occupancy tap.
//
// WHY (Mino live test 2026-07-16, gpt-5.6-luna 372K lane): the agent hit its
// context ceiling ~1.5h into real use and every turn drowned in a 2-3min
// autocompact pass. From the app there was NO way to see occupancy -- the
// agent terminal is headless (expect-wrapped PTY), /context is a CLI-UI
// command nothing can type, and the log viewer only shows the *symptoms*
// ("Compacting conversation…", "Context limit reached"). This hook is the
// missing instrument: on every Stop (and at SessionStart, for the
// post-restore baseline) it tail-parses the transcript's most recent usage
// block and drops a small JSON snapshot the app can serve.
//
// Read side: onboarding/http-server.cjs GET /api/context-status attaches the
// model->cap table and the /logs page renders the gauge.
//
// Contract: advisory instrument, NEVER a wall. Exit 0 on every path,
// fail-open with a stderr line (fail-loud, non-blocking). No hookSpecific
// output -- this hook talks to the APP, not to the agent's context (feeding
// the gauge back into context would be self-inflicted occupancy).

import fs from 'node:fs'
import path from 'node:path'

const TAIL_BYTES = 500 * 1024 // same tail budget as stop-reply-guard

const MEM = process.env.AGENT_DATA_HOME || process.env.MEM || process.cwd()
const STATUS_PATH = path.join(MEM, 'context-status.json')

function tailLines(filePath) {
  const stat = fs.statSync(filePath)
  const bytesToRead = Math.min(stat.size, TAIL_BYTES)
  const start = Math.max(0, stat.size - bytesToRead)
  const buf = Buffer.alloc(bytesToRead)
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.readSync(fd, buf, 0, bytesToRead, start)
  } finally {
    fs.closeSync(fd)
  }
  const lines = buf.toString('utf8').split('\n')
  // first line of a mid-file tail is likely a truncated record -- drop it
  return { lines: start === 0 ? lines : lines.slice(1), fileBytes: stat.size }
}

async function main() {
  let rawInput = ''
  for await (const chunk of process.stdin) rawInput += chunk
  let hookInput = {}
  try { hookInput = JSON.parse(rawInput || '{}') } catch { process.exit(0) }

  const transcriptPath = hookInput.transcript_path
  const sessionId = typeof hookInput.session_id === 'string' ? hookInput.session_id : null
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0)

  const { lines, fileBytes } = tailLines(transcriptPath)

  // Walk from the END: the last assistant record carrying message.usage is
  // the most recent API request, and its prompt-side counters ARE the
  // current context occupancy (input + cache_read + cache_creation = what
  // was sent; + output = what the next turn will additionally carry).
  let usage = null
  let model = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('"usage"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const u = entry && entry.message && entry.message.usage
    if (!u || typeof u.input_tokens !== 'number') continue
    usage = u
    model = (entry.message && entry.message.model) || null
    break
  }
  // A fresh session (SessionStart before any turn) legitimately has no
  // usage yet -- keep the previous snapshot rather than blanking the gauge,
  // but MARK it as carried over from an earlier session. Live incident
  // (Mino, 2026-07-28): a previous session ended near 133K, the agent was
  // rebooted on a new build, and the gauge's unmarked leftover read as
  // "133K at boot" -- a 20K arithmetic gap against the real session ledger
  // that cost a three-hypothesis diagnosis to close. An instrument may
  // show history, but never history dressed as the present.
  if (!usage) {
    try {
      const prev = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'))
      const sameSession = sessionId && prev.sessionId && prev.sessionId === sessionId
      if (!prev.carriedOver && !sameSession) {
        prev.carriedOver = true
        prev.carriedAt = new Date().toISOString()
        const tmpMark = `${STATUS_PATH}.tmp`
        fs.writeFileSync(tmpMark, JSON.stringify(prev, null, 2))
        fs.renameSync(tmpMark, STATUS_PATH)
      }
    } catch { /* no previous snapshot, or unreadable -- nothing to mark */ }
    process.exit(0)
  }

  const contextTokens =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.output_tokens || 0)

  const snapshot = {
    ts: new Date().toISOString(),
    model,
    sessionId,
    contextTokens,
    usage: {
      input_tokens: usage.input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
    },
    transcriptPath,
    transcriptBytes: fileBytes,
  }

  // atomic write: a reader (http-server polls this) must never see a torn file
  const tmp = `${STATUS_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2))
  fs.renameSync(tmp, STATUS_PATH)
  process.exit(0)
}

main().catch((e) => {
  process.stderr.write(`[context-gauge] fatal: ${e.stack || e.message}\n`)
  process.exit(0) // fail-open: an instrument must never trap the agent
})
