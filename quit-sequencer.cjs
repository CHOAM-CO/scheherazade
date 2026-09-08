// quit-sequencer.cjs -- ONE bounded, idempotent app-quit path.
//
// WHY THIS FILE EXISTS (defect, live E2E 2026-09-08, dev-run repro measured
// 76s to exit / observed as "never exits"): quitting used to be a chain of
// event handlers with no ceiling on it. before-quit called preventDefault(),
// kicked off an async grace wait for the agent's .shutdown-ack, and re-entered
// app.quit() from a .finally(). Every step in that chain was unbounded:
//   - the grace wait ran its full 75s window even when NOTHING in the running
//     configuration could ever write the ack (see main.cjs's
//     ACK_CAPABLE_BACKENDS -- only the Discord channel has the watcher, while
//     every backend writes the .agent-live heartbeat the fast path reads);
//   - main.cjs registered NO SIGTERM/SIGINT handler at all, so the whole path
//     was reached only via Chromium's own signal translation -- undefined
//     behaviour we neither own nor can test;
//   - nothing force-exited if the re-entered app.quit() did not end the
//     process, and nothing closed the servers this process owns (the
//     in-process codex proxy from ensureCodexProxy, the onboarding http
//     server) on the way out.
// The sequencer replaces the chain with three phases, each with its own
// deadline, plus a hard watchdog over the whole thing. A quit ALWAYS ends in
// exit(code); the only question is how much cleanup got done first.
//
// No Electron here on purpose: every effect is an injected function, so
// tests/test-quit-sequencer.mjs drives the whole state machine with fakes on a
// plain node runner (the real thing needs a display, and a test that needs a
// display is a test nobody runs).

'use strict'

// Wait for `promise`, but never longer than `ms`. Timeout and rejection both
// resolve to a status string rather than throwing: the quit path must proceed
// through a broken step, never abort on it.
function withDeadline(promise, ms, timeoutValue, { setTimer, clearTimer, onError }) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimer(() => {
      if (settled) return
      settled = true
      resolve(timeoutValue)
    }, ms)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimer(timer)
      resolve(value)
    }
    Promise.resolve()
      .then(() => promise)
      .then((v) => finish(v === undefined ? 'done' : v), (err) => finish(onError(err)))
  })
}

// createQuitSequencer -- one instance per app process.
//
//   waitForAck(): the agent-flush grace window. Resolves 'acked' / 'expired' /
//     'skipped'. Bounded here by graceMs regardless of what it does.
//   teardown(): kill the supervisor tree, close every server/handle we own.
//     Bounded by teardownMs; a throw is logged and the quit continues.
//   exit(code): end the process. Called EXACTLY once, always.
//   hardMs: ceiling over the whole sequence. If the phases have not reached
//     exit() by then, the watchdog calls exit(1) itself -- that is the
//     "never waits forever" guarantee, and it holds even if a phase's own
//     deadline is defeated (a blocked event loop, a timer that never fires
//     because the step wedged the process).
function createQuitSequencer({
  log = () => {},
  waitForAck = async () => 'skipped',
  teardown = async () => {},
  exit,
  graceMs = 75_000,
  teardownMs = 10_000,
  hardMs = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof exit !== 'function') throw new TypeError('createQuitSequencer: exit(code) is required')
  const hardDeadlineMs = hardMs == null ? graceMs + teardownMs + 15_000 : hardMs

  let running = null
  let exited = false
  const exitOnce = (code, why) => {
    if (exited) return
    exited = true
    log(`quit: exit(${code}) -- ${why}`)
    exit(code)
  }

  async function run(reason = 'unspecified') {
    // Idempotent by construction: a second SIGTERM, a Cmd-Q landing on top of
    // a signal, before-quit re-entering -- all join the sequence in flight
    // instead of starting a second teardown (which would double-signal the
    // supervisor and race the exit).
    if (running) {
      log(`quit: already in progress -- '${reason}' joins the running sequence`)
      return running
    }
    running = (async () => {
      log(`quit: sequence started (${reason}); grace<=${graceMs}ms teardown<=${teardownMs}ms hard<=${hardDeadlineMs}ms`)
      // Deliberately NOT unref'd: this timer is the last-resort exit and must
      // fire even if it is the only handle left.
      const watchdog = setTimer(() => {
        exitOnce(1, `HARD deadline ${hardDeadlineMs}ms reached with the sequence unfinished`)
      }, hardDeadlineMs)

      const ack = await withDeadline(waitForAck(), graceMs, 'expired', {
        setTimer,
        clearTimer,
        onError: (err) => {
          log(`quit: grace phase threw (proceeding): ${err && err.message ? err.message : err}`)
          return 'error'
        },
      })
      log(`quit: grace phase -> ${ack}`)

      const td = await withDeadline(teardown(), teardownMs, 'timeout', {
        setTimer,
        clearTimer,
        onError: (err) => {
          log(`quit: teardown threw (proceeding to exit anyway): ${err && err.message ? err.message : err}`)
          return 'error'
        },
      })
      log(`quit: teardown -> ${td}`)

      clearTimer(watchdog)
      exitOnce(0, `sequence complete (grace=${ack}, teardown=${td})`)
      return { reason, ack, teardown: td }
    })()
    return running
  }

  return {
    run,
    isRunning: () => running != null,
    hasExited: () => exited,
    hardDeadlineMs,
  }
}

module.exports = { createQuitSequencer, withDeadline }
