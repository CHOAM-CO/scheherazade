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

// skills/ listing (design doc R1 -- the read side. The write-side nudge
// hook was cut in the 2026-07-28 boot-context diet; writing a skill file
// is now purely the agent's own call, and this listing keeps whatever it
// writes from becoming a dead drawer). Purely additive: no
// dir is created here, and a missing/empty dir produces no lines at all.
// Trigger line lives in YAML frontmatter (between the first two ---
// delimiter lines), key "trigger:" -- scoped to the frontmatter block so a
// "trigger:" word in the skill body can't be picked up by mistake.
// BOOT BUDGET (red-team 2026-08-05 item 7): this listing grew one line per
// skill file with no ceiling and no per-line cap -- so the more successfully
// the agent used skills, the fatter EVERY boot got, against CLAUDE.md's own
// excerpt-first rule. Caps now: at most SKILL_LIST_MAX entries (newest
// first by mtime, so a fresh skill is never the one that falls off), each
// trigger clipped to SKILL_TRIGGER_CHARS. Overflow is STATED, not silent --
// a hidden truncation reads as "that's all of them".
const SKILL_LIST_MAX = 20
const SKILL_TRIGGER_CHARS = 160
const skillLines = []
let skillOverflow = 0
const skillsDir = path.join(MEM, 'skills')
if (fs.existsSync(skillsDir)) {
  const files = []
  for (const f of fs.readdirSync(skillsDir).sort()) {
    if (!f.endsWith('.md')) continue
    const full = path.join(skillsDir, f)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isFile()) continue
    files.push({ f, full, mtime: st.mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime) // newest first: the cap drops the stalest
  skillOverflow = Math.max(0, files.length - SKILL_LIST_MAX)
  for (const { f, full } of files.slice(0, SKILL_LIST_MAX)) {
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
    if (trigger && trigger.length > SKILL_TRIGGER_CHARS) trigger = `${trigger.slice(0, SKILL_TRIGGER_CHARS)}…`
    skillLines.push(`- ${f}: ${trigger || '(no trigger field found)'}`)
  }
  skillLines.sort() // display order stays alphabetical; mtime only chose WHICH
}

// Permission wall map (P0, 2026-07-15 -- docs/permission-visibility-design.md).
// http-server.cjs drops a probe snapshot into DATA_HOME/permission-status.json
// on every /api/permissions/status call; MEM and DATA_HOME are the same
// directory in production (main.cjs injects AGENT_DATA_HOME into both). One
// line of "what this machine can't do" at boot beats discovering each wall
// mid-task. Additive: no file -> no lines; a granted-everything map -> no
// lines either (silence means nothing known to be blocked, and the P1
// translator hook covers the moment a wall IS hit).
let permLine = null
try {
  const snap = JSON.parse(fs.readFileSync(path.join(MEM, 'permission-status.json'), 'utf8'))
  const walls = (snap.rows || []).filter((r) => r.granted === false && r.class !== 'sip')
  if (walls.length > 0) {
    const ageDays = snap.checkedAt ? Math.floor((Date.now() - Date.parse(snap.checkedAt)) / 86400000) : null
    const staleMark = ageDays !== null && ageDays > 7 ? ` (checked ${ageDays}d ago -- may be stale)` : ''
    permLine = `Known permission walls on this machine: ${walls.map((r) => r.class).join(', ')}${staleMark}. Tell the user what is blocked BEFORE attempting work that needs these -- do not rediscover them mid-task.`
  }
} catch {
  // no snapshot yet, or unreadable -- say nothing rather than guess.
}

// Oversize guard on the restore-order files (v0.0.15 Root B mitigation).
// The autocompact thrash loop in the 07-13..07-15 teardown corpus was fed by
// compaction re-attaching every session-read file -- ~12 files, the fattest
// being 15-18KB memory files -- so the context refilled to the limit right
// after each compact. The app cannot change the CLI's re-attach behavior,
// but it CAN stop teaching the agent to full-Read big files at boot: any
// restore-order file over the threshold gets named here with an explicit
// excerpt instruction instead of being silently swept into "read these".
// Advisory line, not a wall: reading stays the agent's call.
const OVERSIZE_KB = 24
const oversize = []
for (const [label, file] of [
  [`session_notes/${TODAY}.md`, notesFile],
  ['checkpoint.md', checkpointFile],
  ['self_persona.md', path.join(MEM, 'self_persona.md')],
]) {
  try {
    const size = fs.statSync(file).size
    // compare in bytes: Math.round on the KB display would otherwise pull
    // 23.6KB files over the stated 24KB floor.
    if (size >= OVERSIZE_KB * 1024) oversize.push(`${label} (${Math.round(size / 1024)}KB)`)
  } catch { /* absent file = nothing to warn about */ }
}

const out = []
out.push(`Session note for ${TODAY}: ${noteStatus}.`)
if (oversize.length > 0) {
  out.push(`OVERSIZED restore files: ${oversize.join(', ')}. Read these with offset/limit excerpts (tail first), NOT a full Read -- fully-read files are re-attached at every compaction and large ones can thrash the context until the session stalls. Consider compressing/archiving them this session.`)
}
if (permLine) out.push(permLine)
out.push(`Checkpoint: ${checkpointStatus}.`)
if (pendingCount > 0) out.push(`${pendingCount} prior-date session note(s) waiting on journal compression -- run journal-compress.mjs scan.`)
if (dreamCount > 0) out.push(`${dreamCount} dream fragment(s) in dreams/ -- skim the 2 most recent (CLAUDE.md §1 lazy-restore).`)
if (skillLines.length > 0) {
  out.push(`${skillLines.length} skill(s) in skills/ (Read the file when one looks relevant):`)
  out.push(...skillLines)
  if (skillOverflow > 0) {
    out.push(`(+${skillOverflow} older skill(s) not listed -- boot budget cap. \`ls skills/\` for the full set.)`)
  }
}
out.push("Restore order: today's session note (head+tail excerpt, Felt first), then checkpoint.md, then yesterday's journal, then self_persona.md, then 2 recent dreams. Excerpt first, full Read only on a pointer -- CLAUDE.md §1.")

console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: out.join('\n') } }))
