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

const SCAN_TAIL = 80
const TAIL_BYTES = 500 * 1024
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

  // Walk forward looking for a reply-class tool_use hitting the same channel.
  let replyFound = false
  for (let i = triggerIdx + 1; i < entries.length && !replyFound; i++) {
    const e = entries[i]
    if (e.type !== 'assistant') continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_use') continue
      if (!REPLY_TOOLS.has(block.name)) continue
      if (String(block.input?.channelId || '') === triggerChannelId) {
        replyFound = true
        break
      }
    }
  }
  if (replyFound) process.exit(0)

  // Retry cap: if Claude already retried once for this stop event, allow.
  if (hookInput.stop_hook_active) {
    process.stderr.write('[stop-reply-guard] cap hit (stop_hook_active), allowing\n')
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
