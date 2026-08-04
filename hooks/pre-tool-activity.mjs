#!/usr/bin/env node
// pre-tool-activity.mjs — PreToolUse hook, Bash tool only.
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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Kill switch (product-prefixed, mirrors SCHEHERAZADE_RUMINATION_GATE).
if (process.env.SCHEHERAZADE_ACTIVITY_FEED === '0') process.exit(0)

const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')

try {
  // fd 0, not '/dev/stdin' — the Windows lesson (2026-08-04, six hooks did
  // nothing on that platform because the path does not exist there).
  const payload = JSON.parse(readFileSync(0, 'utf8'))
  if (payload.tool_name !== 'Bash') process.exit(0)
  const input = payload.tool_input || {}
  // Prefer the model's own natural-language `description` ("Install package
  // dependencies") over the raw command line: it is written for exactly this
  // kind of surface. Fall back to the command, truncated hard — this is a
  // status line, not a terminal.
  const label = String(input.description || input.command || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (!label) process.exit(0)

  const portFile = JSON.parse(readFileSync(path.join(DATA_HOME, 'local-channel.json'), 'utf8'))
  const port = Number(portFile.port)
  const token = String(portFile.token || '')
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(0)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  await fetch(`http://127.0.0.1:${port}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ label }),
    signal: controller.signal,
  }).catch(() => {})
  clearTimeout(timer)
} catch {
  // No port file (Discord backend), unreadable stdin, dead server: all mean
  // "no activity feed right now", never "block the tool".
}
process.exit(0)
