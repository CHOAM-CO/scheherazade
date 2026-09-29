#!/usr/bin/env node
// test-harness-refresh.mjs — the boot harness refresh must fail CLOSED.
// Run: node tests/test-harness-refresh.mjs
//
// WHY THIS FILE EXISTS (nogabi issue #6): refreshHarnessIfOnboarded() caught a
// template or config failure, logged `agent runs on stale harness`, returned
// false, and boot continued. The agent then started against whatever harness
// happened to be on disk, and the only trace was a log line nobody reads at
// boot. A new runtime paired with an old CLAUDE.md / ONTOLOGY_GUIDE.md /
// system_prompt.md is exactly the mismatch the every-boot re-render exists to
// prevent.
//
// A second defect turned up while fixing it, and it is the worse one: the
// render read, rendered and wrote each file in turn, so a template that failed
// partway through left a MIXED harness — a new CLAUDE.md beside an old
// system_prompt.md. "Stale" is the wrong word for that; stale is at least
// internally consistent. The render is now all-or-nothing.
//
// WHAT IT PROVES
//   1. read failure   -> nothing on disk changes, marker written, gate armed
//   2. write failure  -> same, and no half-written harness survives
//   3. recovery       -> a later clean render deletes the marker with no user
//                        action, which is the whole premise of re-rendering
//                        every boot
//   4. atomicity      -> a failure on the LAST file leaves the FIRST file at
//                        its previous content (the mixed-harness case)
//   5. fail closed    -> an unreadable/corrupt marker still reads as a failure
//
// SCOPE: the render + marker contract, plus a STATIC check that main.cjs's
// pre-spawn gate exists and sits ahead of the spawn. It does NOT launch
// Electron, so the gate is asserted against source rather than by observing a
// refused spawn. Uses the file's own readFileFn/writeFileFn test seams (same
// shape as resolveOutboundChannel's).

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const LIVE_HOME = path.join(os.homedir(), 'Documents', 'Scheherazade')
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'sch-harness-'))
if (path.resolve(SANDBOX) === path.resolve(LIVE_HOME)) {
  console.error('refusing to run against the live data home')
  process.exit(2)
}
process.env.AGENT_DATA_HOME = SANDBOX

const server = require('../onboarding/http-server.cjs')
const { refreshHarnessIfOnboarded, readHarnessFailure, HARNESS_FAILURE_PATH } = server

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}
function finish() {
  rmSync(SANDBOX, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

for (const name of ['refreshHarnessIfOnboarded', 'readHarnessFailure']) {
  if (typeof server[name] !== 'function') {
    console.log(`  FAIL ${name} is not exported from http-server.cjs`)
    fail++
  }
}
if (fail) finish()

// An onboarded install: the refresh is a no-op before this exists.
writeFileSync(path.join(SANDBOX, '.agent-config'),
  'ONBOARDING_COMPLETE=1\nDISPLAY_NAME=Testboard\nTONE=casual\nPRIMARY_TASK=testing\n')

const CLAUDE = path.join(SANDBOX, 'CLAUDE.md')
const PROMPT = path.join(SANDBOX, 'system_prompt.md')

console.log('\n0. a clean render is the baseline')
assert(refreshHarnessIfOnboarded() === true, 'a clean refresh returns true')
assert(existsSync(CLAUDE) && existsSync(PROMPT), 'the harness files were written')
{
  // Korean voice guide (0.3.8) is inlined into the prompt, and no template
  // placeholder survives the render.
  const rendered = readFileSync(PROMPT, 'utf8')
  assert(rendered.includes('## Speaking Korean') && rendered.includes('파일 세 개'),
    'the rendered prompt carries the Korean voice guide')
  assert(!/\{[A-Z_]+\}/.test(rendered), 'no {PLACEHOLDER} left in the rendered prompt')
}
assert(readHarnessFailure() === null, 'no failure marker after a clean render')
const goodClaude = readFileSync(CLAUDE, 'utf8')
// Behavioural version of what tests/test-attach-topology.mjs used to assert
// by grepping for a chmodSync line: sudo -A execs this helper, so the mode is
// the thing that matters, not the shape of the call that sets it.
// POSIX only: sudo -A execs this helper, and both sudo and the exec bit are
// POSIX concepts -- Node's chmod maps only the read-only bit on Windows, so
// the mode can never be 0700 there (2026-08-04 win suite).
if (process.platform === 'win32') {
  console.log('  n/a  sudo-askpass.sh 0700 -- no sudo and no exec bit on Windows')
} else {
  assert((statSync(path.join(SANDBOX, 'sudo-askpass.sh')).mode & 0o777) === 0o700,
    'sudo-askpass.sh lands at 0700 after a real render')
}

console.log('\n1. a template that cannot be read')
const readBoom = () => { throw new Error('EIO: simulated unreadable template') }
assert(refreshHarnessIfOnboarded({ readFileFn: readBoom }) === false, 'refresh returns false')
const marker1 = readHarnessFailure()
assert(marker1 !== null, 'a durable failure marker is written')
assert(!!marker1 && /unreadable template/.test(marker1.message), 'the marker carries the underlying reason')
assert(!!marker1 && typeof marker1.at === 'string', 'the marker is timestamped')
assert(readFileSync(CLAUDE, 'utf8') === goodClaude, 'the previous harness on disk is untouched')

console.log('\n2. recovery needs no user action')
assert(refreshHarnessIfOnboarded() === true, 'the next clean refresh succeeds')
assert(readHarnessFailure() === null, 'success deletes the marker, so the spawn gate re-opens')

console.log('\n3. a harness file that cannot be written')
const writeBoom = () => { throw new Error('ENOSPC: simulated write failure') }
assert(refreshHarnessIfOnboarded({ writeFileFn: writeBoom }) === false, 'refresh returns false')
assert(readHarnessFailure() !== null, 'a durable failure marker is written')
assert(readFileSync(CLAUDE, 'utf8') === goodClaude, 'the previous CLAUDE.md survives the failed write')
assert(!existsSync(`${CLAUDE}.tmp`) || readFileSync(CLAUDE, 'utf8') === goodClaude,
  'no partial write replaced the live file')
refreshHarnessIfOnboarded() // back to clean for the next case

console.log('\n4. atomicity: a failure on the LAST source cannot leave a mixed harness')
// This is the case the old code got wrong. system_prompt.md is read last, so a
// per-file write loop would already have replaced CLAUDE.md by the time it blew
// up, leaving a new CLAUDE.md next to an old system_prompt.md.
//
// The sentinels are load-bearing and the reason this assertion is worth
// writing at all. A first attempt compared the files to their own previous
// contents, which a render reproduces byte for byte -- so "rewritten with
// identical bytes" and "not rewritten" looked the same, and restoring the
// per-file write loop passed 19/0. Found by running the mutation, not by
// reading the test. Planting distinguishable content is what makes a write
// visible.
const SENTINEL = '<<<sentinel: this content is not what a render produces>>>\n'
writeFileSync(CLAUDE, SENTINEL)
writeFileSync(PROMPT, SENTINEL)
const failOnLast = (p, enc) => {
  if (String(p).endsWith('agent-system-prompt.md')) throw new Error('EIO: last template unreadable')
  return readFileSync(p, enc)
}
assert(refreshHarnessIfOnboarded({ readFileFn: failOnLast }) === false, 'refresh returns false')
assert(readFileSync(CLAUDE, 'utf8') === SENTINEL,
  'the FIRST harness file was not replaced, so no mixed harness exists')
assert(readFileSync(PROMPT, 'utf8') === SENTINEL, 'the LAST harness file was not replaced')
assert(refreshHarnessIfOnboarded() === true, 'and a clean render afterwards does replace both')
assert(readFileSync(CLAUDE, 'utf8') !== SENTINEL, 'the sentinel is gone once a render succeeds')

console.log('\n5. main.cjs actually consults the marker before spawning')
// Static, like tests/test-window-floor.mjs: the marker is only a gate if
// something reads it, and a test that stops at "the file was written" would
// have passed on the old log-only behaviour too. Order matters as much as
// presence -- a check placed after the spawn call is not a gate.
const mainSrc = readFileSync(path.join(import.meta.dirname, '..', 'main.cjs'), 'utf8')
const locked = mainSrc.indexOf('async function spawnRealAgentChildLocked')
const gateAt = mainSrc.indexOf('readHarnessFailure()', locked)
const spawnAt = mainSrc.indexOf('spawn(', locked)
assert(mainSrc.includes('readHarnessFailure'), 'main.cjs imports the marker reader')
assert(locked !== -1 && gateAt !== -1, 'the gate is inside spawnRealAgentChildLocked')
assert(gateAt !== -1 && spawnAt !== -1 && gateAt < spawnAt, 'the gate runs BEFORE the spawn call')
assert(/setAgentStatus\('failed', 'harness_stale'/.test(mainSrc), "the gate reports state failed with code 'harness_stale'")
assert(readFileSync(path.join(import.meta.dirname, '..', 'onboarding', 'public', 'js', 'copy.js'), 'utf8').includes('harness_stale'),
  'the UI has copy for harness_stale, so the failure is actionable and not just a code')

console.log('\n6. an unreadable marker still means failure')
writeFileSync(HARNESS_FAILURE_PATH, '{ this is not json')
const corrupt = readHarnessFailure()
assert(corrupt !== null, 'a corrupt marker reads as a failure, never as "fine"')
assert(!!corrupt && /could not be read/.test(corrupt.message), 'and says why it could not be parsed')

finish()
