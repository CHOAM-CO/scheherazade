#!/usr/bin/env node
// session-start.mjs -- SessionStart hook: restores continuity at boot.
// Node port of session-start.sh (win-port Phase 3: bash removed from hooks;
// the other 5 hooks already ran via node, so this adds no new runtime
// dependency). Non-blocking; prints hookSpecificOutput so the summary
// reaches Claude's context as a system reminder, not just a user-facing
// log line.
//
// Reads AGENT_NAME / MEM from the environment (set by the supervisor).
// Falls back to the current directory when unset, so a manually-started
// `claude` session (cwd = the memory dir) still restores correctly.

import fs from 'node:fs'
import path from 'node:path'

const MEM = process.env.MEM || process.cwd()
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

for (const dir of ['session_notes', 'journals', 'dreams', 'logs']) {
  fs.mkdirSync(path.join(MEM, dir), { recursive: true })
}

const notesFile = path.join(MEM, 'session_notes', `${TODAY}.md`)
let noteStatus = 'found'
if (!fs.existsSync(notesFile)) {
  fs.writeFileSync(notesFile, `# ${TODAY}\n\n## 🔥 Felt\n\n\n### Pending\n\n\n### Handoff\n\n`)
  noteStatus = 'created fresh'
}

const checkpointFile = path.join(MEM, 'checkpoint.md')
let checkpointStatus = 'none yet'
if (fs.existsSync(checkpointFile)) {
  const ageMin = Math.floor((Date.now() - fs.statSync(checkpointFile).mtimeMs) / 60000)
  checkpointStatus = `last updated ${ageMin}min ago`
}

// Prior-date notes still waiting on journal compression. Same comparison as
// the bash version: date-named files sort lexicographically == chronologically.
let pendingCount = 0
for (const f of fs.readdirSync(path.join(MEM, 'session_notes'))) {
  if (!f.endsWith('.md')) continue
  if (path.basename(f, '.md') < TODAY) pendingCount++
}

let dreamCount = 0
const dreamsDir = path.join(MEM, 'dreams')
if (fs.existsSync(dreamsDir)) {
  dreamCount = fs.readdirSync(dreamsDir).filter((f) => f.endsWith('.md') && fs.statSync(path.join(dreamsDir, f)).isFile()).length
}

// skills/ listing (design doc R1 consumption pair -- stop-skill-extraction-
// nudge.mjs is the write side, this is the read side). Purely additive: no
// dir is created here, and a missing/empty dir produces no lines at all.
// Trigger line lives in YAML frontmatter (between the first two ---
// delimiter lines), key "trigger:" -- scoped to the frontmatter block so a
// "trigger:" word in the skill body can't be picked up by mistake.
const skillLines = []
const skillsDir = path.join(MEM, 'skills')
if (fs.existsSync(skillsDir)) {
  for (const f of fs.readdirSync(skillsDir).sort()) {
    if (!f.endsWith('.md')) continue
    const full = path.join(skillsDir, f)
    if (!fs.statSync(full).isFile()) continue
    let trigger = null
    const lines = fs.readFileSync(full, 'utf8').split('\n')
    let delim = 0
    for (const line of lines) {
      if (/^---\s*$/.test(line)) { delim++; if (delim === 2) break; continue }
      if (delim === 1) {
        const m = line.match(/^trigger:\s*(.*)$/)
        if (m && trigger === null) trigger = m[1].replace(/^"(.*)"$/, '$1')
      }
    }
    skillLines.push(`- ${f}: ${trigger || '(no trigger field found)'}`)
  }
}

const out = []
out.push(`Session note for ${TODAY}: ${noteStatus}.`)
out.push(`Checkpoint: ${checkpointStatus}.`)
if (pendingCount > 0) out.push(`${pendingCount} prior-date session note(s) waiting on journal compression -- run journal-compress.mjs scan.`)
if (dreamCount > 0) out.push(`${dreamCount} dream fragment(s) in dreams/ -- read the 5 most recent for context.`)
if (skillLines.length > 0) {
  out.push(`${skillLines.length} skill(s) in skills/ (Read the file when one looks relevant):`)
  out.push(...skillLines)
}
out.push("Restore order: today's session note (Felt first), then checkpoint.md, then self_persona.md, then recent dreams.")

console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: out.join('\n') } }))
