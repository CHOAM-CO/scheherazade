// setup-token.cjs -- pure parsing for `claude setup-token` pty output.
//
// WHY A SEPARATE MODULE, AND WHY PURE: the value this extracts is a
// long-lived (1 year) OAuth token. It must never be logged, echoed to a
// client, or written to disk by anything here -- so the extraction is
// isolated from the spawn/IO that surrounds it, and can be tested
// exhaustively against recorded terminal framing with no child process and
// no real credential in the loop. The caller owns the token's lifetime; this
// file only ever turns a string into a shorter string.
//
// GROUND TRUTH (recorded from a real `claude setup-token` run under a pty,
// CLI 2.1.220, 2026-07-29, before the log was deleted). The interesting part
// is that the token is WRAPPED at the terminal width, so a naive line parse
// gets a fragment and a naive greedy match gets the token plus the next word:
//
//   Your OAuth token (valid for 1 year):ESC[K            CR LF
//   ESC[1C ESC[1B ESC[K                                  CR LF
//   ESC[1C ESC[1B ESC[38;2;255;193;7m sk-ant-oat01-<..>  CR LF   <- token, part 1
//   ESC[1C ESC[1B <29 more chars>                        CR LF   <- token, part 2
//   ESC[1C ESC[2B ESC[38;..m Store this token securely.  CR LF   <- trailer
//
// An earlier note of mine claimed the token was "not newline-terminated".
// That was wrong and is corrected here against the raw: every pty line IS
// CR-LF terminated. The failure mode is un-wrapping, not termination -- once
// you strip ANSI and join lines, `sk-ant-oat01-[A-Za-z0-9_-]+` runs the
// token's tail straight into "Store".
//
// Two independent defenses, because either alone is a single point of
// failure:
//   1. The caller spawns the pty WIDE (see SETUP_TOKEN_PTY_COLS) so the
//      wrap does not happen in the first place.
//   2. This parser un-wraps anyway, so a narrower terminal, a future CLI
//      that pads differently, or a resize mid-flow still yields the token.
//
// What this deliberately does NOT do: pin a token LENGTH. The one real token
// I have measured was 108 characters, but a sample of one is not a spec, and
// a wrong length check fails closed on a token that would have worked.
//
// THERE IS NO DOWNSTREAM VALIDITY CHECK. An earlier version of this comment
// said validity was "proven by the caller handing the result to the same
// provider-validation call the manual paste path already uses", so a
// mis-capture would surface as an honest "token rejected". That was FALSE and
// it was load-bearing: validateProviderKey('claude-subscription', ...) is a
// hardcoded `return { ok: true }` for any non-empty string
// (onboarding/http-server.cjs, the claude-subscription branch) -- it never
// contacts Anthropic, because a setup-token OAuth token is not an x-api-key
// and the original design declined to build a pty driver just to exercise it.
// Nothing can produce 'token_rejected' for this provider today.
//
// So this parser IS the gate, and it is written that way: the un-wrap below
// only joins a line when the previous line actually FILLED the terminal,
// which is the only condition under which a wrap can occur. Without that
// check a bare word printed after the token was silently absorbed into it,
// stored, and reported to the user as "Connected" -- a keychain entry that
// fails the first time the real agent spawns, with nothing pointing back
// here. Making claude-subscription validation real is the right follow-up,
// but it needs a live token to verify against and must not be guessed at:
// a wrong validation call rejects credentials that work.
'use strict'

// Matches the supervisor's pty geometry (supervisor.mjs spawnPtyChild uses
// cols: 200, rows: 50). 200 is ~2x the longest token observed, so the token
// occupies one line and defense #1 above holds. Exported so the test can
// assert the caller actually uses it -- a default that silently drifts back
// to 80 would re-introduce the wrap this module was written for.
const SETUP_TOKEN_PTY_COLS = 200
const SETUP_TOKEN_PTY_ROWS = 50

// The token's own alphabet. Anthropic OAuth tokens are base64url-ish; this is
// the character class the recorded sample used and the class the wrap-join
// below relies on to decide "this line is a continuation, not prose".
const TOKEN_CHARS = 'A-Za-z0-9_-'
const TOKEN_PREFIX = 'sk-ant-oat01-'

// Lower bound only (see the header's note on not pinning a length). 20 is
// comfortably below the 95-char body observed and comfortably above anything
// that could be a stray fragment of the prefix line.
const TOKEN_MIN_BODY = 20
// Upper bound is a sanity rail against pathological input (a runaway join
// across a corrupted stream), not a claim about token size.
const TOKEN_MAX_BODY = 400

// CSI (ESC [ ... final) plus OSC (ESC ] ... BEL | ST). The recorded stream
// uses CSI only -- colour (ESC[38;2;r;g;bm), cursor moves (ESC[1C, ESC[1B,
// ESC[2B) and erase (ESC[K) -- but OSC is stripped too so a title-setting
// sequence can never end up inside a captured token.
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g
// Bare ESC-<single char> (e.g. ESC(B charset select), which appears in the
// recorded stream's tail and would otherwise survive as a literal.
const ANSI_ESC_SHORT = /\x1B[@-Z\\-_]/g

function stripAnsi(text) {
  return String(text).replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_ESC_SHORT, '')
}

// Cursor-forward (CSI n C) moves the cursor right WITHOUT emitting a
// character, which is how this CLI indents -- it does not pad with spaces.
// stripAnsi deletes those sequences, so a stripped line is shorter than the
// column the row actually reaches. That undercount is the dangerous direction
// for the wrap rule below: it makes a genuinely full row look short, the join
// is refused, and a TRUNCATED token is returned as a successful capture. So
// the cells are counted rather than assumed to be small.
// `CSI C` with no parameter means 1.
const ANSI_CURSOR_FORWARD = /\x1B\[(\d*)C/g
function renderedWidth(rawLine) {
  const line = String(rawLine)
  let forward = 0
  for (const m of line.matchAll(ANSI_CURSOR_FORWARD)) forward += m[1] === '' ? 1 : Number(m[1])
  return stripAnsi(line).length + forward
}

// Split on CRLF, LF, or a bare CR. A lone CR in a TUI means "return to
// column 0", i.e. what follows overwrites rather than appends -- treating it
// as a line break is the conservative reading: it can only split a token that
// was already going to be re-rendered, and the wrap-join below puts such a
// split back together. Gluing across it, by contrast, is exactly the bug that
// produced "...pNQAAStore".
function toLines(text) {
  return stripAnsi(text).split(/\r\n|\r|\n/)
}

// Split the RAW stream first, so each line's cursor-forward cells can be
// attributed to that line before its escapes are discarded. Splitting after
// stripping (what this did originally) loses that information irrecoverably.
function toLineRecords(text) {
  return String(text).split(/\r\n|\r|\n/).map((raw) => ({
    text: stripAnsi(raw).trim(),
    width: renderedWidth(raw),
  }))
}

// Is this line a pure continuation of a wrapped token? Prose lines all
// contain spaces or punctuation outside the token alphabet; the recorded
// trailer ("Store this token securely...") fails on its first space.
const CONTINUATION_RE = new RegExp(`^[${TOKEN_CHARS}]+$`)

// How far short of the terminal width a row may fall and still count as
// "filled". Now that renderedWidth() counts the cursor-forward indent instead
// of discarding it, the only remaining sources of undercount are exotic
// (a multi-cell character in a token drawn from single-width ASCII; a cursor
// move this parser does not model). So this is small on purpose.
//
// It was 8, chosen to be "small enough that a 108-char line can't look full".
// That reasoning defended only the ceiling -- over-joining. The floor is the
// direction that actually hurts: if the measured width is too LOW, a genuine
// wrap is refused and a TRUNCATED token is returned as a successful capture,
// which is the same silent-corruption failure this rule was added to stop,
// just from the other side. With indent counted, measurement error is ~0 and
// a wide tolerance buys nothing while widening the over-join window.
const WRAP_FILL_TOLERANCE = 2

/**
 * Extract the OAuth token from accumulated `claude setup-token` pty output.
 *
 * Call this on the COMPLETE buffer -- in practice when the child exits, which
 * setup-token does immediately after printing. Calling it mid-stream is safe
 * (it returns {found:false} until the token is present) but can return a
 * fragment if invoked between the two halves of a wrapped token, which is
 * precisely the race the caller avoids by parsing at close.
 *
 * @param {string} rawOutput
 * @param {{cols?: number}} [opts]  the terminal width the pty was spawned
 *   with. A following line is only joined when the preceding line FILLED that
 *   width -- the sole condition that produces a wrap. Pass the real value;
 *   the default assumes this module's own spawn geometry.
 * @returns {{found: true, token: string} | {found: false, reason: string}}
 *   `reason` is a fixed enum member, never interpolated child output: this
 *   value is allowed to reach a client, and the buffer it was derived from
 *   contains a credential.
 */
function extractSetupToken(rawOutput, opts = {}) {
  const cols = typeof opts.cols === 'number' && opts.cols > 0 ? opts.cols : SETUP_TOKEN_PTY_COLS
  if (typeof rawOutput !== 'string' || rawOutput === '') {
    return { found: false, reason: 'no_output' }
  }
  const lines = toLineRecords(rawOutput)
  const startIdx = lines.findIndex((line) => line.text.includes(TOKEN_PREFIX))
  if (startIdx === -1) return { found: false, reason: 'no_token_in_output' }

  // Take from the prefix to end-of-line. Anything before it on that line is
  // rendering (indentation, colour) -- the prefix is the anchor.
  const first = lines[startIdx]
  let body = first.text.slice(first.text.indexOf(TOKEN_PREFIX) + TOKEN_PREFIX.length).trim()

  // Un-wrap: absorb following lines while they are pure token alphabet AND
  // the line before them actually filled the terminal. A wrap can only happen
  // at the right margin, so a short token line followed by a bare word is NOT
  // a wrap and joining them would silently corrupt the credential. (It did,
  // before this check: the corrupted value stored fine and the user was told
  // "Connected".) The loop is bounded by TOKEN_MAX_BODY rather than by a line
  // count so a stream of junk cannot build an unbounded string.
  const filled = (line) => line.width >= cols - WRAP_FILL_TOLERANCE
  let prevFilled = filled(first)
  let stoppedOnCandidate = false
  for (let i = startIdx + 1; i < lines.length; i++) {
    const next = lines[i].text
    const isCandidate = CONTINUATION_RE.test(next)
    if (!prevFilled) {
      // A continuation-shaped line that we are NOT joining. This is the
      // ambiguous case and it is dangerous in BOTH directions: either it is a
      // bare word that would corrupt the token if joined, or it is a real wrap
      // whose first line we measured as short and refusing it TRUNCATES the
      // token. Nothing in the byte stream distinguishes them, and there is no
      // downstream validation to catch either. Fail closed.
      stoppedOnCandidate = isCandidate
      break
    }
    if (!isCandidate) break
    if (body.length + next.length > TOKEN_MAX_BODY) break
    body += next
    prevFilled = filled(lines[i])
  }
  if (stoppedOnCandidate) return { found: false, reason: 'ambiguous_wrap' }

  if (body.length < TOKEN_MIN_BODY) return { found: false, reason: 'token_too_short' }
  if (body.length > TOKEN_MAX_BODY) return { found: false, reason: 'token_too_long' }
  if (!CONTINUATION_RE.test(body)) return { found: false, reason: 'token_malformed' }

  return { found: true, token: TOKEN_PREFIX + body }
}

/**
 * Does the buffer show the CLI asking for a manual authorization code?
 *
 * The CLI races a localhost /callback listener against this prompt (verified
 * by reading the 2.1.220 binary: waitForAuthorizationCode resolves from
 * whichever arrives first, and buildAuthUrl is called twice, isManual true
 * and false). So the prompt appearing does NOT mean a paste is required --
 * the automatic redirect usually wins. It only means the fallback is
 * available, which is what the UI needs to know before offering a code box.
 */
const MANUAL_PROMPT = 'Paste code here'
function awaitingManualCode(rawOutput) {
  if (typeof rawOutput !== 'string') return false
  return stripAnsi(rawOutput).includes(MANUAL_PROMPT)
}

/**
 * Shape-check an authorization code before it is written into the child's
 * stdin. This is injection defense, not validation: the value goes to a pty
 * that interprets control characters, so a newline would submit early and an
 * escape sequence could drive the TUI. Codes are opaque; only the alphabet
 * and a length rail are asserted.
 */
const AUTH_CODE_RE = /^[A-Za-z0-9_#/=+-]{8,512}$/
function isPlausibleAuthCode(code) {
  return typeof code === 'string' && AUTH_CODE_RE.test(code)
}

module.exports = {
  extractSetupToken,
  awaitingManualCode,
  isPlausibleAuthCode,
  stripAnsi,
  renderedWidth,
  WRAP_FILL_TOLERANCE,
  SETUP_TOKEN_PTY_COLS,
  SETUP_TOKEN_PTY_ROWS,
  TOKEN_PREFIX,
}
