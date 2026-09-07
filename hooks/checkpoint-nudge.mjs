#!/usr/bin/env node
// checkpoint-nudge.mjs -- Stop hook: reminds to write checkpoint.md after
// 30min with no update. Node port of checkpoint-nudge.sh (win-port Phase 3).
// Self-throttled via .last_checkpoint_nudge so it fires at most once per
// 30min no matter how many Stop events land in that window. Advisory only,
// exit 0 always.

import fs from 'node:fs'
import path from 'node:path'
import { resolveDataHome } from '../data-home.cjs' // one resolver: AGENT_DATA_HOME || MEM || ~/Documents/Scheherazade

const MEM = resolveDataHome()
const checkpointFile = path.join(MEM, 'checkpoint.md')
const nudgeFile = path.join(MEM, '.last_checkpoint_nudge')
const THRESHOLD_SEC = 1800

if (!fs.existsSync(checkpointFile)) process.exit(0)

const nowTs = Math.floor(Date.now() / 1000)
const staleSec = nowTs - Math.floor(fs.statSync(checkpointFile).mtimeMs / 1000)
if (staleSec < THRESHOLD_SEC) process.exit(0)

if (fs.existsSync(nudgeFile)) {
  let lastNudgeTs = 0
  try { lastNudgeTs = parseInt(fs.readFileSync(nudgeFile, 'utf8').trim(), 10) || 0 } catch {}
  if (nowTs - lastNudgeTs < THRESHOLD_SEC) process.exit(0)
}

fs.writeFileSync(nudgeFile, `${nowTs}\n`)
const staleMin = Math.floor(staleSec / 60)
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: `checkpoint.md has not been touched in ${staleMin}min. If there is state worth handing off, write it now.` } }))
process.exit(0)
