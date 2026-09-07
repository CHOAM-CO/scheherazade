// test-agent-status-codes.mjs -- the status-code vocabulary is closed, and
// every code in it reaches a sentence a user can read.
//
// WHY THIS FILE EXISTS. For a month the list of valid codes lived only in a
// doc comment in onboarding/agent-status.cjs, and three codes drifted past it
// and past the UI at the same time:
//
//   'bootstrap-needed'    four call sites in main.cjs (attach topology)
//   'slack_token_bad'     channel-slack.mjs's writeFailureMarker
//   'telegram_token_bad'  channel-telegram.mjs's writeFailureMarker
//
// All three are relayed into setAgentStatus, none had a row in copy.js, so
// wizard.js's `causes[code] || causes.unknown` rendered all three as "wait a
// moment and click Check status again" -- for three conditions where nothing
// is transient and we knew exactly what was wrong. The user was told we did
// not know, by code that did.
//
// So the check is not "is the list correct" (nothing can check that). It is
// the three-way agreement that failed:
//
//   1. every code literal in the source is in AGENT_STATUS_CODES
//   2. every code in AGENT_STATUS_CODES has a copy.js row
//   3. every copy.js row corresponds to a real code (dead rows are their own
//      lie -- copy nobody will ever see, that reads as coverage)
//
// This is a SOURCE-TEXT test, deliberately. Importing main.cjs pulls in
// Electron; importing copy.js pulls in `window`. Neither is available here,
// and both would make this test a stub that passes because it ran nothing.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { AGENT_STATUS_CODES, AGENT_STATES } = require(path.join(ROOT, 'onboarding', 'agent-status.cjs'))

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`PASS  ${label}`) } else { fail++; console.log(`FAIL  ${label}`) }
}

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

// ── 0. the vocabulary itself is well-formed ─────────────────────────────
assert(Array.isArray(AGENT_STATUS_CODES) && AGENT_STATUS_CODES.length > 0, 'AGENT_STATUS_CODES is a non-empty array')
assert(Object.isFrozen(AGENT_STATUS_CODES), 'AGENT_STATUS_CODES is frozen (a shared singleton nobody can push onto at runtime)')
assert(Object.isFrozen(AGENT_STATES), 'AGENT_STATES is frozen')
assert(new Set(AGENT_STATUS_CODES).size === AGENT_STATUS_CODES.length, 'AGENT_STATUS_CODES has no duplicates')
assert(AGENT_STATUS_CODES.includes('unknown'), "AGENT_STATUS_CODES includes the 'unknown' fallback (wizard.js falls back to it by name)")

// ── 1. every code the source emits is in the vocabulary ─────────────────
// Two emitters, because a code reaches the status object by two routes:
//   setAgentStatus('failed', 'x', ...)          -- direct, in-process
//   writeFailureMarker(reason, 'x', ...)        -- on disk, relayed by
//                                                  main.cjs's pollFailureMarker
// Missing the second route is exactly how slack_token_bad and
// telegram_token_bad stayed invisible: nothing in main.cjs mentions them.
const EMITTERS = [
  { file: 'main.cjs', re: /setAgentStatus\(\s*'[a-z]+'\s*,\s*'([^']+)'/g },
  { file: 'channel.mjs', re: /writeFailureMarker\(\s*[^,)]+,\s*'([^']+)'/g },
  { file: 'channel-slack.mjs', re: /writeFailureMarker\(\s*[^,)]+,\s*'([^']+)'/g },
  { file: 'channel-telegram.mjs', re: /writeFailureMarker\(\s*[^,)]+,\s*'([^']+)'/g },
  { file: 'onboarding/http-server.cjs', re: /code:\s*'(timeout|crash_loop|unknown)'/g },
]

const emitted = new Map() // code -> Set(files)
for (const { file, re } of EMITTERS) {
  const src = read(file)
  let m
  while ((m = re.exec(src)) !== null) {
    if (!emitted.has(m[1])) emitted.set(m[1], new Set())
    emitted.get(m[1]).add(file)
  }
}

assert(emitted.size > 0, 'the source scan actually found status codes (guards against a regex that silently matches nothing)')
for (const [code, files] of [...emitted].sort()) {
  assert(
    AGENT_STATUS_CODES.includes(code),
    `code '${code}' (emitted by ${[...files].join(', ')}) is in AGENT_STATUS_CODES`,
  )
}

// The scan must see the three that drifted -- if a refactor moves them out of
// reach of these regexes, this test would go quiet and pass, which is the
// failure mode it was written against.
for (const code of ['bootstrap-needed', 'slack_token_bad', 'telegram_token_bad', 'discord_token_bad', 'key_error', 'provider_not_wired']) {
  assert(emitted.has(code), `the source scan still reaches '${code}' (a passing-because-it-found-nothing test is the thing this file exists to prevent)`)
}

// ── 2 & 3. the vocabulary and the user-facing copy agree exactly ────────
// copy.js is browser source (`window` at load), so the rows are read out of
// the text. The slice is bounded by the `causes: {` ... `buttonLabels:`
// landmarks so an unrelated object elsewhere in the file cannot contribute
// phantom rows.
const copySrc = read('onboarding/public/js/copy.js')
const causesStart = copySrc.indexOf('causes: {')
const causesEnd = copySrc.indexOf('buttonLabels:', causesStart)
assert(causesStart !== -1 && causesEnd > causesStart, 'copy.js: located the step5.failed.causes block (landmarks intact)')

const causesBlock = copySrc.slice(causesStart, causesEnd)
const copyRows = new Set()
// Keys are written both bare (key_error:) and quoted ('bootstrap-needed':),
// because the hyphenated one is not a valid bare identifier. Both forms count.
for (const m of causesBlock.matchAll(/^\s{8}'?([a-z_][a-z_\-]*)'?:\s*\{/gm)) copyRows.add(m[1])

assert(copyRows.size > 0, 'copy.js: the causes-row scan found rows (again: a scan that finds nothing must not read as agreement)')

for (const code of AGENT_STATUS_CODES) {
  // 'timeout' is computed downstream in http-server.cjs rather than set here,
  // but it still renders, so it still needs a row -- no exemption.
  assert(copyRows.has(code), `copy.js has a step5.failed.causes row for '${code}' (without one the user gets the generic 'unknown' text)`)
}

for (const row of [...copyRows].sort()) {
  assert(
    AGENT_STATUS_CODES.includes(row),
    `copy.js row '${row}' corresponds to a real status code (a row no code can reach is copy nobody will ever see)`,
  )
}

// ── 4. the runtime backstop coerces rather than crashes ─────────────────
// An unrecognized code arrives on a path where something has ALREADY failed.
// Throwing there turns a mislabelled failure into a crash while reporting a
// failure. Assert the coercion, and assert it is loud.
{
  const { setAgentStatus, getAgentStatus } = require(path.join(ROOT, 'onboarding', 'agent-status.cjs'))
  const realError = console.error
  const seen = []
  console.error = (...a) => seen.push(a.join(' '))
  try {
    setAgentStatus('failed', 'totally_made_up_code', 'detail text')
  } finally {
    console.error = realError
  }
  const s = getAgentStatus()
  assert(s.code === 'unknown', "an unrecognized code is coerced to 'unknown' rather than stored or thrown")
  assert(s.detail === 'detail text', 'the detail survives the coercion (the prose is the only thing left that says what happened)')
  assert(seen.some((line) => line.includes('totally_made_up_code')), 'the coercion is logged, and the log names the offending code')

  // A known code passes through untouched, and null stays null.
  setAgentStatus('failed', 'crash_loop', 'x')
  assert(getAgentStatus().code === 'crash_loop', 'a recognized code is stored verbatim')
  setAgentStatus('connecting')
  assert(getAgentStatus().code === null, 'a null code stays null (not coerced to "unknown" -- connecting/idle/live carry no cause)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
