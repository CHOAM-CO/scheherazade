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
  let dataCb = null
  let exitCb = null
  const fakeChild = {
    onData: (cb) => { dataCb = cb },
    onExit: (cb) => { exitCb = cb },
    write: (s) => calls.writes.push(s),
    kill: () => { calls.kills++ },
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
      calls.spawn.push({ bin, args, opts }); return fakeChild
    }),
    timeoutMs: overrides.timeoutMs,
  })
  return {
    session, calls, logs,
    emit: (s) => dataCb && dataCb(s),
    exit: () => exitCb && exitCb({ exitCode: 0 }),
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
  assert(env.PATH === process.env.PATH, 'control: the rest of the environment IS inherited')
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
