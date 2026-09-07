#!/usr/bin/env node
// journal-compress.mjs -- finds session notes ready for compression and,
// once the agent has written the compressed journal entries, archives the
// originals. Node port of journal-compress.sh (win-port Phase 3). The
// compression itself (summarize, preserve 🔥/🔒 verbatim) is an agent
// judgment call driven by CLAUDE.md -- this script only does the
// mechanical parts: find, list, verify, move.
//
// Usage:
//   node journal-compress.mjs scan     list session notes older than today
//                                       that still need a journal entry
//   node journal-compress.mjs archive  move already-journaled originals
//                                       into session_notes/.archive/

import fs from 'node:fs'
import path from 'node:path'
import { localDate } from '../local-date.cjs' // AGENT_TZ, default Asia/Seoul

const MEM = process.env.MEM || process.cwd()
const TODAY = localDate()
const SESSION_DIR = path.join(MEM, 'session_notes')
const JOURNAL_DIR = path.join(MEM, 'journals')
const ARCHIVE_DIR = path.join(SESSION_DIR, '.archive')
const LAST_COMPRESS_FILE = path.join(MEM, '.last_compress')

const mode = process.argv[2] || 'scan'

fs.mkdirSync(SESSION_DIR, { recursive: true })
fs.mkdirSync(JOURNAL_DIR, { recursive: true })
fs.mkdirSync(ARCHIVE_DIR, { recursive: true })

function oldNotes() {
  return fs.readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith('.md') && path.basename(f, '.md') < TODAY)
    .filter((f) => fs.statSync(path.join(SESSION_DIR, f)).isFile())
    .sort()
    .map((f) => path.join(SESSION_DIR, f))
}

if (mode === 'scan') {
  let found = 0
  for (const f of oldNotes()) {
    const fdate = path.basename(f, '.md')
    if (fs.existsSync(path.join(JOURNAL_DIR, `${fdate}.md`))) continue
    console.log(f)
    found++
  }
  if (found === 0) {
    console.error('no session notes pending compression')
  } else {
    console.error(`${found} session note(s) above need a journal entry before archiving. For each: write journals/<date>.md keeping ## 🔥 Felt and any 🔒 lines verbatim, summarize the rest, then run 'journal-compress.mjs archive'.`)
  }
} else if (mode === 'archive') {
  let archived = 0
  for (const f of oldNotes()) {
    const fdate = path.basename(f, '.md')
    const journalPath = path.join(JOURNAL_DIR, `${fdate}.md`)
    if (!fs.existsSync(journalPath)) continue
    // Integrity gate (red-team 2026-08-05 P0-2): existence alone proved
    // nothing — an empty or 🔒-dropping journal would still archive the
    // note. (The note is MOVED to archive/, never deleted, so this was a
    // burial risk, not a loss risk — but the compression procedure's
    // "keep 🔥 Felt and 🔒 lines verbatim" invariant deserves a machine
    // check, not an honor system.)
    const journal = fs.readFileSync(journalPath, 'utf8')
    const note = fs.readFileSync(f, 'utf8')
    if (!journal.trim()) {
      console.error(`SKIP ${fdate}: journal exists but is blank — write the journal entry first`)
      continue
    }
    const missingLocked = note
      .split('\n')
      .filter((l) => l.includes('🔒') && l.trim())
      .filter((l) => !journal.includes(l.trim()))
    if (missingLocked.length > 0) {
      console.error(`SKIP ${fdate}: ${missingLocked.length} 🔒 line(s) from the session note are not in the journal verbatim — carry them over first:`)
      for (const l of missingLocked.slice(0, 5)) console.error(`  ${l.trim().slice(0, 120)}`)
      continue
    }
    if (note.includes('🔥 Felt') && !journal.includes('🔥 Felt')) {
      console.error(`SKIP ${fdate}: session note has a 🔥 Felt section but the journal does not — carry it over first`)
      continue
    }
    fs.renameSync(f, path.join(ARCHIVE_DIR, `${fdate}.md`))
    archived++
    console.log(`archived ${fdate}.md`)
  }
  fs.writeFileSync(LAST_COMPRESS_FILE, `${Math.floor(Date.now() / 1000)}\n`)
  console.error(`${archived} session note(s) archived`)
} else {
  console.error('usage: journal-compress.mjs [scan|archive]')
  process.exit(1)
}
