// tests/test-setup-token.mjs -- tests for setup-token.cjs's pure parsing.
//
// The fixtures below reproduce the EXACT control-character framing recorded
// from a real `claude setup-token` run under a pty (CLI 2.1.220, 2026-07-29),
// with a fake token substituted for the real one. That framing is the point:
// the token WRAPS at the terminal width, and both bugs this module exists to
// prevent (capturing only the first half, or capturing the tail glued to the
// next word) are invisible against a hand-simplified fixture.
//
// No real credential appears in this file and none is needed -- the parser is
// pure. These tests are load-bearing: the downstream validity check
// (validateProviderKey('claude-subscription'), real since 2026-07-29, see
// tests/test-claude-subscription-validate.mjs) is FAIL-OPEN by design and
// rejects only an explicit 401 authentication_error, so it is a second net
// and not a substitute for this one. For the whole of this parser's first
// life that call was a hardcoded {ok:true} and four separate comments cited
// it as proof anyway -- do not thin these tests on the strength of it.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  extractSetupToken, awaitingManualCode, isPlausibleAuthCode, stripAnsi, renderedWidth,
  SETUP_TOKEN_PTY_COLS, TOKEN_PREFIX, WRAP_FILL_TOLERANCE,
} = require('../setup-token.cjs')

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++ } else { fail++; console.error(`FAIL: ${label}`) }
}

// ── fixtures ───────────────────────────────────────────────────────────────
const ESC = '\x1B'
// A fake token of realistic shape: prefix + 95 chars of the real alphabet,
// matching the length of the one token actually observed (108 total).
const BODY = 'AbC1' + 'x'.repeat(62) + '-_Qz9' + 'K'.repeat(24)
const FAKE = TOKEN_PREFIX + BODY
assert(FAKE.length === 108, 'fixture token is the observed length (108)')

// Recorded framing, WRAPPED (what an 80-column pty produces). The split point
// is the real one: the tail carried 29 characters onto the next line.
const WRAP_AT = BODY.length - 29
const wrapped = [
  `Your OAuth token (valid for 1 year):${ESC}[K\r\n`,
  `${ESC}[1C${ESC}[1B${ESC}[K\r\n`,
  `${ESC}[1C${ESC}[1B${ESC}[38;2;255;193;7m${TOKEN_PREFIX}${BODY.slice(0, WRAP_AT)}\r\n`,
  `${ESC}[1C${ESC}[1B${BODY.slice(WRAP_AT)}\r\n`,
  `${ESC}[1C${ESC}[2B${ESC}[38;2;153;153;153mStore this token securely. You won't be able to see it again.\r\n`,
  `${ESC}[1C${ESC}[1B${ESC}[39m${ESC}[K\r\n`,
  `${ESC}[1C${ESC}[1B${ESC}[38;2;153;153;153mUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\r\n`,
].join('')

// Same run at the width the app actually spawns (SETUP_TOKEN_PTY_COLS): the
// token fits on one line and never wraps.
const unwrapped = [
  `Your OAuth token (valid for 1 year):${ESC}[K\r\n`,
  `${ESC}[1C${ESC}[1B${ESC}[38;2;255;193;7m${FAKE}\r\n`,
  `${ESC}[1C${ESC}[2B${ESC}[38;2;153;153;153mStore this token securely. You won't be able to see it again.\r\n`,
].join('')

// Everything the CLI prints BEFORE the token, including the manual-code
// prompt that races the localhost callback.
const preTokenOutput = [
  `${ESC}[?25l${ESC}[1mClaude Code${ESC}[22m\r\n`,
  `Opening browser to complete authentication...\r\n`,
  `${ESC}[1C${ESC}[1BPaste code here if prompted > ${ESC}[K\r\n`,
].join('')

// The recorded session ran in an 80-column terminal -- that is WHY it wrapped.
// The parser only joins a line when the previous one filled the width, so the
// fixture must be parsed at the width that produced it. Passing the real cols
// is not test bookkeeping: it is the safety property (see WRAP_FILL_TOLERANCE).
const NARROW = { cols: 80 }

// ── extraction: the wrap, which is the whole reason this module exists ─────
{
  const r = extractSetupToken(wrapped, NARROW)
  assert(r.found === true, 'wrapped: token is found')
  assert(r.token === FAKE, 'wrapped: token is re-joined across the line break IN FULL')
  // The two specific bugs, named:
  assert(r.token.length === 108, 'wrapped: not truncated to the first line (the fragment bug)')
  assert(!/Store/.test(r.token), 'wrapped: does not glue the trailer word on (the greedy-match bug)')
  assert(!/\s/.test(r.token), 'wrapped: no whitespace survives into the token')
}
{
  const r = extractSetupToken(unwrapped)
  assert(r.found === true && r.token === FAKE, 'unwrapped (wide pty): token extracted whole')
}

// Non-vacuity: if the parser did NOT un-wrap, the wrapped case would yield
// exactly the first-line fragment. Assert that fragment is a DIFFERENT and
// shorter string, so the equality above cannot pass by accident.
{
  const fragment = TOKEN_PREFIX + BODY.slice(0, WRAP_AT)
  assert(fragment !== FAKE && fragment.length < FAKE.length,
    'non-vacuity: the un-wrapped fragment is materially different from the full token')
  assert(extractSetupToken(wrapped, NARROW).token !== fragment,
    'non-vacuity: parser returns the joined token, not the fragment')
}

// Non-vacuity for the greedy bug: build what a naive strip-then-join would
// produce and assert the parser does not produce it.
{
  const naive = stripAnsi(wrapped).replace(/[\r\n]/g, '')
  const m = naive.match(/sk-ant-oat01-[A-Za-z0-9_-]+/)
  assert(m && m[0].startsWith(FAKE) && m[0].length > FAKE.length,
    'non-vacuity: the naive greedy match really does over-capture on this fixture')
  assert(extractSetupToken(wrapped, NARROW).token !== m[0],
    'non-vacuity: parser does not reproduce the naive over-capture')
}

// ── extraction: negative cases ─────────────────────────────────────────────
{
  const r = extractSetupToken(preTokenOutput)
  assert(r.found === false && r.reason === 'no_token_in_output', 'pre-token output: not found, named reason')
}
assert(extractSetupToken('').found === false, 'empty string: not found')
assert(extractSetupToken('').reason === 'no_output', 'empty string: reason is no_output')
assert(extractSetupToken(undefined).found === false, 'undefined: not found (no throw)')
assert(extractSetupToken(null).found === false, 'null: not found (no throw)')
assert(extractSetupToken(12345).found === false, 'non-string: not found (no throw)')
{
  const r = extractSetupToken(`${TOKEN_PREFIX}short\r\n`)
  assert(r.found === false && r.reason === 'token_too_short', 'too-short body is rejected, not returned')
}
{
  const r = extractSetupToken(`${TOKEN_PREFIX}${'A'.repeat(500)}\r\n`)
  assert(r.found === false && r.reason === 'token_too_long', 'over-long body is rejected')
}

// The continuation loop must stop at prose. Without this, the trailer would
// be absorbed whenever it happened to lack a space.
{
  const r = extractSetupToken(
    `${TOKEN_PREFIX}${BODY.slice(0, WRAP_AT)}\r\n${BODY.slice(WRAP_AT)}\r\nStore this token securely.\r\n`, NARROW)
  assert(r.token === FAKE, 'continuation stops at the real trailer line')
}
{
  // The assertion above passes on the real trailer for several reasons at
  // once (space, period, apostrophe). Isolate the SPACE so the guarantee is
  // actually pinned: a line drawn entirely from the token alphabet except for
  // one space must still terminate the run.
  const r = extractSetupToken(`${TOKEN_PREFIX}${BODY}\r\nAAAA BBBB\r\n`)
  assert(r.token === FAKE, 'a single space is disqualifying on its own -- continuation stops')
}
{
  // Same isolation for the other end: a line that is pure token alphabet is
  // absorbed, so the stop above is attributable to the space and not to the
  // loop simply never running.
  const r = extractSetupToken(`${TOKEN_PREFIX}${BODY.slice(0, WRAP_AT)}\r\n${BODY.slice(WRAP_AT)}\r\n`, NARROW)
  assert(r.token === FAKE, 'control: a pure-alphabet line IS absorbed, so the space test is meaningful')
}
{
  // A blank line between token and trailer must also stop absorption.
  const r = extractSetupToken(`${TOKEN_PREFIX}${BODY}\r\n\r\nAAAA\r\n`)
  assert(r.token === FAKE, 'a blank line terminates the continuation run')
}

// ── the wrap-fill rule: what CLOSED the silent-corruption hole ─────────────
// This block used to assert the opposite. A bare word on the line after the
// token was absorbed into it, justified by "validate downstream is the real
// gate" -- and that gate does not exist (see this file's header). The result
// would have been a corrupted credential stored successfully, the user told
// "Connected", and a failure surfacing much later with nothing pointing back
// at onboarding. A wrap can only occur at the right margin, so the line
// before a continuation must have FILLED the terminal.
{
  // 108-char token line in a 200-column terminal followed by a bare word.
  // This FAILS CLOSED rather than returning a token, and that is the third
  // position this block has held today -- worth spelling out why it landed
  // here. Absorbing the word corrupts the credential. Silently dropping it
  // was the obvious correction, but it is only right if the word really is a
  // stray: if instead our width measurement were low and this were a genuine
  // wrap, dropping it TRUNCATES the credential. Both outcomes store a broken
  // token and tell the user "Connected", and nothing in the byte stream tells
  // them apart. With no downstream validation to catch either, the only
  // honest answer is to refuse and let the user retry.
  const r = extractSetupToken(`${TOKEN_PREFIX}${BODY}\r\nBAREWORD\r\n`)
  assert(r.found === false, 'a bare adjacent word makes the capture ambiguous -- refuse, do not guess')
  assert(r.reason === 'ambiguous_wrap', 'and says so by name')
  assert(r.token === undefined, 'no token is returned in the ambiguous case')
}
{
  // Same bytes, but now the token line genuinely fills an 80-column terminal
  // (the recorded case): the continuation IS a wrap and must be joined.
  const r = extractSetupToken(`${TOKEN_PREFIX}${BODY.slice(0, WRAP_AT)}\r\n${BODY.slice(WRAP_AT)}\r\n`, NARROW)
  assert(r.token === FAKE, 'a real wrap is still re-joined -- the rule discriminates, it does not just refuse')
}
{
  // The discriminator is the WIDTH, nothing else: identical input, two widths,
  // two answers. If this pair ever agrees, the rule has stopped working.
  const input = `${TOKEN_PREFIX}${BODY.slice(0, WRAP_AT)}\r\n${BODY.slice(WRAP_AT)}\r\n`
  const narrow = extractSetupToken(input, { cols: 80 })
  const wide = extractSetupToken(input, { cols: 200 })
  assert(narrow.found === true && narrow.token === FAKE, 'at the width that produced the wrap: joined')
  assert(wide.found === false && wide.reason === 'ambiguous_wrap',
    'at a width where no wrap could occur: refused, not silently truncated')
}
{
  // The tolerance boundary, expressed in terms of the CONSTANT rather than a
  // hardcoded copy of its current value. Written as literals, this pair
  // silently stops testing the boundary the moment the constant moves -- and
  // it did move (8 -> 2) in the same change that added indent counting.
  const line = TOKEN_PREFIX + BODY.slice(0, 40) // 53 chars, single-line
  const justOutside = extractSetupToken(`${line}\r\nAAAABBBB\r\n`, { cols: line.length + WRAP_FILL_TOLERANCE + 1 })
  assert(justOutside.found === false && justOutside.reason === 'ambiguous_wrap',
    'just outside the fill tolerance: not a wrap, and ambiguous -> refused')
  const justInside = extractSetupToken(`${line}\r\nAAAABBBB\r\n`, { cols: line.length + WRAP_FILL_TOLERANCE })
  assert(justInside.found === true && justInside.token === line + 'AAAABBBB',
    'just inside the fill tolerance: treated as a wrap and joined')
}

{
  // The boundary pair above is written symbolically, so it proves the
  // arithmetic is APPLIED correctly but moves with the constant and therefore
  // cannot notice the constant's value changing. That is the exact trade: a
  // hardcoded 8 stops testing the boundary when the number moves, a symbolic
  // one stops testing the number. Both matter, so the VALUE gets its own
  // assertion.
  //
  // It must stay small. renderedWidth() now counts the cursor-forward indent,
  // so measurement error is ~0 and slack buys nothing -- while every extra
  // column of tolerance widens the window in which a non-wrap is treated as a
  // wrap. It was 8 when the indent was being discarded, which is how a
  // genuine wrap at indent>=8 came back TRUNCATED and marked successful.
  assert(WRAP_FILL_TOLERANCE <= 2,
    `WRAP_FILL_TOLERANCE stays tight now that indent is measured (got ${WRAP_FILL_TOLERANCE})`)
  assert(WRAP_FILL_TOLERANCE >= 1, 'but non-zero, so an off-by-one in cell accounting is absorbed')
}

// ── the INDENT must be counted, not discarded ──────────────────────────────
// This is the failure the third review reproduced. The CLI indents with a
// cursor-forward (ESC[nC), which emits no character -- so a stripped line is
// shorter than the column the row actually reaches. Measuring the stripped
// length made a genuinely full row look short, the join was refused, and a
// TRUNCATED token came back as found:true. Same silent corruption as the bug
// this rule was added to stop, entered from the other side.
{
  // Build the recorded wrap at a range of indents, keeping the RENDERED width
  // constant at 80 so every case is a genuine wrap that must be re-joined.
  for (const indent of [1, 2, 4, 8, 16, 30]) {
    const head = `${ESC}[${indent}C${ESC}[1B${ESC}[38;2;255;193;7m`
    const cut = WRAP_AT - (indent - 1)
    const input =
      `${head}${TOKEN_PREFIX}${BODY.slice(0, cut)}\r\n` +
      `${ESC}[${indent}C${ESC}[1B${BODY.slice(cut)}\r\n` +
      `${ESC}[${indent}C${ESC}[2BStore this token securely.\r\n`
    const r = extractSetupToken(input, NARROW)
    assert(r.found === true && r.token === FAKE,
      `indent=${indent}: a real wrap is still joined in full (no silent truncation)`)
  }
}
{
  // Non-vacuity for the loop above: prove the indent actually moves the
  // measurement, so those cases are not all trivially identical.
  const bare = `${TOKEN_PREFIX}${BODY.slice(0, 40)}`
  assert(renderedWidth(bare) === bare.length, 'no indent: rendered width == stripped length')
  assert(renderedWidth(`${ESC}[9C${bare}`) === bare.length + 9, 'ESC[9C adds exactly 9 cells')
  assert(renderedWidth(`${ESC}[C${bare}`) === bare.length + 1, 'a parameterless ESC[C means one cell')
  assert(renderedWidth(`${ESC}[2C${ESC}[3C${bare}`) === bare.length + 5, 'multiple cursor-forwards accumulate')
  assert(renderedWidth(`${ESC}[38;2;1;2;3m${bare}${ESC}[0m`) === bare.length, 'colour codes add no width')
}

// ── reason strings must never carry the buffer ─────────────────────────────
// The buffer contains a credential. Any reason reaching a client must be a
// fixed enum member.
for (const input of ['', preTokenOutput, `${TOKEN_PREFIX}short\r\n`, `${TOKEN_PREFIX}${'A'.repeat(500)}\r\n`]) {
  const r = extractSetupToken(input)
  if (r.found) continue
  assert(['no_output', 'no_token_in_output', 'token_too_short', 'token_too_long', 'token_malformed'].includes(r.reason),
    `reason is a fixed enum member, not interpolated output (got: ${r.reason})`)
  assert(!r.reason.includes(TOKEN_PREFIX), 'reason never contains the token prefix')
  assert(r.reason.length < 40, 'reason is short enough to be a constant, not an echo')
}

// ── manual-code prompt detection ───────────────────────────────────────────
assert(awaitingManualCode(preTokenOutput) === true, 'manual prompt detected through ANSI framing')
assert(awaitingManualCode(unwrapped) === false, 'no false positive on token output')
assert(awaitingManualCode('') === false, 'empty: no manual prompt')
assert(awaitingManualCode(null) === false, 'null: no manual prompt (no throw)')

// ── auth-code shape gate (injection defense on a pty write) ────────────────
assert(isPlausibleAuthCode('abc12345') === true, 'plain code accepted')
assert(isPlausibleAuthCode('AbC-123_x#state/9=') === true, 'real-world code alphabet accepted')
assert(isPlausibleAuthCode('short') === false, 'too-short code rejected')
assert(isPlausibleAuthCode('a'.repeat(600)) === false, 'over-long code rejected')
// These are the ones that matter: a pty interprets control characters.
assert(isPlausibleAuthCode('abc12345\r') === false, 'carriage return rejected (would submit early)')
assert(isPlausibleAuthCode('abc12345\n') === false, 'newline rejected (would submit early)')
assert(isPlausibleAuthCode('abc12345\x1B[2J') === false, 'escape sequence rejected (would drive the TUI)')
assert(isPlausibleAuthCode('abc12345 rm -rf') === false, 'whitespace/command text rejected')
assert(isPlausibleAuthCode('abc\x00 12345') === false, 'NUL byte rejected')
assert(isPlausibleAuthCode(undefined) === false, 'undefined rejected (no throw)')
assert(isPlausibleAuthCode({ toString: () => 'abc12345' }) === false, 'non-string rejected without coercion')

// ── pty geometry ───────────────────────────────────────────────────────────
// Defense #1. If this drifts back toward 80, the wrap returns and the parser
// becomes the only thing standing between the user and a broken capture.
assert(SETUP_TOKEN_PTY_COLS >= 200, 'pty cols is wide enough that a 108-char token cannot wrap')
assert(SETUP_TOKEN_PTY_COLS > 108 * 1.5, 'pty cols keeps real headroom over the observed token length')

// ── stripAnsi ──────────────────────────────────────────────────────────────
assert(stripAnsi(`${ESC}[38;2;1;2;3mred${ESC}[39m`) === 'red', 'strips truecolor SGR')
assert(stripAnsi(`${ESC}[1C${ESC}[2Bxy`) === 'xy', 'strips cursor movement')
assert(stripAnsi(`${ESC}]0;title\x07body`) === 'body', 'strips OSC with BEL terminator')
assert(stripAnsi(`${ESC}]0;title${ESC}\\body`) === 'body', 'strips OSC with ST terminator')
assert(stripAnsi('plain') === 'plain', 'leaves plain text alone')
assert(!stripAnsi(wrapped).includes(ESC), 'no ESC survives the recorded fixture')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
