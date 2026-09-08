// test-quit-sequencer.mjs -- the bounded app-quit path (quit-sequencer.cjs).
// Run: node tests/test-quit-sequencer.mjs
//
// The defect this covers is "SIGTERM and the app never exits" (live E2E
// 2026-09-08). A real Electron is needed to prove the SIGNAL wiring; what is
// hermetically testable -- and what actually broke -- is the state machine:
// does a quit ALWAYS reach exit(), with exactly one exit, no matter which step
// hangs, throws, or is entered twice. Every step here is a fake that hangs or
// explodes on purpose; nothing is demonstrated, everything is attacked.

import { createQuitSequencer } from '../quit-sequencer.cjs'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const never = () => new Promise(() => {}) // a step that hangs forever
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function harness(overrides = {}) {
  const calls = { exits: [], teardowns: 0, acks: 0, logs: [] }
  const seq = createQuitSequencer({
    log: (m) => calls.logs.push(String(m)),
    exit: (code) => calls.exits.push(code),
    graceMs: 60,
    teardownMs: 60,
    hardMs: 400,
    waitForAck: async () => { calls.acks++; return 'skipped' },
    teardown: async () => { calls.teardowns++ },
    ...overrides,
  })
  return { seq, calls }
}

// ── the happy path: the agent acks, teardown runs, exit(0) ─────────────────
console.log('\n-- ack path')
{
  const { seq, calls } = harness({ waitForAck: async () => 'acked' })
  const r = await seq.run('test')
  ok('ack path resolves with the ack status', r.ack === 'acked', JSON.stringify(r))
  ok('ack path ran teardown once', calls.teardowns === 1, String(calls.teardowns))
  ok('ack path exits 0 exactly once', calls.exits.length === 1 && calls.exits[0] === 0, JSON.stringify(calls.exits))
}

// ── the DEFECT: nothing ever acks. The grace window must expire, not wait ──
console.log('\n-- grace window: an ack that never comes')
{
  const { seq, calls } = harness({ waitForAck: never })
  const t0 = Date.now()
  const r = await seq.run('test')
  const ms = Date.now() - t0
  ok('a never-acking agent expires the grace window', r.ack === 'expired', JSON.stringify(r))
  ok('and does so at the grace deadline, not the hard one', ms < 300, `${ms}ms`)
  ok('teardown still ran', calls.teardowns === 1)
  ok('and the process still exits 0', calls.exits.length === 1 && calls.exits[0] === 0)
}

// ── a teardown that hangs must not hold the quit ──────────────────────────
console.log('\n-- teardown that never returns')
{
  const { seq, calls } = harness({ teardown: never })
  const t0 = Date.now()
  const r = await seq.run('test')
  const ms = Date.now() - t0
  ok('a hung teardown times out', r.teardown === 'timeout', JSON.stringify(r))
  ok('bounded by teardownMs, not the hard deadline', ms < 300, `${ms}ms`)
  ok('and the process still exits 0', calls.exits.length === 1 && calls.exits[0] === 0)
}

// ── throws in either phase are logged, never fatal to the quit ────────────
console.log('\n-- steps that throw')
{
  const { seq, calls } = harness({
    waitForAck: async () => { throw new Error('ack step exploded') },
    teardown: async () => { throw new Error('teardown exploded') },
  })
  const r = await seq.run('test')
  ok('a throwing grace step reports error, not a rejection', r.ack === 'error', JSON.stringify(r))
  ok('a throwing teardown reports error too', r.teardown === 'error', JSON.stringify(r))
  ok('and the quit still exits 0', calls.exits.length === 1 && calls.exits[0] === 0)
  ok('both throws were logged', calls.logs.filter((l) => l.includes('exploded')).length === 2,
    calls.logs.join(' | '))
}

// ── idempotence: an impatient second SIGTERM must not double-teardown ─────
console.log('\n-- re-entry (second signal, Cmd-Q on top of a signal, before-quit)')
{
  const { seq, calls } = harness({ waitForAck: async () => { await sleep(30); return 'acked' } })
  const a = seq.run('SIGTERM')
  const b = seq.run('SIGTERM again')
  const c = seq.run('before-quit')
  const [ra] = await Promise.all([a, b, c])
  ok('teardown ran exactly once across three entries', calls.teardowns === 1, String(calls.teardowns))
  ok('exit called exactly once', calls.exits.length === 1, JSON.stringify(calls.exits))
  ok('the joiners resolve on the first run', ra.reason === 'SIGTERM', JSON.stringify(ra))
  ok('isRunning() reports the sequence', seq.isRunning() === true)
  ok('hasExited() reports the exit', seq.hasExited() === true)
}

// ── the last-resort watchdog: every phase deadline defeated ───────────────
// Fake timers that only fire for the watchdog: the phase deadlines are handed
// a setTimer that drops them on the floor, which is the "a blocked step also
// defeated its own timeout" case the hard deadline exists for.
console.log('\n-- hard watchdog when the phase deadlines themselves fail')
{
  const calls = { exits: [], logs: [] }
  let watchdogFn = null
  const seq = createQuitSequencer({
    log: (m) => calls.logs.push(String(m)),
    exit: (code) => calls.exits.push(code),
    graceMs: 1000,
    teardownMs: 1000,
    hardMs: 5000,
    waitForAck: never,
    teardown: never,
    // The FIRST timer armed by a run is the watchdog (see the sequence order);
    // every later one is a phase deadline and is deliberately never fired.
    setTimer: (fn, ms) => {
      if (ms === 5000 && !watchdogFn) { watchdogFn = fn; return 'watchdog' }
      return 'dropped'
    },
    clearTimer: () => {},
  })
  seq.run('test')
  await sleep(10)
  ok('nothing exited before the watchdog fired', calls.exits.length === 0, JSON.stringify(calls.exits))
  ok('a watchdog was armed at hardMs', typeof watchdogFn === 'function')
  watchdogFn()
  ok('the watchdog exits non-zero', calls.exits.length === 1 && calls.exits[0] === 1, JSON.stringify(calls.exits))
  ok('and says why', calls.logs.some((l) => l.includes('HARD deadline')), calls.logs.join(' | '))
  // A late-arriving normal completion must not exit a second time.
  watchdogFn()
  ok('exit stays single-shot', calls.exits.length === 1, JSON.stringify(calls.exits))
}

// ── the default hard deadline is a ceiling over both phases ───────────────
console.log('\n-- default hard deadline')
{
  const seq = createQuitSequencer({ exit: () => {}, graceMs: 75_000, teardownMs: 10_000 })
  ok('defaults to grace + teardown + slack', seq.hardDeadlineMs === 100_000, String(seq.hardDeadlineMs))
}

// ── contract: no exit function is a programming error, not a silent hang ──
console.log('\n-- construction contract')
{
  let threw = false
  try { createQuitSequencer({}) } catch { threw = true }
  ok('refuses to build without exit()', threw)
}

// ── main.cjs wiring ───────────────────────────────────────────────────────
// The sequencer is only worth anything if main.cjs actually routes every quit
// through it and hands it a teardown that closes what this process owns. Both
// halves are source-text checks for the same reason the rest of the repo uses
// them on main.cjs: importing it needs a real Electron and a display.
console.log('\n-- main.cjs wiring')
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const src = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')

  ok('SIGTERM/SIGINT are handled by main.cjs, not left to Chromium',
    /for \(const sig of \['SIGTERM', 'SIGINT'\]\)/.test(src) && /quitSequencer\.run\(sig\)/.test(src))
  ok('before-quit defers to the sequencer instead of chaining its own quit',
    /event\.preventDefault\(\)\s*\n\s*quitSequencer\.run\('before-quit'\)/.test(src))
  ok('the sequencer is built with the 75s grace as its grace phase',
    /graceMs: SHUTDOWN_GRACE_MS/.test(src))
  ok('teardown kills the supervisor tree', /step\('killAgentSupervisor'/.test(src))
  ok('teardown closes the in-process codex proxy (the PR-33 ephemeral-port server)',
    /step\('killCodexProxy'/.test(src))
  ok('teardown closes the onboarding http server', /await closeOnboardingServer\(\)/.test(src))
  ok('...and does not wait on its keep-alive sockets to drain',
    /closeAllConnections/.test(src))
  ok('teardown destroys the windows so app.quit() has an empty window list',
    /step\('destroy windows'/.test(src) && /win\.destroy\(\)/.test(src))
  ok('the grace window is skipped on a backend that has no ack watcher',
    /ACK_CAPABLE_BACKENDS = new Set\(\['discord'\]\)/.test(src) &&
    /!ACK_CAPABLE_BACKENDS\.has\(backend\)/.test(src))
  ok('the identity-safe supervisor stop runs even with no pid in hand',
    /if \(agentSupervisorPid == null\) \{\s*\n\s*log\('app quit: no supervisor pid in hand/.test(src))
  ok('the natural app.quit() is still preferred (electron-updater installs on quit)',
    /try \{ app\.quit\(\) \} catch/.test(src) && /app\.exit\(code\)/.test(src))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
