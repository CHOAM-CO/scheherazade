#!/usr/bin/env node
// stop-reply-guard.mjs -- silent-text regression detector (Stop hook).
//
// Failure mode this blocks (observed on a live install, 2026-07-13 19:10 KST,
// agent's own transcript self-diagnosis): the agent COMPOSED reply text in
// its transcript but never called the reply tool -- twice in a row -- so
// from Discord it was indistinguishable from a hang/crash ("돌연사").
// Port of the reference fleet hooks/check-discord-reply.mjs (live on three fleet agents
// since 2026-04), trimmed to this app's single-agent
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

// Escalating scan windows (red-team 2026-08-05 item 5, "tail anchor"): a
// single fixed tail (was 500KB/80 events) let one large tool output push
// the last inbound channel message out of the window -- triggerIdx came
// back -1 and the guard silently waved the turn through, exactly the
// silent-death class it exists to block. Now: scan the smallest window
// first (the common case costs what it always cost), and only when NO
// trigger is found AND the window didn't already cover the whole file,
// widen and rescan. The 16MB/5000 ceiling is the fail-open boundary: a
// transcript whose last inbound message is buried deeper than that reads
// as no-trigger, same as before -- but the boundary moved from "one big
// tool result" to "16MB of them".
const SCAN_STEPS = [
  { bytes: 500 * 1024, entries: 80 },
  { bytes: 2 * 1024 * 1024, entries: 400 },
  { bytes: 8 * 1024 * 1024, entries: 2000 },
  { bytes: 16 * 1024 * 1024, entries: 5000 },
]

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
// was demonstrably mute in the owner's install. So a pre-swap probe would have
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
  // v0.0.34: an emoji reaction IS an answer in DM terms -- without this the
  // guard bounces every react-only turn into a forced verbal reply, which
  // defeats the reaction's whole reason to exist.
  'mcp__agent-channel__react',
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

  // Most recent user message carrying a channel tag. Id charset is [\w-]:
  // Discord = digits, Telegram groups = NEGATIVE digits (multichannel
  // v0.0.18 -- digits-only left the guard silently inert there), Slack =
  // C0ABC123, in-app = the literal "in-app" (v0.0.34 -- digits-only left
  // the guard inert on the LOCAL backend too, i.e. the 0.0.31 silent-agent
  // class had no net exactly where the owner hit it).
  const channelRegex = /<channel\s+[^>]*channelId="([\w-]+)"[^>]*>([\s\S]*?)<\/channel>/
  let entries = []
  let triggerIdx = -1
  let triggerChannelId = null
  let triggerBody = ''
  const transcriptSize = fs.statSync(transcriptPath).size
  for (const step of SCAN_STEPS) {
    entries = tailJsonl(transcriptPath, step.entries, step.bytes)
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
    if (triggerIdx !== -1) break
    // Whole file read AND the entry-count cap didn't clip anything -> the
    // scan was exhaustive; there is genuinely no trigger. (Both conditions:
    // a small file can be fully READ while the last-n slice still hides an
    // older entry.)
    if (step.bytes >= transcriptSize && entries.length < step.entries) break
  }
  if (triggerIdx === -1) process.exit(0) // no Discord trigger -> not applicable

  for (const pat of SKIP_PATTERNS) {
    if (pat.test(triggerBody)) process.exit(0)
  }

  // A reaction injection ("[reaction] user put 👍 on ...", channel-local's
  // deliverReaction) is a signal, not a question: forcing a reply to every
  // emoji tap turns a DM affordance into a call center. The agent still MAY
  // answer one -- this only removes the obligation.
  if (/^\s*\[reaction\]/.test(triggerBody)) process.exit(0)

  // A housekeeping turn addressed to channelId="system" (the headless
  // lane's context-pressure rotation handoff) is the LANE talking, not the
  // user: nobody is on the other end to answer, and demanding a reply here
  // would nudge-loop the very turn whose only job is to write checkpoint.md
  // and exit quietly. Matched on the CHANNEL, not the [SYSTEM] text prefix,
  // on purpose: autonomy's morning brief also starts with "[SYSTEM]" but
  // rides the HOME channel and deliberately RELIES on this guard to force
  // the brief into Discord -- a prefix match would silently un-enforce it
  // (caught same-day, 2026-08-04).
  if (triggerChannelId === 'system') process.exit(0)

  // Walk forward looking for a reply-class call that ANSWERED the trigger
  // channel. Two layers, receipt first (2026-07-15 the reviewer chain review):
  //
  // 1. DELIVERY RECEIPT: channel.mjs stamps `delivered_channel=<id>` into
  //    every successful reply/send_file tool result -- where the message
  //    actually LANDED. This is the authoritative match. It exists because
  //    since v0.0.11 the server delivers even on a wrong/omitted args id via
  //    fallback routing: matching on ARGS alone judged where the model
  //    AIMED, so a confabulated-id reply that the server had already
  //    delivered to the trigger channel still drew exit 2 -> the model
  //    resent -> the user got the same answer twice (double-send class,
  //    the reviewer catch). Guard semantics are now "actually delivered", which
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
  // DUAL-CHANNEL storm guard (2026-08-13, the owner's live repro): when Discord AND
  // in-app are both connected, inbound messages from the two surfaces interleave
  // in the ONE headless transcript. The trigger is the single newest channel
  // tag, but the agent may have just answered the OTHER surface (e.g. replied to
  // Discord with an explicit channelId while the newest inbound is an in-app
  // ping). Per-channel matching then convicts a turn where the agent DID speak
  // to a human -> exit 2 injects "you never replied" -> the model resends ->
  // and because pings keep arriving on both channels, every Stop re-convicts:
  // a forced-reply storm (the owner: "계속 답장함", saw 4-5 dupes per message). The
  // silent-death class this hook exists to block is "composed text, called NO
  // tool" -- an agent that delivered a message to ANY channel is demonstrably
  // NOT mute. So we track whether anything landed anywhere after the trigger and
  // treat that as alive, without forcing a cross-channel reply.
  let deliveredAnywhere = false
  for (let i = triggerIdx + 1; i < entries.length; i++) {
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
        // ID charset is per-platform (red-team 2026-08-05 P1-4): discord =
        // numeric snowflake, telegram = possibly-negative integer, slack =
        // alphanumeric (C0123ABC), local = 'in-app'. The old numeric-only
        // pattern silently ignored every non-discord delivery receipt and
        // fell back to tool args — lower-authority evidence.
        const m = text.match(/^delivered_channel=([A-Za-z0-9_.-]+)$/m)
        if (m) {
          deliveredAnywhere = true // a message landed on SOME channel -> not mute
          if (m[1] === triggerChannelId) replyFound = true
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
  // The trigger channel itself went unanswered, but the agent DID deliver a
  // message to another surface this turn: it is alive and speaking, just not to
  // this exact channel. Forcing a reply here is the storm. Clear strikes (an
  // agent that delivered is not mute) and let the turn end. NOTE: this
  // deliberately does NOT chase the unanswered channel -- cross-channel
  // completeness is not this guard's job; muteness detection is.
  if (deliveredAnywhere) {
    clearStrikes()
    process.stderr.write(
      `[stop-reply-guard] trigger channel ${triggerChannelId} unanswered but a reply landed on another channel this turn -- not mute, allowing (dual-channel; no forced cross-channel reply)\n`
    )
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

function tailJsonl(filePath, n, tailBytes) {
  const stat = fs.statSync(filePath)
  const bytesToRead = Math.min(stat.size, tailBytes)
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
