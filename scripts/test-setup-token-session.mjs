// scripts/test-setup-token-session.mjs -- state machine tests for
// setup-token-session.cjs, driven by a fake pty.
//
// The positive assertions here (does the happy path store the token?) are the
// easy half. The half that matters is negative: this module handles a
// long-lived credential, so the tests assert that the token does NOT appear
// in status() in any state, does NOT appear in the log, and that a captured
// token is never stored without validating first.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createSetupTokenSession, PROVIDER_ID } = require('../setup-token-session.cjs')
const { TOKEN_PREFIX, SETUP_TOKEN_PTY_COLS } = require('../setup-token.cjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++ } else { fail++; console.error(`FAIL: ${label}`) }
}
const tick = () => new Promise((r) => setTimeout(r, 10))

const ESC = '\x1B'
const BODY = 'AbC1' + 'x'.repeat(62) + '-_Qz9' + 'K'.repeat(24)
const FAKE = TOKEN_PREFIX + BODY
// Distinctive text that must never escape to a client or a log.
const SECRET_NOISE = 'ZZ-SENSITIVE-CHILD-CHATTER-ZZ'
const tokenOutput =
  `${SECRET_NOISE}\r\n` +
  `Your OAuth token (valid for 1 year):${ESC}[K\r\n` +
  `${ESC}[1C${ESC}[1B${ESC}[38;2;255;193;7m${FAKE}\r\n` +
  `${ESC}[1C${ESC}[2BStore this token securely.\r\n`

// ── fake pty ───────────────────────────────────────────────────────────────
function makeHarness(overrides = {}) {
  const calls = { spawn: [], validate: [], store: [], writes: [], kills: 0 }
  const logs = []
  // Every spawn gets its OWN child with its OWN callbacks -- a single shared
  // fake child cannot express a superseded generation at all, because the
  // second spawn just overwrites the first one's handlers. A real pty leaves
  // the old child's closures alive, which is the whole hazard.
  const children = []
  function newChild() {
    const c = {
      dataCb: null,
      exitCb: null,
      onData: (cb) => { c.dataCb = cb },
      onExit: (cb) => { c.exitCb = cb },
      // Per-child writes as well as the shared list: "did the WRONG child get
      // typed at" is unanswerable from a single flat array.
      writes: [],
      write: (s) => { c.writes.push(s); calls.writes.push(s) },
      kill: () => { calls.kills++ },
    }
    children.push(c)
    return c
  }
  const session = createSetupTokenSession({
    resolveClaudeBin: overrides.resolveClaudeBin || (() => '/fake/bin/claude'),
    validateProviderKey: overrides.validateProviderKey || (async (p, k) => {
      calls.validate.push([p, k]); return { ok: true }
    }),
    storeProviderKeyVerified: overrides.storeProviderKeyVerified || ((p, k) => {
      calls.store.push([p, k])
    }),
    log: (m) => logs.push(m),
    spawnPty: overrides.spawnPty || ((bin, args, opts) => {
      calls.spawn.push({ bin, args, opts }); return newChild()
    }),
    timeoutMs: overrides.timeoutMs,
  })
  const at = (i) => children[i]
  return {
    session, calls, logs, children,
    // Default: drive the most recent child.
    emit: (s) => { const c = children[children.length - 1]; if (c && c.dataCb) c.dataCb(s) },
    exit: () => { const c = children[children.length - 1]; if (c && c.exitCb) c.exitCb({ exitCode: 0 }) },
    // Drive a SPECIFIC generation, including a superseded one.
    emitAt: (i, s) => { const c = at(i); if (c && c.dataCb) c.dataCb(s) },
    exitAt: (i) => { const c = at(i); if (c && c.exitCb) c.exitCb({ exitCode: 0 }) },
  }
}

// ── happy path ─────────────────────────────────────────────────────────────
{
  const h = makeHarness()
  assert(h.session.status().state === 'idle', 'starts idle')
  const r = h.session.start()
  assert(r.ok === true, 'start returns ok')
  assert(h.session.status().state === 'running', 'state is running after start')
  assert(h.calls.spawn.length === 1, 'spawned exactly once')
  assert(h.calls.spawn[0].args.join(' ') === 'setup-token', 'spawned `claude setup-token`')
  assert(h.calls.spawn[0].opts.cols === SETUP_TOKEN_PTY_COLS, 'pty spawned at the wide width (wrap defense #1)')
  assert(h.calls.spawn[0].opts.cols >= 200, 'pty width is concretely >= 200, not just equal to whatever the const says')

  h.emit(tokenOutput)
  h.exit()
  await tick()

  assert(h.calls.validate.length === 1, 'validated exactly once')
  assert(h.calls.validate[0][0] === PROVIDER_ID, 'validated under claude-subscription')
  assert(h.calls.validate[0][1] === FAKE, 'validated the FULL token')
  assert(h.calls.store.length === 1, 'stored exactly once')
  assert(h.calls.store[0][1] === FAKE, 'stored the FULL token')
  assert(h.session.status().state === 'connected', 'final state is connected')
}

// ── the token must never reach the client, in any state ────────────────────
{
  const h = makeHarness()
  const seen = []
  seen.push(JSON.stringify(h.session.status()))
  h.session.start()
  seen.push(JSON.stringify(h.session.status()))
  h.emit(tokenOutput)
  seen.push(JSON.stringify(h.session.status()))
  h.exit()
  await tick()
  seen.push(JSON.stringify(h.session.status()))

  for (const snap of seen) {
    assert(!snap.includes(FAKE), 'status() never contains the token')
    assert(!snap.includes(BODY.slice(0, 30)), 'status() never contains even a token fragment')
    assert(!snap.includes(SECRET_NOISE), 'status() never contains raw child output')
    assert(!snap.includes(TOKEN_PREFIX), 'status() never contains the token prefix')
  }
  // ...and the same for the log, which is the other thing that outlives the turn.
  const allLogs = h.logs.join('\n')
  assert(!allLogs.includes(FAKE), 'log never contains the token')
  assert(!allLogs.includes(BODY.slice(0, 30)), 'log never contains a token fragment')
  assert(!allLogs.includes(SECRET_NOISE), 'log never contains raw child output')
  assert(h.logs.length > 0, 'control: the log was actually written to, so the checks above are meaningful')
}

// ── validation failure: captured but rejected -> never stored ──────────────
{
  const h = makeHarness({ validateProviderKey: async () => ({ ok: false }) })
  h.session.start(); h.emit(tokenOutput); h.exit(); await tick()
  assert(h.session.status().state === 'failed', 'rejected token -> failed')
  assert(h.session.status().reason === 'token_rejected', 'reason is token_rejected')
  assert(h.calls.store.length === 0, 'a rejected token is NEVER stored')
}

// ── store failure is loud, not silent ──────────────────────────────────────
{
  const h = makeHarness({
    storeProviderKeyVerified: () => { throw new Error(`round-trip verify failed for provider=${PROVIDER_ID}`) },
  })
  h.session.start(); h.emit(tokenOutput); h.exit(); await tick()
  assert(h.session.status().state === 'failed', 'store throw -> failed')
  assert(h.session.status().reason === 'store_failed', 'reason is store_failed')
}

// ── nothing captured ───────────────────────────────────────────────────────
{
  const h = makeHarness()
  h.session.start(); h.emit('some chatter but no credential\r\n'); h.exit(); await tick()
  assert(h.session.status().state === 'failed', 'no token in output -> failed')
  assert(h.session.status().reason === 'no_token_in_output', 'reason names the miss')
  assert(h.calls.validate.length === 0, 'nothing validated when nothing was captured')
}

// ── CLI missing ────────────────────────────────────────────────────────────
{
  const h = makeHarness({ resolveClaudeBin: () => null })
  const r = h.session.start()
  assert(r.ok === false && r.reason === 'cli_missing', 'missing CLI reported at start')
  assert(h.session.status().state === 'failed', 'missing CLI -> failed state')
  assert(h.calls.spawn.length === 0, 'nothing spawned when the CLI is missing')
}

// ── spawn throws ───────────────────────────────────────────────────────────
{
  const h = makeHarness({ spawnPty: () => { throw new Error('ENOENT /fake/bin/claude') } })
  const r = h.session.start()
  assert(r.ok === false && r.reason === 'spawn_failed', 'spawn throw handled, not propagated')
  assert(!JSON.stringify(h.session.status()).includes('ENOENT'), 'spawn error text does not reach the client')
}

// ── manual-code fallback ───────────────────────────────────────────────────
{
  const h = makeHarness()
  h.session.start()
  h.emit(`${ESC}[1C${ESC}[1BPaste code here if prompted > \r\n`)
  assert(h.session.status().state === 'awaiting_code', 'manual prompt moves state to awaiting_code')

  assert(h.session.submitCode('abc\r\nrm -rf /').ok === false, 'control-character code rejected')
  assert(h.session.submitCode('short').ok === false, 'too-short code rejected')
  assert(h.calls.writes.length === 0, 'a rejected code is never written to the pty')

  const ok = h.session.submitCode('validcode123#state/9')
  assert(ok.ok === true, 'plausible code accepted')
  assert(h.calls.writes.length === 1, 'code written, submit NOT glued to it')
  assert(h.calls.writes[0] === 'validcode123#state/9', 'first write is exactly the code')
  assert(!h.calls.writes[0].includes('\r'), 'first write carries no carriage return (the swallow bug)')
  await tick()
  await new Promise((r) => setTimeout(r, 300))
  assert(h.calls.writes.length === 2, 'submit arrives as a SEPARATE, later write')
  assert(h.calls.writes[1] === '\r', 'second write is the bare submit')
}
{
  const h = makeHarness()
  assert(h.session.submitCode('validcode123').ok === false, 'code before start is refused')
  assert(h.session.submitCode('validcode123').reason === 'not_running', 'reason is not_running')
}
{
  // A child exists but the CLI has not reached its code prompt. Submitting
  // here would type an Enter at whatever prompt happens to be on screen --
  // answering a question nobody asked.
  const h = makeHarness()
  h.session.start()
  assert(h.session.status().state === 'running', 'child is up, prompt not yet seen')
  const r = h.session.submitCode('validcode123')
  assert(r.ok === false && r.reason === 'not_awaiting_code', 'an early code submit is refused by state')
  assert(h.calls.writes.length === 0, 'nothing is written to the pty before the prompt exists')
}

// ── the deferred submit must not land on a different child ─────────────────
{
  // submitCode writes the code, then schedules the Enter 250ms later. If that
  // timer re-reads the shared `child`, cancelling and restarting inside the
  // window delivers an unrequested keystroke to a brand-new setup-token
  // process, at whatever screen it is on. Same bug class as the stale
  // onData/onExit callbacks -- this was the site the first sweep missed.
  const h = makeHarness()
  h.session.start()
  h.emit('Paste code here if prompted > ')
  assert(h.session.status().state === 'awaiting_code', 'flow 1 is at the code prompt')
  assert(h.session.submitCode('validcode123').ok === true, 'flow 1 accepts a code')
  h.session.cancel()
  h.session.start() // flow 2, brand new child, inside the 250ms window
  assert(h.children.length === 2, 'control: a second child really was spawned')
  await new Promise((r) => setTimeout(r, 400)) // let the deferred write fire
  assert(h.children[1].writes.length === 0,
    'the deferred Enter does NOT land on the new child')
  assert(h.children[0].writes.join('') === 'validcode123',
    'and the superseded child got only what it was actually sent -- no trailing submit')
}

// ── shutdown hook: the pty must not outlive the app ────────────────────────
{
  // Same class the codebase already refuses to orphan (killAllLoginChildren's
  // own comment): a login child that could finish its OAuth exchange after the
  // app is gone. This one also holds a localhost /callback listener.
  const { killSetupTokenChildOnShutdown } = require('../setup-token-session.cjs')
  const h = makeHarness()
  h.session.start()
  assert(h.calls.kills === 0, 'control: nothing killed yet')
  killSetupTokenChildOnShutdown()
  assert(h.calls.kills === 1, 'the shutdown hook kills a running setup-token child')
  assert(h.session.status().state === 'cancelled', 'and leaves the session in a terminal state')
  // Idempotent and inert with nothing running -- before-quit runs on every
  // exit, including the overwhelming majority with no login in flight.
  killSetupTokenChildOnShutdown()
  assert(h.calls.kills === 1, 'the hook does not kill twice')
}

// ── idempotency and cancel ─────────────────────────────────────────────────
{
  const h = makeHarness()
  h.session.start()
  const second = h.session.start()
  assert(second.alreadyRunning === true, 'second start is a no-op')
  assert(h.calls.spawn.length === 1, 'no double spawn (one localhost callback port, one child)')

  h.session.cancel()
  assert(h.session.status().state === 'cancelled', 'cancel moves to cancelled')
  assert(h.calls.kills === 1, 'cancel kills the child')
  assert(h.session.cancel().alreadyStopped === true, 'cancel is idempotent')
}

// ── timeout ────────────────────────────────────────────────────────────────
{
  const h = makeHarness({ timeoutMs: 20 })
  h.session.start()
  await new Promise((r) => setTimeout(r, 60))
  assert(h.session.status().state === 'failed', 'abandoned flow times out')
  assert(h.session.status().reason === 'timeout', 'reason is timeout')
  assert(h.calls.kills === 1, 'timeout kills the child rather than leaking a pty')
}
{
  // A flow that completed must not then be failed by its own timer.
  const h = makeHarness({ timeoutMs: 40 })
  h.session.start(); h.emit(tokenOutput); h.exit(); await tick()
  assert(h.session.status().state === 'connected', 'connected before the timer')
  await new Promise((r) => setTimeout(r, 80))
  assert(h.session.status().state === 'connected', 'a fired timer does NOT clobber a completed flow')
}

// ── a second exit event must not re-enter finish() ─────────────────────────
{
  // finish() empties the buffer before awaiting. A second exit re-entering it
  // would extract from '', fail as no_output, and overwrite a capture that
  // actually succeeded -- the user sees a failure for a stored credential.
  let resolveValidate
  const h = makeHarness({
    validateProviderKey: (p, k) => new Promise((r) => { resolveValidate = () => r({ ok: true }) }),
  })
  h.session.start()
  h.emit(tokenOutput)
  h.exit()
  await tick()
  assert(h.session.status().state === 'validating', 'first exit started the validate')
  h.exit() // duplicate event, mid-validate
  await tick()
  assert(h.session.status().state === 'validating', 'a duplicate exit does not knock the flow out of validating')
  resolveValidate()
  await tick()
  assert(h.session.status().state === 'connected', 'the flow still lands on connected')
  assert(h.calls.store.length === 1, 'the credential is stored exactly once, not twice')
}
{
  // ...and after a terminal state, further exits are inert.
  const h = makeHarness()
  h.session.start(); h.emit(tokenOutput); h.exit(); await tick()
  assert(h.session.status().state === 'connected', 'connected')
  h.exit(); h.exit(); await tick()
  assert(h.session.status().state === 'connected', 'exits after a terminal state are ignored')
  assert(h.calls.store.length === 1, 'no extra store from repeated exits')
}

// ── cancel during validation must actually cancel ──────────────────────────
{
  // The window that matters: the child has exited, the token is captured, and
  // validation is in flight. `child` is still set, so cancel() runs -- and
  // before the generation guard existed, the resolving validate went on to
  // store the credential and flip the UI to connected. Cancel that stores the
  // thing you cancelled is worse than a cancel button that does nothing.
  let resolveValidate
  const h = makeHarness({
    validateProviderKey: (p, k) => new Promise((r) => { resolveValidate = () => r({ ok: true }) }),
  })
  h.session.start(); h.emit(tokenOutput); h.exit(); await tick()
  assert(h.session.status().state === 'validating', 'validate in flight')
  h.session.cancel()
  assert(h.session.status().state === 'cancelled', 'cancel lands immediately')
  resolveValidate()
  await tick()
  assert(h.calls.store.length === 0, 'a cancelled flow NEVER stores the credential')
  assert(h.session.status().state === 'cancelled', 'a resolving validate does not resurrect a cancelled flow')
}
{
  // Same window, timeout instead of the user.
  let resolveValidate
  const h = makeHarness({
    timeoutMs: 20,
    validateProviderKey: (p, k) => new Promise((r) => { resolveValidate = () => r({ ok: true }) }),
  })
  h.session.start(); h.emit(tokenOutput); h.exit(); await tick()
  // finish() disarms the timer, so validation is deliberately NOT timed out --
  // assert that, then confirm an explicit cancel still wins.
  await new Promise((r) => setTimeout(r, 60))
  assert(h.session.status().state === 'validating', 'the disarmed timer leaves a slow validate alone')
  h.session.cancel()
  resolveValidate()
  await tick()
  assert(h.calls.store.length === 0, 'cancel after the timer window still prevents the store')
}

// ── a superseded child must not pollute the next run ───────────────────────
{
  // Cancel leaves the old pty's onData closure alive. Without a generation
  // check its late output lands in the NEXT run's buffer -- so a stale token
  // fragment could be validated and stored under a flow the user thinks is
  // fresh.
  const h = makeHarness()
  h.session.start()
  h.emit('first run chatter\r\n')
  h.session.cancel()
  h.session.start() // generation 2 -- a genuinely distinct child
  assert(h.children.length === 2, 'control: two separate children exist, so the scenario is real')
  h.emitAt(0, tokenOutput) // late output from the SUPERSEDED generation
  h.exitAt(1) // the live run ends having captured nothing
  await tick()
  assert(h.calls.store.length === 0, 'a superseded generation cannot store through the new run')
  assert(h.session.status().state !== 'connected', 'stale output does not complete the new run')
  // 'no_output' (not 'no_token_in_output') is the load-bearing value here: it
  // means the live run's buffer was EMPTY, which is only true if the stale
  // generation's emit was rejected outright rather than merely failing to
  // parse. Had the guard been missing, the buffer would have held the stale
  // token and this would read 'connected'.
  assert(h.session.status().reason === 'no_output',
    'the live run saw an empty buffer -- the stale write never landed in it')
  // ...and the superseded child's own exit is inert too.
  h.exitAt(0)
  await tick()
  assert(h.calls.store.length === 0, 'the superseded exit event stores nothing either')
}

// ── logged error text is scrubbed, not trusted ─────────────────────────────
{
  // validateProviderKey makes a network call whose error text this module does
  // not author. If such an error ever quotes the credential, it must not reach
  // the log verbatim.
  const h = makeHarness({
    validateProviderKey: async () => { throw new Error(`upstream rejected ${FAKE} at api.anthropic.com`) },
  })
  h.session.start(); h.emit(tokenOutput); h.exit(); await tick()
  const allLogs = h.logs.join('\n')
  assert(h.session.status().state === 'failed', 'a throwing validate fails the flow')
  assert(!allLogs.includes(FAKE), 'a token quoted by a dependency error is NOT logged verbatim')
  assert(!allLogs.includes(BODY.slice(0, 30)), 'not even a fragment of it is logged')
  assert(/redacted/.test(allLogs), 'control: the message WAS logged, with the credential redacted')
  assert(/api\.anthropic\.com/.test(allLogs), 'control: the non-secret part of the message survives (still debuggable)')
}

// ── child env scrub ────────────────────────────────────────────────────────
{
  process.env.ANTHROPIC_API_KEY = 'sk-ant-parent-should-not-be-inherited'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-parent-should-not-be-inherited'
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.invalid'
  const h = makeHarness()
  h.session.start()
  const env = h.calls.spawn[0].opts.env
  assert(!('ANTHROPIC_API_KEY' in env), 'child does not inherit ANTHROPIC_API_KEY')
  assert(!('CLAUDE_CODE_OAUTH_TOKEN' in env), 'child does not inherit an existing OAuth token')
  assert(!('ANTHROPIC_BASE_URL' in env), 'child does not inherit a base-URL override')
  // Case-insensitive PATH lookup. Windows env var names are case-insensitive
  // and the block is commonly spelled 'Path' there, so a strict env.PATH read
  // came back undefined and this CONTROL assertion failed while the three real
  // ones above passed -- i.e. the test reported a leak that did not exist
  // (2026-08-04 win suite).
  const readPath = (o) => (o.PATH !== undefined ? o.PATH : o[Object.keys(o).find((k) => k.toUpperCase() === 'PATH')])
  assert(readPath(env) === readPath(process.env), 'control: the rest of the environment IS inherited')
  // The parent's own environment must be untouched -- scrub the child, never
  // the process the app itself runs in.
  assert(process.env.ANTHROPIC_API_KEY === 'sk-ant-parent-should-not-be-inherited',
    'parent env is NOT mutated by the scrub')
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
}

// ── buffer bound ───────────────────────────────────────────────────────────
{
  // A CLI stuck redrawing must not grow the in-process buffer without limit,
  // and the token must still be found afterwards because the TAIL is kept.
  //
  // The overflow and the token must arrive in the SAME chunk. Split across
  // two emits, the trim happens on the first and the token lands in an
  // already-trimmed buffer that never overflows again -- so the test would
  // pass even if the trim kept the head, which is exactly what mutation
  // testing caught it doing.
  const h = makeHarness()
  h.session.start()
  h.emit('x'.repeat(300 * 1024) + tokenOutput)
  h.exit()
  await tick()
  assert(h.session.status().state === 'connected', 'token still captured after the buffer was trimmed')
  assert(Boolean(h.calls.store[0]) && h.calls.store[0][1] === FAKE,
    'trimming keeps the TAIL, so the token survives intact')
}

// ── a slow validate must not be clobbered by its own timeout ───────────────
{
  // The timer is armed for the whole flow, including the validate round-trip.
  // If it is not disarmed when the child exits, a validate slower than the
  // remaining budget fails the flow and kills the child, and then the
  // resolving validate writes 'connected' over the top -- two terminal states
  // for one run, with a stored credential the UI already called failed.
  let resolveValidate
  const h = makeHarness({
    timeoutMs: 30,
    validateProviderKey: () => new Promise((r) => { resolveValidate = () => r({ ok: true }) }),
  })
  h.session.start()
  h.emit(tokenOutput)
  h.exit()
  await tick()
  assert(h.session.status().state === 'validating', 'validate is in flight')
  await new Promise((r) => setTimeout(r, 80)) // outlive the timeout budget
  assert(h.session.status().state === 'validating', 'the timer does NOT fire while validating')
  assert(h.calls.kills === 0, 'the child is not killed out from under an in-flight validate')
  resolveValidate()
  await tick()
  assert(h.session.status().state === 'connected', 'slow validate still lands on connected')
  assert(h.session.status().reason === null, 'no stale timeout reason survives')
}

// ── the PRODUCTION shape: no pty spawner at all (design-0023 P2) ───────────
// Every harness above injects a fake spawnPty, which is what makes the state
// machine testable -- and which means none of them exercise what the app
// actually constructs. onboarding/http-server.cjs's getSetupTokenSession()
// passes resolveClaudeBin / validateProviderKey / storeProviderKeyVerified /
// log and NO spawner, because node-pty is retired. That path deserves its own
// rows, or "the pty lane refuses honestly" is a claim nothing checks.
{
  const logs = []
  let resolveCalls = 0
  const session = createSetupTokenSession({
    // A machine WITH the CLI installed. The refusal must not depend on the
    // binary being missing -- that would make the reason wrong (and the copy
    // send the user off to install something that would not help) on exactly
    // the machines where the old flow used to work.
    resolveClaudeBin: () => { resolveCalls++; return '/fake/bin/claude' },
    validateProviderKey: async () => { throw new Error('must never validate') },
    storeProviderKeyVerified: () => { throw new Error('must never store') },
    log: (m) => logs.push(m),
  })
  const r = session.start()
  assert(r.ok === false, 'a session with no pty spawner refuses to start')
  assert(r.reason === 'unsupported', 'the reason is unsupported (not cli_missing, not spawn_failed)')
  assert(session.status().state === 'failed', 'status reports the terminal failure')
  assert(session.status().reason === 'unsupported', 'status carries the same reason the client got')
  assert(resolveCalls === 0, 'it refuses BEFORE resolving a claude binary')
  assert(session.status().provider === PROVIDER_ID,
    'the refusal still names the provider slot the in-app login writes instead')
  // Repeat calls must stay refusals, not flip to alreadyRunning: nothing was
  // started, so there is nothing to be already running.
  const again = session.start()
  assert(again.ok === false && again.reason === 'unsupported', 'a second start is refused the same way')
  // The client-facing surface stays enum-only, same guarantee as every other
  // state in this file.
  assert(JSON.stringify(session.status()).includes('unsupported'), 'status serialises')
  assert(!JSON.stringify(session.status()).includes('/fake/bin/claude'), 'status carries no path')
  // submitCode/cancel on a session that never started must not throw.
  assert(session.submitCode('abcdef1234').ok === false, 'submitCode on a never-started session is refused')
  assert(session.cancel().alreadyStopped === true, 'cancel on a never-started session is a no-op')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
