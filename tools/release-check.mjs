#!/usr/bin/env node
// tools/release-check.mjs -- what is INSIDE the packaged app.asar, and is it
// the build this release run asked for?
//
// WHY THIS FILE EXISTS. v0.3.4 was published on three pieces of evidence: the
// preflight printed a HEAD, one artifact came out one byte bigger than the
// last, and the verify stage's rows were green. Not one of those opens the
// app.asar a user actually receives. The verify stage checks that latest*.yml
// agrees with the bytes on disk; it cannot tell whether those bytes were built
// from the commit the preflight named, or are a stale staging tree, or a
// previous run's artifact that happened to survive in release/.
//
// So every lane now carries a stamp and every lane's asar gets opened:
//
//   stamp  -- written into the build tree's root as BUILD_INFO.json right
//             BEFORE packaging (build.files ships it into app.asar). It
//             carries the tag, git HEAD and a per-run id the driver made up
//             for this run. The run id is the part a stale artifact cannot
//             forge: a dmg left over from an earlier run of the SAME commit
//             carries the same HEAD, but never this run's id.
//   dump   -- opens an app.asar, reads package.json and BUILD_INFO.json out
//             of it, writes what it found as JSON, and (given the expected
//             tag / head / run id) exits 1 on any mismatch. The win and linux
//             lanes run this ON the build box, before the remote build dir is
//             deleted; the JSON comes back to release/ for the verify stage.
//
// The comparison itself (compareFacts) is a pure function so that
// tests/test-release-check.mjs can exercise it against a fake asar with no
// build at all.
//
// Usage:
//   node tools/release-check.mjs stamp --tag v0.3.5 --run-id <id> [--head <sha>] [--no-git] [--dir <tree>]
//   node tools/release-check.mjs dump  --asar <app.asar> --source <label> [--out <file.json>]
//                                      [--tag v0.3.5 --head <sha> [--run-id <id>]]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export const STAMP_NAME = 'BUILD_INFO.json'
const SHA_RE = /^[0-9a-f]{40}$/

// ── stamp ───────────────────────────────────────────────────────────────────

export function makeStamp({ tag, head, runId, dirty = null, builtAt = new Date().toISOString() }) {
  return {
    schema: 1,
    tag,
    version: String(tag || '').replace(/^v/, ''),
    head,
    runId,
    dirty,
    builtAt,
  }
}

function gitIn(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

// Writes <dir>/BUILD_INFO.json. HEAD comes from the tree's own git when it has
// one (the linux lane builds from a bundle checkout, so this is the commit that
// was actually checked out there, not a claim relayed from the Mac); --head is
// then a cross-check, and a disagreement refuses to stamp at all. The win lane
// builds from `git archive` output, which has no .git, so it passes --no-git
// and --head is the only source.
export function writeStamp({ dir, tag, runId, head = null, useGit = true }) {
  if (!tag) throw new Error('stamp: --tag is required')
  if (!runId) throw new Error('stamp: --run-id is required')
  let treeHead = null
  let dirty = null
  if (useGit) {
    treeHead = gitIn(dir, ['rev-parse', 'HEAD'])
    const st = gitIn(dir, ['status', '--porcelain'])
    if (st !== null) dirty = st !== ''
  }
  if (treeHead && head && treeHead !== head) {
    throw new Error(`stamp: this tree is at ${treeHead} but the release run expected ${head} -- refusing to stamp a build of the wrong commit`)
  }
  const finalHead = treeHead || head
  if (!finalHead || !SHA_RE.test(finalHead)) {
    throw new Error(`stamp: no usable HEAD (${JSON.stringify(finalHead)}); pass --head <40-hex sha> or run inside the git tree`)
  }
  const stamp = makeStamp({ tag, head: finalHead, runId, dirty })
  const file = path.join(dir, STAMP_NAME)
  fs.writeFileSync(file, JSON.stringify(stamp, null, 2) + '\n')
  return { file, stamp }
}

// ── reading a packaged asar ─────────────────────────────────────────────────

// What the asar says about itself, never throwing: an asar that cannot be
// opened is a FAIL row downstream, not a crash that skips the row.
export function readPackagedFacts(asarPath, source = null) {
  const facts = { source, asar: asarPath, error: null, packageVersion: null, stamp: null, stampError: null }
  if (!asarPath || !fs.existsSync(asarPath)) {
    facts.error = `app.asar not found at ${asarPath}`
    return facts
  }
  let asar
  try { asar = require('@electron/asar') } catch (e) {
    facts.error = `@electron/asar is not installed here (${e && e.message}) -- cannot open the asar`
    return facts
  }
  try {
    const pkgJson = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    facts.packageVersion = pkgJson.version == null ? null : String(pkgJson.version)
  } catch (e) {
    facts.error = `package.json could not be read out of the asar: ${e && e.message}`
  }
  try {
    facts.stamp = JSON.parse(asar.extractFile(asarPath, STAMP_NAME).toString('utf8'))
  } catch (e) {
    facts.stampError = `${STAMP_NAME} could not be read out of the asar: ${e && e.message}`
  }
  try { asar.uncache(asarPath) } catch { /* cache only */ }
  return facts
}

// ── the comparison (pure) ───────────────────────────────────────────────────

// Returns rows { name, ok, detail }. Every row is always present, in the same
// order, so a log of a failed run and a log of a passing run line up.
// runId === null means "no run id to hold it to" (--verify-only): that row is
// then reported as not checked rather than silently dropped, and ok stays true
// for it because there is nothing to compare against.
export function compareFacts(facts, { tag, head, runId = null }) {
  const rows = []
  const row = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail })
  const version = String(tag || '').replace(/^v/, '')
  const where = facts && facts.source ? ` (${facts.source})` : ''

  const opened = !!facts && !facts.error
  row(`the packaged app.asar opens${where}`, opened, facts ? facts.error || '' : 'no facts at all')

  row(`packaged package.json version is ${version}`,
    opened && facts.packageVersion === version,
    opened ? `the asar says ${JSON.stringify(facts.packageVersion)}` : 'asar not opened')

  const stamp = opened ? facts.stamp : null
  row(`packaged ${STAMP_NAME} is present`, !!stamp && typeof stamp === 'object',
    opened ? (facts.stampError || 'no stamp object') : 'asar not opened')

  row(`packaged ${STAMP_NAME} tag is ${tag}`, !!stamp && stamp.tag === tag,
    stamp ? `stamp says ${JSON.stringify(stamp.tag)}` : 'no stamp')

  // An empty expected head must never "match" an empty stamped head.
  const headOk = SHA_RE.test(String(head || '')) && !!stamp && stamp.head === head
  row(`packaged ${STAMP_NAME} head is the preflight HEAD ${String(head || '').slice(0, 12)}`, headOk,
    !SHA_RE.test(String(head || '')) ? `expected head ${JSON.stringify(head)} is not a 40-hex sha`
      : stamp ? `stamp says ${JSON.stringify(stamp.head)}` : 'no stamp')

  if (runId) {
    row(`packaged ${STAMP_NAME} run id is this run's (${runId.slice(0, 8)})`, !!stamp && stamp.runId === runId,
      stamp ? `stamp says ${JSON.stringify(stamp.runId)} -- this asar was packaged by a DIFFERENT run (stale artifact)` : 'no stamp')
  } else {
    rows.push({ name: `packaged ${STAMP_NAME} run id NOT checked (no run id: --verify-only)`, ok: true, detail: '', notChecked: true })
  }
  return rows
}

// ── mac: the dmg can be opened cheaply, so open the dmg ─────────────────────

export function readDmgFacts(dmgPath, productName) {
  if (!fs.existsSync(dmgPath)) return { source: 'dmg', asar: null, error: `${dmgPath} does not exist`, packageVersion: null, stamp: null }
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-release-check-dmg-'))
  let attached = false
  try {
    const a = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dmgPath], { encoding: 'utf8' })
    if (a.status !== 0) {
      return { source: 'dmg', asar: null, error: `hdiutil attach failed (exit ${a.status}): ${(a.stderr || '').trim()}`, packageVersion: null, stamp: null }
    }
    attached = true
    const asarPath = path.join(mnt, `${productName}.app`, 'Contents', 'Resources', 'app.asar')
    const facts = readPackagedFacts(asarPath, 'mounted dmg')
    facts.asar = `${path.basename(dmgPath)}:/${productName}.app/Contents/Resources/app.asar`
    return facts
  } finally {
    if (attached) spawnSync('hdiutil', ['detach', mnt], { stdio: 'ignore' })
    try { fs.rmSync(mnt, { recursive: true, force: true }) } catch { /* tmp */ }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const o = { cmd: argv[0], tag: null, head: null, runId: null, asar: null, source: null, out: null, dir: process.cwd(), useGit: true }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tag') o.tag = argv[++i]
    else if (a === '--head') o.head = argv[++i]
    else if (a === '--run-id') o.runId = argv[++i]
    else if (a === '--asar') o.asar = argv[++i]
    else if (a === '--source') o.source = argv[++i]
    else if (a === '--out') o.out = argv[++i]
    else if (a === '--dir') o.dir = path.resolve(argv[++i])
    else if (a === '--no-git') o.useGit = false
    else throw new Error(`unknown argument ${JSON.stringify(a)}`)
  }
  return o
}

function cli(argv) {
  const o = parseCli(argv)
  if (o.cmd === 'stamp') {
    const { file, stamp } = writeStamp({ dir: o.dir, tag: o.tag, runId: o.runId, head: o.head, useGit: o.useGit })
    console.log(`[release-check] wrote ${file}: tag ${stamp.tag} head ${stamp.head} run ${stamp.runId}${stamp.dirty ? ' (DIRTY tree)' : ''}`)
    return 0
  }
  if (o.cmd === 'dump') {
    const facts = readPackagedFacts(o.asar ? path.resolve(o.asar) : null, o.source)
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(facts, null, 2) + '\n')
    console.log(`[release-check] ${o.source || 'asar'}: ${facts.asar}`)
    console.log(`[release-check]   package.json version ${JSON.stringify(facts.packageVersion)}; stamp ${facts.stamp ? JSON.stringify(facts.stamp) : `ABSENT (${facts.stampError || facts.error})`}`)
    if (!o.tag && !o.head) return facts.error ? 1 : 0
    const rows = compareFacts(facts, { tag: o.tag, head: o.head, runId: o.runId })
    for (const r of rows) console.log(`[release-check]   ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? ` -- ${r.detail}` : ''}`)
    return rows.every((r) => r.ok) ? 0 : 1
  }
  console.error('usage: node tools/release-check.mjs stamp|dump [options]  (see the header of this file)')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = cli(process.argv.slice(2)) } catch (e) {
    console.error(`[release-check] FAIL ${e && e.message ? e.message : e}`)
    process.exitCode = 1
  }
}
