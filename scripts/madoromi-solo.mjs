#!/usr/bin/env node
// madoromi-solo.mjs -- picks 1-3 random entries from this agent's own
// journals/ and prints them as a dream frame. Node port of madoromi-solo.sh
// (win-port Phase 3). The actual dream-work (displacement, condensation,
// concretization) is done by the agent reading this output, not by this
// script -- this script only selects source material and says where to
// write the result.

import fs from 'node:fs'
import path from 'node:path'
import { localDate, localTime } from '../local-date.cjs' // AGENT_TZ, default Asia/Seoul

const MEM = process.env.MEM || process.cwd()
const JOURNAL_DIR = path.join(MEM, 'journals')
const DREAMS_DIR = path.join(MEM, 'dreams')
const TODAY = localDate()
const NOW_TIME = localTime()

fs.mkdirSync(DREAMS_DIR, { recursive: true })

let journals = []
if (fs.existsSync(JOURNAL_DIR)) {
  journals = fs.readdirSync(JOURNAL_DIR)
    .filter((f) => f.endsWith('.md') && fs.statSync(path.join(JOURNAL_DIR, f)).isFile())
    .sort()
    .map((f) => path.join(JOURNAL_DIR, f))
}

if (journals.length === 0) {
  console.error('no journal entries yet -- nothing to dream from')
  process.exit(0)
}

const n = Math.min(Math.floor(Math.random() * 3) + 1, journals.length)
const indices = new Set()
while (indices.size < n) indices.add(Math.floor(Math.random() * journals.length))
const picked = [...indices].map((i) => journals[i])

console.log('[MADOROMI]')
console.log(`${n} of ${journals.length} journal entries, picked at random, unedited:`)
console.log('')
for (const f of picked) {
  console.log(`--- ${path.basename(f)} ---`)
  console.log(fs.readFileSync(f, 'utf8'))
  console.log('')
}

const sources = picked.map((f) => path.basename(f)).join(',')

console.log(`---
Now dream from this. Not a summary -- dream-work:
  displacement    emotional weight slides onto a peripheral object
  condensation    figures/objects from different entries merge into one
  concretization  any abstraction becomes a specific sensory/spatial detail
  elaboration     light coherence pass, seams can still show

Build the scene first, distort second. Never let a theory generate the
dream -- the distortion carries the meaning, the dream never names it.
Pull objects from what's actually in the entries above, not a generic
symbol bank. Real nouns should dominate; allow at most one impossibility.
No moral, no interpretation, no "this represents." End on an image, not
an explanation.

Write the told version only (120-300 tokens, past tense, your own voice,
anchor with a concrete first sentence) to:
  ${path.join(DREAMS_DIR, `${TODAY}.md`)}

Append this frame if the file already has an entry for today:
  ## [${NOW_TIME}] -- madoromi
  - Sources: ${sources}
  - (the dream)

Then one more step (fragment check, see procedures/madoromi.md "Fragments"):
  Name the ONE real fact from the source entries the dream rests on
  (something about the human or your life together, not dream imagery).
  memory_query for it. If memory already holds it, you are done.
  If memory does NOT hold it, it is a lost fragment. Append to
    ${path.join(DREAMS_DIR, 'fragments.md')}
  one line:
    - [ ] ${TODAY} | <the fact, plain> | source: <journal file>
  Do NOT memory_write it. It enters memory only if the human confirms it.

Then stop. The dream is over -- it isn't a report and doesn't need one.`)
