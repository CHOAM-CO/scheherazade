// scripts/test-setup-token-copy.mjs -- the seam between the server's failure
// reasons and the copy that explains them, plus the wizard wiring that has no
// other harness.
//
// WHY THIS FILE EXISTS: browser JS in this repo runs in no test. On the
// provider branch that gap let a wrong predicate ship twice, so the fix there
// was to extract the function BY NAME from the real source and run it. Same
// technique here, aimed at the contract most likely to drift silently: the
// session emits a fixed enum of failure reasons, and copy.js switches on
// those strings. Add a reason server-side, forget the copy, and the user gets
// a generic sentence instead of the one thing that would tell them what to do
// -- with nothing anywhere going red.
//
// The reason set is derived from the SOURCE of the modules that emit it, not
// re-typed here. A hand-maintained list would drift in exactly the way this
// test is meant to catch.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++ } else { fail++; console.error(`FAIL: ${label}`) }
}

const sessionSrc = fs.readFileSync(path.join(ROOT, 'setup-token-session.cjs'), 'utf8')
const parserSrc = fs.readFileSync(path.join(ROOT, 'setup-token.cjs'), 'utf8')
const copySrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'public', 'js', 'copy.js'), 'utf8')
const wizardSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'public', 'js', 'wizard.js'), 'utf8')
const routeSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'setup-token.cjs'), 'utf8')

// ── derive the server's failure-reason enum from source ────────────────────
// setState('failed', 'X') in the session, plus the parser's own {found:false,
// reason:'X'} members, which the session passes straight through.
const sessionReasons = [...sessionSrc.matchAll(/setState\('failed',\s*'([a-z_]+)'\)/g)].map((m) => m[1])
const parserReasons = [...parserSrc.matchAll(/reason:\s*'([a-z_]+)'\s*\}/g)].map((m) => m[1])
const reasons = [...new Set([...sessionReasons, ...parserReasons])]

assert(sessionReasons.length >= 4, `extraction found session reasons (got ${sessionReasons.length})`)
assert(parserReasons.length >= 4, `extraction found parser reasons (got ${parserReasons.length})`)
// Non-vacuity: if the regexes silently matched nothing, every coverage check
// below would pass over an empty set.
assert(reasons.includes('timeout') && reasons.includes('cli_missing') && reasons.includes('token_rejected'),
  'extraction found reasons known to exist by name -- the regexes are really matching')

// ── extract copy.js's failure mapper and run it ────────────────────────────
// Pull the inApp.failure arrow function out of the real file rather than
// re-declaring it, so this test breaks when THAT function changes.
const failureMatch = copySrc.match(/failure:\s*\(reason\)\s*=>\s*\(\{[\s\S]*?\}\[reason\]\s*\|\|\s*'[^']*'\)/)
assert(Boolean(failureMatch), 'located inApp.failure in copy.js')
// The extracted text is an arrow function; parenthesise it before calling, or
// `(reason) => (X)(reason)` parses as "call X's result", which hands back the
// arrow itself instead of a string.
const failureExpr = failureMatch ? failureMatch[0].replace(/^failure:\s*/, '') : ''
// copy.js's strings interpolate its platform layer (THIS_MACHINE / SHELL_APP /
// CRED_STORE*, added 2026-08-03 so the UI stops calling a Windows box "this
// Mac"). Those are module-level consts in the browser; a bare new Function has
// no binding for them, so they are injected as parameters here. Building the
// mapper once PER PLATFORM also makes this test prove the mapper survives both
// -- a string that only renders on mac is exactly the bug being fixed.
const PLATFORM_BINDINGS = {
  darwin: ['this Mac', 'Terminal', "this Mac's keychain", 'the macOS keychain'],
  win32: ['this computer', 'PowerShell', "this computer's encrypted credential store", "the OS's encrypted credential store"],
}
const makeFailureFn = (platform) =>
  new Function('reason', 'THIS_MACHINE', 'SHELL_APP', 'CRED_STORE', 'CRED_STORE_THE',
    `return (${failureExpr})(reason)`)
    .bind(null)
const callFailure = (platform, reason) =>
  makeFailureFn(platform)(reason, ...PLATFORM_BINDINGS[platform])
const failureFn = failureMatch ? (reason) => callFailure('darwin', reason) : null
assert(failureFn === null || typeof failureFn('cli_missing') === 'string',
  'extraction yields a function returning STRINGS (not the arrow itself)')

if (failureFn) {
  const generic = failureFn('a_reason_that_will_never_exist')
  assert(typeof generic === 'string' && generic.length > 0, 'unknown reason falls back to a non-empty string')

  // Every reason the server can emit must map to something SPECIFIC. The
  // fallback existing is good; a reason silently landing on it is the drift.
  //
  // user_cancelled is included because cancel() sets it and the UI renders
  // cancelled through the same failure() call.
  // Same completeness check on the Windows bindings: a mapper that throws or
  // returns undefined off macOS ships a blank error message to the user.
  for (const reason of [...reasons, 'user_cancelled']) {
    const winText = callFailure('win32', reason)
    assert(typeof winText === 'string' && winText.length > 0,
      `win32 bindings render "${reason}" as a non-empty string`)
  }

  const emitted = [...reasons, 'user_cancelled']
  for (const r of emitted) {
    const msg = failureFn(r)
    assert(typeof msg === 'string' && msg.length > 0, `reason "${r}" produces a message`)
    assert(msg !== generic, `reason "${r}" has its OWN message, not the generic fallback`)
  }

  // The two the user can actually act on must say what to do, not just that
  // something failed. cli_missing is the only one with an external remedy.
  assert(/install/i.test(failureFn('cli_missing')), 'cli_missing tells the user to install something')
  assert(/again|manual/i.test(failureFn('timeout')), 'timeout tells the user what to do next')

  // Copy must not leak implementation vocabulary into a user-facing line.
  for (const r of emitted) {
    const msg = failureFn(r)
    assert(!/pty|stdout|buffer|enum|regex|sk-ant/i.test(msg), `reason "${r}" message is free of implementation jargon`)
    assert(!msg.includes('_'), `reason "${r}" message does not spell a raw reason code at the user`)
  }
}

// ── copy honesty constraints ───────────────────────────────────────────────
// The CLI opens a browser and races a localhost callback against a paste
// prompt. Copy that promises no browser, or presents the code box as a
// required step, would be describing a flow that does not exist -- the same
// failure the Ollama "friction-moved, not friction-removed" note guards.
const inAppMatch = copySrc.match(/inApp:\s*\{[\s\S]*?\n {10}\},/)
assert(Boolean(inAppMatch), 'located the inApp copy block')
if (inAppMatch) {
  const block = inAppMatch[0]
  assert(/browser/i.test(block), 'copy tells the user a browser will open')
  assert(!/no browser|without a browser|one[- ]click/i.test(block), 'copy does not promise a browser-free or one-click flow')
  // The code prompt must be conditional. "If" is the whole difference between
  // an optional fallback and an instruction.
  const codePrompt = block.match(/codePrompt:\s*"([^"]*)"/)
  assert(Boolean(codePrompt), 'codePrompt is present')
  assert(codePrompt && /^If\b/i.test(codePrompt[1]), 'codePrompt is conditional ("If ..."), not an instruction')
}

// ── wizard wiring pins ─────────────────────────────────────────────────────
// These are source-text pins, which this repo already relies on elsewhere;
// they are here because the alternative is no coverage at all for a file that
// spawns a CLI child and moves a credential.

// Endpoints the UI must call, exactly as the routes define them.
for (const route of ['/api/setup-token/start', '/api/setup-token/status', '/api/setup-token/code', '/api/setup-token/cancel']) {
  assert(routeSrc.includes(`pathname === '${route}'`), `route ${route} is defined server-side`)
  assert(wizardSrc.includes(`'${route}'`), `wizard calls ${route}`)
}

// On success the server has ALREADY validated and stored the credential, and
// there is no key in the form. Routing Next back through validateNextHandler
// would POST an empty key to /api/byok/validate and fail a flow that
// succeeded. Pin the direct advance.
const connectedBlock = wizardSrc.match(/st === 'connected'\)\s*\{[\s\S]*?\}\s*else if/)
assert(Boolean(connectedBlock), 'located the connected branch in wizard.js')
if (connectedBlock) {
  assert(/showStep\('2'\)/.test(connectedBlock[0]), 'connected advances the wizard directly')
  assert(!/validateNextHandler|wireValidateNext/.test(connectedBlock[0]),
    'connected does NOT re-enter the key-validate handler (there is no key to send)')
  assert(/nextBtn\.disabled = false/.test(connectedBlock[0]), 'connected un-gates Next')
}

// The code box must not be visible until the CLI asks for it.
assert(/codeField\.className = 'field hidden'/.test(wizardSrc), 'code box starts hidden')
const awaitingIdx = wizardSrc.indexOf("st === 'awaiting_code'")
const revealIdx = wizardSrc.indexOf("codeField.classList.remove('hidden')")
assert(awaitingIdx !== -1 && revealIdx !== -1 && revealIdx > awaitingIdx,
  'the code box is revealed only under the awaiting_code branch')

// ORDER pin: renderClaudeArea's reset un-hides the key field for every tab,
// so the in-app default must re-hide it AFTER that reset. Written the other
// way round the field is visible with Next gated, which reads as a broken
// form. Compare positions rather than trusting the read.
const resetIdx = wizardSrc.indexOf("keyFieldWrap.classList.remove('hidden')")
const hideIdx = wizardSrc.indexOf("keyFieldWrap.classList.add('hidden')\n        nextBtn.disabled = true")
assert(resetIdx !== -1, 'located the shared reset')
assert(hideIdx !== -1, 'located the in-app default hide')
assert(hideIdx > resetIdx, 'the in-app hide runs AFTER the shared reset, not before it')

// The manual path must remain reachable and must restore the key-validate
// handler when opened -- it is the fallback for machines where the spawn or
// the loopback redirect does not work.
assert(/manualToggle/.test(wizardSrc), 'manual Terminal path still has a toggle')
const manualBlock = wizardSrc.match(/manualToggle\.onclick = \(\) => \{[\s\S]*?\n {8}\}/)
assert(Boolean(manualBlock), 'located the manual toggle handler')
if (manualBlock) {
  assert(/wireValidateNext\(\)/.test(manualBlock[0]), 'opening the manual panel restores the key-validate handler')
  assert(/keyFieldWrap\.classList\.toggle\('hidden'/.test(manualBlock[0]), 'opening the manual panel shows the key field')
}

// The poll must reuse loginPollTimer so the existing stopLoginPoll() cleanup
// on tab/submode change cancels it. A second timer would keep polling after
// the user navigated away.
const pollFn = wizardSrc.match(/function startSetupPoll\(\) \{[\s\S]*?\n {8}\}/)
assert(Boolean(pollFn), 'the in-app poll is a single named function')
if (pollFn) {
  assert(/loginPollTimer = setInterval/.test(pollFn[0]), 'the in-app poll uses the shared loginPollTimer')
  assert(/stopLoginPoll\(\)/.test(pollFn[0]), 'the in-app poll stops any previous poll before starting')
}
// Exactly one setInterval in this sub-mode: the button path and the resume
// path must share it. Two copies means the resume one drifts, and it is the
// copy nobody clicks through by hand.
// Region end = the manual-Terminal panel: the BYOK fallback sub-mode that
// used to terminate this region is gone (2026-08-04, Mino "claude API Key는
// 없애버리고").
const inAppRegion = wizardSrc.slice(wizardSrc.indexOf('const A = primary.inApp'), wizardSrc.indexOf('const manualToggle'))
assert(inAppRegion.length > 500, 'located the in-app sub-mode region')
assert((inAppRegion.match(/setInterval/g) || []).length === 1,
  'the in-app sub-mode defines the poll interval exactly once')

// RESUME: a flow already in flight when this renders (page reload, or leaving
// and returning to the tab mid-login) must restart the poll, not merely
// repaint the status line. The server session outlives the page; the interval
// does not. Without this the user waits forever on a login that already
// finished.
const resumeBlock = wizardSrc.match(/api\('\/api\/setup-token\/status'\)\.then\(\(s\) => \{[\s\S]*?\}\)\.catch/)
assert(Boolean(resumeBlock), 'located the resume-on-render probe')
if (resumeBlock) {
  assert(/startSetupPoll\(\)/.test(resumeBlock[0]), 'the resume path restarts the poll for an in-flight flow')
  for (const st of ['running', 'awaiting_code', 'validating']) {
    assert(resumeBlock[0].includes(`'${st}'`), `the resume path treats "${st}" as in-flight`)
  }
  assert(/state === 'idle'/.test(resumeBlock[0]), 'the resume path still short-circuits on idle')
}

// The claude API-key (BYOK) sub-mode is REMOVED (2026-08-04, Mino "claude
// API Key는 없애버리고"): no wizard path may submit provider:'claude' again.
// The exact-string check does not false-positive on 'claude-subscription'
// (the closing quote pins it). The connectors page's key-paste row is
// likewise gone -- its replacement drives /api/setup-token/*, never
// /api/byok/validate with provider 'claude'.
assert(!wizardSrc.includes("state.provider = 'claude'\n") && !wizardSrc.includes("state.provider = 'claude' "),
  'no wizard sub-mode submits provider:\'claude\' (BYOK removed 2026-08-04)')
const connectorsSrc = fs.readFileSync(new URL('../onboarding/public/js/connectors.js', import.meta.url), 'utf8')
assert(!/provider: 'claude'[,}]/.test(connectorsSrc), 'connectors page never validates provider:\'claude\' (BYOK row removed)')
assert(/api\('\/api\/setup-token\/start'/.test(connectorsSrc), 'connectors claude row drives the setup-token capture (re-login)')
const connResume = connectorsSrc.match(/api\('\/api\/setup-token\/status'\)\.then\(\(s\) => \{[\s\S]*?\}\)\.catch/)
assert(Boolean(connResume) && /startSetupPoll\(\)/.test(connResume[0]),
  'connectors claude row resumes an in-flight login poll on load (same rule as the wizard)')
for (const st of ['running', 'awaiting_code', 'validating']) {
  assert(connResume && connResume[0].includes(`'${st}'`), `connectors resume path treats "${st}" as in-flight`)
}

// Unified provider-row grammar (2026-08-06, 0.67 feedback "이 페이지 기능좀
// 일원화"): every connected row carries the same Test + Re-login pair, and
// the ollama key flow links out to the key console. Anchored to the specific
// elements (source-grep tests must anchor to their selector — 0.67 lesson).
console.log('\nconnectors: unified row grammar (0.67)')
const connectorsHtml = fs.readFileSync(new URL('../onboarding/public/connectors.html', import.meta.url), 'utf8')
assert(connectorsHtml.includes('id="conn-provider-claude-test"'), 'claude row carries a Test button in the DOM')
assert(/runProviderTest\('claude-subscription'/.test(connectorsSrc),
  'claude Test drives the SAME generic probe as the other rows (claude-subscription)')
assert(connectorsHtml.includes('id="conn-ollama-get-key"'), 'ollama key flow carries the get-a-key button')
assert(/getKeyBtn\.onclick = \(\) => window\.open\(C\.links\.ollamaKeys, '_blank', 'noopener'\)/.test(connectorsSrc),
  'get-a-key opens the console via the house window.open pattern')
const copySrc067 = fs.readFileSync(new URL('../onboarding/public/js/copy.js', import.meta.url), 'utf8')
assert(copySrc067.includes("ollamaKeys: 'https://ollama.com/settings/keys'"), 'key-console URL lives in the copy links map')
const serverSrc = fs.readFileSync(new URL('../onboarding/http-server.cjs', import.meta.url), 'utf8')
{
  // The keyless claude-subscription Test only works if the stored-token
  // fallback sits BEFORE the generic empty-key guard in validateProviderKey.
  const fallbackIdx = serverSrc.indexOf("provider === 'claude-subscription' && (!key")
  const guardIdx = serverSrc.indexOf("return { ok: false, reason: '키가 비어 있습니다' }")
  assert(fallbackIdx !== -1 && guardIdx !== -1 && fallbackIdx < guardIdx,
    'claude-subscription stored-token fallback precedes the empty-key guard (keyless Test works)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
