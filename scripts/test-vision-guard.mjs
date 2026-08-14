// test-vision-guard.mjs — no-vision lane image/PDF Read gate
// (hooks/pre-tool-vision-guard.mjs, v0.1.11).
//
// Pins the contract:
//   1. env-gated: without SCHEHERAZADE_LANE_VISION=no the hook exits 0 on
//      anything (vision lanes and pre-0.1.11 supervisors fail OPEN).
//   2. lane=no + Read of image/PDF extensions -> exit 2, reason on stderr
//      mentions the caption path (redirect, not a bare wall).
//   3. lane=no + Read of text files -> exit 0 (only the poison class blocks).
//   4. lane=no + non-Read tools -> exit 0 (Bash/Glob are out of scope here).
//   5. quote-wrapped paths still match; malformed stdin fails open.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-tool-vision-guard.mjs')

let ok = 0, bad = 0
const pass = (m) => { ok++; console.log(`  ok: ${m}`) }
const fail = (m) => { bad++; console.log(`  FAIL: ${m}`) }
const check = (cond, m) => (cond ? pass(m) : fail(m))

function run(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, SCHEHERAZADE_LANE_VISION: undefined, ...env },
    encoding: 'utf8',
  })
}

const readOf = (p) => ({ tool_name: 'Read', tool_input: { file_path: p } })

console.log('env gating')
check(run(readOf('/tmp/shot.png')).status === 0, 'no env var -> image Read passes (fail-open)')
check(run(readOf('/tmp/shot.png'), { SCHEHERAZADE_LANE_VISION: 'yes' }).status === 0, 'lane=yes -> image Read passes')

console.log('no-vision lane blocks')
const NO = { SCHEHERAZADE_LANE_VISION: 'no' }
for (const p of ['/tmp/shot.png', 'C:\\Users\\m\\screen.JPG', '/tmp/scan.pdf', '/tmp/pic.webp', '/tmp/photo.heic']) {
  const r = run(readOf(p), NO)
  check(r.status === 2, `lane=no blocks Read of ${p}`)
  if (r.status === 2) check(/caption|describe/i.test(r.stderr), `${p}: block reason carries the redirect`)
}
check(run(readOf('"/tmp/quoted image.png"'), NO).status === 2, 'quote-wrapped image path still blocks')

console.log('non-poison passes')
check(run(readOf('/tmp/notes.md'), NO).status === 0, 'lane=no still reads text files')
check(run(readOf('/tmp/pngparser.js'), NO).status === 0, 'extension matched at end only (pngparser.js passes)')
check(run({ tool_name: 'Bash', tool_input: { command: 'cat x.png' } }, NO).status === 0, 'non-Read tool out of scope')
check(run('not json at all', NO).status === 0, 'malformed stdin fails open')

console.log(`\n${ok} passed, ${bad} failed`)
if (bad > 0) process.exit(1)
