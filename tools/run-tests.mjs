#!/usr/bin/env node
// tools/run-tests.mjs -- the one test gate (P1 of design-0023, cross-platform 0.3).
//
// WHY THIS FILE EXISTS. Until now there was no `npm test`. CONTRIBUTING said
// "node tests/test-*.mjs", which the shell expands into ONE node invocation
// that runs the first file and hands it the other 84 paths as argv. RELEASE.md
// carried the de-facto runner -- a for-loop that echoed "FAIL <file>" and then
// exited 0 anyway, skipped the two .cjs test programs and tests/smoke.mjs, had
// no timeout, and always included test-packaging.mjs, which is RED by design
// without a freshly built artifact. "The suite is green" meant a human reading
// 85 scrollbacks and remembering which reds were expected.
//
// WHAT THIS DOES. Enumerate every standalone test program, run each in its own
// process with THIS node (process.execPath -- never the bare string 'node',
// which resolves against PATH and on Windows or inside a hook lane is a
// different runtime, or nothing), capture stdout+stderr to a per-test log,
// classify PASS / FAIL / SKIP, print one table, and exit non-zero if anything
// failed.
//
// THE SKIP MARKER (one convention, the whole suite uses it). A test program
// that could not run on this host prints, at COLUMN 0:
//
//     SKIP: <reason>
//
// and exits 0. That marks the whole program skipped. Section-level skips inside
// a file keep their INDENTED "  SKIP ..." / "  n/a ..." form and do not mark the
// file: a file that ran 60 assertions and skipped one section is a PASS, not a
// SKIP. Column 0 is the entire difference, which is why nothing else in the
// suite prints an unindented SKIP line. Indented ones are still COUNTED and
// listed under the table -- "green on Windows" used to mean "green with nine
// sections silently unrun", and that is the number that says so.
//
// LIVE LANES. Three lanes need something this process cannot conjure -- the
// real Calendar (TCC), a tmux binary + server, a freshly built dmg/exe. They
// run only under --live (env RUN_TESTS_LIVE=1); otherwise they print the marker
// and exit 0. The runner also sets RUN_TESTS=1 for every child, which is how
// tools/test-packaging.mjs tells "the runner is asking" from "npm run dist's
// predist/postdist hook is asking" -- the hook still fails hard on a missing
// artifact, because that is the only gate this project has on what ships.
//
// Usage:
//   node tools/run-tests.mjs                 # the gate (no live lanes)
//   node tools/run-tests.mjs --live          # + calendar / tmux / artifact lanes
//   node tools/run-tests.mjs --filter local  # substring match on the path
//   node tools/run-tests.mjs --list          # print what would run, run nothing
//   node tools/run-tests.mjs --timeout 300   # per-file seconds (env RUN_TESTS_TIMEOUT)
//   node tools/run-tests.mjs --logs <dir>    # where the per-test logs go

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TIMEOUT_S = 180
const KILL_GRACE_MS = 5000
const MAX_CAPTURE = 4 * 1024 * 1024 // per test, in memory; the log file gets the same

// WHERE THE TESTS LIVE (0.3 P2). tests/ -- not scripts/. Until now every test
// program sat in scripts/, which package.json shipped whole
// ("scripts/**/*" in build.files, "scripts/**" in asarUnpack), so all 85 of
// them landed in every installer as real, executable, on-disk files. The
// enumeration below is the runner's half of that split; the other half is the
// PAYLOAD gate in tools/test-packaging.mjs, which fails the build if anything
// under tests/ or tools/ ever gets back into a bundle.
const TEST_DIR = 'tests'

// Extra programs that the tests/test-* glob does not match.
//   tests/smoke.mjs         -- a real 52-assert memory program with no
//                              requirer. It lived in memory/ (a SHIPPED
//                              directory) and was outside every loop this repo
//                              ever had, which is how it sat untouched since
//                              2026-07-03.
//   tools/test-packaging.mjs -- lives in tools/ because it is FIRST a build
//                              gate (npm's predist/postdist run it) and only
//                              second a suite member. Naming it here keeps
//                              `npm test -- --live --filter packaging` working
//                              from its new home.
const EXTRA_TESTS = ['tests/smoke.mjs', 'tools/test-packaging.mjs']

function usage() {
  console.log(`node tools/run-tests.mjs [--live] [--filter <substr>] [--list] [--timeout <s>] [--logs <dir>]

  --live            run the lanes that need this machine's real state:
                    test-calendar (EventKit/TCC), test-attach-topology (tmux),
                    test-packaging (a freshly built dmg/exe). Sets RUN_TESTS_LIVE=1.
  --filter <substr> only tests whose path contains <substr> (repeatable)
  --list            print the selected tests and exit
  --timeout <s>     per-file timeout, default ${DEFAULT_TIMEOUT_S}s (env RUN_TESTS_TIMEOUT)
  --logs <dir>      per-test logs (default release/test-logs, gitignored)`)
}

function parseArgs(argv) {
  const opts = { live: false, list: false, help: false, filters: [], timeoutS: null, logDir: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = (inline) => (inline !== null ? inline : argv[++i])
    const inline = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : null)
    if (a === '--live') opts.live = true
    else if (a === '--list') opts.list = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--filter' || a.startsWith('--filter=')) {
      const v = take(inline('--filter'))
      if (!v) { console.error('run-tests: --filter needs a substring'); process.exit(2) }
      opts.filters.push(String(v))
    } else if (a === '--timeout' || a.startsWith('--timeout=')) {
      const v = Number(take(inline('--timeout')))
      if (!Number.isFinite(v) || v <= 0) { console.error('run-tests: --timeout needs a positive number of seconds'); process.exit(2) }
      opts.timeoutS = v
    } else if (a === '--logs' || a.startsWith('--logs=')) {
      const v = take(inline('--logs'))
      if (!v) { console.error('run-tests: --logs needs a directory'); process.exit(2) }
      opts.logDir = String(v)
    }
    else {
      console.error(`run-tests: unknown argument ${JSON.stringify(a)}`)
      usage()
      process.exit(2)
    }
  }
  return opts
}

function listTests() {
  const found = fs
    .readdirSync(path.join(ROOT, TEST_DIR))
    .filter((f) => /^test-.*\.(mjs|cjs)$/.test(f))
    .sort()
    .map((f) => `${TEST_DIR}/${f}`)
  for (const rel of EXTRA_TESTS) {
    if (fs.existsSync(path.join(ROOT, rel))) found.push(rel)
  }
  return found
}

function resolveLogDir(requested) {
  const candidates = requested
    ? [path.resolve(ROOT, requested)]
    : [path.join(ROOT, 'release', 'test-logs')]
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return dir
    } catch { /* fall through to tmp */ }
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-test-logs-'))
}

// The first line that looks like a failure, for the summary table. Every test
// file in this repo hand-rolls its own harness, so this matches all five
// conventions ("FAIL name", "  FAIL: name", "FAIL  name", a thrown stack, and
// the "N passed, M failed" trailer) rather than one.
function firstFailingLine(out) {
  const lines = out.split(/\r?\n/)
  for (const line of lines) {
    if (/(^|\s)FAIL\b/.test(line)) return line.trim()
    if (/^\s*(Error|AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(line)) return line.trim()
    if (/^\s*Uncaught\b/.test(line)) return line.trim()
    if (/^\s*throw\b/.test(line)) return line.trim()
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i].trim()
  }
  return ''
}

const SKIP_MARKER = /^SKIP:[ \t]*(.*)$/m
// Section-level skips: the INDENTED form ("  SKIP ...", "  n/a ...") that a
// file prints when one of its sections could not be set up on this host while
// the rest of it ran. They do not change the file's status -- a file that
// asserted 58 things and skipped one fixture is a PASS -- but they are the
// difference between "green on Windows" and "green on Windows with nine
// sections silently unrun", so they are counted and named.
const SECTION_SKIP = /^[ \t]+(?:SKIP|n\/a)\b[ \t:-]*(.*)$/gm
function sectionSkipsIn(out) {
  return [...out.matchAll(SECTION_SKIP)].map((m) => m[1].trim())
}

function runOne(rel, { timeoutMs, env, logPath }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let out = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let killTimer = null

    const child = spawn(process.execPath, [path.join(ROOT, rel)], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const capture = (buf) => {
      if (out.length >= MAX_CAPTURE) { truncated = true; return }
      out += buf.toString()
      if (out.length > MAX_CAPTURE) { out = out.slice(0, MAX_CAPTURE); truncated = true }
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    const timer = setTimeout(() => {
      timedOut = true
      // SIGTERM first: a test holding a real http server or a spawned child
      // gets its exit handlers. SIGKILL only if it ignores that.
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, KILL_GRACE_MS)
    }, timeoutMs)

    const finish = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const seconds = (Date.now() - t0) / 1000
      if (truncated) out += `\n[run-tests: output truncated at ${MAX_CAPTURE} bytes]\n`
      try { fs.writeFileSync(logPath, out) } catch { /* log is a convenience, not the gate */ }

      const sectionSkips = sectionSkipsIn(out)
      let status
      let note = ''
      if (spawnError) {
        status = 'FAIL'
        note = `could not spawn: ${spawnError.message}`
      } else if (timedOut) {
        status = 'FAIL'
        note = `TIMEOUT after ${Math.round(timeoutMs / 1000)}s${signal ? ` (${signal})` : ''}`
      } else if (code !== 0) {
        status = 'FAIL'
        note = firstFailingLine(out) || `exit ${code}${signal ? ` (${signal})` : ''}`
      } else {
        const m = out.match(SKIP_MARKER)
        if (m) { status = 'SKIP'; note = m[1].trim() }
        else { status = 'PASS' }
      }
      resolve({ rel, status, seconds, note, sectionSkips, code, signal, timedOut })
    }

    child.on('error', (err) => finish(null, null, err))
    child.on('close', (code, signal) => finish(code, signal, null))
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { usage(); return 0 }

  const envTimeout = Number(process.env.RUN_TESTS_TIMEOUT)
  const timeoutS =
    Number.isFinite(opts.timeoutS) && opts.timeoutS > 0 ? opts.timeoutS
      : Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout
        : DEFAULT_TIMEOUT_S

  let tests = listTests()
  if (opts.filters.length) {
    tests = tests.filter((rel) => opts.filters.some((f) => rel.includes(f)))
  }

  if (opts.list) {
    for (const rel of tests) console.log(rel)
    console.log(`\n${tests.length} test program(s)${opts.filters.length ? ` matching ${opts.filters.map((f) => JSON.stringify(f)).join(', ')}` : ''}`)
    return 0
  }
  if (!tests.length) {
    console.error(`run-tests: no test programs matched ${opts.filters.map((f) => JSON.stringify(f)).join(', ')}`)
    return 2
  }

  const logDir = resolveLogDir(opts.logDir)
  const env = { ...process.env, RUN_TESTS: '1' }
  if (opts.live) env.RUN_TESTS_LIVE = '1'
  else delete env.RUN_TESTS_LIVE // never inherit a stale one from the shell

  console.log(`run-tests: ${tests.length} programs, ${process.execPath} (node ${process.versions.node}), ${process.platform}/${process.arch}`)
  console.log(`run-tests: live lanes ${opts.live ? 'ON (--live)' : 'OFF (pass --live for calendar / tmux / packaging artifact)'}; timeout ${timeoutS}s/file`)
  console.log(`run-tests: logs -> ${logDir}\n`)

  const t0 = Date.now()
  const results = []
  let i = 0
  for (const rel of tests) {
    i++
    const label = rel.replace(/^(?:tests|tools)\//, '').replace(/\.(mjs|cjs)$/, '')
    process.stdout.write(`[${String(i).padStart(String(tests.length).length)}/${tests.length}] ${label} ... `)
    const logPath = path.join(logDir, `${label.replace(/[\\/]/g, '_')}.log`)
    const r = await runOne(rel, { timeoutMs: timeoutS * 1000, env, logPath })
    results.push({ ...r, label, logPath })
    console.log(`${r.status} ${r.seconds.toFixed(1)}s${r.status === 'PASS' ? '' : r.note ? ` -- ${r.note.slice(0, 120)}` : ''}`)
  }
  const wall = (Date.now() - t0) / 1000

  const width = Math.max(...results.map((r) => r.label.length), 4)
  console.log('\n' + '-'.repeat(Math.min(width + 60, 120)))
  console.log(`${'test'.padEnd(width)}  status  secs  detail`)
  console.log('-'.repeat(Math.min(width + 60, 120)))
  for (const r of results) {
    const skips = r.sectionSkips.length ? `${r.status === 'PASS' ? '' : ' '}(${r.sectionSkips.length} section skip${r.sectionSkips.length > 1 ? 's' : ''})` : ''
    const detail = `${r.status === 'PASS' ? '' : r.note.slice(0, 90)}${skips}`
    console.log(`${r.label.padEnd(width)}  ${r.status.padEnd(6)}  ${r.seconds.toFixed(1).padStart(4)}  ${detail}`)
  }

  const counts = { PASS: 0, FAIL: 0, SKIP: 0 }
  for (const r of results) counts[r.status]++
  const failures = results.filter((r) => r.status === 'FAIL')
  const skips = results.filter((r) => r.status === 'SKIP')

  console.log('-'.repeat(Math.min(width + 60, 120)))
  console.log(`${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped of ${results.length} in ${wall.toFixed(1)}s`)

  if (skips.length) {
    console.log('\nskipped (not run on this host -- NOT a pass):')
    for (const r of skips) console.log(`  ${r.label}: ${r.note}`)
  }
  const sectioned = results.filter((r) => r.sectionSkips.length)
  if (sectioned.length) {
    const total = sectioned.reduce((n, r) => n + r.sectionSkips.length, 0)
    console.log(`\n${total} section(s) skipped inside files that otherwise ran (also NOT a pass):`)
    for (const r of sectioned) {
      for (const why of r.sectionSkips) console.log(`  ${r.label}: ${why || '(no reason given)'}`)
    }
  }
  if (failures.length) {
    console.log('\nFAILED:')
    for (const r of failures) console.log(`  ${r.label}: ${r.note}\n    log: ${r.logPath}`)
  }
  return failures.length ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { console.error('run-tests: crashed:', err && err.stack ? err.stack : err); process.exitCode = 1 },
)
