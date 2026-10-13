#!/usr/bin/env node
// test-turn-stop.mjs -- 0.3.5 soft stop: how a Stop press ends the turn.
//
// The reported bug (Windows box): Stop hard-terminated claude.exe and left
// every MCP server it had spawned running, because on win32 child.kill() is
// TerminateProcess on ONE pid. The fix lives in headless-lane.mjs as a pure
// planner (planTurnStop) plus an executor with every side effect injected
// (createTurnStopper). This file drives both with fakes:
//  1. the plan per platform (the mac path must stay SIGTERM -> SIGKILL);
//  2. the win32 executor, stubbed: interrupt first, tree kill only after the
//     grace window, on a refusal, or on a dead stdin -- never a real taskkill;
//  3. text pins on the wiring the fakes cannot see: the lane feeds the
//     stopper its stdout events, the /interrupt route goes through it, and
//     the default tree kill is proc.cjs's taskkill /T /F.
// The E2E of the posix path (SIGTERM, lane exit, --resume boot) stays in
// test-headless-lane.mjs section 8, unchanged.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

const L = await import(pathToFileURL(path.join(ROOT, 'headless-lane.mjs')).href)
const { planTurnStop, createTurnStopper, renderInterruptRequest, SOFT_STOP_GRACE_MS, SIGNAL_STOP_KILL_MS } = L

// A fake claude child + manual timers. Nothing here touches a real process.
function rig({ platform, stdinThrows = false, killTreeThrows = false, exited = false } = {}) {
  const r = { kills: [], trees: [], stdin: [], timers: [], cleared: [], logs: [], exited }
  r.child = {
    pid: 4242,
    kill: (sig) => { r.kills.push(sig) },
    stdin: { write: (s) => { if (stdinThrows) throw new Error('EPIPE'); r.stdin.push(s) } },
  }
  let n = 0
  r.stopper = createTurnStopper({
    child: r.child,
    platform,
    isExited: () => r.exited,
    killTree: (pid, sig) => { if (killTreeThrows) throw new Error('taskkill exit 1'); r.trees.push([pid, sig]) },
    setTimer: (fn, ms) => { const t = { fn, ms, id: ++n }; r.timers.push(t); return t },
    clearTimer: (t) => { r.cleared.push(t) },
    newRequestId: () => 'req_test_1',
    log: (m) => r.logs.push(m),
  })
  r.fire = () => { const live = r.timers.filter((t) => !r.cleared.includes(t)); for (const t of live) t.fn() }
  return r
}

console.log('1. the plan per platform (pure)')
{
  const mac = planTurnStop({ platform: 'darwin' })
  assert(mac.mode === 'signal' && mac.graceMs === SIGNAL_STOP_KILL_MS && SIGNAL_STOP_KILL_MS === 10_000,
    'darwin: signal path, SIGKILL after the same 10 s the watchdog uses (mac unchanged)')
  assert(planTurnStop({ platform: 'linux' }).mode === 'signal', 'linux: signal path')
  const win = planTurnStop({ platform: 'win32' })
  assert(win.mode === 'soft-then-tree' && win.graceMs === SOFT_STOP_GRACE_MS,
    'win32: soft interrupt first, tree kill after the grace window')
  assert(SOFT_STOP_GRACE_MS >= 1_000 && SOFT_STOP_GRACE_MS <= 60_000, `the grace window is bounded (${SOFT_STOP_GRACE_MS} ms)`)
  assert(planTurnStop({ platform: 'win32', softGraceMs: 3000 }).graceMs === 3000, 'grace is injectable')
  const line = renderInterruptRequest('req_x')
  const parsed = JSON.parse(line)
  assert(line.endsWith('\n') && line.split('\n').length === 2, 'the interrupt is exactly one stream-json line')
  assert(parsed.type === 'control_request' && parsed.request_id === 'req_x' && parsed.request.subtype === 'interrupt',
    'the interrupt is the CLI control_request shape (probed: control_response success + result)')
}

console.log('\n2. posix: SIGTERM, then SIGKILL on timeout, never a tree kill or a stdin write')
{
  const r = rig({ platform: 'darwin' })
  assert(r.stopper.begin() === 'signal', 'begin() takes the signal path')
  assert(r.kills.length === 1 && r.kills[0] === 'SIGTERM', 'SIGTERM first (claude reaps its own MCP children on it)')
  assert(r.stdin.length === 0 && r.trees.length === 0, 'no control_request and no group/tree kill (the child shares the lane group)')
  assert(r.timers.length === 1 && r.timers[0].ms === 10_000, 'SIGKILL armed at 10 s')
  r.fire()
  assert(r.kills.join(',') === 'SIGTERM,SIGKILL', 'still alive at the deadline -> SIGKILL')
  const r2 = rig({ platform: 'darwin' })
  r2.stopper.begin(); r2.exited = true; r2.fire()
  assert(r2.kills.join(',') === 'SIGTERM', 'exited before the deadline -> no SIGKILL')
  assert(r2.stopper.noteResult() === false, 'posix never claims a result (the child is on its way out)')
}

console.log('\n3. win32 (stubbed): the soft interrupt is honoured -> nothing is killed')
{
  const r = rig({ platform: 'win32' })
  assert(r.stopper.begin() === 'soft', 'begin() takes the soft path')
  assert(r.kills.length === 0 && r.trees.length === 0, 'no TerminateProcess and no taskkill at the press')
  assert(r.stdin.length === 1 && JSON.parse(r.stdin[0]).request.subtype === 'interrupt', 'the control_request went to claude stdin')
  assert(r.timers.length === 1 && r.timers[0].ms === SOFT_STOP_GRACE_MS, 'the escalation timer is armed for the grace window')
  assert(r.stopper.pending() === true, 'pending while the turn has not closed')
  assert(r.stopper.noteControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: 'other' } }) === false,
    'a control_response for some other request is ignored')
  assert(r.stopper.noteControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: 'req_test_1' } }) === true
    && r.trees.length === 0, 'success response: accepted, still no kill (wait for the result)')
  assert(r.stopper.noteResult() === true, 'the next result is claimed as the cancelled turn\'s close')
  assert(r.cleared.includes(r.timers[0]), 'the escalation timer is cleared on the result')
  r.timers[0].fn() // a timer that fires anyway (raced the clear) must be inert
  assert(r.trees.length === 0 && r.kills.length === 0, 'a late timer after the result kills nothing')
  assert(r.stopper.noteResult() === false, 'only ONE result is claimed; the next turn\'s result is a normal result')
  assert(r.stopper.pending() === false, 'no longer pending')
  assert(r.stopper.begin() === 'soft' && r.stdin.length === 2, 'a later stop sends a fresh interrupt')
}

console.log('\n4. win32 (stubbed): not honoured in time -> tree kill of the claude pid')
{
  const r = rig({ platform: 'win32' })
  r.stopper.begin()
  r.fire()
  assert(r.trees.length === 1 && r.trees[0][0] === 4242, 'grace elapsed with the child alive -> killTree(child.pid) (taskkill /T /F on win32)')
  assert(r.kills.length === 0, 'NOT the single-process child.kill that orphaned the MCP servers')
  assert(r.stopper.noteResult() === false, 'a result racing the kill is not claimed as a soft stop')
  assert(r.logs.some((m) => /taskkill \/T \/F/.test(m)), 'the escalation is logged with its mechanism')
  const r2 = rig({ platform: 'win32' })
  r2.stopper.begin(); r2.exited = true; r2.fire()
  assert(r2.trees.length === 0 && r2.kills.length === 0, 'child already gone at the deadline -> nothing to kill')
}

console.log('\n5. win32 (stubbed): refusal, dead stdin, failing taskkill')
{
  const r = rig({ platform: 'win32' })
  r.stopper.begin()
  r.stopper.noteControlResponse({ type: 'control_response', response: { subtype: 'error', request_id: 'req_test_1', error: 'no turn' } })
  assert(r.trees.length === 1, 'the CLI refused the interrupt -> tree kill at once, no waiting out the window')
  assert(r.cleared.includes(r.timers[0]), 'and the escalation timer is cleared (no second kill)')
  const r2 = rig({ platform: 'win32', stdinThrows: true })
  assert(r2.stopper.begin() === 'tree' && r2.trees.length === 1, 'stdin write throws -> immediate tree kill')
  const r3 = rig({ platform: 'win32', killTreeThrows: true })
  r3.stopper.begin(); r3.fire()
  assert(r3.kills.join(',') === 'SIGKILL', 'taskkill failing -> last-resort single-process kill still ends the turn')
  const r4 = rig({ platform: 'win32' })
  r4.stopper.begin()
  assert(r4.stopper.begin() === 'soft' && r4.stdin.length === 1, 'a double press rides the first request (one interrupt on stdin)')
}

console.log('\n6. wiring pins (what the fakes cannot see)')
{
  const lane = readFileSync(path.join(ROOT, 'headless-lane.mjs'), 'utf8')
  const proc = readFileSync(path.join(ROOT, 'proc.cjs'), 'utf8')
  assert(/import \{ killTree as procKillTree \} from '\.\/proc\.cjs'/.test(lane) && /killTree = procKillTree/.test(lane),
    'the default tree kill is proc.cjs killTree')
  assert(proc.includes("execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']"),
    'proc.killTree on win32 is taskkill /PID <pid> /T /F (children included)')
  const route = lane.slice(lane.indexOf("if (req.url === '/interrupt')"), lane.indexOf("if (req.url !== '/inbound')"))
  assert(route.length > 0 && route.includes('turnStopper.begin()'), '/interrupt ends the turn through the stopper')
  assert(!/child\.kill\(/.test(route), '/interrupt has no bare child.kill left (that was the win32 orphan bug)')
  assert(route.indexOf('writePending([])') < route.indexOf('turnStopper.begin()'),
    'the FIFO is still cleared BEFORE anything is interrupted or killed')
  const soft = lane.indexOf("e.type === 'result' && turnStopper.noteResult()")
  const generic = lane.indexOf("} else if (e.type === 'result') {")
  assert(soft !== -1 && generic !== -1 && soft < generic,
    'the soft-stop result is intercepted BEFORE the generic result handler (no error strike, no banner)')
  assert(lane.includes("e.type === 'control_response'") && lane.includes('turnStopper.noteControlResponse(e)'),
    'control_response events reach the stopper (a refusal escalates at once)')
  const added = lane.slice(lane.indexOf('// ── turn-level STOP mechanics'), lane.indexOf('function readPriorSession()'))
  assert(added.length > 0 && !added.includes(String.fromCharCode(0x2014)), 'no em dash in the new stop block')
}

console.log('\n7. 0.3.6: every other kill path goes through the same tree kill')
{
  const { createChildTerminator } = L
  const mk = (platform, opts = {}) => {
    const r = { kills: [], trees: [], timers: [], exited: !!opts.exited }
    const child = { pid: 777, kill: (s) => r.kills.push(s) }
    r.term = createChildTerminator({
      child, platform, isExited: () => r.exited,
      killTree: (pid, sig) => { if (opts.throws) throw new Error('taskkill exit 1'); r.trees.push([pid, sig]) },
      setTimer: (fn, ms) => { r.timers.push({ fn, ms }) }, log: () => {},
    })
    return r
  }
  const w = mk('win32')
  assert(w.term('turn watchdog stall') === 'tree' && w.trees.length === 1 && w.trees[0][0] === 777 && w.kills.length === 0,
    'win32: terminate() tree-kills the claude pid, no bare child.kill')
  const wf = mk('win32', { throws: true })
  assert(wf.term('x') === 'single' && wf.kills[0] === 'SIGKILL', 'win32: a failed tree kill falls back to a single-pid kill')
  const m = mk('darwin')
  assert(m.term('x') === 'signal' && m.kills[0] === 'SIGTERM' && m.trees.length === 0 && m.timers[0].ms === SIGNAL_STOP_KILL_MS,
    'posix: SIGTERM then a 10 s SIGKILL timer, no tree kill (unchanged)')
  m.timers[0].fn()
  assert(m.kills.join() === 'SIGTERM,SIGKILL', 'posix: the timer escalates to SIGKILL when still alive')
  const g = mk('win32', { exited: true })
  assert(g.term('x') === 'gone' && g.trees.length === 0, 'an already-exited child is left alone')

  const lane = readFileSync(path.join(ROOT, 'headless-lane.mjs'), 'utf8')
  const body = lane.slice(lane.indexOf('const turnStopper = createTurnStopper'))
  assert(!/child\.kill\(/.test(body), 'headless lane body after the stopper has no bare child.kill left')
  for (const why of ['stopped rotation handoff', '3 consecutive error turns', 'rotation handoff finished', 'turn watchdog stall', 'shutdown', 'endpoint FATAL']) {
    assert(body.includes(`terminateChild('${why}')`), `path routed: ${why}`)
  }
  const sd = body.slice(body.indexOf("const stopflag = path.join(MEM, '.stop_requested')"))
  assert(sd.includes("shutdown('stop request (.stop_requested)')"), '.stop_requested -> shutdown -> terminateChild (tree kill on win32)')

  const dsh = readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')
  assert((dsh.match(/child\.kill\(/g) || []).length === 0, 'dsh-lane has no bare child.kill outside killEngine')
  assert((dsh.match(/killEngine\(child\)/g) || []).length === 5, 'dsh-lane: model-selection failure, error recycle, AUTH-hold fallback (0.4.3), shutdown (incl. .stop_requested) and boot failure use killEngine')
  assert(dsh.includes("killTree(c.pid, 'SIGKILL')") && dsh.includes("platform === 'win32'"), 'dsh killEngine tree-kills on win32')
  const copy = readFileSync(path.join(ROOT, 'onboarding/public/js/copy.js'), 'utf8')
  assert(!copy.includes('takes a few seconds to come back'), 'Stop copy no longer promises a restart delay on every platform')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
