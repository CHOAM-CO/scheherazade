#!/usr/bin/env node
// pre-tool-activity.mjs — PreToolUse hook: Bash, WebSearch, WebFetch, and
// subagent spawns (Agent/Task). Was Bash-only until 2026-08-13 (the owner: a
// 20-call research turn showed NOTHING in the chat fold).
//
// WHY: the in-app chat's only mid-turn signal was the typing dots, capped at
// 3 minutes by their own honesty rule. A turn that runs `npm test` for four
// minutes looked identical to a dead agent. This hook pushes what is about
// to run into the local channel's transcript queue as a kind:'activity'
// item (POST /activity), and the chat page renders it as a one-line status
// ("running: Install package dependencies"). Stolen from Codex's
// item/started event — the half of their delta stream that pays off on a
// non-streaming surface (docs/codex-architecture-review-2026-08-04.md §7).
//
// LOCAL CHANNEL ONLY, BY DESIGN: Discord/Slack/Telegram render presence as
// their own typing indicator and cannot show an ephemeral line without
// posting a real message (spam). The port file only exists while
// channel-local runs, so on other backends this hook exits at the stat.
//
// ADVISORY, FAIL-OPEN, FAST: pack convention — only the rumination gate
// blocks. Any error (no port file, dead server, bad JSON, timeout) exits 0
// silently. Budget: one 500ms-capped loopback POST per Bash call.
//
// SECOND JOB (2026-09-28, the owner's "기억을 꺼낸 티 내기" → "완전 굿"): the
// MEMORY MARK. When the agent CALLS a memory read tool (memory_query /
// journal_read / memory_recall_material) this hook posts POST /memory-read,
// which arms a per-turn flag in the local channel; the reply that follows
// carries it to the chat page. Nothing renders at the read — no label, no
// fold row (see the branch below for why it is not an activity item). The
// same matcher file registers this hook for both jobs.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveDataHome } from '../data-home.cjs' // one resolver: AGENT_DATA_HOME || MEM || ~/Documents/Scheherazade

// Kill switch (product-prefixed, mirrors SCHEHERAZADE_RUMINATION_GATE).
if (process.env.SCHEHERAZADE_ACTIVITY_FEED === '0') process.exit(0)

const DATA_HOME = resolveDataHome()

try {
  // fd 0, not '/dev/stdin' — the Windows lesson (2026-08-04, six hooks did
  // nothing on that platform because the path does not exist there).
  const payload = JSON.parse(readFileSync(0, 'utf8'))
  const input = payload.tool_input || {}
  // Per-tool label builders (2026-08-13, the owner: "채팅창에서는 WebFetch /
  // sub spawn같은 정보가 아예 안보이네" -- the panel log ring showed a
  // 20-call research turn while the chat fold showed nothing, because this
  // hook was Bash-only). Bash keeps its bare description (the model writes
  // it for exactly this surface); the others carry a short tool prefix so a
  // mixed fold still reads at a glance. Every other tool (Read/Edit/MCP...)
  // stays OFF this feed on purpose: a busy turn fires dozens of them and
  // the fold is a status line, not a transcript -- the log ring has the
  // full record.
  const trunc = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const hostPath = (u) => {
    try { const p = new URL(String(u)); return p.hostname + (p.pathname === '/' ? '' : p.pathname) } catch { return String(u || '') }
  }
  let label = ''
  // Memory reads: the OTHER job, and the reason it is not an activity label.
  // The tool names are the harness's MCP form — server key `memory` from
  // .mcp.json, tool names from memory/server.mjs's TOOLS. Only the READ-class
  // three: memory_write / memory_confirm / memory_delete are the agent
  // changing what it knows, which is not "this came out of memory".
  const MEMORY_READ_TOOLS = new Set([
    'mcp__memory__memory_query',
    'mcp__memory__journal_read',
    'mcp__memory__memory_recall_material',
  ])
  const memoryRead = MEMORY_READ_TOOLS.has(String(payload.tool_name || ''))
  if (payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell') {
    // PowerShell is what the shell tool is CALLED on native Windows (the Windows box
    // live repro 2026-08-14: matcher "Bash" meant the feed never fired there
    // at all). Same shape, same bare-description treatment.
    label = trunc(input.description || input.command)
  } else if (payload.tool_name === 'WebSearch') {
    label = input.query ? `WebSearch: ${trunc(input.query)}` : ''
  } else if (payload.tool_name === 'WebFetch') {
    label = input.url ? `WebFetch: ${trunc(hostPath(input.url))}` : ''
  } else if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
    // The subagent tool's name differs across CLI versions (Task pre-2.1,
    // Agent current) -- the settings matcher names both, and so does this.
    label = `Subagent: ${trunc(input.description || input.subagent_type || 'working')}`
  }
  // A memory read builds no label and must still reach the channel (below),
  // so it exits on neither count.
  if (!label && !memoryRead) process.exit(0)

  const portFile = JSON.parse(readFileSync(path.join(DATA_HOME, 'local-channel.json'), 'utf8'))
  const port = Number(portFile.port)
  const token = String(portFile.token || '')
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(0)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  // Same budget, same posture, two destinations: the label feed (a status
  // line for the fold) or the memory mark (a flag, no body — the call IS the
  // signal). The memory post carries no content-type because it has no body.
  const init = memoryRead
    ? { method: 'POST', headers: { authorization: `Bearer ${token}` } }
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ label }),
      }
  await fetch(`http://127.0.0.1:${port}/${memoryRead ? 'memory-read' : 'activity'}`, {
    ...init,
    signal: controller.signal,
  }).catch(() => {})
  clearTimeout(timer)
} catch {
  // No port file (Discord backend), unreadable stdin, dead server: all mean
  // "no activity feed right now", never "block the tool".
}
process.exit(0)
