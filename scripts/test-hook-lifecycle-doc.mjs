#!/usr/bin/env node
// test-hook-lifecycle-doc.mjs — docs/ARCHITECTURE.md's hook section must match
// what is actually registered and what those hooks can actually do.
// Run: node scripts/test-hook-lifecycle-doc.mjs
//
// WHY THIS FILE EXISTS (nogabi issue #11): the doc said "three hooks, all
// advisory (none of them block)". The shipped settings template registered
// thirteen hook commands across four stages, and three of them exit(2), which
// refuses a tool call or a turn end. The sentence was true of the original
// spec and quietly stopped being true as hooks were added.
//
// Rewriting the section fixes today. It does not fix the next hook someone
// adds, and the issue's own last acceptance criterion is "documentation is
// checked when hook wiring changes" -- which is a test, not a paragraph. A
// scope statement that lives only in prose dies the moment the code moves; the
// only durable version is one that runs.
//
// WHAT IT CHECKS
//   1. every hook registered in the settings template appears in the doc
//   2. nothing is documented that is not registered (the reverse drift, which
//      reads as coverage and is worse than an omission)
//   3. every registered stage for a hook is named in its doc row
//   4. blocking status matches reality: a hook is in the Blocking table iff it
//      can exit(2), and in the Advisory table iff it cannot
//   5. the prose count matches the registered count
//
// SCOPE: the shipped TEMPLATE (onboarding/templates/claude-settings.local.json)
// against docs/ARCHITECTURE.md. It does not read a user's installed
// .claude/settings.local.json -- that file is theirs to edit and is not what
// the doc describes.

import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const settings = JSON.parse(
  readFileSync(path.join(ROOT, 'onboarding/templates/claude-settings.local.json'), 'utf8')
)
const doc = readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

// ── ground truth: what is registered ────────────────────────────────────────
const registered = new Map() // file -> Set(stage)
let commandCount = 0
for (const [stage, entries] of Object.entries(settings.hooks || {})) {
  for (const entry of entries) {
    for (const h of entry.hooks || []) {
      const m = /hooks\/([\w.-]+\.mjs)/.exec(h.command || '')
      if (!m) continue
      commandCount++
      if (!registered.has(m[1])) registered.set(m[1], new Set())
      registered.get(m[1]).add(stage)
    }
  }
}

// ── ground truth: what can refuse ───────────────────────────────────────────
// TWO refusal signals exist: exit(2), and an emitted permissionDecision
// 'deny' (exit 0 + hookSpecificOutput JSON -- how the rumination gate's
// normal path and the AskUserQuestion redirect actually refuse). Reading the
// source is the only honest way to know; a hook's own header comment
// claiming "advisory only" is prose too, and prose is exactly what this file
// exists to distrust.
const canBlock = new Set()
for (const file of registered.keys()) {
  let src = ''
  try { src = readFileSync(path.join(ROOT, 'hooks', file), 'utf8') } catch { continue }
  if (/process\.exit\(2\)/.test(src)) canBlock.add(file)
  if (/permissionDecision/.test(src) && /(['"])deny\1/.test(src)) canBlock.add(file)
}

// ── the doc's two tables ────────────────────────────────────────────────────
function sectionBetween(startHeading, endHeading) {
  const a = doc.indexOf(startHeading)
  const b = doc.indexOf(endHeading, a + 1)
  return a === -1 ? '' : doc.slice(a, b === -1 ? doc.length : b)
}
const blockingSection = sectionBetween('### Blocking hooks', '### Advisory hooks')
const advisorySection = sectionBetween('### Advisory hooks', '\n## ')

console.log('\n0. the doc has both tables')
assert(blockingSection.length > 0, 'a "Blocking hooks" section exists')
assert(advisorySection.length > 0, 'an "Advisory hooks" section exists')
if (!blockingSection || !advisorySection) {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(1)
}

console.log(`\n1. every registered hook is documented (${registered.size} files, ${commandCount} commands)`)
for (const file of [...registered.keys()].sort()) {
  assert(doc.includes(file), `${file} appears in ARCHITECTURE.md`)
}

console.log('\n2. nothing documented that is not registered')
for (const m of doc.matchAll(/`([\w.-]+\.mjs)`/g)) {
  const name = m[1]
  // Only hook files are in scope; scripts/ tools are referenced elsewhere in
  // the same document and are not part of the hook contract.
  if (!/^(session-start|felt-check|checkpoint-nudge|context-gauge|post-|pre-|stop-)/.test(name)) continue
  assert(registered.has(name), `${name} is documented and is actually registered`)
}

console.log('\n3. stages match')
for (const [file, stages] of [...registered.entries()].sort()) {
  const row = doc.split('\n').find((l) => l.includes(`\`${file}\``) && l.startsWith('|'))
  assert(!!row, `${file} has a table row`)
  if (!row) continue
  for (const stage of stages) {
    assert(row.includes(stage), `${file} row names its ${stage} registration`)
  }
}

console.log('\n4. blocking status matches the refusal signals (exit(2) / permissionDecision deny)')
for (const file of [...registered.keys()].sort()) {
  const inBlocking = blockingSection.includes(file)
  const inAdvisory = advisorySection.includes(file)
  assert(inBlocking !== inAdvisory, `${file} is in exactly one of the two tables`)
  if (canBlock.has(file)) {
    assert(inBlocking, `${file} can refuse (exit(2) or permissionDecision deny), so it must be listed as blocking`)
  } else {
    assert(inAdvisory, `${file} carries no refusal signal, so it must be listed as advisory`)
  }
}

console.log('\n5. the prose count matches reality')
const countWord = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Eleven', 12: 'Twelve', 13: 'Thirteen', 14: 'Fourteen', 15: 'Fifteen' }
const expectCommands = countWord[commandCount]
const expectBlocking = (countWord[canBlock.size] || String(canBlock.size)).toLowerCase()
// Label says WORD (n registered), not WORD (actual: n) -- the old form printed
// the expected word beside the same number it was derived from, so a genuine
// drift failure read as "Twelve (actual: 12)" and looked like a broken test
// rather than a stale doc (2026-08-03).
assert(!!expectCommands && doc.includes(`${expectCommands} hook commands`),
  `ARCHITECTURE.md says "${expectCommands} hook commands" (${commandCount} registered)`)
assert(doc.toLowerCase().includes(`${expectBlocking} of them can\nblock`) ||
       doc.toLowerCase().includes(`${expectBlocking} of them can block`),
  `ARCHITECTURE.md says "${expectBlocking} of them can block" (${canBlock.size} can)`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
