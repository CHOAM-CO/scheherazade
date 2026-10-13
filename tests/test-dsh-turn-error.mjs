#!/usr/bin/env node
// test-dsh-turn-error.mjs -- a failed model call on the dsh lane must
// annotate the product (Mino 2026-10-07 16:37: DeepSeek INVALID_REQUEST,
// app.log held `turn end (error: INVALID_REQUEST)` and the app showed
// nothing; the provider's HTTP body was dropped).
//
// dsh-lane.mjs is not importable (binds its server at module scope), so the
// marker writer lives in turn-error-marker.mjs and is driven directly here;
// the lane's turn/end wiring and the chat divider are source pins.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  writeTurnErrorMarker, clearTurnErrorMarker, turnErrorLogLine, markerPath, TURN_ERROR_DETAIL_MAX,
  writeTurnRetryMarker, clearTurnRetryMarker,
} from '../turn-error-marker.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-turnerr-'))

let passed = 0
let failed = 0
function assert (cond, msg) {
  if (cond) { passed++; console.log(`  ok   ${msg}`) } else { failed++; console.log(`  FAIL ${msg}`) }
}

console.log('1. marker writer: error reason -> .last-turn-error.json with the provider text')
const body = '400 {"error":{"message":"This model does not support image input","type":"invalid_request_error"}}'
const marker = writeTurnErrorMarker(TMP, { code: 'INVALID_REQUEST', message: body, model: 'deepseek-v4-pro', now: 1700000000000 })
const onDisk = JSON.parse(fs.readFileSync(markerPath(TMP), 'utf8'))
assert(path.basename(markerPath(TMP)) === '.last-turn-error.json', 'marker file is the route\'s .last-turn-error.json (headless-lane parity)')
assert(onDisk.ts === 1700000000000 && onDisk.subtype === 'INVALID_REQUEST', 'marker carries { ts, subtype: code }')
assert(onDisk.detail === `deepseek-v4-pro: ${body}`, 'detail is "<model>: <provider message>" -- the body is the discriminator, kept verbatim')
assert(JSON.stringify(marker) === JSON.stringify(onDisk), 'the return value is what landed on disk')
assert((fs.statSync(markerPath(TMP)).mode & 0o777) === 0o600, 'marker is 0600')
assert(fs.readdirSync(TMP).every((f) => !f.includes('.tmp.')), 'atomic write leaves no tmp file behind')

console.log('2. caps and fallbacks')
const long = writeTurnErrorMarker(TMP, { code: 'SERVER', message: 'x'.repeat(5000), model: 'm' })
assert(long.detail.length === 'm: '.length + TURN_ERROR_DETAIL_MAX, `detail text is capped at ${TURN_ERROR_DETAIL_MAX} chars`)
const bare = writeTurnErrorMarker(TMP, { code: undefined, message: '', model: 'm' })
assert(bare.subtype === 'error' && /no detail/.test(bare.detail), 'no code -> subtype "error"; empty message -> says so instead of a bare "m: "')
const ws = writeTurnErrorMarker(TMP, { code: 'TRANSPORT', message: '503\n\n<html>\n  <body>bad gateway</body>\n</html>', model: 'm' })
assert(ws.detail === 'm: 503 <html> <body>bad gateway</body> </html>', 'newlines collapse to one line (log + banner are single-line surfaces)')

console.log('3. log line')
const line = turnErrorLogLine('INVALID_REQUEST', body)
assert(line.startsWith('turn end (error: INVALID_REQUEST) ') && line.includes('does not support image input'), 'log line = code AND message (the old line was the code alone)')
assert(turnErrorLogLine('RATE_LIMIT', 'y'.repeat(5000)).length <= 'turn end (error: RATE_LIMIT) '.length + TURN_ERROR_DETAIL_MAX, 'log line message is capped')
assert(turnErrorLogLine(undefined, '') === 'turn end (error: unknown)', 'no code, no message -> still a parseable line')

console.log('4. completed turn clears the marker')
assert(fs.existsSync(markerPath(TMP)), 'precondition: marker present')
assert(clearTurnErrorMarker(TMP) === true, 'clear removes it and reports true')
assert(!fs.existsSync(markerPath(TMP)), 'marker gone')
assert(clearTurnErrorMarker(TMP) === false, 'clearing an absent marker is a no-op (false), never a throw')

console.log('5. dsh-lane wiring (source pins; the lane is not importable)')
const lane = fs.readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')
assert(lane.includes("from './turn-error-marker.mjs'"), 'dsh-lane imports the shared marker module')
assert(/reason\.error && \(reason\.error\.message \|\| reason\.error\.errorMessage\)/.test(lane), 'turn/end reads reason.error.message (pi-ai errorMessage = status + body), not only .code')
assert(lane.includes('errLog(turnErrorLogLine(code, message))'), 'the error line is logged WITH the message')
assert(lane.includes('writeTurnErrorMarker(MEM, { code, message, model: DSH_MODEL })'), 'marker written under MEM (= the supervisor\'s cfg.mem = DATA_HOME the route reads) with the lane model')
assert(/if \(reason\.kind === 'error' && code !== 'EMPTY_RESPONSE'\) \{\s*const message/.test(lane), 'EMPTY_RESPONSE stays excluded (the silent finish is not a failure)')
assert(lane.includes('clearTurnErrorMarker(MEM)'), 'a non-error turn end clears the marker (headless-lane :980 parity)')
const idxLog = lane.indexOf('clearTurnErrorMarker(MEM)')
const idxWrite = lane.indexOf('writeTurnErrorMarker(MEM')
assert(idxWrite > 0 && idxLog > idxWrite, 'write path precedes the clear path inside the same turn/end branch')

console.log('6. chat surface: [system] divider for the fresh marker, once per ts')
const chat = fs.readFileSync(path.join(ROOT, 'onboarding', 'public', 'js', 'chat.js'), 'utf8')
const copy = fs.readFileSync(path.join(ROOT, 'onboarding', 'public', 'js', 'copy.js'), 'utf8')
assert(chat.includes("window.api('/api/agent/turn-error')"), 'chat.js polls the same route the nav banner reads')
assert(chat.includes('e.ts === turnErrorShownTs) return') && chat.includes('turnErrorShownTs = e.ts'), 'one divider per marker ts (module variable)')
assert(chat.includes('!e.present || !e.fresh'), 'only a present AND fresh marker renders')
assert(/text: `\[system\] \$\{Q\.turnErrorDivider\(e\.subtype, e\.detail\)\}`/.test(chat), 'rendered through the [system] divider path (parseSystemLine) with turnErrorDivider copy')
assert(chat.includes('await pollTurnError()'), 'the poll rides the chat poll loop')
assert(copy.includes("turnErrorDivider: (subtype, detail) => `모델이 거절했어: ${detail"), 'ko copy "모델이 거절했어: {detail}" lives in quickbarKo')
assert(copy.includes("turnErrorDivider: (subtype, detail) => `Model rejected the request: ${detail"), 'en mirror next to it')
const koBlock = copy.slice(copy.indexOf('quickbarKo: {'), copy.indexOf('turnErrorDivider: (subtype, detail) => `Model rejected'))
assert(!/[—–]/.test(koBlock), 'no em/en dashes in the Korean copy block')

console.log('7. retry status never hides an exhausted overload')
for (const error of ['HTTP 529', 'overloaded', 'Please retry your request']) {
  const retry = writeTurnRetryMarker(TMP, { type: 'system', subtype: 'api_retry', error, error_status: 529 })
  assert(retry.subtype === 'retrying', `${error}: retry is a status, not an error`)
  assert(JSON.parse(fs.readFileSync(markerPath(TMP))).subtype === 'retrying', 'transient marker reaches the shared UI route')
  assert(clearTurnRetryMarker(TMP) && !fs.existsSync(markerPath(TMP)), 'answer clears retry status')
  writeTurnRetryMarker(TMP, { type: 'system', subtype: 'api_retry', error })
  writeTurnErrorMarker(TMP, { code: 'error_during_execution', message: error })
  assert(!clearTurnRetryMarker(TMP), 'retry cleanup must not erase an exhausted error')
  assert(JSON.parse(fs.readFileSync(markerPath(TMP))).subtype === 'error_during_execution', 'exhaustion replaces status with a real error')
  assert(writeTurnRetryMarker(TMP, { type: 'result', is_error: true, error }) === null, 'error words alone never imply retrying')
}
clearTurnErrorMarker(TMP)

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
