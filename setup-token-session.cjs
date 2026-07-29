// setup-token-session.cjs -- runs `claude setup-token` under a pty and turns
// its output into a stored claude-subscription credential.
//
// WHAT THIS REPLACES: today the user opens Terminal, runs `claude
// setup-token` themselves, and pastes the printed 1-year token into the app.
// That means the long-lived credential transits the clipboard. Here the token
// is read out of the child's pty inside this process, handed straight to the
// same validate-then-store path the paste used, and dropped. It is never sent
// to the client, never logged, and never touches the clipboard.
//
// WHY IT CAN BE ONE CLICK (read out of the CLI binary 2.1.220, not assumed):
// `waitForAuthorizationCode` resolves from whichever of two sources arrives
// first -- a localhost `/callback` listener the CLI starts itself, or the
// "Paste code here if prompted >" box. `buildAuthUrl` is called twice, once
// with isManual:true and once with isManual:false, and the token exchange
// then passes `useManualRedirect: !automatic`. So on the user's own machine
// the browser redirect normally wins and nothing is typed at all. The manual
// box is a RACE FALLBACK, which is why submitCode() exists but is not on the
// happy path.
//
// SHAPE: deliberately the same one startMcpConnectorLogin already
// established in http-server.cjs -- fire-and-forget start, client polls
// status, idempotency guard, timeout, and a close handler that distinguishes
// "exited cleanly but captured nothing" from "failed". Its load-bearing rule
// is inherited too, and matters more here than there: ONLY VERIFIED CAPTURES
// REACH THE CLIENT, raw child output stays in-process. There, the child was
// printing a URL. Here it is printing a credential.
//
// Everything external is injected so the state machine can be tested without
// a real pty, a real network call, or a real credential.
'use strict'

const { extractSetupToken, awaitingManualCode, isPlausibleAuthCode,
  SETUP_TOKEN_PTY_COLS, SETUP_TOKEN_PTY_ROWS } = require('./setup-token.cjs')

// The provider id this lane stores under. buildProviderEnv()'s
// 'claude-subscription' row reads exactly this key back and exports it as
// CLAUDE_CODE_OAUTH_TOKEN (provider-env.cjs).
const PROVIDER_ID = 'claude-subscription'

// Longer than the MCP connector's 180s: that flow is one browser redirect,
// this one is a full account login that may include a password manager, 2FA,
// and an account picker. Still bounded -- an abandoned flow must not leave a
// child holding a pty forever.
const SETUP_TOKEN_TIMEOUT_MS = 300_000

// Terminal states. Anything not in here is still in flight and the client
// should keep polling.
const TERMINAL_STATES = new Set(['connected', 'failed', 'cancelled'])

/**
 * @param {object} deps
 * @param {() => string|null} deps.resolveClaudeBin  path to the claude binary, or null
 * @param {(provider: string, key: string, opts?: object) => Promise<{ok: boolean}>} deps.validateProviderKey
 * @param {(provider: string, key: string) => void} deps.storeProviderKeyVerified  throws on failure
 * @param {(msg: string) => void} deps.log
 * @param {(bin: string, args: string[], opts: object) => object} [deps.spawnPty]  injectable for tests
 * @param {() => number} [deps.now]
 */
function createSetupTokenSession(deps) {
  const {
    resolveClaudeBin, validateProviderKey, storeProviderKeyVerified,
    log = () => {}, spawnPty = defaultSpawnPty, now = () => Date.now(),
    timeoutMs = SETUP_TOKEN_TIMEOUT_MS,
  } = deps

  // Single-flight. There is exactly one user in front of one app, and a
  // second concurrent `setup-token` would race the first for the same
  // localhost callback port.
  let child = null
  let timer = null
  let state = 'idle'
  let reason = null
  let startedAt = null
  // The credential lives here between capture and store, and nowhere else.
  // Never returned, never logged, cleared in finish().
  let buffer = ''
  // Generation counter. A pty's onData/onExit closures capture THIS scope, so
  // a child that was cancelled or timed out still holds live callbacks
  // pointing at `buffer` -- late output from a dead run would otherwise land
  // in the next run's buffer, and an in-flight validate would still store its
  // token after the user pressed Cancel. Every callback and every post-await
  // step checks its own generation and no-ops if it has been superseded.
  let runId = 0

  function setState(next, why = null) {
    state = next
    reason = why
    // Log the STATE only. `why` is always one of this module's own fixed
    // strings, but the buffer it may have been derived from holds a token, so
    // the rule is enforced structurally rather than by remembering.
    log(`setup-token: ${next}${why ? ` (${why})` : ''}`)
  }

  function clearChild() {
    if (timer) { clearTimeout(timer); timer = null }
    child = null
    buffer = ''
  }

  function killChild() {
    if (!child) return
    try { child.kill() } catch (err) { log(`setup-token: kill failed: ${safeMessage(err && err.message)}`) }
  }

  // Anything derived from a caught error before it is logged. The catch below
  // wraps a NETWORK call whose error text this module does not control, so
  // "the message cannot contain the key" is not something it can assert --
  // it enforces it instead. Bounded too: a log line is not an error channel.
  const TOKEN_LIKE = /sk-ant-[A-Za-z0-9_-]+/g
  function safeMessage(msg) {
    return String(msg === undefined || msg === null ? '' : msg).replace(TOKEN_LIKE, '<redacted>').slice(0, 300)
  }

  async function finish(rawOutput, myRun) {
    // Disarm the timeout BEFORE the await below. Without this, a validate
    // call slower than the remaining timeout budget gets clobbered by its own
    // timer: the flow goes failed('timeout') and kills the child, and then
    // the resolving validate sets connected on top of it. 'validating' is not
    // a terminal state, so the guard inside the timer does not cover this --
    // found by mutation testing, which showed the guard was unreachable in
    // every case the tests exercised.
    if (timer) { clearTimeout(timer); timer = null }
    const extracted = extractSetupToken(rawOutput)
    // Drop the buffer before any await: from here on the only copy of the
    // credential is `extracted.token`, whose lifetime is this function.
    buffer = ''
    if (!extracted.found) {
      setState('failed', extracted.reason)
      clearChild()
      return
    }
    setState('validating')
    try {
      const result = await validateProviderKey(PROVIDER_ID, extracted.token)
      // Re-check the generation ACROSS the await. Cancel and timeout both
      // supersede the run, and until this check existed a user who pressed
      // Cancel during validation still had the credential written to the
      // keychain and watched the UI flip to "connected" -- the one thing
      // Cancel is supposed to prevent.
      if (myRun !== runId) return
      if (!result || !result.ok) {
        // The token was captured but Anthropic rejected it. This is the
        // designed landing spot for a mis-capture -- honest and visible,
        // rather than a stored credential that fails later at spawn time.
        setState('failed', 'token_rejected')
        clearChild()
        return
      }
      storeProviderKeyVerified(PROVIDER_ID, extracted.token) // throws -> caught below
      setState('connected')
    } catch (err) {
      if (myRun !== runId) return
      // Scrubbed, not trusted. The previous version of this comment claimed
      // err.message "can quote a provider id but never the key" -- true of
      // storeProviderKeyVerified, which this module owns, and NOT something
      // it can assert about validateProviderKey, which makes a network call
      // whose error text comes from elsewhere. A justification that confident
      // about a value it does not control is exactly the shape that has been
      // wrong before, so the guarantee is now enforced by safeMessage().
      log(`setup-token: store/validate threw: ${safeMessage(err && err.message)}`)
      setState('failed', 'store_failed')
    }
    clearChild()
  }

  function start() {
    if (child || state === 'validating') return { ok: true, alreadyRunning: true }
    const bin = resolveClaudeBin()
    if (!bin) {
      setState('failed', 'cli_missing')
      return { ok: false, reason: 'cli_missing' }
    }
    buffer = ''
    startedAt = now()
    // Claim a generation. This also supersedes any callbacks still held by a
    // previous child that was cancelled or timed out but has not exited yet.
    const myRun = ++runId
    setState('running')

    // Child-only env scrub. The parent's own credentials are never modified;
    // the child must simply not inherit an auth shortcut, or `setup-token`
    // can take an already-authenticated path and print nothing to capture.
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete childEnv.ANTHROPIC_BASE_URL
    // CLAUDE_CONFIG_DIR is deliberately NOT set. The manual instructions this
    // feature replaces tell the user to run `claude setup-token` in their own
    // shell, against their own config dir; matching that exactly keeps
    // behaviour identical to the path users and docs already know. The token
    // itself is config-dir independent -- setup-token persists nothing
    // (verified live: no keychain entry is created and the isolated config
    // JSON gains no credential fields), it only prints.

    try {
      child = spawnPty(bin, ['setup-token'], {
        name: 'xterm-256color',
        // Defense #1 against the wrap (see setup-token.cjs's header): at this
        // width a 108-character token occupies one line.
        cols: SETUP_TOKEN_PTY_COLS,
        rows: SETUP_TOKEN_PTY_ROWS,
        env: childEnv,
      })
    } catch (err) {
      log(`setup-token: spawn threw: ${safeMessage(err && err.message)}`)
      setState('failed', 'spawn_failed')
      clearChild()
      return { ok: false, reason: 'spawn_failed' }
    }

    child.onData((chunk) => {
      // Late output from a superseded run must not land in this buffer.
      if (myRun !== runId) return
      buffer += chunk
      // Bound the buffer. A CLI stuck in a redraw loop must not grow this
      // without limit; keeping the TAIL is correct because the token is
      // printed at the very end.
      if (buffer.length > 256 * 1024) buffer = buffer.slice(-64 * 1024)
      // State-only signal for the UI. Note this does NOT mean a paste is
      // required -- the localhost callback is racing and usually wins (see
      // the header). It means the fallback box may now be offered.
      if (state === 'running' && awaitingManualCode(buffer)) setState('awaiting_code')
    })

    child.onExit(() => {
      // Extract at EXIT, on the complete buffer. Parsing mid-stream risks
      // catching a wrapped token between its halves; setup-token prints and
      // exits immediately, so waiting costs nothing and removes the race.
      //
      // 'validating' is checked alongside the terminal states because finish()
      // is already in flight there and has emptied the buffer. A second exit
      // event would re-enter it with '', fail as no_output, and overwrite a
      // successful capture with a failure the user can see.
      if (myRun !== runId) { return }
      if (TERMINAL_STATES.has(state) || state === 'validating') { clearChild(); return }
      finish(buffer, myRun)
    })

    timer = setTimeout(() => {
      if (myRun !== runId || TERMINAL_STATES.has(state)) return
      setState('failed', 'timeout')
      // Supersede BEFORE killing: the kill produces an exit event, and this
      // run must not be able to act on it.
      runId++
      killChild()
      clearChild()
    }, timeoutMs)

    return { ok: true }
  }

  /**
   * Fallback path: hand the CLI an authorization code the user copied out of
   * the browser, for the case where the localhost callback did not land.
   */
  function submitCode(code) {
    if (!child) return { ok: false, reason: 'not_running' }
    if (!isPlausibleAuthCode(code)) return { ok: false, reason: 'invalid_code' }
    // Two separate writes, with the submit deferred. Learned by breaking it
    // during the spike: a "\r" glued onto the code is swallowed by the TUI --
    // the code renders as masked asterisks and nothing advances. The pty also
    // drops characters on a fast bulk write, which is why the spike's expect
    // driver needed a slow send; node-pty's write is not char-throttled, so
    // the separation is what remains available and it is the half that
    // actually fixed it.
    try {
      child.write(code)
      setTimeout(() => { try { child && child.write('\r') } catch { /* child gone */ } }, 250)
    } catch (err) {
      log(`setup-token: code write failed: ${safeMessage(err && err.message)}`)
      return { ok: false, reason: 'write_failed' }
    }
    setState('running')
    return { ok: true }
  }

  function cancel() {
    // `child` is still set while finish() awaits validation, which is exactly
    // the window this needs to cover -- cancelling there must stop the store,
    // not just kill a process that has already exited.
    if (!child) return { ok: true, alreadyStopped: true }
    setState('cancelled', 'user_cancelled')
    // Supersede FIRST. Everything still in flight for this generation -- the
    // pending validate, the pty's exit event, late output -- is now inert.
    runId++
    killChild()
    clearChild()
    return { ok: true }
  }

  /**
   * The ONLY thing this module exposes to a client. Fixed enum members and a
   * clock reading -- structurally incapable of carrying the credential or any
   * raw child output.
   */
  function status() {
    return {
      state,
      reason,
      elapsedMs: startedAt === null ? 0 : now() - startedAt,
      provider: PROVIDER_ID,
    }
  }

  return { start, submitCode, cancel, status }
}

// Lazy require, matching supervisor.mjs: node-pty is a native module and only
// this lane needs it, so a load failure must not take down the whole server
// at import time.
function defaultSpawnPty(bin, args, opts) {
  const pty = require('node-pty')
  return pty.spawn(bin, args, opts)
}

module.exports = {
  createSetupTokenSession,
  PROVIDER_ID,
  SETUP_TOKEN_TIMEOUT_MS,
  TERMINAL_STATES,
}
