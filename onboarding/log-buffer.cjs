// log-buffer.cjs — in-memory ring buffer + on-disk sink for the app's
// operational log (v0.0.20, the owner 07-16 "로그 터미널 창" commission).
//
// WHY THIS EXISTS: in the packaged app, main.cjs's console.* goes nowhere a
// user can see (no terminal; Console.app at best). The agent supervisor's
// stdout/stderr are piped INTO main.cjs (spawn stdio 'pipe') and were only
// re-echoed to that same invisible console — run.sh's own LOGFILE is used
// only by its standalone `start` path, never by the app's `__loop` spawn.
// So during live debugging the user is fully blind ("지금 너무 깜깜이라").
// This module is the single tap point: main.cjs appends every line here,
// GET /api/logs (http-server.cjs) reads it, /logs renders it.
//
// DESIGN CONSTRAINTS:
// - No require on http-server.cjs (it requires US — a DATA_HOME import here
//   would be a cycle). The file sink dir is handed in by main.cjs via
//   initSink(); never initialized (tests, standalone) = buffer-only, no disk.
// - SECRETS: lines are redacted BEFORE they enter the buffer or the disk
//   sink. The safeStorage seam keeps tokens out of config files, but agent
//   stdout is arbitrary text — a child echoing its env must not turn this
//   viewer into a token leak. Patterns cover every credential class the app
//   itself handles (discord bot / slack xoxb+xapp / telegram bot / sk-*
//   provider keys / Bearer headers). Redaction is best-effort defense in
//   depth, not a promise — the UI copy must not claim "safe to share".
// - Sink failures are loud-once, never fatal: a broken log sink must not
//   take down the app it is supposed to help debug.

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_ENTRIES = 3000
// getSince() response cap: a client that fell far behind (or just loaded
// the page) gets at most this many entries per poll and catches up over
// successive polls via the nextSeq cursor.
const MAX_RESPONSE_ENTRIES = 1000
const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024 // 5MB, one .1 generation kept

// Order matters only for overlap; each pattern is applied globally.
const REDACT_PATTERNS = [
  // Discord bot token: base64ish id . 6-7 char timestamp . 27+ char HMAC
  /[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{25,}/g,
  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xapp-
  /\bx(?:oxb|oxp|oxa|oxr|app)-[A-Za-z0-9-]{10,}/g,
  // Telegram bot token: numeric bot id ":" 30+ char secret. No \b anchors:
  // the token routinely appears glued to a "bot" prefix (the file URL
  // .../file/bot<TOKEN>/...), where a leading \b never matches ("bot"+digits
  // are both word chars) and the token survived. Over-redaction is the safe
  // failure for a credential filter, so both boundaries are dropped.
  /\d{6,12}:[A-Za-z0-9_-]{30,}/g,
  // Provider keys (sk-ant-..., sk-proj-..., plain sk-...)
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Anything already riding an Authorization header shape
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
]

function redact(line) {
  let out = line
  for (const re of REDACT_PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}

// ── ring buffer ───────────────────────────────────────────────────────────
const entries = [] // { seq, ts, stream, line } — seq is monotonically increasing
let nextSeq = 1

// ── file sink (optional; initSink() from main.cjs) ────────────────────────
let sinkPath = null
let sinkRotateBytes = DEFAULT_ROTATE_BYTES
let sinkBroken = false // loud-once latch
let sinkBytes = 0 // tracked in-process; seeded from the existing file at init

function initSink(dir, opts) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    sinkPath = path.join(dir, 'app.log')
    if (opts && Number.isFinite(opts.rotateBytes)) sinkRotateBytes = opts.rotateBytes
    try {
      sinkBytes = fs.statSync(sinkPath).size
    } catch {
      sinkBytes = 0 // no file yet
    }
    // Session separator so a grabbed file reads across restarts.
    writeToSink(`===== app session start ${new Date().toISOString()} =====\n`)
  } catch (err) {
    sinkBroken = true
    sinkPath = null
    console.error(`[scheherazade/log-buffer] sink init failed (${err.message}) -- buffer-only mode`)
  }
}

function writeToSink(text) {
  if (!sinkPath || sinkBroken) return
  try {
    if (sinkBytes + text.length > sinkRotateBytes) {
      // One rotation generation: app.log -> app.log.1 (previous .1 dropped).
      fs.renameSync(sinkPath, `${sinkPath}.1`)
      sinkBytes = 0
    }
    fs.appendFileSync(sinkPath, text)
    sinkBytes += text.length
  } catch (err) {
    // Loud once, then silent: a dying disk shouldn't spam or crash.
    sinkBroken = true
    console.error(`[scheherazade/log-buffer] sink write failed (${err.message}) -- disk sink disabled for this session`)
  }
}

// ── public API ────────────────────────────────────────────────────────────
// stream conventions (renderer colors by these):
//   'main'   — main.cjs's own log()
//   'main!'  — main.cjs fatal/error surface
//   'agent'  — agent child stdout
//   'agent!' — agent child stderr
function append(stream, text) {
  const ts = new Date().toISOString()
  const lines = String(text).split('\n')
  let sinkChunk = ''
  for (const raw of lines) {
    const line = redact(raw.trimEnd())
    if (!line) continue
    entries.push({ seq: nextSeq++, ts, stream, line })
    sinkChunk += `[${ts}] [${stream}] ${line}\n`
  }
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  if (sinkChunk) writeToSink(sinkChunk)
}

// since = last seq the client already has (0 = from the top of the buffer).
// dropped = true when the buffer has already discarded entries the client
// never saw (client renders a gap marker instead of pretending continuity).
function getSince(since) {
  const from = Number.isFinite(since) && since > 0 ? since : 0
  const oldestRetained = entries.length ? entries[0].seq : nextSeq
  const dropped = from > 0 ? oldestRetained > from + 1 : false
  const out = []
  for (const e of entries) {
    if (e.seq <= from) continue
    out.push(e)
    if (out.length >= MAX_RESPONSE_ENTRIES) break
  }
  return {
    entries: out,
    nextSeq: out.length ? out[out.length - 1].seq : Math.max(from, oldestRetained - 1),
    dropped,
    file: sinkPath, // full-history pointer for "로그 파일 위치" in the UI
  }
}

// test hook: reset module state without a process restart
function _resetForTest() {
  entries.length = 0
  nextSeq = 1
  sinkPath = null
  sinkBroken = false
  sinkBytes = 0
  sinkRotateBytes = DEFAULT_ROTATE_BYTES
}

module.exports = { append, getSince, initSink, redact, _resetForTest }
