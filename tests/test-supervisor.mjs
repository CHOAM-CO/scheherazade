// test-supervisor.mjs -- attacks on supervisor.mjs (Windows-port Phase 1).
// Run: node tests/test-supervisor.mjs
//
// Design rule (docs/supervisor-design.md, Test plan): attacks, not
// demonstrations. Every section tries to make the port DIVERGE from run.sh's
// battle-tested semantics; the ladder tests drive the REAL runLoop with a
// fake child and a fake clock (each mock names what it stands in for), and
// the two integration tests at the end use a REAL __loop process with a real
// pty child on macOS -- the signal test asserts no orphan survives, which no
// mock can prove.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  backoffFor,
  localDate,
  parseAgentConfig,
  writeFailureMarker,
  clearFailureMarker,
  isOurSupervisor,
  classifyPidfileOwner,
  ensureNodeShim,
  transcriptDirFor,
  newestTranscript,
  readTranscriptTail,
  stallVerdict,
  createStallLane,
  createBounceBudget,
  runLoop,
} from '../supervisor.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── orphan reaper ───────────────────────────────────────────────────────────
// The integration sections spawn REAL `supervisor.mjs __loop` processes. Their
// try/catch paths kill them, but a hard death of THIS process (Ctrl-C, a
// harness timeout kill, an uncaught throw outside those trys) used to leave
// the loop running forever — an orphan supervisor from an ad-hoc run survived
// 2026-08-04→05 and needed kill -9. Every spawned supervisor registers here:
// on a signal it gets SIGTERM (the supervisor reaps its own pty child on TERM
// — section 9a proves that), and whatever is somehow still alive at 'exit'
// gets SIGKILL. SIGKILL of this process itself remains undefendable.
const LIVE_SUPS = new Set()
const trackSup = (sup) => { LIVE_SUPS.add(sup); sup.on('exit', () => LIVE_SUPS.delete(sup)); return sup }
process.on('exit', () => { for (const s of LIVE_SUPS) { try { s.kill('SIGKILL') } catch {} } })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    for (const s of LIVE_SUPS) { try { s.kill('SIGTERM') } catch {} }
    // Grace so the supervisors can reap their children before 'exit' SIGKILLs
    // survivors; unref'd so an already-idle process still exits promptly.
    setTimeout(() => process.exit(1), 2000).unref()
  })
}

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── 1+2. THE lane (design-0020 + design-0023 P3) ───────────────────────────
// This section used to pin run.sh and supervisor.mjs against each other, a
// string-parity contract that existed only because two supervisors shipped.
// One lane now: run.sh is deleted, and what these pins defend is that the
// surviving one still carries every semantic the bash loop was trusted for --
// the lane spawn on OUR OWN runtime, the env contract, the guarded
// SYSTEM_PROMPT_FILE/MCP_CONFIG_FILE, the two reaper patterns.
console.log('\n-- one lane: supervisor.mjs execs the lane on its own runtime')
{
  const supSrc = fs.readFileSync(path.join(ROOT, 'supervisor.mjs'), 'utf8')
  ok('run.sh is GONE from the tree (a resurrected second supervisor fails here)',
    !fs.existsSync(path.join(ROOT, 'run.sh')))
  ok('nothing in the runtime spawns bash as a launcher',
    !fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8').includes("'/bin/bash'"))
  ok('supervisor spawns the SAME lane script on its own runtime (dsh lane switched by cfg.laneKind, 0.2.1)',
    supSrc.includes("new URL('./headless-lane.mjs', import.meta.url)") &&
    supSrc.includes("cpSpawn(process.execPath, [cfg.laneKind === 'dsh' ? DSH_LANE_PATH : HEADLESS_LANE_PATH]"))
  for (const key of ['AGENT_NAME: cfg.agentName', 'MEM: cfg.mem', 'CLAUDE_BIN: cfg.claudeBin', 'MODEL: cfg.model']) {
    ok(`supervisor child env carries ${key.split(':')[0]}`, supSrc.includes(key))
  }
  ok('supervisor passes SYSTEM_PROMPT_FILE / MCP_CONFIG_FILE guarded on existence',
    supSrc.includes('SYSTEM_PROMPT_FILE: cfg.systemPromptFile') &&
    supSrc.includes('MCP_CONFIG_FILE: cfg.mcpConfigFile'))
  ok('node-pty is fully gone from the supervisor', !supSrc.includes("require_('node-pty')"))
  // reaper patterns: FULL lane path + the leaf argv. A basename alone
  // cross-matched any process whose argv mentions the file -- an editor, a
  // grep, the E2E driver's own pkill (live bite 2026-08-04).
  ok('supervisor reaper patterns (full path; dsh lane keys on its --patch argv)',
    supSrc.includes("laneKind === 'dsh' ? 'dsh-lane.mjs' : 'headless-lane.mjs'") &&
    supSrc.includes("`--mcp-config ${path.join(mem, '.mcp.json')}`") &&
    supSrc.includes("`--patch ${path.join(mem, '.dsh-lane-home', 'lane.patch.yml')}`"))
  // win sweep self-kill regression (2026-08-18, magi-win live repro): the
  // sweep powershell's own command line contains `*<pattern>*`, so without
  // excluding $PID the Where-Object matches the sweep itself and
  // Stop-Process kills it mid-pipeline (exit -1, empty output, every boot).
  // POSIX pkill self-excludes; win32 must do it explicitly. The sweep moved
  // into proc.cjs with P3 (one seam, four callers) -- the pin moved with it,
  // it did not get dropped.
  const procSrc = fs.readFileSync(path.join(ROOT, 'proc.cjs'), 'utf8')
  ok('win orphan sweep excludes its own powershell ($PID) -- self-kill regression',
    procSrc.includes('-and $_.ProcessId -ne $PID }'))
  ok('the supervisor sweeps through proc.cjs, not a private copy',
    supSrc.includes('sweepByPattern(pkillPattern, { log })') && !supSrc.includes('Get-CimInstance Win32_Process'))
}

// ── 2b. the lane's claude argv (the ONE argv builder) ──────────────────────
console.log('\n-- headless-lane buildArgs: the one claude argv')
{
  // pathToFileURL, not the raw join: bare absolute paths import on POSIX by
  // accident but win32 ESM refuses them (protocol 'c:' -- magi-win 0.57 gate).
  const { buildArgs } = await import(pathToFileURL(path.join(ROOT, 'headless-lane.mjs')).href)
  const base = buildArgs({ model: 'm1', systemPromptFile: null, mcpConfigFile: null, resumeId: null })
  ok('base argv: -p stream-json both ways, verbose, model, skip-permissions',
    base.join(' ') === '-p --input-format stream-json --output-format stream-json --verbose --model m1 --dangerously-skip-permissions',
    base.join(' '))
  ok('NO dev-channels flag anywhere (dead in -p, probe 5)', !base.includes('--dangerously-load-development-channels'))
  const full = buildArgs({ model: 'm1', systemPromptFile: '/mem/system_prompt.md', mcpConfigFile: '/mem/.mcp.json', resumeId: 'sess-9' })
  ok('prompt rides before strict mcp pair, resume last',
    full.join(' ') === '-p --input-format stream-json --output-format stream-json --verbose --model m1 --dangerously-skip-permissions --append-system-prompt-file /mem/system_prompt.md --strict-mcp-config --mcp-config /mem/.mcp.json --resume sess-9',
    full.join(' '))
}

// ── 3. backoff ladder (run.sh:394-400 verbatim) ─────────────────────────────
console.log('\n-- backoff ladder')
{
  const expected = { 0: 5, 1: 5, 2: 10, 3: 20, 4: 40, 5: 120, 6: 120 }
  for (const [count, want] of Object.entries(expected)) {
    ok(`count ${count} -> ${want}s`, backoffFor(Number(count)) === want, `got ${backoffFor(Number(count))}`)
  }
}

// ── 4. config parser round-trips the producer's quoting ────────────────────
console.log('\n-- .agent-config: parser round-trips writeAgentConfig quoting')
{
  // shellQuote reproduced from onboarding/http-server.cjs -- and PINNED
  // below against that source, because a drifted copy would silently test
  // the wrong contract.
  function shellQuote(value) {
    const str = String(value).replace(/\r?\n/g, ' ')
    const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
    return `"${escaped}"`
  }
  const httpServer = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  ok('http-server.cjs still contains the exact shellQuote escape chain this test copies',
    httpServer.includes(".replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\"').replace(/\\$/g, '\\\\$').replace(/`/g, '\\\\`')"),
    'the producer changed -- update BOTH this fixture and supervisor.mjs parseAgentConfig')

  const nasty = {
    AGENT_NAME: 'chunsik',
    DISPLAY_NAME: '춘식이 "the agent" $HOME 백틱`테스트` back\\slash',
    PRIMARY_TASK: '매일 아침 브리핑, and $PATH stays literal',
    MODEL: 'deepseek-v4-pro:cloud',
  }
  const text = Object.entries(nasty).map(([k, v]) => `${k}=${shellQuote(v)}`).join('\n') + '\n'
  const parsed = parseAgentConfig(text)
  for (const [k, v] of Object.entries(nasty)) {
    ok(`round-trip: ${k}`, parsed[k] === v, `got ${JSON.stringify(parsed[k])}`)
  }
  ok('unquoted setup.sh-style line still parses (AGENT_NAME=x)', parseAgentConfig('AGENT_NAME=plain\n').AGENT_NAME === 'plain')
  ok('non-KEY=VALUE noise lines are ignored', Object.keys(parseAgentConfig('# comment\n\nweird line\n')).length === 0)
}

// ── 5. failure marker ───────────────────────────────────────────────────────
console.log('\n-- failure marker (shape shared with channel.mjs writeFailureMarker)')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suptest-marker-'))
  const failfile = path.join(dir, '.agent-failed.json')
  writeFailureMarker(failfile, 'reason with "quotes" and\nnewline', { now: () => Date.UTC(2026, 6, 14, 1, 2, 3) })
  const parsed = JSON.parse(fs.readFileSync(failfile, 'utf8')) // throws = fail loud
  ok('marker parses as JSON with status/code/reason/since', parsed.status === 'failed' && parsed.code === 'crash_loop' && parsed.reason.includes('"quotes"') && parsed.since === '2026-07-14T01:02:03Z', JSON.stringify(parsed))
  ok('no .tmp debris left behind (atomic tmp+rename)', fs.readdirSync(dir).length === 1, fs.readdirSync(dir).join(','))
  clearFailureMarker(failfile)
  ok('clearFailureMarker removes it', !fs.existsSync(failfile))
  clearFailureMarker(failfile) // second clear on a missing file must not throw
  ok('clearing a missing marker is a no-op', true)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 6. identity check (Bug-1 class: stale/recycled pids) ───────────────────
console.log('\n-- isOurSupervisor: never trust, never force-kill an unverified pid')
{
  const SIG = '/some/install/supervisor.mjs __loop'
  const alive = process.pid // a real, live pid -- ours
  ok('contiguous signature match -> verified',
    isOurSupervisor(alive, { signature: SIG, readCommandLine: () => `node ${SIG}` }) === true)
  ok('recycled pid whose argv merely mentions both tokens separately -> NOT verified (Fix-B class)',
    isOurSupervisor(alive, { signature: SIG, readCommandLine: () => 'vim /some/install/supervisor.mjs notes about __loop' }) === false)
  ok('empty ps output -> NOT verified (fail safe)',
    isOurSupervisor(alive, { signature: SIG, readCommandLine: () => '' }) === false)
  ok('ps lookup throwing -> NOT verified (fail safe)',
    isOurSupervisor(alive, { signature: SIG, readCommandLine: () => { throw new Error('boom') } }) === false)
  ok('dead pid -> NOT verified without even reading a command line',
    isOurSupervisor(999999999, { signature: SIG, readCommandLine: () => { throw new Error('must not be called') } }) === false)
  ok('null/garbage pid -> NOT verified', isOurSupervisor(null) === false && isOurSupervisor(0) === false)
}
{
  // Upgrade hazard: an install coming from <=0.2.20 can still have a LIVE
  // `bash run.sh __loop` supervisor on this PIDFILE. Calling it stale would
  // delete the pidfile out from under a running agent and let the next start
  // double-spawn onto one Discord token. It is LEGACY: recognized, stoppable,
  // never adopted as ours.
  const SIG = '/some/install/supervisor.mjs __loop'
  const alive = process.pid
  ok("live 0.2.x bash supervisor -> 'legacy_supervisor', never 'stale'",
    classifyPidfileOwner(alive, { signature: SIG, readCommandLine: () => '/bin/bash /Applications/S.app/Contents/Resources/app.asar.unpacked/run.sh __loop' }) === 'legacy_supervisor')
  ok("our own signature -> 'ours'",
    classifyPidfileOwner(alive, { signature: SIG, readCommandLine: () => `node ${SIG}` }) === 'ours')
  ok("recycled pid (unrelated argv) -> 'stale'",
    classifyPidfileOwner(alive, { signature: SIG, readCommandLine: () => 'vim notes.txt' }) === 'stale')
  ok("dead pid -> 'stale'", classifyPidfileOwner(999999999, { signature: SIG }) === 'stale')
}

// ── 6b. main.cjs seam source pins (the ONE lane) ───────────────────────────
console.log('\n-- main.cjs seam: one launcher, one stopper, one signature')
{
  // main.cjs is Electron-main and cannot be unit-imported here; these pins
  // keep the three seam points (spawn / stop / identity) from drifting apart.
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  // design-0023 P3: the lane SELECTOR is gone, not merely defaulted. A
  // reintroduced env switch is a second lane by another name.
  ok('no SUPERVISOR_LANE selector survives', !mainSrc.includes('SUPERVISOR_LANE ='))
  ok('no BASH_BIN / run.sh launcher constants survive',
    !mainSrc.includes('BASH_BIN') && !mainSrc.includes('RUN_SH_PATH'))
  ok('every platform spawns supervisor.mjs under ELECTRON_RUN_AS_NODE, detached',
    /spawn\(process\.execPath, \[SUPERVISOR_MJS_PATH, '__loop'\], \{[\s\S]*?ELECTRON_RUN_AS_NODE: '1'[\s\S]*?detached: true/.test(mainSrc))
  ok('the spawn is NOT platform-branched (one lane, not a win32 fork)',
    (mainSrc.match(/SUPERVISOR_MJS_PATH, '__loop'/g) || []).length === 1)
  // Upgrade path: an install coming from <=0.2.20 can still have a live bash
  // supervisor on this PIDFILE. Recognizing it is what stops a double-spawn
  // onto one Discord token; spawning one is what must never happen again.
  ok('identity recognizes our signature AND a leftover 0.2.x bash supervisor',
    mainSrc.includes('SUPERVISOR_SIGNATURE') && mainSrc.includes("LEGACY_BASH_SIGNATURE = 'run.sh __loop'"))
  ok('nothing can SPAWN the legacy lane (recognition only)',
    !/spawn\([^)]*LEGACY_BASH_SIGNATURE/.test(mainSrc) && !mainSrc.includes("'/bin/bash'"))
  ok('the stop path is the supervisor on every platform (no lane router left)',
    mainSrc.includes('function supervisorStopCommand') &&
    /args: \[SUPERVISOR_MJS_PATH, 'stop'\]/.test(mainSrc) &&
    !mainSrc.includes("args: [RUN_SH_PATH, 'stop']"))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok('supervisor.mjs ships (build.files)', pkg.build.files.includes('supervisor.mjs'))
  ok('supervisor.mjs is a REAL file on disk (asarUnpack) -- plain node cannot read inside app.asar',
    pkg.build.asarUnpack.includes('supervisor.mjs'))
  ok('run.sh is out of build.files and asarUnpack (the payload followed the deletion)',
    !pkg.build.files.includes('run.sh') && !pkg.build.asarUnpack.includes('run.sh'))
}

// ── 8. runLoop ladder attacks: REAL loop, fake child + fake clock ───────────
console.log('\n-- runLoop: fake child (scripted exits) + fake clock (ladder only)')

function makeLoopHarness({ baseMs, script }) {
  // Mock inventory: `now` stands in for Date.now (the ladder measures uptime
  // and KST dates through it); `sleep` stands in for the backoff sleep and
  // ADVANCES the fake clock; `spawnChild` stands in for the pty child -- each
  // scripted step advances the clock by its runSec (the child's lifetime)
  // and can plant the stopflag to end the loop. installSignalHandler is a
  // no-op: signal semantics get the REAL integration test below.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suptest-loop-'))
  const cfg = {
    mem: dir,
    pidfile: path.join(dir, '.agent.pid'),
    logfile: path.join(dir, 'logs', 'agent.log'),
    stopflag: path.join(dir, '.stop_requested'),
    failfile: path.join(dir, '.agent-failed.json'),
    agentName: 'suptest',
    pkillPattern: '--name suptest',
    sessionTimeoutSec: 43200,
  }
  let t = baseMs
  const sleeps = []
  const steps = [...script]
  const deps = {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms },
    log: () => {},
    sweepOrphans: () => {},
    installSignalHandler: () => {},
    spawnChild: () => {
      const step = steps.shift()
      if (!step) throw new Error('script exhausted -- loop ran longer than the attack expected')
      t += step.runSec * 1000
      if (step.thenStop) fs.writeFileSync(cfg.stopflag, '')
      return { pid: 1, kill: () => {}, exited: Promise.resolve({ exitCode: step.exitCode ?? 1, signal: null }) }
    },
  }
  return { cfg, deps, sleeps, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const NOON_KST = Date.UTC(2026, 6, 14, 3, 0, 0) // 12:00 KST -- far from rollover

{
  // Attack: three quick crashes escalate the ladder AND write the marker.
  const h = makeLoopHarness({
    baseMs: NOON_KST,
    script: [{ runSec: 1 }, { runSec: 1 }, { runSec: 1 }, { runSec: 1, thenStop: true }],
  })
  fs.writeFileSync(h.cfg.failfile, 'stale from a previous life')
  await runLoop(h.cfg, h.deps)
  ok('fresh loop start cleared the stale marker before any crash could be blamed', !fs.existsSync(h.cfg.failfile) || JSON.parse(fs.readFileSync(h.cfg.failfile, 'utf8')).code === 'crash_loop')
  ok('two quick crashes escalate 5s -> 10s, third hits 20s', h.sleeps.slice(0, 3).join(',') === '5000,10000,20000', h.sleeps.join(','))
  const marker = JSON.parse(fs.readFileSync(h.cfg.failfile, 'utf8'))
  ok('3 quick fails wrote the crash-loop marker with the current count', marker.reason.includes('restarted 3 times quickly'), marker.reason)
  ok('marker records the real exit code honestly (verdict 2: recorded, not branched on)', marker.reason.includes('exit code 1'), marker.reason)
  ok('stop path removed stopflag + pidfile', !fs.existsSync(h.cfg.stopflag) && !fs.existsSync(h.cfg.pidfile))
  h.cleanup()
}
{
  // Attack: a fresh .shutdown-request HOLDS the spawn loop instead of feeding
  // children into the quit shredder (live 2026-08-05 02:01: every respawn
  // during the 75s grace window re-processed the shutdown turn and died,
  // reading as "무한부팅"). Freshness-capped: once the marker is older than
  // 5min on the loop's own clock, spawning resumes (crash-leftover marker
  // must not freeze a boot).
  const h = makeLoopHarness({
    baseMs: NOON_KST,
    script: [{ runSec: 400 }, { runSec: 400, thenStop: true }],
  })
  const req = path.join(h.cfg.mem, '.shutdown-request')
  fs.writeFileSync(req, '{"requested_at":"test"}')
  fs.utimesSync(req, NOON_KST / 1000, NOON_KST / 1000) // fresh on the FAKE clock
  await runLoop(h.cfg, h.deps)
  const holds = h.sleeps.filter((ms) => ms === 500).length
  ok('spawn loop held in 500ms polls while the request was fresh, then resumed at the 5min cap',
    holds >= 595 && holds <= 605, `holds=${holds}`)
  // exactly one backoff sleep = child1 exited AND the loop went around to
  // spawn child2 (whose thenStop ends the loop BEFORE its own backoff) —
  // proves the hold released into a live loop, not an abort.
  ok('both scripted children still ran after the hold (loop resumed, not aborted)', h.sleeps.length === holds + 1, String(h.sleeps.length))
  h.cleanup()
}
{
  // Attack: a 301s run RESETS the ladder and clears the marker; the next
  // quick crash starts back at 5s (without the reset it would be 40s).
  const h = makeLoopHarness({
    baseMs: NOON_KST,
    script: [{ runSec: 1 }, { runSec: 1 }, { runSec: 1 }, { runSec: 301 }, { runSec: 1 }, { runSec: 1, thenStop: true }],
  })
  await runLoop(h.cfg, h.deps)
  ok('301s uptime resets the count (post-reset crash sleeps 5s, not 40s)', h.sleeps.join(',') === '5000,10000,20000,5000,5000', h.sleeps.join(','))
  ok('301s uptime cleared the crash-loop marker', !fs.existsSync(h.cfg.failfile))
  h.cleanup()
}
{
  // Attack: a 300s run is NOT enough -- run.sh's guard is strictly `-gt 300`.
  const h = makeLoopHarness({
    baseMs: NOON_KST,
    script: [{ runSec: 1 }, { runSec: 300 }, { runSec: 1, thenStop: true }],
  })
  await runLoop(h.cfg, h.deps)
  ok('exactly-300s uptime does NOT reset (strict >300, run.sh:387)', h.sleeps.join(',') === '5000,10000', h.sleeps.join(','))
  h.cleanup()
}
{
  // Attack: KST rollover resets the COUNT but leaves the failure marker
  // (verdict 6 asymmetry: a new day resets patience, it does not fix a bad
  // token). Base 23:59:30 KST; the third crash's 20s backoff crosses
  // midnight. The 4th (post-midnight) crash proves the reset via its 5s
  // sleep -- it must be a SEPARATE step from the stop child, because the
  // stop child exits at the post-exit check and never reaches its sleep
  // (first run of this test welded them together and lost the receipt).
  const h = makeLoopHarness({
    baseMs: Date.UTC(2026, 6, 14, 14, 59, 30), // 23:59:30 KST
    script: [{ runSec: 1 }, { runSec: 1 }, { runSec: 1 }, { runSec: 1 }, { runSec: 1, thenStop: true }],
  })
  await runLoop(h.cfg, h.deps)
  ok('rollover reset the ladder (post-midnight crash sleeps 5s, not 40s)', h.sleeps.join(',') === '5000,10000,20000,5000', h.sleeps.join(','))
  ok('rollover did NOT clear the failure marker (asymmetric on purpose)', fs.existsSync(h.cfg.failfile))
  ok('sanity: the clock really did cross a local date boundary', localDate(h.deps.now()) === '2026-07-15', localDate(h.deps.now()))
  h.cleanup()
}
{
  // Attack: STOPFLAG already present -> the loop exits BEFORE ever spawning.
  const h = makeLoopHarness({ baseMs: NOON_KST, script: [] })
  fs.writeFileSync(h.cfg.stopflag, '')
  fs.writeFileSync(h.cfg.pidfile, '12345\n')
  await runLoop(h.cfg, h.deps) // script is empty: any spawn would throw
  ok('pre-existing stopflag exits cleanly with zero spawns', true)
  ok('stopflag and pidfile both removed on that path', !fs.existsSync(h.cfg.stopflag) && !fs.existsSync(h.cfg.pidfile))
  h.cleanup()
}
{
  // Attack: spawn itself exploding (bad CLAUDE_BIN / missing native module)
  // must feed the ladder + marker, not kill the loop (fail_loud).
  const h = makeLoopHarness({ baseMs: NOON_KST, script: [] })
  let calls = 0
  h.deps.spawnChild = () => {
    calls++
    if (calls >= 4) fs.writeFileSync(h.cfg.stopflag, '')
    throw new Error('posix_spawnp failed')
  }
  await runLoop(h.cfg, h.deps)
  ok('spawn failures ride the ladder instead of crashing the loop', h.sleeps.join(',') === '5000,10000,20000', `${h.sleeps.join(',')} (calls=${calls})`)
  const marker = JSON.parse(fs.readFileSync(h.cfg.failfile, 'utf8'))
  ok('spawn failure surfaces in the marker with exit code 127', marker.reason.includes('exit code 127'), marker.reason)
  h.cleanup()
}

// ── 9. integration: REAL __loop, real pty child, real signals (mac only) ────
console.log('\n-- integration: real supervisor process (signal reap + session timeout)')
if (process.platform === 'win32') {
  console.log('  SKIP  posix integration tests on win32 -- the win lanes carry their own UNVERIFIED flags in supervisor.mjs; NOT a pass')
} else {
  const itDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suptest-int-'))
  const mem = path.join(itDir, 'mem')
  fs.mkdirSync(mem, { recursive: true })
  const childPidFile = path.join(itDir, 'child.pid')
  // The fake agent: stands in for the claude CLI. Writes its pid, announces
  // itself, then exec's into a long sleep (exec so the TERM lands on THIS
  // pid, not a wrapper shell).
  const fakeBin = path.join(itDir, 'fake-claude.sh')
  fs.writeFileSync(fakeBin, `#!/bin/sh\necho $$ > "${childPidFile}"\necho SUPTEST_CHILD_UP\nexec sleep 1000\n`)
  fs.chmodSync(fakeBin, 0o755)
  const configFile = path.join(itDir, '.agent-config')
  // LANE_KIND=headless: the fake agent stands in for the claude CLI, which
  // only the legacy escape-hatch lane execs (0.2.2 default is dsh-lane,
  // which ignores CLAUDE_BIN entirely). Signal/timeout semantics under test
  // are lane-independent -- the spawn/kill contract is shared.
  fs.writeFileSync(configFile, `AGENT_NAME=suptest-${process.pid}\nCLAUDE_BIN=${fakeBin}\nAGENT_DATA_HOME=${mem}\nMODEL=fake-model\nLANE_KIND=headless\n`)

  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

  // 9a. TERM to the supervisor kills the pty child before exit (verdict 7).
  {
    const sup = trackSup(spawn(process.execPath, [path.join(ROOT, 'supervisor.mjs'), '__loop'],
      { env: { ...process.env, AGENT_CONFIG_FILE: configFile }, stdio: ['ignore', 'pipe', 'pipe'] }))
    let out = ''
    sup.stdout.on('data', (d) => { out += d })
    sup.stderr.on('data', (d) => { out += d })
    try {
      await waitFor(() => fs.existsSync(childPidFile), 10_000, 'fake child to start')
      const childPid = parseInt(fs.readFileSync(childPidFile, 'utf8').trim(), 10)
      ok('real pty child is alive under the supervisor', pidAlive(childPid))
      sup.kill('SIGTERM')
      const supExited = new Promise((r) => sup.on('exit', r))
      await Promise.race([supExited, new Promise((_, rej) => setTimeout(() => rej(new Error('supervisor did not exit on TERM')), 15_000))])
      await waitFor(() => !pidAlive(childPid), 12_000, 'child to be reaped')
      ok('TERM to the supervisor reaped the child (no orphan) before exiting', !pidAlive(childPid))
      ok('supervisor logged the signal exit', out.includes('signal received, exiting loop'), out.slice(-300))
    } catch (err) {
      ok('signal integration test', false, err.message)
      try { sup.kill('SIGKILL') } catch {}
    }
    fs.rmSync(childPidFile, { force: true })
  }

  // 9b. SESSION_TIMEOUT terminates a stuck-but-alive child; stopflag then
  // ends the loop at the post-exit check.
  {
    fs.appendFileSync(configFile, 'SESSION_TIMEOUT=2\n')
    const sup = trackSup(spawn(process.execPath, [path.join(ROOT, 'supervisor.mjs'), '__loop'],
      { env: { ...process.env, AGENT_CONFIG_FILE: configFile }, stdio: ['ignore', 'pipe', 'pipe'] }))
    let out = ''
    sup.stdout.on('data', (d) => { out += d })
    // Attach the exit listener NOW: the supervisor exits ~0.2s after the
    // child dies, and this test only looks up after observing the child's
    // death -- a listener attached that late watches an event that already
    // fired and times out forever (first run of this test convicted the
    // LOOP for exactly that; the loop was innocent).
    const supExited = new Promise((r) => sup.on('exit', r))
    try {
      await waitFor(() => fs.existsSync(childPidFile), 10_000, 'fake child to start (round 2)')
      const childPid = parseInt(fs.readFileSync(childPidFile, 'utf8').trim(), 10)
      fs.writeFileSync(path.join(mem, '.stop_requested'), '') // end loop after the timeout kill
      await waitFor(() => !pidAlive(childPid), 15_000, 'session timeout to kill the child')
      ok('session timeout killed the stuck child', !pidAlive(childPid))
      await Promise.race([supExited, new Promise((_, rej) => setTimeout(() => rej(new Error('loop did not honor stopflag after timeout kill')), 15_000))])
      ok('loop honored the stopflag at the post-exit check', out.includes('stop requested, exiting'), out.slice(-300))
      ok('session timeout was logged', out.includes('session timeout'), out.slice(-300))
    } catch (err) {
      ok('session-timeout integration test', false, err.message)
      try { sup.kill('SIGKILL') } catch {}
    }
  }

  fs.rmSync(itDir, { recursive: true, force: true })
}

// ── node shim for the hook lane (v0.0.15 Root A) ────────────────────────────
// Attack: the shim must (a) actually run .mjs when `node` is absent from
// PATH, (b) never shadow a real node (append semantics), (c) fail soft when
// the write is impossible, (d) be idempotent across spawns.
console.log('\n-- ensureNodeShim: hook-lane node absence (teardown Root A)')
if (!process.platform.startsWith('win')) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-test-'))
  const cfg = { mem: shimDir }

  // (a) absence: PATH without node -> shim dir appended, shim executes a .mjs
  {
    const noNodePath = '/usr/bin:/bin' // macOS system dirs; node is not stock there
    const patched = ensureNodeShim(cfg, { env: { PATH: noNodePath } })
    ok('shim dir appended when PATH lacks node', patched === `${noNodePath}:${path.join(shimDir, 'bin')}`, patched)
    const shimPath = path.join(shimDir, 'bin', 'node')
    ok('shim file exists and is executable', fs.existsSync(shimPath) && (fs.statSync(shimPath).mode & 0o111) !== 0)
    const probe = path.join(shimDir, 'probe.mjs')
    fs.writeFileSync(probe, 'console.log("shim-ran-" + (1 + 1))\n')
    // The hook reality: /bin/sh -c "node <script>" with the patched PATH.
    const outText = execFileSync('/bin/sh', ['-c', `node ${JSON.stringify(probe)}`], {
      env: { PATH: patched }, encoding: 'utf8',
    })
    ok('sh -c "node script.mjs" runs through the shim', outText.includes('shim-ran-2'), outText.trim())
  }

  // (b) append, not prepend: a PATH that already resolves node is extended at
  // the END, so the real node keeps winning; and a PATH already containing
  // the shim dir is returned unchanged (idempotent across respawns).
  {
    const patched = ensureNodeShim(cfg, { env: { PATH: '/usr/bin:/bin' } })
    const again = ensureNodeShim(cfg, { env: { PATH: patched } })
    ok('re-run with shim already on PATH is a no-op', again === patched, again)
    ok('shim dir sits at the END of PATH', patched.endsWith(path.join(shimDir, 'bin')))
  }

  // (c) fail-soft: unwritable MEM must return the original PATH and log, not throw
  {
    const lines = []
    const badCfg = { mem: path.join(shimDir, 'probe.mjs') } // a FILE, mkdir fails
    const patched = ensureNodeShim(badCfg, { env: { PATH: '/usr/bin:/bin' }, log: (l) => lines.push(l) })
    ok('unwritable shim dir fails soft with original PATH', patched === '/usr/bin:/bin', patched)
    ok('fail-soft is loud (logged)', lines.some((l) => l.includes('node shim write failed')), lines.join('|'))
  }

  // (d) regeneration: a stale shim pointing at a dead binary is rewritten
  {
    const shimPath = path.join(shimDir, 'bin', 'node')
    fs.writeFileSync(shimPath, '#!/bin/sh\nexec "/dead/binary" "$@"\n')
    ensureNodeShim(cfg, { env: { PATH: '/usr/bin:/bin' } })
    ok('stale shim content is regenerated at spawn', fs.readFileSync(shimPath, 'utf8').includes(process.execPath))
  }

  // (e) spark F4: a MEM containing the PATH delimiter must refuse loudly,
  // never ship a PATH that tokenizes wrong for the whole child env
  {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-evil:colon-'))
    const lines = []
    const patched = ensureNodeShim({ mem: evil }, { env: { PATH: '/usr/bin:/bin' }, log: (l) => lines.push(l) })
    ok('delimiter-poisoned MEM leaves PATH untouched', patched === '/usr/bin:/bin', patched)
    ok('...and says so', lines.some((l) => l.includes('PATH delimiter')), lines.join('|'))
    fs.rmSync(evil, { recursive: true, force: true })
  }

  fs.rmSync(shimDir, { recursive: true, force: true })
}

// ── stall/thrash watchdog (v0.0.15 Root B) ──────────────────────────────────
// Attacks mirror the live incident shapes: 429-min pending-inbound stall,
// synthetic-error terminal state, and the false-positive lanes the watchdog
// must NOT fire on (idle agent, parse doubt, previous-era transcript).
console.log('\n-- stall watchdog: transcript tail verdicts (teardown Root B)')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-test-'))
  const T0 = Date.parse('2026-07-15T00:00:00Z')
  const STALL_MS = 900_000
  const entry = (type, tsOffsetMs, extra = {}) =>
    JSON.stringify({ type, timestamp: new Date(T0 + tsOffsetMs).toISOString(), ...extra })
  const writeTranscript = (name, lines) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, lines.join('\n') + '\n')
    return f
  }
  const nowAt = (offsetMs) => () => T0 + offsetMs

  if (process.platform === 'win32') {
    // 2026-08-01 magi-win first run: these two assert the POSIX munge rule
    // with POSIX fixtures; win path.resolve prefixes a drive letter
    // ('C:\...' -> 'C--Users-...'), so they test node's win path handling,
    // not the munge. The full transcriptDirFor (realpathSync + join) is still
    // only exercisable on win32; the munge RULE itself is now pinned
    // platform-neutrally below against the verified magi-win receipt.
    console.log('  SKIP  posix-fixture transcriptDirFor munge tests on win32 -- see the platform-neutral munge-rule pin below')
  } else {
    ok('transcriptDirFor munges cwd the way Claude Code does',
      transcriptDirFor('/Users/cto/Documents/Scheherazade', '/Users/cto')
        .endsWith(path.join('.claude', 'projects', '-Users-cto-Documents-Scheherazade')))
    // Melchior counter-receipt: '_' and '.' are ALSO munged to '-' by the CLI
    // (raw: ~/Documents/MAGI_Memory -> -Users-narr-Documents-MAGI-Memory).
    ok('underscore and dot munge to dashes like the CLI does',
      transcriptDirFor('/Users/x/My_Agent.data', '/h')
        .endsWith(path.join('.claude', 'projects', '-Users-x-My-Agent-data')))
  }
  // Windows munge receipt (magi-win 2026-08-13): the CLI turned DATA_HOME
  // C:\Users\minom\Documents\Scheherazade into the project dir
  // C--Users-minom-Documents-Scheherazade -- exactly transcriptDirFor's
  // `[^a-zA-Z0-9] -> '-'` rule (the drive colon and each backslash become a
  // dash). The Windows watchdog is now ON on the strength of this; pin the
  // rule itself, platform-neutrally, so a regex tweak cannot silently
  // re-break the path the watchdog watches.
  ok('Windows munge rule matches the magi-win receipt',
    'C:\\Users\\minom\\Documents\\Scheherazade'.replace(/[^a-zA-Z0-9]/g, '-')
      === 'C--Users-minom-Documents-Scheherazade')
  // spark F1: a trailing slash must not mint a different (never-written)
  // watch dir -- that fails quiet, the silent-detector class itself.
  // (platform-neutral: compares two calls, no posix fixture expectation)
  ok('trailing slash resolves to the same watch dir',
    transcriptDirFor('/Users/cto/Documents/Scheherazade/', '/Users/cto') ===
    transcriptDirFor('/Users/cto/Documents/Scheherazade', '/Users/cto'))
  // spark F1: symlinked MEM watches the CLI's REAL cwd munge
  {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'real-mem-'))
    const link = `${real}-link`
    fs.symlinkSync(real, link)
    ok('symlinked MEM resolves to the real path munge',
      transcriptDirFor(link, '/h') === transcriptDirFor(real, '/h'))
    fs.unlinkSync(link); fs.rmSync(real, { recursive: true, force: true })
  }

  const TH = { userStallMs: 2 * STALL_MS, syntheticStallMs: STALL_MS } // S1 asymmetric shape

  // (a) the 429-min shape: last entry is a delivered user message, no turn
  // after. S1: the user lane waits 2x the synthetic lane.
  {
    const f = writeTranscript('a.jsonl', [
      entry('assistant', 0, { message: { model: 'glm-5.2' } }),
      entry('user', 60_000),
    ])
    const tail = readTranscriptTail(f, { now: nowAt(60_000 + 2 * STALL_MS + 1000) })
    ok('pending-inbound stall detected past the 2x user window', stallVerdict(tail, TH) === 'pending inbound with no turn', JSON.stringify(tail))
    const between = readTranscriptTail(f, { now: nowAt(60_000 + STALL_MS + 1000) })
    ok('user tail between 1x and 2x is NOT yet a stall (long-turn margin)', stallVerdict(between, TH) === null)
    const young = readTranscriptTail(f, { now: nowAt(120_000) })
    ok('same tail under the window is NOT a stall', stallVerdict(young, TH) === null)
  }

  // (a2) S1: a user tail that is a tool_result names the mid-turn-death shape
  {
    const f = writeTranscript('a2.jsonl', [
      entry('user', 60_000, { message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    ])
    const tail = readTranscriptTail(f, { now: nowAt(60_000 + 2 * STALL_MS + 1000) })
    ok('tool_result tail is classified as mid-turn death', stallVerdict(tail, TH) === 'mid-turn death (tool_result tail)', JSON.stringify(tail))
  }

  // (b) thrash terminal state: last entry is the CLI's synthetic error --
  // fires at 1x, the tighter synthetic window
  {
    const f = writeTranscript('b.jsonl', [
      entry('user', 0),
      entry('assistant', 30_000, { message: { model: '<synthetic>', content: [{ type: 'text', text: 'Autocompact is thrashing: the context refilled to the limit' }] } }),
    ])
    const tail = readTranscriptTail(f, { now: nowAt(30_000 + STALL_MS + 1000) })
    ok('synthetic-error terminal stall detected at 1x', String(stallVerdict(tail, TH)).includes('synthetic'), JSON.stringify(tail))
  }

  // (c) idle agent: old NORMAL assistant tail must never bounce
  {
    const f = writeTranscript('c.jsonl', [
      entry('user', 0),
      entry('assistant', 30_000, { message: { model: 'glm-5.2' } }),
    ])
    const tail = readTranscriptTail(f, { now: nowAt(30_000 + 10 * STALL_MS) })
    ok('idle agent (old assistant tail) is NOT a stall', stallVerdict(tail, TH) === null, JSON.stringify(tail))
  }

  // (d) parse doubt fails safe: garbage tail = no verdict, no throw
  {
    const f = path.join(dir, 'd.jsonl')
    fs.writeFileSync(f, 'not json at all\n{"broken": \n')
    const tail = readTranscriptTail(f, { now: nowAt(STALL_MS * 2) })
    ok('unparseable transcript yields no verdict', tail === null || stallVerdict(tail, TH) === null)
    ok('missing file yields no verdict', readTranscriptTail(path.join(dir, 'nope.jsonl')) === null)
  }

  // (d2) G2: synthetic-entry counting from the transcript (the structural
  // replacement for the pty substring lane -- a grep of this source file in a
  // tool_result can never mint model:'<synthetic>')
  {
    const f = writeTranscript('d2.jsonl', [
      entry('assistant', 0, { message: { model: '<synthetic>' } }),          // before the count window
      entry('assistant', 100_000, { message: { model: '<synthetic>' } }),
      entry('user', 110_000, { message: { content: [{ type: 'tool_result', content: 'grep: Autocompact is thrashing x100' }] } }),
      entry('assistant', 120_000, { isApiErrorMessage: true }),
      entry('assistant', 130_000, { message: { model: '<synthetic>' } }),
    ])
    const scan = readTranscriptTail(f, { now: nowAt(140_000), countSyntheticSince: 90_000 + T0 })
    ok('synthetic entries counted only inside the window', scan.syntheticCount === 3, JSON.stringify(scan))
    ok('tool_result text mentioning the error is NOT counted', scan.syntheticCount === 3)
    const all = readTranscriptTail(f, { now: nowAt(140_000), countSyntheticSince: T0 - 1 })
    ok('window widened catches the earlier synthetic too', all.syntheticCount === 4)
    const off = readTranscriptTail(f, { now: nowAt(140_000) })
    ok('counting off by default', off.syntheticCount === 0)
  }

  // (e) newestTranscript picks by mtime, ignores non-jsonl
  {
    const sub = path.join(dir, 'pick')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'noise.txt'), 'x')
    const older = path.join(sub, 'old.jsonl')
    const newer = path.join(sub, 'new.jsonl')
    fs.writeFileSync(older, '{}\n')
    fs.writeFileSync(newer, '{}\n')
    fs.utimesSync(older, new Date(T0), new Date(T0))
    fs.utimesSync(newer, new Date(T0 + 5000), new Date(T0 + 5000))
    ok('newestTranscript picks the newest jsonl', newestTranscript(sub) === newer)
    ok('newestTranscript on a missing dir is null', newestTranscript(path.join(sub, 'ghost')) === null)
  }

  // (e2) G1 era binding: eraStart filters by file CREATION, so a shared
  // project dir full of other sessions' files cannot capture the watchdog.
  // birthtime cannot be faked backward, so the two directions are driven by
  // placing eraStart around the real creation instant.
  {
    const sub = path.join(dir, 'era')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 's.jsonl'), '{}\n')
    ok('file born before eraStart is excluded (prior generation)',
      newestTranscript(sub, { eraStart: Date.now() + 3600_000 }) === null)
    ok('file born after eraStart is eligible (this era)',
      newestTranscript(sub, { eraStart: Date.now() - 3600_000 }) === path.join(sub, 's.jsonl'))
    ok('no eraStart keeps the legacy pick-newest behavior',
      newestTranscript(sub) === path.join(sub, 's.jsonl'))
    // admitName: our own resumed <id>.jsonl is admitted past the birthtime
    // gate that would otherwise blind the watchdog on the resume path, while a
    // foreign prior-era file with a different name stays excluded.
    ok('resumed session file is admitted by name despite an old birthtime',
      newestTranscript(sub, { eraStart: Date.now() + 3600_000, admitName: 's.jsonl' }) === path.join(sub, 's.jsonl'))
    ok('a DIFFERENT prior-era file is still excluded (foreign hole not widened)',
      newestTranscript(sub, { eraStart: Date.now() + 3600_000, admitName: 'someone-else.jsonl' }) === null)
  }

  // (f) tail window: entry buried past the tail window is still found via
  // the LAST parseable line, and a first-line cut by the window is skipped
  {
    const bigPad = entry('user', 0, { message: { content: 'x'.repeat(300_000) } })
    const f = writeTranscript('f.jsonl', [bigPad, entry('user', 60_000)])
    const tail = readTranscriptTail(f, { now: nowAt(60_000 + STALL_MS + 1000) })
    ok('tail window still parses the last entry of a huge file', tail !== null && tail.type === 'user', JSON.stringify(tail))
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── era guard arithmetic (createStallLane, extracted for exactly this) ──────
// The one line the whole anti-re-bounce-loop promise hangs on:
// `now() - tail.ageMs < spawnedAt`. Attack it directly.
console.log('\n-- stall lane: era guard + poll closure')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'era-test-'))
  const T0 = Date.parse('2026-07-15T00:00:00Z')
  const STALL_MS = 900_000
  const entry = (type, atMs) => JSON.stringify({ type, timestamp: new Date(atMs).toISOString() })
  const lane = (nowMs, spawnedAt, lines = []) =>
    createStallLane({ transcriptDir: dir, stallMs: STALL_MS, spawnedAt, now: () => nowMs, log: (l) => lines.push(l) })

  // previous-era stalled file: tail user entry at T0, child spawned LATER at
  // T0+2h -- aged way past the window, still must NOT bounce
  fs.writeFileSync(path.join(dir, 's.jsonl'), entry('user', T0) + '\n')
  ok('previous-era stalled tail never bounces a fresh child',
    lane(T0 + 3 * 3600_000, T0 + 2 * 3600_000)() === null)

  // same tail, child spawned BEFORE the entry -- this child's era, bounces
  // (past the 2x user window per S1)
  ok('current-era pending tail past the 2x window bounces',
    String(lane(T0 + 2 * STALL_MS + 60_000, T0 - 1000)()).includes('pending inbound'))

  // boundary: entry written in the same ms as spawn counts as this era
  ok('entry at exactly spawn time is this era',
    String(lane(T0 + 2 * STALL_MS + 60_000, T0)()).includes('pending inbound'))

  // G2 at lane level: 3 fresh synthetic entries trip the thrash verdict
  // immediately -- no 15-min wait
  fs.writeFileSync(path.join(dir, 's.jsonl'), [
    entry('assistant', T0 + 60_000) /* normal */,
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 100_000).toISOString(), message: { model: '<synthetic>' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 220_000).toISOString(), message: { model: '<synthetic>' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 340_000).toISOString(), message: { model: '<synthetic>' } }),
  ].join('\n') + '\n')
  ok('3 era-valid synthetic entries trip the thrash lane fast',
    String(lane(T0 + 400_000, T0)()).includes('autocompact thrash'), String(lane(T0 + 400_000, T0)()))
  // (the terminal-stall reason ALSO says "autocompact thrash shape", so the
  // discriminator is the early lane's "autocompact thrash:" prefix)
  {
    const r = String(lane(T0 + 100_000 + 1_800_000 + 1000, T0)())
    ok('narrowed window with only 2 era-valid synthetics never trips the EARLY thrash lane',
      !r.includes('autocompact thrash:') && r.includes('transcript stalled'), r)
  }

  // clock rewind / future-stamped tail: ageMs clamps to 0 -> under window -> null
  fs.writeFileSync(path.join(dir, 's.jsonl'), entry('user', T0 + 3600_000) + '\n')
  ok('future-stamped tail (clock skew) never bounces', lane(T0, T0 - 1000)() === null)

  // missing transcript dir: null verdict + exactly ONE log across many polls
  {
    const lines = []
    const p = createStallLane({ transcriptDir: path.join(dir, 'ghost'), stallMs: STALL_MS, spawnedAt: T0, now: () => T0, log: (l) => lines.push(l) })
    ok('no transcript -> no verdict', p() === null && p() === null && p() === null)
    ok('...and the fail-quiet log fires exactly once', lines.length === 1 && lines[0].includes('no this-era transcript yet'), String(lines.length))
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── bounce budget (review S2): outage flap guard ────────────────────────────
// A provider outage makes stall verdicts legitimate-but-wrong; unlimited
// bouncing burns a full session context per cycle. The ledger is shared
// across respawns, so a fresh child cannot reset the count.
console.log('\n-- bounce budget: outage flap guard')
{
  let t = 0
  const ledger = []
  const lines = []
  const consume = createBounceBudget({ ledger, budget: 3, windowMs: 6 * 3600_000, now: () => t, log: (l) => lines.push(l) })
  ok('first three bounces consume budget', consume('r1') === true && consume('r2') === true && consume('r3') === true)
  ok('fourth is refused', consume('r4') === false)
  ok('refusal is logged once and carries the verdict', lines.length === 1 && lines[0].includes('r4'), lines.join('|'))
  ok('repeated refusals do not spam the log', consume('r5') === false && lines.length === 1)
  t += 6 * 3600_000 + 1000
  ok('window expiry restores the budget', consume('r6') === true)

  // a NEW factory (fresh child after respawn) sharing the ledger continues
  // the count instead of starting clean
  const consume2 = createBounceBudget({ ledger, budget: 3, windowMs: 6 * 3600_000, now: () => t, log: () => {} })
  ok('fresh child inherits the shared ledger count',
    consume2('r7') === true && consume2('r8') === true && consume2('r9') === false, JSON.stringify(ledger))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
