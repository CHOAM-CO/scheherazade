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

const MEM = process.env.MEM || process.cwd()
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
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
    if (!fs.existsSync(path.join(JOURNAL_DIR, `${fdate}.md`))) continue
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
