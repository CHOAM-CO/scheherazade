#!/usr/bin/env node
// headless-lane.mjs — the -p (headless stream-json) spawn lane. design-0020.
//
// Replaces the old expect script: instead of driving an interactive TUI
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
//   - no restart/backoff: supervisor.mjs's loop owns that; this process
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
// (hooks/stop-reply-guard.mjs:135). tests/test-headless-lane.mjs pins the
// rendered shape against that exact regex.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killTree as procKillTree } from './proc.cjs'
import { createTurnGate } from './turn-gate.mjs'

const MEM = process.env.MEM
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const MODEL = process.env.MODEL
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || ''
const MCP_CONFIG_FILE = process.env.MCP_CONFIG_FILE || ''

// Lifecycle logs go to STDOUT: the app's log console colors stderr red
// ([agent!]), and a healthy boot painted red read as an error to a real
// user (the owner 16:02 "인디케이터에서는 빨간색으로 떠서 에러난것같음"). The
// lane's own stdout is free -- claude's stream-json rides a pipe consumed
// internally, never this process's stdout. errLog stays on stderr for
// genuine failures only.
const log = (m) => process.stdout.write(`[headless-lane] ${m}\n`)
const errLog = (m) => process.stderr.write(`[headless-lane] ${m}\n`)
// Per-tool-call chatter drowned the app's log console the moment a real
// agent got busy (the owner, clean-mac 13:54 "로그 존나뜸"). Lifecycle lines
// (spawn/init/result/exit/redelivery/strikes) stay on by default;
// per-event diagnostics go behind this flag.
const DEBUG = process.env.SCHEHERAZADE_LANE_DEBUG === '1'
const debugLog = (m) => { if (DEBUG) log(m) }

// Resolved lazily inside main() -- MEM is unset when this module is merely
// imported (tests import the pure renderers), and a module-level guard here
// killed the import itself (caught 2026-08-04, first syntax check).
const sessionFile = () => path.join(MEM, '.headless-session.json')
const endpointFile = () => path.join(MEM, '.ingest-endpoint.json')
const strikesFile = () => path.join(MEM, '.headless-resume-strikes.json')
const pendingFile = () => path.join(MEM, '.headless-pending.json')
// User STOP receipt (0.3.1 steering/stop). The hard interrupt path kills the
// claude child, so the explanation cannot be written into the dying session:
// it is left on disk and consumed by the NEXT boot (same pattern as
// rotateFile()), then folded into the next real user message so the resumed
// transcript explains its own gap instead of looking like the agent went mute.
const stoppedFile = () => path.join(MEM, '.stopped-by-user')

// Conversation rotation. v1 (UX red-team 2026-08-04 F3) cut purely by AGE;
// v2 (the owner 2026-08-04 19:44 "시간으로 끊지말고 더 좋은 방법 있나?") cuts by
// CONTEXT PRESSURE, which is the thing age was a proxy for: what actually
// degrades a long resume is the context the next turn must carry.
// v2.1 (2026-08-05 live receipts): the `result` event's usage turns out to be
// CUMULATIVE across the turn's sub-turn API calls, not standing context —
// the owner's box read "932,698 tokens" after a turns=35 turn (≈26.6k × 35), the
// opus probe "190,368" after turns=10 (≈19k × 10). Reading it over-rotated
// by roughly a factor of num_turns. The LAST `assistant` event's
// message.usage is the actual standing weight of the newest API call, so
// that is what pressure now reads; the result usage stays only as a
// fallback for providers whose stream never carries assistant usage —
// deliberately the over-counting direction (rotating too often beats never).
// The rules:
//   1. pressure over threshold -> SCHEDULE a rotation (marker on disk, so
//      the decision survives recycles) -- never cut immediately;
//   2. cut only at an IDLE BOUNDARY (no open turn, quiet for a few
//      minutes) -- a conversation is never beheaded mid-thread;
//   3. before cutting, ONE [SYSTEM] handoff turn asks the agent to flush
//      checkpoint.md -- the same continuity bridge the graceful-quit path
//      uses -- and the fresh session boots reading it (MEM CLAUDE.md §1).
// A light conversation can now live for days; a heavy one rotates the same
// evening. AGE stays only as a backstop (default raised 24h -> 72h) for a
// lane whose provider never reports usage.
const MAX_CONVO_AGE_MS = (Number(process.env.SCHEHERAZADE_MAX_CONVO_HOURS) || 72) * 3600 * 1000
const ROTATE_CONTEXT_TOKENS = Math.max(20_000, Number(process.env.SCHEHERAZADE_CONTEXT_TOKENS) || 200_000)
const ROTATE_AT = Math.min(0.95, Math.max(0.3, Number(process.env.SCHEHERAZADE_ROTATE_AT) || 0.7))
const ROTATE_IDLE_MS = Math.max(0.005, Number(process.env.SCHEHERAZADE_ROTATE_IDLE_MINUTES) || 5) * 60_000
// Check cadence follows the idle window down so tests (and aggressive
// configs) are not stuck behind a 30s tick.
const ROTATE_CHECK_MS = Math.min(30_000, Math.max(250, Math.floor(ROTATE_IDLE_MS / 2)))
const rotateFile = () => path.join(MEM, '.headless-rotate-pending.json')

// What the NEXT turn must carry ≈ what this turn carried: input + both
// cache flavors. output_tokens is excluded on purpose -- it is this turn's
// spend, not the conversation's standing weight (it shows up as next
// turn's input anyway). Exported pure for tests.
export function contextTokensOf(usage) {
  const u = usage || {}
  return (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
}

// Turn watchdog (2026-08-04, field case: deepseek/glm via ollama.com wedging
// a turn forever -- process alive, init clean, model call never returns,
// user sees eternal silence; first reported by external tester #1 as
// "silent die", reproduced on the owner's own machine 17:47). stream-json emits
// per-MESSAGE events, not token deltas, so a slow model is legitimately
// silent for the length of one API call -- the ceiling must be generous.
// Default 10min of ZERO child stdout while a turn is in flight = wedged:
// kill the child, let the supervisor respawn, and the stranded-redelivery
// machinery below retries the unanswered message exactly once (its
// redelivered:true rule already prevents a wedge->redeliver->wedge loop
// from re-sending forever; the SECOND wedge drops the message and only the
// loud log remains).
const TURN_STALL_MS = Math.max(2, Number(process.env.SCHEHERAZADE_TURN_STALL_MINUTES) || 10) * 60_000

// Stranded-message redelivery (UX red-team 2026-08-04 F4): a recycle can
// land mid-turn -- the user's message reached claude's stdin (chat shows
// "Read") but the answer died with the process, and a --resume does NOT
// restart the turn. The lane keeps a FIFO of user events written to stdin
// that have not yet been paid for by a `result` event; whatever is left at
// boot gets re-injected once (redelivered:true entries are never re-sent a
// second time -- one retry, no loops).
// Splits the boot-time pending FIFO. `sweeps` = entries the onboarding UI
// queued while the lane was down (flagged sweep:true by routes/migrate.cjs):
// they are sender=SYSTEM on purpose but NOT moment-bound, so the SYSTEM drop
// below must not apply to them (root cause of 0.3.6 "Queued but never
// delivered"). `stranded` = the old mid-turn-recycle redelivery set.
export function partitionPending(list, now, { sweepMaxAgeMs = 7 * 24 * 3600_000 } = {}) {
  const sweeps = []
  const stranded = []
  for (const ev of list) {
    const age = now - (Number(ev.ts) || 0)
    if (ev && ev.sweep === true) {
      if (age < sweepMaxAgeMs) sweeps.push(ev)
    } else if (!ev.redelivered && age < 48 * 3600_000 && !(ev.meta && ev.meta.sender === 'SYSTEM')) {
      stranded.push(ev)
    }
  }
  return { stranded, sweeps }
}
function readPending() {
  try {
    const v = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'))
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
// Returns true when the pending FIFO is durable on disk, false when the write
// failed. Existing best-effort callers ignore the return; the ingest path uses
// it to refuse (500) a delivery it could not make crash-recoverable.
function writePending(list) {
  try {
    if (!list.length) {
      try { fs.unlinkSync(pendingFile()) } catch { /* already gone */ }
      return true
    }
    writeJsonAtomic(pendingFile(), list.slice(-20), 0o600)
    return true
  } catch (err) {
    log(`pending write failed (a mid-turn recycle could strand this message): ${err.message}`)
    return false
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

// The turn-abort record's producer -- lane side (design-0025, 2026-09-28). Same
// record shape the supervisor writes and channel-local consumes; the reason here
// is 'stall' -- the upstream call went quiet past TURN_STALL_MS, so the turn is
// dead even though this process is still alive. tail is null: this watchdog
// reads no transcript, so it has no tail kind to name. elapsedMs is null for the
// same reason the supervisor leaves it null (see supervisor.mjs's writer): the
// true "from awaitingSince" number lives in the channel, not here.
//
// NEVER throws and NEVER blocks the recycle: a record that cannot be written
// costs one honest line on the next boot, not the kill. tmp+rename with a
// pid-suffixed tmp -- the supervisor writes this same file (the $MEM it passes
// to us IS its cfg.mem), and a shared tmp name would let the two writers
// truncate each other's bytes. Exported so the contract is testable against a
// temp dir without spawning the lane.
export function writeTurnAbortRecord(reason, { dir = MEM } = {}) {
  try {
    const file = path.join(dir, '.last-turn-abort.json')
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), reason, tail: null, elapsedMs: null }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    log(`turn-abort record write failed (non-fatal -- the recycle proceeds): ${err.message}`)
  }
}

// ── turn-level STOP mechanics (0.3.5 soft stop) ─────────────────────────────
// Which way a Stop press ends the in-flight turn, per platform. PURE: the
// platform is an argument so the win32 branch is testable on a mac.
//
//   posix ('signal') -- unchanged since 0.3.1. SIGTERM is the interrupt the
//     CLI understands there: its handler reaps its own MCP children and exits,
//     the lane follows it out, the supervisor respawns with --resume. SIGKILL
//     after 10 s if it did not go.
//   win32 ('soft-then-tree') -- no signal is deliverable (process.kill is
//     TerminateProcess: no handler runs), so the old SIGTERM was a hard
//     terminate of claude.exe ALONE and every MCP server it had spawned
//     (channel-local included) was orphaned. Now: a stream-json
//     control_request {subtype:'interrupt'} on stdin, which the CLI honours
//     in-process -- it cancels the running tool, answers control_response
//     success, and closes the turn with a `result` (probe receipt, claude
//     2.1.284 on mac, 2026-09-29: control_response at +0 ms, result
//     subtype=error_during_execution in the same tick, the NEXT user message
//     answered normally on the same live session). The session and its MCP
//     children stay up, so there is nothing to orphan and no respawn. Only
//     if no result lands inside the grace window (or the CLI refuses the
//     request, or stdin is gone) does the lane escalate to a TREE kill
//     (proc.killTree = taskkill /PID <claude> /T /F), which takes the MCP
//     children with it. The claude child is spawned non-detached, but on
//     win32 there are no process groups, so /T on the CHILD's pid never
//     reaches this lane.
export const SOFT_STOP_GRACE_MS = Math.max(1_000, (Number(process.env.SCHEHERAZADE_SOFT_STOP_SECONDS) || 8) * 1000)
export const SIGNAL_STOP_KILL_MS = 10_000

export function planTurnStop({ platform = process.platform, softGraceMs = SOFT_STOP_GRACE_MS } = {}) {
  if (platform === 'win32') return { mode: 'soft-then-tree', graceMs: softGraceMs }
  return { mode: 'signal', graceMs: SIGNAL_STOP_KILL_MS }
}

export function renderInterruptRequest(requestId) {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n'
}

// The stop executor. Everything with a side effect is injected (child handle,
// tree kill, timer, clock), so tests drive the win32 branch with fakes and no
// real taskkill ever runs. The lane feeds it the two stdout events that
// matter: control_response (noteControlResponse) and result (noteResult).
// noteResult() returns true exactly once per soft stop -- that result IS the
// cancelled turn's close, and the lane must not count it as an error turn,
// pay the FIFO with it, or mute-nudge on it.
export function createTurnStopper({
  child,
  platform = process.platform,
  isExited = () => false,
  killTree = procKillTree,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t },
  clearTimer = (t) => clearTimeout(t),
  softGraceMs = SOFT_STOP_GRACE_MS,
  newRequestId = () => `stop_${Date.now()}_${randomBytes(4).toString('hex')}`,
  log: slog = log,
} = {}) {
  let soft = null // { requestId, timer, escalated, settled }

  const treeKill = (why) => {
    if (soft) { soft.escalated = true; if (soft.timer) clearTimer(soft.timer); soft.timer = null }
    if (isExited()) return 'gone'
    slog(`user STOP: ${why} -- tree-killing the claude child and its MCP children (taskkill /T /F)`)
    try {
      killTree(child.pid, 'SIGKILL')
      return 'tree'
    } catch (err) {
      // taskkill exit 128 = no such process: it went away on its own in the
      // gap. Anything else: last resort is the single-process terminate,
      // which at least ends the turn (children then fall to the supervisor's
      // orphan sweep, the pre-0.3.5 behaviour).
      slog(`tree kill failed (${err.message}) -- falling back to a single-process kill`)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      return 'single'
    }
  }

  return {
    plan: planTurnStop({ platform, softGraceMs }),
    // Returns the mode actually taken: 'signal' | 'soft' | 'tree' | 'single' | 'gone'.
    begin() {
      const { mode, graceMs } = this.plan
      if (mode === 'signal') {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        setTimer(() => { if (!isExited()) { try { child.kill('SIGKILL') } catch { /* gone */ } } }, graceMs)
        return 'signal'
      }
      if (soft && !soft.settled && !soft.escalated) return 'soft' // a double press rides the first request
      const requestId = newRequestId()
      soft = { requestId, timer: null, escalated: false, settled: false }
      try {
        child.stdin.write(renderInterruptRequest(requestId))
      } catch (err) {
        return treeKill(`interrupt write failed (${err.message})`)
      }
      soft.timer = setTimer(() => {
        if (!soft || soft.settled || soft.escalated) return
        treeKill(`the soft interrupt did not end the turn within ${Math.round(graceMs / 1000)}s`)
      }, graceMs)
      slog(`user STOP: soft interrupt sent (control_request ${requestId}); tree kill in ${Math.round(graceMs / 1000)}s if the turn does not end`)
      return 'soft'
    },
    noteControlResponse(e) {
      const r = e && e.response
      if (!soft || !r || r.request_id !== soft.requestId || soft.settled || soft.escalated) return false
      if (r.subtype === 'error') {
        treeKill(`the CLI refused the interrupt (${String(r.error || 'no detail').slice(0, 200)})`)
      } else {
        slog('user STOP: interrupt accepted by the CLI, waiting for the turn to close')
      }
      return true
    },
    noteResult() {
      if (!soft || soft.settled || soft.escalated) return false
      soft.settled = true
      if (soft.timer) clearTimer(soft.timer)
      soft.timer = null
      return true
    },
    pending() { return !!(soft && !soft.settled && !soft.escalated) },
  }
}

// ── whole-child terminator (0.3.6) ───────────────────────────────────────────
// Every NON-user-Stop way the lane ends its claude child (stall watchdog,
// 3-error recycle, context-rotation recycle, .stop_requested / SIGTERM
// shutdown, endpoint FATAL) used to be a bare child.kill('SIGTERM'), which on
// win32 is TerminateProcess on ONE pid and orphans every MCP server claude
// spawned (the 0.3.5 soft-stop bug, other doors). Same seam as the Stop button:
//   win32: proc.killTree (taskkill /PID /T /F), single-pid kill if that throws.
//   posix: SIGTERM, SIGKILL after graceMs -- unchanged (claude reaps its MCP
//          children on SIGTERM; a group kill would take the lane with it).
export function createChildTerminator({
  child,
  platform = process.platform,
  isExited = () => false,
  killTree = procKillTree,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t },
  graceMs = SIGNAL_STOP_KILL_MS,
  log: tlog = log,
} = {}) {
  return function terminate(why = '') {
    if (isExited()) return 'gone'
    if (platform === 'win32') {
      tlog(`${why ? why + ': ' : ''}tree-killing the claude child and its MCP children (taskkill /T /F)`)
      try {
        killTree(child.pid, 'SIGKILL')
        return 'tree'
      } catch (err) {
        tlog(`tree kill failed (${err.message}) -- falling back to a single-process kill`)
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        return 'single'
      }
    }
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    setTimer(() => { if (!isExited()) { try { child.kill('SIGKILL') } catch { /* gone */ } } }, graceMs)
    return 'signal'
  }
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

// ── mute recovery (2026-08-13, the owner field report: in-app 0.1.7, Windows) ─────
// The `-p` mute: a model composes reply text but never calls the reply tool,
// so the answer sits in the transcript and never reaches the user.
// hooks/stop-reply-guard.mjs is meant to catch this on Stop and force a resend
// via exit 2 -- but Claude Code drops a Stop-hook's exit 2 as a NON-blocking
// error in `claude -p` headless mode ("Failed with non-blocking status code"),
// because there is no interactive turn for it to block into. Proven on the owner's
// box: the guard fired 7x, every one logged non-blocking, the turns ended
// silent, and the mute-strike ledger (which only advances behind the guard's
// blocked-and-retried path) never moved. So the guard's decision moves HERE,
// where the lane owns the live stream-json session and CAN inject a fresh turn.
//
// Pure decision (exported for tests): given what a just-finished turn did,
//   - it delivered SOMETHING (reply / react / file) -> 'clear' (not mute)
//   - a real user asked and it composed text but sent nothing -> 'nudge'
//   - anything else (SYSTEM/rotation turn, silent no-text, etc.) -> 'none'
// A reaction/file counts as delivery on purpose -- same as the guard's
// REPLY_TOOLS -- so an emoji-only answer is never nudged into forced words.
export function muteRecoveryDecision({ turnHadUserInbound, sawReply, sawText }) {
  if (sawReply) return 'clear'
  if (turnHadUserInbound && sawText) return 'nudge'
  return 'none'
}

// A reply-class tool call is any backend's reply / send_file_to_discord /
// react (mcp__agent-channel__* in the packaged app, mcp__idea__* in the idea
// dev lane) -- matched by suffix so a backend/server rename can't silently
// disarm mute detection, exactly as stop-reply-guard matches its REPLY_TOOLS.
export const isReplyClassTool = (name) => /__(?:reply|send_file_to_discord|react)$/.test(String(name || ''))

// Does a turn's inbound open the mute-recovery gate? EXACTLY stop-reply-guard's
// exemptions and no more: channelId 'system' (the lane's OWN housekeeping turns
// -- the rotation handoff and the mute nudge below; guard :197) and a
// [reaction] injection (guard :186) are exempt. Deliberately NOT sender===
// 'SYSTEM': an autonomy brief / routine tick / note-cadence reminder rides a
// REAL home channel with sender SYSTEM, and the guard forces it to actually
// send (its comment at :188-197 warns precisely against a sender/[SYSTEM]-prefix
// match here) -- so those mutes must be policed in -p too. Excluding by sender
// was a coverage gap on the default Discord backend (red-team 2026-08-13).
export function opensMuteGate({ channelId, content } = {}) {
  if (String(channelId || '') === 'system') return false
  if (/^\s*\[reaction\]/.test(String(content || ''))) return false
  return true
}

// mute-strike ledger: SAME file/shape/purpose as stop-reply-guard's ledger
// (MEM/.mute-strikes.json {strikes, model, lastAt}); the UI model-revert offer
// reads it (onboarding/http-server.cjs, threshold 2). The guard was its sole
// writer, but its writes are gated behind exit-2-blocking, which `-p` drops --
// so in headless the ledger never advanced. The lane writes it for the -p case:
// increment on a mute, clear when the agent speaks. (http-server.cjs's "CODE
// sites define this path" note counts THIS as the third writer.)
//
// On the shared THRESHOLD=2 rationale ("4 failed attempts" -- each guard strike
// contains one retry): a LANE strike is one muted turn, but clearMuteStrike
// fires on the very next delivered reply INCLUDING the nudge's own response, so
// a mute that recovers on the nudge nets zero. A strike only PERSISTS when the
// nudge failed to recover it -- i.e. a persisting strike already carries "one
// nudge-and-still-mute", the same shape the guard's strike had. Threshold 2
// therefore still means "asked twice, nudged, still silent", not two flukes.
const muteStrikesFile = () => path.join(MEM, '.mute-strikes.json')
const agentConfigFile = () => path.join(MEM, '.agent-config')
function laneCurrentModel() {
  try {
    const m = fs.readFileSync(agentConfigFile(), 'utf8').match(/^MODEL=(.*)$/m)
    return m ? m[1].replace(/^"|"$/g, '') : ''
  } catch { return '' }
}
function recordMuteStrike() {
  try {
    let cur = {}
    try { cur = JSON.parse(fs.readFileSync(muteStrikesFile(), 'utf8')) || {} } catch { cur = {} }
    const model = laneCurrentModel()
    // A strike ledger belongs to ONE model (guard's rule): a model change under
    // us starts the count over rather than inheriting another subject's tally.
    const strikes = (cur.model === model && Number.isInteger(cur.strikes)) ? cur.strikes + 1 : 1
    writeJsonAtomic(muteStrikesFile(), { strikes, model, lastAt: new Date().toISOString() }, 0o600)
    return strikes
  } catch { return 0 }
}
function clearMuteStrike() {
  try {
    if (!fs.existsSync(muteStrikesFile())) return
    const cur = JSON.parse(fs.readFileSync(muteStrikesFile(), 'utf8'))
    if (!cur || !cur.strikes) return // already clean -- don't churn on every healthy turn
  } catch { /* corrupt -> overwrite clean below */ }
  try { writeJsonAtomic(muteStrikesFile(), { strikes: 0, model: laneCurrentModel(), lastAt: new Date().toISOString() }, 0o600) } catch { /* best-effort */ }
}

// Session backstop against an unforeseen nudge loop -- reset to 0 on any
// delivered reply, so it only bites a run of consecutive muted user turns that
// never yield a reply (a genuinely stuck model, which the ledger's revert offer
// already covers). Tunable but rarely relevant.
const MUTE_NUDGE_SESSION_CAP = Math.max(1, Number(process.env.SCHEHERAZADE_MUTE_NUDGE_CAP) || 5)

// ── the <channel> tag (contract: stop-reply-guard's parser) ────────────────
// `>` matters as much as `<` here: stop-reply-guard scans attributes with
// [^>]*, so a bare `>` inside an attr VALUE truncates the scan before the
// real channelId — a hostile display name could unparse its own message.
const escapeAttr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// escapeAttr minus the quote handling: for the tag BODY, where `"` is
// harmless but `<`/`>` are the breakout vectors. A raw body containing
// `</channel><channel source="...">` would otherwise forge a second envelope
// and impersonate any source/sender. Boundary-integrity hardening: the
// tradeoff is that literal `<`/`>`/`&` in genuine user content arrive to the
// model as HTML entities, which it reads back fine.
const escapeText = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderChannelTag({ content, meta = {} }) {
  const attrs = [
    `source="${escapeAttr(meta.source || 'agent-channel')}"`,
    `sender="${escapeAttr(meta.sender || 'user')}"`,
    `channelId="${escapeAttr(meta.channelId || 'in-app')}"`,
    `authorId="${escapeAttr(meta.authorId || '')}"`,
    `timestamp="${escapeAttr(meta.timestamp || '')}"`,
  ]
  // Slack thread support (2026-08-11): raw Slack ts attrs, rendered only
  // when the backend supplied them so Discord/Telegram/in-app tags are
  // byte-identical to before. stop-reply-guard's [^>]* attribute scan is
  // order/extra-attr tolerant, so appending is contract-safe.
  if (meta.messageTs) attrs.push(`messageTs="${escapeAttr(meta.messageTs)}"`)
  if (meta.threadTs) attrs.push(`threadTs="${escapeAttr(meta.threadTs)}"`)
  return `<channel ${attrs.join(' ')}>${escapeText(content)}</channel>`
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

// ── pre-spawn model preflight (2026-08-13) ──────────────────────────────────
// Field case (the owner's box, "핑" → eternal silence): the panel held an ollama
// model tag the endpoint did not have (`deepseek-v4-flash:0731`; the local
// daemon's real tag is `:0731-cloud`). `claude -p` prints "There's an issue
// with the selected model... may not exist" and exits 0 — NOT an error event,
// so the 3-strike contamination breaker never trips, .last-turn-error.json is
// never written, and the user sees nothing but silence. A bad model tag is a
// CONFIG error and must fail loud at boot, not soft at turn time.
//
// Scope: only lanes with ANTHROPIC_BASE_URL set (ollama daemon / ollama.com /
// chatgpt proxy / custom). Anthropic OAuth/API lanes are skipped: their model
// ids come from the versioned catalog, and a probe there would spend real
// Anthropic tokens per boot against auth shapes (OAuth) the probe can't
// mirror. The probe MIRRORS the runtime lane exactly — same endpoint, same
// auth header precedence (AUTH_TOKEN as Bearer, else API_KEY as x-api-key) —
// per the 2026-08-04 lesson: a validator that authenticates differently from
// the runtime vouches for a lane it never tested.
//
// Verdict is deliberately narrow: only a DEFINITIVE model-not-found blocks
// the spawn (404 / Anthropic-shaped not_found_error — live receipt from the
// local daemon 2026-08-13: HTTP 404 {"type":"error","error":{"type":
// "not_found_error","message":"model '...' not found"}}). Auth errors, 5xx,
// timeouts, and unreachable endpoints all fail OPEN — those are somebody
// else's failure mode with their own loud paths (key validation, turn
// watchdog), and blocking boot on a transient network blip would trade one
// silence for another. Escape hatch: SCHEHERAZADE_SKIP_MODEL_PREFLIGHT=1.
// (Not SKIP_MODEL_GUARD — provider-env sets that on the exact lane this
// preflight exists to cover.)
export function judgeModelProbe({ status, body }) {
  let parsed = null
  try { parsed = typeof body === 'string' ? JSON.parse(body) : body } catch { /* non-JSON body: judge on status alone */ }
  const errType = parsed && parsed.error && parsed.error.type
  const errMsg = (parsed && parsed.error && parsed.error.message) || ''
  if (status === 404 || errType === 'not_found_error') {
    return { verdict: 'bad_model', detail: errMsg || `endpoint answered HTTP ${status}` }
  }
  if (status >= 200 && status < 300) return { verdict: 'ok', detail: '' }
  return { verdict: 'inconclusive', detail: `HTTP ${status}${errMsg ? ` -- ${errMsg}` : ''}` }
}

export async function preflightModel({ baseUrl, model, authToken, apiKey, timeoutMs = 20_000 }) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (authToken) headers.authorization = `Bearer ${authToken}`
  else if (apiKey) headers['x-api-key'] = apiKey
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.text()
    return judgeModelProbe({ status: res.status, body })
  } catch (err) {
    // Unreachable/timeout: fail open -- see the scope comment above.
    return { verdict: 'inconclusive', detail: `probe failed: ${err && err.message ? err.message : err}` }
  }
}

async function main() {
  if (!MEM || !MODEL) {
    log('FATAL: MEM and MODEL env vars are required (the supervisor exports both)')
    process.exit(78) // EX_CONFIG
  }
  // Pre-spawn model preflight -- see judgeModelProbe's block comment for the
  // field case and the fail-open/fail-closed boundary.
  if (process.env.ANTHROPIC_BASE_URL && process.env.SCHEHERAZADE_SKIP_MODEL_PREFLIGHT !== '1') {
    const probe = await preflightModel({
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      model: MODEL,
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
    if (probe.verdict === 'bad_model') {
      const detail = `model tag "${MODEL}" does not exist at ${process.env.ANTHROPIC_BASE_URL} -- ${probe.detail}. ` +
        'Fix the model name in Settings > Model (for a local ollama daemon the tag must appear in `ollama list`, e.g. pull it first).'
      errLog(`FATAL: ${detail}`)
      writeJsonAtomic(path.join(MEM, '.last-turn-error.json'), { ts: Date.now(), subtype: 'model_not_found', detail }, 0o600)
      process.exit(78) // EX_CONFIG -- supervisor backoff + 3-fast-restart banner make this loud in the panel
    }
    if (probe.verdict === 'inconclusive') log(`model preflight inconclusive (${probe.detail}) -- proceeding; the lane's own watchdogs cover runtime failures`)
    else log(`model preflight ok: "${MODEL}" answered at ${process.env.ANTHROPIC_BASE_URL}`)
  }
  const prior = readPriorSession()
  let resumeId = prior ? prior.sessionId : null
  const priorBornTs = prior && Number(prior.bornTs) ? Number(prior.bornTs) : null
  // Scheduled rotation from the previous run (context pressure crossed the
  // threshold). Consumed HERE, whatever path ended that run -- the clean
  // post-flush recycle, a watchdog kill during the flush turn, or a crash:
  // once pressure was seen, resuming would only re-see it.
  if (fs.existsSync(rotateFile())) {
    if (resumeId) log('context-pressure rotation was scheduled -- starting a FRESH session; checkpoint.md carries continuity')
    resumeId = null
    try { fs.unlinkSync(rotateFile()) } catch { /* consumed best-effort */ }
  }
  if (resumeId && priorBornTs && Date.now() - priorBornTs > MAX_CONVO_AGE_MS) {
    const ageH = Math.round((Date.now() - priorBornTs) / 3600_000)
    log(`conversation is ~${ageH}h old (backstop ceiling ${Math.round(MAX_CONVO_AGE_MS / 3600_000)}h) -- rotating to a FRESH session; checkpoint files carry continuity`)
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

  // Crash instrumentation (129 hunt, 2026-08-05): claude dies sporadically
  // on the ollama lane with exit 129 and NOTHING on stderr — unreproducible
  // on demand, so the lane self-instruments instead. Flipped by env or by
  // touching MEM/.claude-debug (no Electron env plumbing needed). Debug goes
  // to stderr + a log FILE; ANTHROPIC_LOG=debug is deliberately NOT used —
  // it writes to stdout and corrupts the stream-json protocol
  // (anthropics/claude-agent-sdk-typescript#157).
  const childEnv = { ...process.env }
  if (process.env.SCHEHERAZADE_CLAUDE_DEBUG || fs.existsSync(path.join(MEM, '.claude-debug'))) {
    childEnv.CLAUDE_CODE_DEBUG = '1'
    childEnv.CLAUDE_CODE_DEBUG_LOG_LEVEL = 'debug'
    childEnv.CLAUDE_CODE_LOG_FILE = path.join(MEM, 'logs', 'claude-debug.log')
    try { fs.mkdirSync(path.join(MEM, 'logs'), { recursive: true }) } catch { /* logs dir best-effort */ }
    log(`claude debug instrumentation ON -- ${childEnv.CLAUDE_CODE_LOG_FILE}`)
  }

  const child = spawn(CLAUDE_BIN, args, {
    cwd: MEM,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childEnv,
  })

  let childExited = false
  let sawInit = false

  // Turn-watchdog state (see TURN_STALL_MS). openTurn = at least one user
  // event written to stdin that no `result` has paid for yet; activity =
  // ANY child stdout line (assistant/tool events count -- a busy agent is
  // not a wedged one).
  let openTurn = false
  let lastActivityTs = Date.now()
  // Consumed-at-boot STOP receipt (see stoppedFile). Not injected as a turn of
  // its own -- a spontaneous [SYSTEM] turn at boot is exactly the moment-bound
  // replay that bit the quit path on 2026-08-05 02:01. It rides on the next
  // real user message instead, where it is actually useful context.
  let stoppedNoticePending = false
  if (fs.existsSync(stoppedFile())) {
    stoppedNoticePending = true
    try { fs.unlinkSync(stoppedFile()) } catch { /* consumed best-effort */ }
    log('previous run was stopped by the user -- the next message carries that note; the cancelled message was dropped, not redelivered')
  }
  // Consecutive is_error results (poisoned-transcript breaker, 0.1.4).
  // Reset by any healthy turn; at 3 the lane abandons the session id and
  // recycles -- see the result handler.
  let errorTurnStreak = 0
  let lastStdinWriteTs = 0
  const noteStdinWrite = () => { openTurn = true; lastActivityTs = Date.now(); lastStdinWriteTs = lastActivityTs }
  // Cross-channel turn ownership (0.3.7, see turn-gate.mjs). Enabled only when
  // main.cjs says more than one messenger is on; otherwise admit() always says
  // 'deliver' and nothing below changes behaviour.
  const turnGate = createTurnGate({ enabled: process.env.SCHEHERAZADE_MULTI_CHANNEL === '1' })
  // Deliver the next surface's queued messages once the lane is idle. Called at
  // the end of every turn close. Skipped while a nudge/flush already reopened
  // the turn (its own result calls this again) or the child is going away (the
  // queued FIFO entries redeliver at the next boot).
  const drainTurnGate = () => {
    if (openTurn || childExited || rotateFlushSent || !child.stdin.writable) return
    const items = turnGate.release()
    if (!items.length) return
    const now = Date.now()
    const keys = new Set(items.map((i) => i.ts))
    writePending(readPending().map((ev) => (ev.queued && keys.has(ev.ts) ? { content: ev.content, meta: ev.meta, ts: now } : ev)))
    log(`turn gate: delivering ${items.length} queued message(s) from ${items[0].surface} (lane idle)`)
    for (const it of items) {
      try {
        child.stdin.write(renderUserEvent({ content: it.content, meta: it.meta || {} }))
        noteStdinWrite()
        if (opensMuteGate({ channelId: (it.meta || {}).channelId, content: it.content })) turnHadUserInbound = true
      } catch (err) { log(`turn gate delivery failed (the FIFO entry redelivers on next boot): ${err.message}`) }
    }
  }
  // Turn-level STOP executor (see createTurnStopper). stopSentTs lets the
  // soft-stop result tell "a new message arrived during the stop window"
  // (turn still owed, watchdog stays armed) from "nothing is owed".
  const turnStopper = createTurnStopper({ child, isExited: () => childExited })
  let stopSentTs = 0
  // Every non-Stop kill goes through this (createChildTerminator): win32 tree kill, posix SIGTERM then SIGKILL.
  const terminateChild = createChildTerminator({ child, isExited: () => childExited })

  // Context-pressure rotation state (see the constants' header). rotatePending
  // mirrors the on-disk marker; lastTurnEndTs anchors the idle boundary to
  // the END of the last turn, not to arbitrary child chatter.
  let rotatePending = fs.existsSync(rotateFile())
  let rotateFlushSent = false
  let lastTurnEndTs = Date.now()
  let lastAssistantUsage = null // newest assistant event's usage = standing context (v2.1)

  // ── mute-recovery per-turn state (see muteRecoveryDecision) ───────────────
  let sawReplyThisTurn = false
  let sawTextThisTurn = false
  let turnHadUserInbound = false // a real user question this turn -> mute check applies (SYSTEM/rotation/nudge turns do not set it)
  let muteNudgeCount = 0         // consecutive nudges without a delivered reply (loop backstop; reset on any reply)

  // Writes queued sweep entries to the agent's stdin. Shared by the boot
  // redelivery and the post-ready re-drain (see drainSweepsAfterReady).
  function deliverSweeps(sweeps, when) {
    for (const ev of sweeps) {
      try {
        child.stdin.write(renderUserEvent({ content: ev.content, meta: ev.meta || {} }))
        noteStdinWrite()
      } catch (err) {
        log(`queued sweep delivery failed: ${err.message}`)
      }
    }
    if (sweeps.length) log(`delivered ${sweeps.length} queued sweep request(s) ${when}`)
  }

  // Redeliver messages stranded by a mid-turn recycle (F4). Runs before the
  // ingest server exists, so these precede any new inbound POST in stdin
  // order. Entries already redelivered once are dropped (no retry loops),
  // as is anything older than 48h (stale beyond usefulness).
  {
    // sender=SYSTEM turns are runtime-generated moment-bound signals (boot
    // announce, shutdown flush, autonomy start/stop/brief) — replaying one
    // after a recycle re-runs a moment that is over (live bite 2026-08-05
    // 02:01: the stranded shutdown-flush turn was redelivered into the next
    // boot and killed it again, extending the quit loop the owner watched).
    // User messages still redeliver exactly as before.
    const { stranded, sweeps } = partitionPending(readPending(), Date.now())
    writePending(stranded.map(({ queued, ...ev }) => ({ ...ev, redelivered: true })))
    // Queued sweeps (migrate/handover "Hand it over" while the lane was down):
    // delivered ONCE as-is -- no [redelivered] note (they were never answered
    // by anyone), and already removed from the FIFO above so the UI's queue
    // read flips to delivered and a later recycle cannot replay them.
    deliverSweeps(sweeps, 'at boot')
    if (stranded.length) {
      log(`re-delivering ${stranded.length} message(s) stranded by the previous recycle`)
      for (const ev of stranded) {
        try {
          child.stdin.write(renderUserEvent({
            content: `${ev.content}\n[redelivered: the previous agent process was recycled mid-turn before this message was answered. If a complete reply was already sent, do not repeat it -- otherwise answer now.]`,
            meta: ev.meta || {},
          }))
          noteStdinWrite()
          // A redelivered user message is still a question awaiting an answer --
          // open the mute gate (same exemptions) so a mute on it gets nudged too.
          if (opensMuteGate({ channelId: (ev.meta || {}).channelId, content: ev.content })) turnHadUserInbound = true
        } catch (err) {
          log(`redelivery write failed: ${err.message}`)
        }
      }
    }
  }

  child.on('error', (err) => {
    errLog(`spawn failed: ${err.message}`)
    process.exit(127)
  })

  // ── stdout: structured events ─────────────────────────────────────────────
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    lastActivityTs = Date.now() // any child output = not wedged (watchdog input)
    let e
    try { e = JSON.parse(line) } catch {
      if (line.trim()) log(`non-json stdout: ${line.slice(0, 200)}`)
      return
    }
    if (e.type === 'assistant') {
      // Standing-context sample: the newest API call's usage (see the v2.1
      // note atop the rotation constants). Guarded so a provider that omits
      // usage keeps the previous sample instead of zeroing pressure.
      const u = e.message && e.message.usage
      if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) lastAssistantUsage = u
      // Turn transcript in the log ring (0.1.4, the owner: "log는 log지 에러메세지
      // 창이 아니야" -- the Logs page is where turn detail belongs, not an
      // error banner). One line per tool call (name + a short arg preview)
      // and per text block (first 200 chars): enough to follow what the
      // agent actually did, without dumping whole messages into the ring.
      // Local-only surface -- the ring lives in this process and the Logs
      // page; nothing leaves the machine.
      //
      // Lives HERE since 2026-08-13: it shipped in 0.1.4 as a SECOND
      // `else if (e.type === 'assistant')` further down this chain -- dead
      // code from day one (this branch consumed every assistant event
      // first), found because a healthy 27-sub-turn repro run printed zero
      // turn> lines while a live mute was being diagnosed blind. The panel
      // debugging story ("모델이 답을 만들어놨는데 메신저엔 안 온 거면 로그
      // 링에서 보인다") was never true until now.
      for (const c of (e.message && e.message.content) || []) {
        if (c.type === 'tool_use') {
          if (isReplyClassTool(c.name)) sawReplyThisTurn = true // delivered something -> not mute
          let argPreview = ''
          try { argPreview = JSON.stringify(c.input).slice(0, 160) } catch { /* unserializable input */ }
          log(`turn> tool: ${c.name} ${argPreview}`)
        } else if (c.type === 'text' && c.text && c.text.trim()) {
          sawTextThisTurn = true // composed visible text -> if no reply lands, this is the mute
          log(`turn> agent: ${c.text.trim().replace(/\s*\n+\s*/g, ' ⏎ ').slice(0, 200)}`)
        }
      }
    } else if (e.type === 'system' && e.subtype === 'api_retry') {
      // Upstream retry storm made VISIBLE (2026-08-13, the owner field log: inbound
      // "님?" reaches stdin, then NOTHING). Mock-429 receipt (/tmp/sched-
      // silentdead): the CLI answers 429 with up to max_retries=10 silent
      // retries at retry_delay_ms=60000 -- ten minutes of dead air per turn --
      // and the only trace is this stream event, which this handler used to
      // fall through and drop. Worse, the event line itself reset the turn
      // watchdog's activity clock, so the one net built for silent turns was
      // disarmed by the very signal of the stall. The process is genuinely
      // alive (waiting, not wedged), so the watchdog reset stands; the fix is
      // honesty -- every retry logs, and from the second consecutive retry
      // the error banner tells the user the lane is quota-walled instead of
      // letting the panel look healthy through a ten-minute storm.
      const waitS = Math.round((Number(e.retry_delay_ms) || 0) / 1000)
      errLog(`upstream ${e.error_status || '?'} (${e.error || 'api error'}): retry ${e.attempt}/${e.max_retries}${waitS ? ` in ${waitS}s` : ''} -- provider rate/quota wall; the turn is WAITING, not dead`)
      if (Number(e.attempt) >= 2) {
        try {
          writeJsonAtomic(path.join(MEM, '.last-turn-error.json'), {
            ts: Date.now(),
            subtype: 'rate_limited',
            detail: `provider keeps answering ${e.error_status || 429} (${e.error || 'rate limit'}) -- retry ${e.attempt}/${e.max_retries}, ~${waitS}s apart. The turn resumes by itself if the quota window reopens; otherwise it errors out after the last retry. Heavy tasks burn provider quota fastest (each sub-turn re-sends the full prompt on no-cache lanes).`,
          }, 0o600)
        } catch (err) { log(`rate-limit marker write failed: ${err.message}`) }
      }
    } else if (e.type === 'system' && e.subtype === 'init') {
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
    } else if (e.type === 'control_response') {
      turnStopper.noteControlResponse(e)
    } else if (e.type === 'result' && turnStopper.noteResult()) {
      // The soft stop landed (win32, see createTurnStopper): this result is
      // the cancelled turn's close (subtype error_during_execution on the
      // probed CLI). It is NOT an error turn -- no strike, no banner -- and it
      // pays nothing from the FIFO (the stop already cleared it; anything
      // newer arrived after the press and is still owed). The session stays
      // live, so the stop receipt that was left for a respawn is consumed
      // here instead and rides the next real message, same as after a boot.
      log(`turn result: ${e.subtype} -- ended by the user STOP (soft interrupt honoured; no respawn, the session and its MCP servers stay up)`)
      openTurn = lastStdinWriteTs > stopSentTs
      lastTurnEndTs = Date.now()
      sawReplyThisTurn = false
      sawTextThisTurn = false
      turnHadUserInbound = false
      if (fs.existsSync(stoppedFile())) {
        stoppedNoticePending = true
        try { fs.unlinkSync(stoppedFile()) } catch { /* consumed best-effort */ }
      }
      // A stopped handoff-flush turn: the checkpoint may be half written, but
      // the rotation marker is on disk, so recycle exactly as a finished flush
      // would; the hard path reached the same fresh boot by dying.
      if (rotateFlushSent) {
        log('the stopped turn was the rotation handoff -- recycling into a FRESH session as scheduled')
        try { child.stdin.end() } catch { /* already gone */ }
        terminateChild('stopped rotation handoff')
      }
      drainTurnGate()
    } else if (e.type === 'result') {
      // Durations exposed for the latency receipts (the owner 2026-08-05 02:47
      // "답변 추론에 비해 너무 늦는데"): dur = whole turn wall-clock, api =
      // time inside model calls. dur >> api means harness/tool overhead;
      // api >> expectation with high turns= means sub-turn churn (each
      // sub-turn re-evaluates the full prompt on providers with no
      // server-side cache — the ollama lane's known tax).
      const durNote = Number(e.duration_ms) ? ` dur=${(e.duration_ms / 1000).toFixed(1)}s${Number(e.duration_api_ms) ? ` api=${(e.duration_api_ms / 1000).toFixed(1)}s` : ''}` : ''
      log(`turn result: ${e.subtype}${e.is_error ? ' (error)' : ''} turns=${e.num_turns}${durNote}`)
      // Error turns used to die as one quiet log line while the user saw
      // nothing at all (2026-08-04 field: subscription lane rate-limited /
      // auth-dead -> "클로드도 동작안함", zero receipts anywhere). Loud
      // stderr WITH the upstream error text, plus a marker file the UI
      // banner reads -- an error must annotate the product, not vanish.
      if (e.is_error) {
        const errText = String(e.result || (e.error && (e.error.message || e.error)) || '').slice(0, 600)
        errLog(`turn ERROR (${e.subtype}): ${errText || 'no detail carried in the result event'}`)
        try {
          writeJsonAtomic(path.join(MEM, '.last-turn-error.json'), { ts: Date.now(), subtype: e.subtype || 'error', detail: errText }, 0o600)
        } catch (err) {
          log(`turn-error marker write failed: ${err.message}`)
        }
        // Poisoned-transcript breaker (0.1.4, field report 2026-08-11): a
        // transcript can carry content the provider rejects on EVERY call
        // (e.g. an image block sent to a non-vision model's Anthropic-compat
        // endpoint -> 400) -- then each turn errors, --resume re-sends the
        // same transcript forever, and only a manual restart-with-fresh-
        // session recovers. Three CONSECUTIVE error turns = the conversation
        // itself is judged broken: drop the session file (so the next boot
        // does NOT resume it) and recycle the lane, mirroring the rotation
        // recycle above. A single healthy turn resets the streak, so a
        // transient provider outage (1-2 errored turns) never triggers this.
        // If fresh sessions ALSO error (dead key), the streak trips again and
        // the supervisor's crash-loop marker takes over -- visible, not silent.
        errorTurnStreak += 1
        if (errorTurnStreak >= 3) {
          errLog(`3 consecutive error turns -- treating the resumed conversation as poisoned; recycling into a FRESH session (old transcript stays on disk, it is just no longer auto-resumed)`)
          try { fs.unlinkSync(sessionFile()) } catch { /* already gone */ }
          try { child.stdin.end() } catch { /* already gone */ }
          terminateChild('3 consecutive error turns')
        }
      } else {
        errorTurnStreak = 0
        // Recovery clears the banner immediately -- a healthy turn must not
        // sit under a 10-minute-old error strip (freshness window is only
        // the fallback for a lane that died before ever succeeding again).
        try { fs.unlinkSync(path.join(MEM, '.last-turn-error.json')) } catch { /* absent = nothing to clear */ }
      }
      // A result pays for EVERY pending event written before it: probe 6
      // (2026-08-04, /tmp/sch-probe6.log) pinned -p's queue semantics --
      // user events arriving mid-turn MERGE into the live turn (3 queued
      // messages -> one result, same as the old dev-channels injection),
      // so anything in stdin before the turn ended has been seen. The
      // race window (a POST landing between turn-end and this line) only
      // costs a redelivery skip, never a double reply.
      const resultTs = Date.now()
      openTurn = false // the watchdog stands down until the next stdin write
      lastTurnEndTs = resultTs
      // Only a SUCCESS result pays for pending events (2026-08-13, the
      // silent-death tail): an ERROR turn answered nobody, so clearing the
      // FIFO here made every message that merged into a doomed turn (429
      // storm, poisoned transcript) vanish without redelivery -- the user's
      // question died with the turn and nothing ever said so. Left in the
      // FIFO, the existing machinery does the right thing at each exit:
      //   - next turn succeeds (resumed context still carries the messages,
      //     the reply addresses them) -> that success result clears them;
      //   - 3-strike breaker / watchdog recycles -> boot redelivery sends
      //     them exactly once (redelivered:true already prevents loops, the
      //     [redelivered] note already tells the model not to double-reply).
      if (!e.is_error) {
        const p = readPending()
        if (p.length) writePending(p.filter((ev) => ev.queued || (Number(ev.ts) || 0) > resultTs))
        // ── mute recovery ────────────────────────────────────────────────────
        // A user turn that composed text but called no reply-class tool is the
        // -p mute (the guard's exit 2 cannot force a resend in headless). Nudge
        // the SAME live session to send the answer it already wrote -- same
        // stdin-injection primitive the rotation handoff uses. The ledger tracks
        // persistence for the UI model-revert offer; muteNudgeCount backstops
        // loops. clearMuteStrike fires on ANY delivered reply (incl. the nudge's
        // own response) so a mute that recovers on the nudge nets a clean ledger.
        const decision = muteRecoveryDecision({ turnHadUserInbound, sawReply: sawReplyThisTurn, sawText: sawTextThisTurn })
        if (decision === 'clear') {
          clearMuteStrike()
          muteNudgeCount = 0
        } else if (decision === 'nudge') {
          const n = recordMuteStrike()
          if (muteNudgeCount < MUTE_NUDGE_SESSION_CAP) {
            muteNudgeCount += 1
            log(`mute: turn composed text but called no reply tool -- nudging the live session to send it (ledger strike ${n}; nudge ${muteNudgeCount}/${MUTE_NUDGE_SESSION_CAP})`)
            try {
              child.stdin.write(renderUserEvent({
                content: '[SYSTEM] 방금 사용자에게 보낼 답을 작성했지만 reply 도구를 호출하지 않아 실제로는 전달되지 않았다. 그 답을 새로 쓰지 말고 지금 mcp__agent-channel__reply(같은 channelId)로 그대로 전송하라. 정말로 보낼 내용이 없다고 판단했다면 그 판단을 한 줄로라도 답하라.',
                meta: { source: 'system', sender: 'system', channelId: 'system' },
              }))
              noteStdinWrite()
            } catch (err) { log(`mute nudge write failed: ${err.message}`) }
          } else {
            log(`mute persists past the session nudge cap (${MUTE_NUDGE_SESSION_CAP}) -- leaving it to the UI model-revert offer (ledger strike ${n})`)
          }
        }
      }
      // Context-pressure check (rotation rule 1: schedule, never cut here).
      // Last assistant usage = standing context; result usage = cumulative
      // fallback only (v2.1 note atop the rotation constants).
      const ctxTokens = contextTokensOf(lastAssistantUsage || e.usage)
      if (!rotatePending && ctxTokens >= ROTATE_CONTEXT_TOKENS * ROTATE_AT) {
        rotatePending = true
        log(
          `context pressure: last turn carried ~${ctxTokens} tokens ` +
          `(threshold ${Math.round(ROTATE_CONTEXT_TOKENS * ROTATE_AT)} = ${Math.round(ROTATE_AT * 100)}% of ${ROTATE_CONTEXT_TOKENS}; ` +
          'SCHEHERAZADE_CONTEXT_TOKENS / SCHEHERAZADE_ROTATE_AT to tune) -- rotation scheduled for the next idle boundary'
        )
        try {
          writeJsonAtomic(rotateFile(), { ts: resultTs, contextTokens: ctxTokens }, 0o600)
        } catch (err) {
          log(`rotate marker write failed (rotation degrades to the age backstop): ${err.message}`)
        }
      }
      // The handoff flush turn just finished (rotation rule 3): checkpoint
      // is as fresh as it will ever be. Recycle now; boot consumes the
      // marker and starts fresh.
      if (rotateFlushSent) {
        log('handoff flush turn finished -- recycling into a FRESH session (context-pressure rotation)')
        try { child.stdin.end() } catch { /* already gone */ }
        terminateChild('rotation handoff finished')
      }
      // Per-turn mute flags reset for the NEXT turn (runs for error turns too,
      // so stale flags never leak forward). muteNudgeCount and the on-disk
      // ledger persist across turns on purpose; the nudge turn re-arms detection.
      sawReplyThisTurn = false
      sawTextThisTurn = false
      turnHadUserInbound = false
      drainTurnGate()
    }
    // (the turn-transcript log ring lives in the FIRST assistant branch above
    // -- a second assistant branch here was dead code for all of 0.1.4/0.1.5,
    // see that branch's comment)
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
    if (req.method !== 'POST') return send(404, { error: 'not found' })
    // ── POST /interrupt: turn-level STOP (0.3.1) ────────────────────────────
    // The user pressed Stop in the chat composer. Same host + token gate as
    // /inbound, empty body, no request data used at all -- so there is no
    // caller-controlled value in this path.
    //
    // ORDER MATTERS. The FIFO is cleared BEFORE anything is killed: the
    // redelivery machinery above exists to re-ask an unanswered question
    // after a mid-turn recycle, and a STOP is the one case where the user
    // has explicitly withdrawn it. Skipping this makes every Stop press
    // hand the cancelled message straight back on the --resume boot.
    //
    // openTurn drops before the kill for the same reason the watchdog does
    // it (see stallTimer): a slow SIGTERM would otherwise let the watchdog
    // fire into the same dying child and log a second, false diagnosis.
    //
    // HOW the turn ends is platform-split (createTurnStopper, 0.3.5):
    //   posix -- the hard path, unchanged: SIGTERM, the lane exits with the
    //     child, the supervisor respawns it with --resume, and the
    //     conversation survives while the turn does. Seconds, and visible to
    //     the user -- the button copy says so.
    //   win32 -- `control_request {subtype:'interrupt'}` first (probed against
    //     claude 2.1.284, receipt in createTurnStopper's header); the turn
    //     closes in-process and nothing respawns. Only a request that is
    //     refused or not honoured within SOFT_STOP_GRACE_MS escalates to
    //     taskkill /T /F on the claude child, which takes its MCP children
    //     with it (the old single-process TerminateProcess orphaned them).
    if (req.url === '/interrupt') {
      if (!tokenOk(req.headers['x-ingest-token'])) return send(403, { error: 'bad token' })
      if (childExited) return send(503, { error: 'agent not running' })
      if (!openTurn) return send(409, { error: 'no turn in flight' })
      openTurn = false
      const cleared = writePending(readPending().filter((ev) => ev.queued)) // other channels' queued messages were never part of the stopped turn
      if (!cleared) log('WARNING: pending FIFO clear failed -- the cancelled message may redeliver on the next boot')
      try {
        writeJsonAtomic(stoppedFile(), { ts: Date.now() }, 0o600)
      } catch (err) {
        // Cosmetic only (the next turn just loses its explanation); never a
        // reason to refuse a stop the user asked for.
        log(`stop receipt write failed: ${err.message}`)
      }
      log(turnStopper.plan.mode === 'signal'
        ? 'user STOP: ending the in-flight turn (pending FIFO cleared -- the cancelled message will NOT redeliver); the supervisor respawns this lane with --resume'
        : 'user STOP: ending the in-flight turn (pending FIFO cleared -- the cancelled message will NOT redeliver); soft interrupt first, tree kill only if it is not honoured')
      // posix: the watchdog's own two lines, via the stopper. NOT a group
      // killTree there: this child is spawned NON-detached, so it shares the
      // lane's process group and a negative-pid group signal would kill the
      // lane itself before its exit handler could clean up the endpoint file.
      // claude reaps its own MCP children on SIGTERM; the supervisor's
      // gracefulStop + orphan sweep remain the backstop, unchanged.
      stopSentTs = Date.now()
      turnStopper.begin()
      return send(200, { ok: true, stopped: true })
    }
    if (req.url !== '/inbound') return send(404, { error: 'not found' })
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
      // Cross-channel gate (turn-gate.mjs): a message from another messenger
      // while a turn is in flight waits its turn. Durable first (queued:true
      // FIFO entry), acked as queued, delivered by drainTurnGate().
      const surface = String(payload.surface || '')
      if (turnGate.admit(surface, openTurn) === 'queue') {
        const qts = Date.now()
        if (!writePending([...readPending(), { content, meta: payload.meta || {}, ts: qts, queued: true }])) {
          return send(500, { error: 'pending persist failed' })
        }
        turnGate.enqueue({ content, meta: payload.meta || {}, surface, ts: qts })
        log(`turn gate: ${surface} message queued behind the in-flight ${turnGate.owner} turn (${turnGate.size} waiting)`)
        return send(200, { ok: true, queued: true })
      }
      // Crash-recovery FIFO must be durable BEFORE the message reaches claude's
      // stdin: if the process dies in the window between the stdin write and the
      // persist, the turn is lost with no redelivery record -- yet the request
      // had already returned 200 (writePending swallowed its own failures).
      // Persist first; if that fails, refuse with 500 rather than acknowledge a
      // delivery we cannot make crash-recoverable. Removal semantics are
      // unchanged: the result event still pays for entries whose ts precedes it.
      if (!writePending([...readPending(), { content, meta: payload.meta || {}, ts: Date.now() }])) {
        return send(500, { error: 'pending persist failed' })
      }
      // Stop receipt rides on the first message after a user-stopped run (see
      // stoppedFile). The FIFO entry above keeps the ORIGINAL content: the
      // note is about a moment, and a redelivery of it later would be a lie.
      let outContent = content
      if (stoppedNoticePending) {
        stoppedNoticePending = false
        outContent = '[SYSTEM] The user pressed Stop during your previous run, so that turn was cancelled mid-work and the message it was answering was withdrawn. Do not resume or apologize for it; just answer what follows.\n\n' + content
      }
      try {
        child.stdin.write(renderUserEvent({ content: outContent, meta: payload.meta || {} }))
        noteStdinWrite()
        // A real user question (or an autonomy/routine turn on a real channel)
        // opens the mute-recovery gate; only the lane's own channelId 'system'
        // housekeeping and reactions are exempt (see opensMuteGate = guard parity).
        if (opensMuteGate({ channelId: (payload.meta || {}).channelId, content })) turnHadUserInbound = true
        // Latency receipt (2026-08-05): this line + the result's dur=/api=
        // bracket a turn in the log, so "model was fast, app was slow"
        // becomes measurable instead of vibes.
        log(`inbound -> stdin (${content.length} chars, sender=${(payload.meta && payload.meta.sender) || '?'})`)
        // Transcript symmetry (0.1.4): the user side of the turn, same
        // 200-char preview discipline as the `turn> agent:` lines above.
        // The body is PII -- gated behind SCHEHERAZADE_LOG_MESSAGE_BODY=1
        // (default OFF). The length-only line above still confirms arrival.
        if (process.env.SCHEHERAZADE_LOG_MESSAGE_BODY === '1') {
          log(`turn> user: ${String(content).trim().replace(/\s*\n+\s*/g, ' ⏎ ').slice(0, 200)}`)
        }
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
      writeJsonAtomic(endpointFile(), { port, token, pid: process.pid }, 0o600)
      log(`ingest endpoint on 127.0.0.1:${port} (token file ${path.basename(endpointFile())})`)
      // Close the boot race: routes/migrate.cjs appends a sweep to the FIFO
      // when it finds no endpoint, but this lane may have already read the FIFO
      // (boot redelivery above) and not yet published its endpoint. An entry
      // appended in that window would sit until the NEXT start. Publishing the
      // endpoint is the point after which the route delivers live instead, so
      // one more drain right here leaves no gap: anything appended before this
      // line is taken now, anything after goes live.
      try {
        const late = readPending().filter((ev) => ev && ev.sweep === true)
        if (late.length) {
          const { sweeps: fresh } = partitionPending(late, Date.now())
          writePending(readPending().filter((ev) => !(ev && ev.sweep === true)))
          deliverSweeps(fresh, 'after ready (appended while booting)')
        }
      } catch (err) { log(`post-ready sweep drain failed: ${err.message}`) }
    } catch (err) {
      // Without the endpoint file backends fall back to the MCP notification,
      // which is dead in -p -- that is an agent that can talk but not hear.
      // Loud and fatal: the supervisor loop respawns us for another try.
      errLog(`FATAL: cannot write ingest endpoint file: ${err.message}`)
      terminateChild('endpoint FATAL')
      process.exitCode = 74 // EX_IOERR
    }
  })

  // ── turn watchdog ─────────────────────────────────────────────────────────
  // See TURN_STALL_MS's header. Checks every 30s; fires at most once per
  // stall (openTurn drops before the kill so a slow SIGTERM can't double-log).
  const stallTimer = setInterval(() => {
    if (childExited || !openTurn) return
    const quietMs = Date.now() - lastActivityTs
    if (quietMs < TURN_STALL_MS) return
    openTurn = false
    errLog(
      `turn watchdog: a turn has been in flight with ZERO model output for ${Math.round(quietMs / 60_000)}m ` +
      `(ceiling ${Math.round(TURN_STALL_MS / 60_000)}m, SCHEHERAZADE_TURN_STALL_MINUTES to tune) -- the upstream call is wedged. ` +
      'Recycling; the unanswered message redelivers once on the next boot. If this repeats on the same model, the model/provider lane is the problem.'
    )
    // design-0025: leave the record BEFORE the kill so the app can settle the
    // pane to an honest "gone" line if the answer never lands (see the writer).
    writeTurnAbortRecord('stall')
    terminateChild('turn watchdog stall')
  }, 30_000)
  stallTimer.unref()

  // ── rotation timer (rule 2: cut only at an idle boundary) ────────────────
  // Fires the ONE handoff flush turn once the scheduled rotation meets a
  // quiet conversation. No separate wedge timeout: the flush turn is a turn,
  // so the stall watchdog above is its backstop, and the on-disk marker
  // makes even a watchdog-kill land as a fresh boot.
  const rotateTimer = setInterval(() => {
    if (childExited || !rotatePending || rotateFlushSent || openTurn) return
    if (Date.now() - lastTurnEndTs < ROTATE_IDLE_MS) return
    rotateFlushSent = true
    log(`idle boundary reached (quiet ${Math.round((Date.now() - lastTurnEndTs) / 1000)}s) -- sending the checkpoint handoff turn before rotating`)
    try {
      child.stdin.write(renderUserEvent({
        content:
          '[SYSTEM] This conversation is about to be rotated to a fresh session because its context is nearly full. ' +
          'Update checkpoint.md NOW with everything the next session needs to continue seamlessly: open threads, promises made to the user, in-progress work and its exact state. ' +
          'Do not message the user about this housekeeping. Reply with a single short line when the checkpoint is written.',
        meta: { source: 'system', sender: 'system', channelId: 'system' },
      }))
      noteStdinWrite()
    } catch (err) {
      // stdin gone = child dying anyway; the marker survives and boot rotates.
      log(`handoff turn write failed (rotation still lands on next boot): ${err.message}`)
    }
  }, ROTATE_CHECK_MS)
  rotateTimer.unref()

  // ── lifecycle ────────────────────────────────────────────────────────────
  const shutdown = (sig) => {
    log(`${sig} received, stopping child`)
    try { child.stdin.end() } catch { /* already gone */ }
    terminateChild('shutdown')
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  // Same portable stop channel as dsh-lane (design-0023 P3 #2): on Windows no
  // signal is deliverable, so the supervisor's stop writes $MEM/.stop_requested
  // and waits -- without this poll that grace window bought nothing and the
  // CLI died to taskkill /T /F mid-turn. unref'd; harmless on POSIX (a belt
  // for a lost signal).
  const stopflag = path.join(MEM, '.stop_requested')
  const stopWatch = setInterval(() => {
    if (!fs.existsSync(stopflag)) return
    clearInterval(stopWatch)
    shutdown('stop request (.stop_requested)')
  }, 500)
  stopWatch.unref()

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
// fileURLToPath, NOT new URL().pathname: on win32 pathname is '/C:/...' and
// path.resolve turns it into garbage, so this guard NEVER matched and the
// lane silently exited 0 without booting — caught by the 0.57 win real-spawn
// probe (lane exited code=0, no endpoint file, zero log lines).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    errLog(`FATAL: unhandled boot error: ${err && err.stack ? err.stack : err}`)
    process.exit(1)
  })
}
