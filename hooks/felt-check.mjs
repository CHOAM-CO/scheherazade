#!/usr/bin/env node
// felt-check.mjs -- Stop hook: nudges toward a concrete Felt section before
// the session ends. Node port of felt-check.sh (win-port Phase 3). Advisory
// only, never blocks the stop (exit 0 always).

import fs from 'node:fs'
import path from 'node:path'

const MEM = process.env.MEM || process.cwd()
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const notesFile = path.join(MEM, 'session_notes', `${TODAY}.md`)

function nudge(text) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } }))
}

if (!fs.existsSync(notesFile)) process.exit(0)
const lines = fs.readFileSync(notesFile, 'utf8').split('\n')

const start = lines.findIndex((l) => l.startsWith('## 🔥 Felt'))
if (start === -1) {
  nudge("No ## 🔥 Felt section in today's session note. Write the actual scene before stopping -- not a label.")
  process.exit(0)
}

let body = []
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## ')) break
  body.push(lines[i])
}
// Codepoint count of non-whitespace content, mirroring bash's
// `tr -d '[:space:]'` + ${#...} (which counts characters, not bytes).
const contentLen = [...body.join('').replace(/\s/g, '')].length
if (contentLen < 50) {
  nudge("The Felt section is thin (under 50 characters of content). Labels aren't enough -- what was the actual scene?")
}
process.exit(0)
