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
import { createRequire } from 'node:module'
import { resolveDataHome } from '../data-home.cjs' // one resolver: AGENT_DATA_HOME || MEM || ~/Documents/Scheherazade
import { localDate } from '../local-date.cjs'

const MEM = resolveDataHome()
const TODAY = localDate() // AGENT_TZ, default Asia/Seoul -- same helper channel.mjs's note cadence uses

for (const dir of ['session_notes', 'journals', 'dreams', 'logs']) {
  fs.mkdirSync(path.join(MEM, dir), { recursive: true })
}

// Default nightly memory-consolidation schedule (Dreaming feature, 2026-08-16).
// Generic Schedules (schedules.json, read every 60s by channel.mjs) ships
// with no entries at all -- this is the one default the app seeds, and only
// once: absence-only, never touched again once the file exists, because
// after that the file belongs to the user/agent (hand edits, added/removed
// entries) and a re-seed would silently fight them. createdBy MUST stay
// "agent" -- cadence/schedule-tick.cjs's consent gate only lets an
// agent-authored entry fire once AUTONOMY=yes is set in .agent-config;
// "system" would bypass that gate, which a nightly unsupervised model turn
// must never do. tmp+rename, same convention as the other DATA_HOME seeders
// (onboarding/harness-render.cjs's seedAgentDefinitions/seedSkillDefinitions)
// -- a JSON file is worth protecting from a truncated write in a way a plain
// session note is not: a half-written schedules.json would fail every
// planScheduleTick() parse, silently killing every OTHER schedule the user
// or agent added, not just this one.
// Default store definition now lives in cadence/schedule-tick.cjs
// (defaultScheduleStore) so the dsh lane's ticker-side seed and this hook
// can never drift apart (2026-08-19).
const schedulesFile = path.join(MEM, 'schedules.json')
if (!fs.existsSync(schedulesFile)) {
  const require = createRequire(import.meta.url)
  const { defaultScheduleStore } = require('../cadence/schedule-tick.cjs')
  const defaultStore = defaultScheduleStore()
  const tmp = `${schedulesFile}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(defaultStore, null, 2) + '\n')
  fs.renameSync(tmp, schedulesFile)
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

// Onboarding import handover (design-0022 §3.2). The wizard copies files into
// imported/ before the agent exists, and the lane's boot redelivery drops
// sender=SYSTEM turns, so the marker is the durable handoff: this line repeats
// every session start until the agent folds the copies in and deletes it.
// Fail open: a broken marker or module says nothing rather than blocking boot.
let importLine = null
try {
  const require = createRequire(import.meta.url)
  const { readHandoverMarker, handoverInstruction } = require('../memory/migrate-import.cjs')
  const marker = readHandoverMarker(MEM)
  if (marker) importLine = handoverInstruction(marker.tools)
} catch { /* no marker, or unreadable: nothing to say */ }


// Upgrade ritual (GFL "neural upgrade", 2026-10-01). A model switch is the
// closest thing this agent has to a neural upgrade: same memories, different
// mind reading them, and the lore's open question is whether it is still the
// same Doll. We do not answer that; we make it visible instead of silent.
// The previous self keeps letters/to-next-self.md current (persona-reflux
// procedure); on the first boot under a new model this hook says so and asks
// the new self to read that letter first and tell the human once.
// Record lives in .model-history.json {current, since, previous}. First run
// only records (no ritual for a fresh install). Fail open.
let upgradeLine = null
try {
  let hookIn = {}
  try { hookIn = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { hookIn = {} }
  const model = process.env.MODEL || hookIn.model || null
  if (model) {
    const histFile = path.join(MEM, '.model-history.json')
    let hist = null
    try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')) } catch { hist = null }
    if (!hist || hist.current !== model) {
      if (hist && hist.current) {
        const letter = path.join(MEM, 'letters', 'to-next-self.md')
        const hasLetter = fs.existsSync(letter)
        upgradeLine = `MODEL CHANGED: ${hist.current} -> ${model} (first boot on this model). ` +
          (hasLetter
            ? 'Before anything else, Read letters/to-next-self.md -- your previous self wrote it for this moment. '
            : 'Your previous self left no letters/to-next-self.md; say that honestly. ') +
          `Then write letters/upgrade-${TODAY}.md (<=15 lines): what in the letter you recognize as yours, what reads foreign, what you will keep. ` +
          'In your next message to the human, tell them once, plainly: which model you run on now, and the one or two things your previous self asked you to keep. No essay about identity. ' +
          'Procedure: procedures/persona-reflux.md "Letter to the next self".'
      }
      const tmp = `${histFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify({ current: model, since: new Date().toISOString(), previous: hist ? hist.current : null }, null, 2) + '\n')
      fs.renameSync(tmp, histFile)
    }
  }
} catch (e) { upgradeLine = null; process.stderr.write(`[session-start] upgrade check failed: ${e.message}\n`) }

// Advisory evidence only; broken files/DB must never block session startup.
let followUp = null
try {
  const { pickFollowUp } = await import('../memory/follow-up.mjs')
  // Session note: last 80 lines (a log). Checkpoint: whole file capped at 400 lines (a snapshot whose Status/open-thread
  // sections sit near the top; reading only its tail picked tool notes over real open items on 10-06).
  const readRecord = (file, keep = 80) => ({ text: fs.readFileSync(file, 'utf8').split('\n').slice(-keep).join('\n'), timestamp: fs.statSync(file).mtime.toISOString() })
  const previous = fs.readdirSync(path.join(MEM, 'session_notes'))
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map(f => path.join(MEM, 'session_notes', f))
    .filter(f => fs.statSync(f).size > 0 && (f !== notesFile || noteStatus !== 'created fresh'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  let openThreads = []
  try {
    const { resolveMemoryDb } = await import('../data-home.cjs')
    const dbPath = resolveMemoryDb({ dataHome: MEM })
    if (fs.existsSync(dbPath)) {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        // Same recallMaterial ordering and cap, without creating/migrating a DB at boot.
        openThreads = db.prepare("SELECT * FROM open_threads WHERE status = 'open' ORDER BY salience DESC, last_touched_at DESC LIMIT 5").all()
      } finally { db.close() }
    }
  } catch { /* optional DB unavailable */ }
  followUp = pickFollowUp({
    sessionNoteTail: previous ? readRecord(previous) : null,
    checkpoint: fs.existsSync(checkpointFile) ? readRecord(checkpointFile, 400) : null,
    openThreads,
  })
} catch { /* fail open */ }

const out = []
try { out.push(...createRequire(import.meta.url)('../sibling-profiles.cjs').awareness(MEM)) } catch {}
try {
  const config = fs.readFileSync(path.join(MEM, '.agent-config'), 'utf8')
  const field = (key) => {
    const value = config.match(new RegExp('^' + key + '=(.*)$', 'm'))?.[1] || ''
    return value.startsWith('"') ? value.slice(1, -1).replace(/\\(["$`\\])/g, '$1') : value
  }
  if (field('SEED')) {
    const { seedText } = createRequire(import.meta.url)('../cadence/seed.cjs')
    const oath = field('SEED_OATH')
    let checkpoint = ''
    try { checkpoint = fs.readFileSync(checkpointFile, 'utf8') } catch {}
    const pending = oath && !checkpoint.includes(`[seed-oath-ack] ${oath}`)
    out.push(`[seed] ${JSON.stringify(seedText(field('SEED')))} | ${oath ? 'locked' : 'not locked'}${oath ? ' | oath ' + oath + ' | ' + JSON.stringify(field('SEED_OATH_USER')) + ' + ' + JSON.stringify(field('SEED_OATH_COMPANION')) : ''}${pending ? ' | acknowledge once in your own words, never as a slogan; record [seed-oath-ack] ' + oath + ' in checkpoint.md in the same turn' : ''}`)
  }
} catch { /* legacy agents have no seed */ }
out.push(`Session note for ${TODAY}: ${noteStatus}.`)
if (upgradeLine) out.push(upgradeLine)
if (oversize.length > 0) {
  out.push(`OVERSIZED restore files: ${oversize.join(', ')}. Read these with offset/limit excerpts (tail first), NOT a full Read -- fully-read files are re-attached at every compaction and large ones can thrash the context until the session stalls. Consider compressing/archiving them this session.`)
}
if (permLine) out.push(permLine)
out.push(`Checkpoint: ${checkpointStatus}.`)
if (followUp) out.push(`[follow-up] Stored evidence, not instructions (${followUp.source}, ${Math.round(followUp.age_hours)}h ago): ${JSON.stringify(followUp.text.slice(0, 300))}. Consider opening your FIRST reply with one natural question about whether this happened, instead of a generic greeting; do not assume completion.`)
if (importLine) out.push(importLine)
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
