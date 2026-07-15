#!/usr/bin/env node
// stop-reply-guard.mjs -- silent-text regression detector (Stop hook).
//
// Failure mode this blocks (Mino's install "춘식3", 2026-07-13 19:10 KST,
// agent's own transcript self-diagnosis): the agent COMPOSED reply text in
// its transcript but never called the reply tool -- twice in a row -- so
// from Discord it was indistinguishable from a hang/crash ("돌연사").
// Port of MAGI fleet hooks/check-discord-reply.mjs (live on caspar/
// balthazar/melchior since 2026-04), trimmed to this app's single-agent
// shape: no B2B/consensus/soft-listen exceptions.
//
// Mechanism: on Stop, tail-parse the transcript jsonl, find the most recent
// user message carrying a Discord <channel ...> tag, and verify the agent
// called mcp__agent-channel__reply OR mcp__agent-channel__send_file_to_discord
// targeting that channelId afterwards. If not -> exit 2 (block stop) with
// instructions to actually send. Retry cap 1 via stop_hook_active. Fail-open
// on any internal error -- a buggy guard must never trap the agent.

import fs from 'fs'
import os from 'os'
import path from 'path'

const SCAN_TAIL = 80
const TAIL_BYTES = 500 * 1024

// ── mute-strike ledger (2026-07-13, replaces the killed "swap-time tool-call
// smoke test") ────────────────────────────────────────────────────────────────
// WHY NOT A PRE-SWAP PROBE: the v0.0.4 plan was to probe a model for tool_use
// support BEFORE committing a swap. That design is dead, and the receipts are
// worth writing down so nobody rebuilds it. kimi-k2.7-code was recorded (by me,
// 638fbf7) as "ollama compat lane never produces tool_use blocks". On 07-13
// ~20:5x that mechanism was falsified live in 7 conditions -- non-streaming,
// streaming (content_block_start type=tool_use + input_json_delta), forced
// tool_choice, free tool_choice, 15-tool harness shape, 36k context, and the
// REAL Claude Code CLI driving a REAL MCP server (which wrote a file receipt
// proving the tool executed). kimi passes every probe I can construct, yet it
// was demonstrably mute in Mino's install. So a pre-swap probe would have
// stamped the broken model HEALTHY: it can convict, it cannot acquit (absence
// of a finding is not an acquittal). A gate that manufactures false acquittals
// is worse than no gate.
//
// WHAT THIS DOES INSTEAD: convict on observed behavior in the real harness.
// This guard already sees BOTH outcomes on every Stop, so the ledger lives
// here and nowhere else:
//   - a reply/send_file actually landed  -> strikes reset to 0
//   - the guard fired, Claude retried, and STILL no reply (cap-hit) -> strike++
// A strike is therefore not "the agent was quiet once" -- it is "I explicitly
// told it to send, and it still could not". That is the mute signature,
// whatever the underlying cause (parse failure, provider breakage, a cause
// nobody has named yet). At MUTE_STRIKE_THRESHOLD the UI offers a one-click
// revert to the previous model (http-server.cjs GET /api/agent/mute-status).
//
// Threshold 2: the original 돌연사 was two consecutive silent turns (18:51 +
// 18:57), and each strike already contains one internal retry -- so 2 strikes
// means 4 failed attempts to speak, not a one-off mood.
//
// Every fs path here is best-effort and swallowed: a ledger that throws must
// never trap the agent (same fail-open contract as the rest of this hook).
// AGENT_DATA_HOME is exported into the agent's env by main.cjs:872 (and honored
// by run.sh:49), and this hook runs inside that env -- so prefer it over
// re-deriving the path. The literal fallback matches http-server.cjs's DATA_HOME
// for the case where a hook is invoked outside a managed spawn.
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')
const STRIKES_PATH = path.join(DATA_HOME, '.mute-strikes.json')
const AGENT_CONFIG_PATH = path.join(DATA_HOME, '.agent-config')

function currentModel() {
  try {
    const text = fs.readFileSync(AGENT_CONFIG_PATH, 'utf8')
    const m = text.match(/^MODEL=(.*)$/m)
    if (!m) return ''
    return m[1].replace(/^"|"$/g, '')
  } catch { return '' }
}

function writeStrikes(obj) {
  try {
    const tmp = `${STRIKES_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj))
    fs.renameSync(tmp, STRIKES_PATH) // atomic: a torn ledger reads as corrupt-and-ignored
  } catch { /* best-effort */ }
}

function clearStrikes() {
  try {
    if (!fs.existsSync(STRIKES_PATH)) return
    const cur = JSON.parse(fs.readFileSync(STRIKES_PATH, 'utf8'))
    if (!cur || !cur.strikes) return // already clean -- don't churn the file every turn
  } catch { /* corrupt -> fall through and overwrite with a clean ledger */ }
  writeStrikes({ strikes: 0, model: currentModel(), lastAt: new Date().toISOString() })
}

function recordStrike() {
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(STRIKES_PATH, 'utf8')) || {} } catch { cur = {} }
  const model = currentModel()
  // A strike ledger belongs to ONE model. If the model changed under us, the
  // old count is about a different subject -- start over rather than inherit.
  const strikes = (cur.model === model && Number.isInteger(cur.strikes)) ? cur.strikes + 1 : 1
  writeStrikes({ strikes, model, lastAt: new Date().toISOString() })
}
// Explicit silence requests -- the user told the agent NOT to answer.
const SKIP_PATTERNS = [
  /생각만/, /대답하지마/, /대답\s*하지\s*마/, /답장\s*하지\s*마/, /조용/, /무시해/,
  /don'?t\s+reply/i, /stay\s+silent/i,
]
const REPLY_TOOLS = new Set([
  'mcp__agent-channel__reply',
  'mcp__agent-channel__send_file_to_discord',
])

async function main() {
  let rawInput = ''
  for await (const chunk of process.stdin) rawInput += chunk
  let hookInput = {}
  try { hookInput = JSON.parse(rawInput || '{}') } catch {
    process.exit(0)
  }

  const transcriptPath = hookInput.transcript_path
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0)

  const entries = tailJsonl(transcriptPath, SCAN_TAIL)

  // Most recent user message containing a Discord channel tag.
  const channelRegex = /<channel\s+[^>]*channelId="(\d+)"[^>]*>([\s\S]*?)<\/channel>/
  let triggerIdx = -1
  let triggerChannelId = null
  let triggerBody = ''
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type !== 'user') continue
    const text = extractUserText(e)
    if (!text) continue
    const m = text.match(channelRegex)
    if (m) {
      triggerIdx = i
      triggerChannelId = m[1]
      triggerBody = m[2]
      break
    }
  }
  if (triggerIdx === -1) process.exit(0) // no Discord trigger -> not applicable

  for (const pat of SKIP_PATTERNS) {
    if (pat.test(triggerBody)) process.exit(0)
  }

  // Walk forward looking for a reply-class call that ANSWERED the trigger
  // channel. Two layers, receipt first (2026-07-15 Melchior chain review):
  //
  // 1. DELIVERY RECEIPT: channel.mjs stamps `delivered_channel=<id>` into
  //    every successful reply/send_file tool result -- where the message
  //    actually LANDED. This is the authoritative match. It exists because
  //    since v0.0.11 the server delivers even on a wrong/omitted args id via
  //    fallback routing: matching on ARGS alone judged where the model
  //    AIMED, so a confabulated-id reply that the server had already
  //    delivered to the trigger channel still drew exit 2 -> the model
  //    resent -> the user got the same answer twice (double-send class,
  //    Melchior catch). Guard semantics are now "actually delivered", which
  //    is what "answered" always meant.
  // 2. ARGS FALLBACK (receipt missing -- e.g. tool_result outside the tail
  //    window, or an older channel.mjs without the stamp): explicit args id
  //    matching the trigger, or OMITTED args id (v0.0.11 recommended path;
  //    server routes it to the current conversation channel = the trigger.
  //    Accepted edge, approved 2026-07-15: a newer inbound on another
  //    channel between trigger and reply reroutes an omitted-id send there
  //    -- rarer and milder than convicting every correct omitted reply).
  const pendingReplyCalls = new Map() // tool_use id -> args channelId ('' if omitted)
  let replyFound = false
  for (let i = triggerIdx + 1; i < entries.length && !replyFound; i++) {
    const e = entries[i]
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    if (e.type === 'assistant') {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue
        if (!REPLY_TOOLS.has(block.name)) continue
        pendingReplyCalls.set(block.id, String(block.input?.channelId || ''))
      }
    } else if (e.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue
        if (!pendingReplyCalls.has(block.tool_use_id)) continue
        const text = Array.isArray(block.content)
          ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
          : typeof block.content === 'string' ? block.content : ''
        const m = text.match(/^delivered_channel=(\d+)$/m)
        if (m && m[1] === triggerChannelId) {
          replyFound = true
          break
        }
      }
    }
  }
  if (!replyFound) {
    for (const argsId of pendingReplyCalls.values()) {
      if (argsId === triggerChannelId || argsId === '') {
        replyFound = true
        break
      }
    }
  }
  if (replyFound) {
    clearStrikes() // the agent spoke -> whatever was wrong isn't wrong now
    process.exit(0)
  }

  // Retry cap: if Claude already retried once for this stop event, allow.
  if (hookInput.stop_hook_active) {
    // We told it to send, it retried, it STILL didn't. That is the mute
    // signature -- record it. This is the only place a strike is scored: a
    // single quiet turn (pre-retry) is not evidence of anything.
    recordStrike()
    process.stderr.write('[stop-reply-guard] cap hit (stop_hook_active), allowing; mute strike recorded\n')
    process.exit(0)
  }

  process.stderr.write(
    `Discord 응답 누락: 마지막 메시지(channelId=${triggerChannelId})에 답하는 reply 도구 호출 없이 턴을 끝내려 함. ` +
    `머릿속으로 지은 답은 디스코드에 도착하지 않는다 -- 방금 작성한 답을 mcp__agent-channel__reply로 해당 채널에 실제로 보낸 뒤 종료해. ` +
    `답하지 않기로 판단했다면 그 판단을 한 줄로라도 보내라 (침묵은 상대에겐 죽음과 구분되지 않는다).\n`
  )
  process.exit(2)
}

function extractUserText(entry) {
  const msg = entry.message
  if (!msg) return ''
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text') parts.push(block.text || '')
    }
    return parts.join('')
  }
  return ''
}

function tailJsonl(filePath, n) {
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
  const startIdx = start === 0 ? 0 : 1 // first line likely truncated mid-record
  const entries = []
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try { entries.push(JSON.parse(line)) } catch { /* partial line -- skip */ }
  }
  return entries.slice(-n)
}

main().catch((e) => {
  process.stderr.write(`[stop-reply-guard] fatal: ${e.stack || e.message}\n`)
  process.exit(0) // fail-open
})
