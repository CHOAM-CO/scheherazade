// test-supervisor.mjs -- attacks on supervisor.mjs (Windows-port Phase 1).
// Run: node scripts/test-supervisor.mjs
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
import { fileURLToPath } from 'node:url'

import {
  AUTO_ANSWER_PATTERNS,
  AUTO_ANSWER_WINDOW_MS,
  createAutoAnswerMatcher,
  backoffFor,
  kstDate,
  parseAgentConfig,
  writeFailureMarker,
  clearFailureMarker,
  isOurSupervisor,
  classifyPidfileOwner,
  buildChildArgs,
  ensureNodeShim,
  transcriptDirFor,
  newestTranscript,
  readTranscriptTail,
  stallVerdict,
  createThrashCounter,
  THRASH_PATTERN,
  runLoop,
} from '../supervisor.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── 1. the auto-answer matcher ──────────────────────────────────────────────
console.log('\n-- matcher: the 5 verbatim prompts (run.sh:338-345)')
{
  for (const p of AUTO_ANSWER_PATTERNS) {
    const sent = []
    const m = createAutoAnswerMatcher({ send: (r) => sent.push(r), now: () => 0 })
    m.feed(`noise before ${p.pattern} noise after`)
    ok(`'${p.pattern}' fires exactly its response`, sent.length === 1 && sent[0] === p.response, JSON.stringify(sent))
  }
}
{
  // THE load-bearing quirk (run.sh:331-337, empirical 3/3 vs 2/2): the
  // API-key answer must be bare "1" -- a CR would independently select the
  // default "No" and corrupt the approval state.
  const apiKey = AUTO_ANSWER_PATTERNS.find((p) => p.pattern.includes('API key'))
  ok('API-key response contains NO carriage return', !apiKey.response.includes('\r'), JSON.stringify(apiKey.response))
  ok('API-key response is exactly "1"', apiKey.response === '1')
}
{
  const sent = []
  const m = createAutoAnswerMatcher({ send: (r) => sent.push(r), now: () => 0 })
  m.feed('tru')
  m.feed('st')
  ok('a pattern straddling two pty chunks still fires (buffer accumulates)', sent.length === 1 && sent[0] === '\r')
}
{
  // The one-shot window (verdict 4): a stray "trust" in ordinary session
  // output, arriving after the 25s window expired, must fire NOTHING -- and
  // the closure is permanent.
  let t = 0
  const sent = []
  const m = createAutoAnswerMatcher({ send: (r) => sent.push(r), now: () => t })
  t = AUTO_ANSWER_WINDOW_MS + 1
  m.feed('please trust this innocuous sentence')
  ok('pattern arriving AFTER window expiry fires nothing', sent.length === 0, JSON.stringify(sent))
  ok('matcher reports closed', m.closed === true)
  t = AUTO_ANSWER_WINDOW_MS + 2
  m.feed('trust again')
  ok('closure is permanent (second feed also fires nothing)', sent.length === 0)
}
{
  // A match RESETS the window (expect's exp_continue restarts its timeout).
  let t = 0
  const sent = []
  const m = createAutoAnswerMatcher({ send: (r) => sent.push(r), now: () => t })
  t = 20_000
  m.feed('trust')
  t = 44_000 // 24s after the match -- inside the reset window, 44s after open
  m.feed('confirm')
  ok('a match resets the 25s window (second prompt 24s later still fires)', sent.length === 2, JSON.stringify(sent))
}
{
  // exp_continue: multiple prompts in one buffer all get answered, in
  // stream-order via the discard-through-match rule.
  const sent = []
  const m = createAutoAnswerMatcher({ send: (r) => sent.push(r), now: () => 0 })
  m.feed('trust ... then later Do you want to use this API key')
  ok('two prompts in one chunk both fire (exp_continue loop)', sent.length === 2 && sent[0] === '\r' && sent[1] === '1', JSON.stringify(sent))
}
{
  // Listed-order priority (expect picks the first LISTED pattern that
  // matches, and discards the buffer through the END of that match --
  // 'trust' listed before the API-key pattern swallows an earlier API-key
  // prompt sitting before it in the same buffer). Replicated, not improved:
  // in real streams these dialogs never co-occur, and diverging from expect
  // here would be an untested semantic change.
  const sent = []
  const m = createAutoAnswerMatcher({ send: (r) => sent.push(r), now: () => 0 })
  m.feed('Do you want to use this API key ... trust')
  ok("listed-order priority: 'trust' (listed first) wins and its discard swallows the earlier prompt", sent.length === 1 && sent[0] === '\r', JSON.stringify(sent))
}

// ── 2. contract pin against run.sh (the source of the semantics) ───────────
console.log('\n-- contract pin: port table == run.sh table')
{
  // A copy of a rule is not the rule: if someone edits run.sh's expect
  // block, this section screams that the port's table diverged.
  const runSh = fs.readFileSync(path.join(ROOT, 'run.sh'), 'utf8')
  for (const p of AUTO_ANSWER_PATTERNS) {
    ok(`run.sh still carries pattern '${p.pattern}'`, runSh.includes(`"${p.pattern}"`))
  }
  ok('run.sh still answers the API-key prompt with bare send "1" (no \\r)',
    /-re "Do you want to use this API key" \{ send "1"; exp_continue \}/.test(runSh),
    'the load-bearing no-CR quirk changed in run.sh -- re-verify and update the port')
  ok('run.sh still opens a 25s window (set timeout 25)', runSh.includes('set timeout 25'))
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
  // Cross-lane hazard: a LIVE run.sh-lane supervisor on the shared PIDFILE
  // is FOREIGN, not stale -- treating it as stale would delete the pidfile
  // out from under a running agent and let the next start double-spawn onto
  // one Discord token.
  const SIG = '/some/install/supervisor.mjs __loop'
  const alive = process.pid
  ok("live run.sh supervisor -> 'foreign_supervisor', never 'stale'",
    classifyPidfileOwner(alive, { signature: SIG, readCommandLine: () => '/bin/bash /Applications/S.app/Contents/Resources/app.asar.unpacked/run.sh __loop' }) === 'foreign_supervisor')
  ok("our own signature -> 'ours'",
    classifyPidfileOwner(alive, { signature: SIG, readCommandLine: () => `node ${SIG}` }) === 'ours')
  ok("recycled pid (unrelated argv) -> 'stale'",
    classifyPidfileOwner(alive, { signature: SIG, readCommandLine: () => 'vim notes.txt' }) === 'stale')
  ok("dead pid -> 'stale'", classifyPidfileOwner(999999999, { signature: SIG }) === 'stale')
}

// ── 6b. main.cjs seam source pins (SUPERVISOR_LANE wiring) ─────────────────
console.log('\n-- main.cjs seam: SUPERVISOR_LANE wiring stays welded')
{
  // main.cjs is Electron-main and cannot be unit-imported here; these pins
  // keep the three seam points (spawn / stop routing / identity) from
  // silently drifting apart. The REAL proof is a full live session on the
  // node lane -- until then run.sh stays production (design doc).
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  ok('lane flag exists and defaults to bash', mainSrc.includes("=== 'node' ? 'node' : 'bash'"))
  ok('node lane spawns supervisor.mjs under ELECTRON_RUN_AS_NODE',
    mainSrc.includes("spawn(process.execPath, [SUPERVISOR_MJS_PATH, '__loop']") && mainSrc.includes("ELECTRON_RUN_AS_NODE: '1'"))
  ok('identity check recognizes BOTH lane signatures (lane-agnostic recognition)',
    mainSrc.includes('${RUN_SH_PATH} __loop') && mainSrc.includes('${SUPERVISOR_MJS_PATH} __loop'))
  ok('stop path routes by the LIVE supervisor lane (supervisorStopCommand)',
    mainSrc.includes('function supervisorStopCommand') && !/spawn\(BASH_BIN, \[RUN_SH_PATH, 'stop'\]/.test(mainSrc))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok('supervisor.mjs ships (build.files)', pkg.build.files.includes('supervisor.mjs'))
  ok('supervisor.mjs is a REAL file on disk (asarUnpack) -- plain node cannot read inside app.asar',
    pkg.build.asarUnpack.includes('supervisor.mjs'))
}

// ── 7. child argv mirrors the expect spawn line ─────────────────────────────
console.log('\n-- child argv (run.sh:319 order)')
{
  const base = { model: 'm1', agentName: 'a1', systemPromptFile: null }
  ok('without system prompt: --model m --name a --dangerously-skip-permissions --dangerously-load-development-channels server:agent-channel',
    buildChildArgs(base).join(' ') === '--model m1 --name a1 --dangerously-skip-permissions --dangerously-load-development-channels server:agent-channel',
    buildChildArgs(base).join(' '))
  const withPrompt = { ...base, systemPromptFile: '/mem/system_prompt.md' }
  ok('system prompt rides BEFORE the dangerously flags (extra_args position)',
    buildChildArgs(withPrompt).join(' ') === '--model m1 --name a1 --append-system-prompt-file /mem/system_prompt.md --dangerously-skip-permissions --dangerously-load-development-channels server:agent-channel',
    buildChildArgs(withPrompt).join(' '))
  ok("pkill discriminator '--name <agent>' is a contiguous substring of the argv",
    buildChildArgs(withPrompt).join(' ').includes('--name a1'))
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
  ok('sanity: the clock really did cross a KST date boundary', kstDate(h.deps.now()) === '2026-07-15', kstDate(h.deps.now()))
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
  fs.writeFileSync(configFile, `AGENT_NAME=suptest-${process.pid}\nCLAUDE_BIN=${fakeBin}\nAGENT_DATA_HOME=${mem}\nMODEL=fake-model\n`)

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
    const sup = spawn(process.execPath, [path.join(ROOT, 'supervisor.mjs'), '__loop'],
      { env: { ...process.env, AGENT_CONFIG_FILE: configFile }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const sup = spawn(process.execPath, [path.join(ROOT, 'supervisor.mjs'), '__loop'],
      { env: { ...process.env, AGENT_CONFIG_FILE: configFile }, stdio: ['ignore', 'pipe', 'pipe'] })
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

  ok('transcriptDirFor munges cwd the way Claude Code does',
    transcriptDirFor('/Users/cto/Documents/Scheherazade', '/Users/cto')
      .endsWith(path.join('.claude', 'projects', '-Users-cto-Documents-Scheherazade')))
  // spark F1: a trailing slash must not mint a different (never-written)
  // watch dir -- that fails quiet, the silent-detector class itself.
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

  // (a) the 429-min shape: last entry is a delivered user message, no turn after
  {
    const f = writeTranscript('a.jsonl', [
      entry('assistant', 0, { message: { model: 'glm-5.2' } }),
      entry('user', 60_000),
    ])
    const tail = readTranscriptTail(f, { now: nowAt(60_000 + STALL_MS + 1000) })
    ok('pending-inbound stall detected', stallVerdict(tail, STALL_MS) === 'pending inbound with no turn', JSON.stringify(tail))
    const young = readTranscriptTail(f, { now: nowAt(120_000) })
    ok('same tail under the window is NOT a stall', stallVerdict(young, STALL_MS) === null)
  }

  // (b) thrash terminal state: last entry is the CLI's synthetic error
  {
    const f = writeTranscript('b.jsonl', [
      entry('user', 0),
      entry('assistant', 30_000, { message: { model: '<synthetic>', content: [{ type: 'text', text: 'Autocompact is thrashing: the context refilled to the limit' }] } }),
    ])
    const tail = readTranscriptTail(f, { now: nowAt(30_000 + STALL_MS + 1000) })
    ok('synthetic-error terminal stall detected', String(stallVerdict(tail, STALL_MS)).includes('synthetic'), JSON.stringify(tail))
  }

  // (c) idle agent: old NORMAL assistant tail must never bounce
  {
    const f = writeTranscript('c.jsonl', [
      entry('user', 0),
      entry('assistant', 30_000, { message: { model: 'glm-5.2' } }),
    ])
    const tail = readTranscriptTail(f, { now: nowAt(30_000 + 10 * STALL_MS) })
    ok('idle agent (old assistant tail) is NOT a stall', stallVerdict(tail, STALL_MS) === null, JSON.stringify(tail))
  }

  // (d) parse doubt fails safe: garbage tail = no verdict, no throw
  {
    const f = path.join(dir, 'd.jsonl')
    fs.writeFileSync(f, 'not json at all\n{"broken": \n')
    const tail = readTranscriptTail(f, { now: nowAt(STALL_MS * 2) })
    ok('unparseable transcript yields no verdict', tail === null || stallVerdict(tail, STALL_MS) === null)
    ok('missing file yields no verdict', readTranscriptTail(path.join(dir, 'nope.jsonl')) === null)
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

console.log('\n-- thrash counter: early pty lane')
{
  let t = 0
  const counter = createThrashCounter({ now: () => t, windowMs: 1_800_000, threshold: 3, cooldownMs: 60_000 })
  ok('one sighting does not trip', counter.feed(`err: ${THRASH_PATTERN}: refilled`) === false)
  // redraw storm: same line repainted immediately must count ONCE
  ok('redraw storm within cooldown counts once', counter.feed(`${THRASH_PATTERN} ${THRASH_PATTERN}`) === false)
  t += 120_000
  ok('second real cycle does not trip', counter.feed(`${THRASH_PATTERN}`) === false)
  t += 120_000
  ok('third real cycle trips the bounce', counter.feed(`${THRASH_PATTERN}`) === true)

  // pattern split across pty chunks must still match
  const c2 = createThrashCounter({ now: () => 0, threshold: 1 })
  const split = THRASH_PATTERN.length >> 1
  c2.feed(THRASH_PATTERN.slice(0, split))
  ok('chunk-split pattern is still caught', c2.feed(THRASH_PATTERN.slice(split)) === true)

  // sightings outside the 30-min window expire
  let t3 = 0
  const c3 = createThrashCounter({ now: () => t3, windowMs: 1_800_000, threshold: 3, cooldownMs: 60_000 })
  c3.feed(THRASH_PATTERN); t3 += 1_900_000
  c3.feed(THRASH_PATTERN); t3 += 61_000
  ok('expired sightings do not accumulate to a trip', c3.feed(THRASH_PATTERN) === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
