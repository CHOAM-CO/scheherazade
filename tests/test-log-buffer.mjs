#!/usr/bin/env node
// test-log-buffer.mjs -- the /logs viewer's data layer (v0.0.20), attacked
// at the module level (no HTTP, no Electron). The promises, in the order
// they matter:
//   1. SECRETS NEVER ENTER: every credential class the app touches
//      (discord bot / slack xoxb+xapp / telegram bot / sk-* keys / Bearer)
//      is redacted BEFORE buffer insertion and before the disk sink -- a
//      child echoing its env must not turn the viewer into a token leak.
//   2. Cursor semantics: getSince(N) returns strictly-after entries;
//      falling off the ring sets dropped=true (the client renders a gap,
//      never fakes continuity); response is capped and catches up.
//   3. Ring cap holds at 3000; the sink rotates at the configured byte
//      limit keeping exactly one .1 generation.
//   4. Sink failure is nonfatal: no sink initialized = buffer-only, no throw.
//
// Run: node tests/test-log-buffer.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const logBuffer = require_(path.join(ROOT, 'onboarding', 'log-buffer.cjs'))
const { append, getSince, initSink, redact, _resetForTest } = logBuffer

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── 1. redaction, per credential class ─────────────────────────────────────
console.log('redaction:')
const SECRETS = [
  ['discord bot token', 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz123456789'],
  ['slack bot token', 'xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'],
  ['slack app token', 'xapp-1-A01234ABCDE-1234567890123-abcdef1234567890abcdef1234567890'],
  ['telegram bot token', '8123456789:AAHfake_fake_fake_fake_fake_fake_12'],
  ['anthropic key', 'sk-ant-api03-abcdefghijklmnop-qrstuvwxyz'],
  ['bearer header', 'Bearer abc123def456ghi789'],
]
for (const [name, secret] of SECRETS) {
  const out = redact(`prefix ${secret} suffix`)
  check(`${name} redacted`, !out.includes(secret) && out.includes('[REDACTED]'), out)
  check(`${name} keeps surroundings`, out.startsWith('prefix ') && out.endsWith(' suffix'), out)
}
check('plain text untouched', redact('agent spawn skipped: no token yet') === 'agent spawn skipped: no token yet')
check('iso timestamp untouched', redact('[2026-07-16T08:00:00.000Z] boot') === '[2026-07-16T08:00:00.000Z] boot')
// Regression (2026-08-18): the token glued to a "bot" prefix inside a Telegram
// file URL is the shape channel-telegram.mjs's download-failure path could
// leak. The old /\b\d{6,12}:.../\b/ never matched here ("bot"+digits are both
// word chars, so the leading \b failed) and the token survived redaction.
{
  const tgToken = '8123456789:AAHfake_fake_fake_fake_fake_fake_12'
  const tgUrl = `https://api.telegram.org/file/bot${tgToken}/photos/a.jpg`
  const out = redact(`image download failed (${tgUrl}): timeout`)
  check('telegram token glued to bot-prefix redacted', !out.includes(tgToken) && out.includes('[REDACTED]'), out)
}

// ── 2. buffer + cursor semantics ───────────────────────────────────────────
console.log('cursor semantics:')
_resetForTest()
append('main', 'line one')
append('agent', 'line two\nline three\n\n') // multi-line split, empties skipped
let r = getSince(0)
check('all entries from 0', r.entries.length === 3, `got ${r.entries.length}`)
check('seq monotonic', r.entries.every((e, i) => i === 0 || e.seq > r.entries[i - 1].seq))
check('streams preserved', r.entries[0].stream === 'main' && r.entries[1].stream === 'agent')
check('no drop flag fresh', r.dropped === false)
check('nextSeq = last seq', r.nextSeq === r.entries[2].seq)
const mid = r.entries[0].seq
r = getSince(mid)
check('strictly-after cursor', r.entries.length === 2 && r.entries[0].line === 'line two')
r = getSince(999999)
check('future cursor -> empty, no throw', r.entries.length === 0)
const secretInBuffer = getSince(0).entries.some((e) => e.line.includes('xoxb-'))
append('agent!', 'echo SLACK_BOT_TOKEN=xoxb-9999999999-9999999999999-ZzYyXxWwVvUuTtSsRrQqPpOo')
const afterSecret = getSince(0).entries.find((e) => e.stream === 'agent!')
check('secret redacted at append', !secretInBuffer && afterSecret && !afterSecret.line.includes('xoxb-9999999999'), afterSecret && afterSecret.line)

// ── 3. ring cap + dropped + response cap ───────────────────────────────────
console.log('ring cap:')
_resetForTest()
for (let i = 0; i < 3500; i++) append('main', `flood ${i}`)
r = getSince(0)
check('response capped at 1000', r.entries.length === 1000, `got ${r.entries.length}`)
check('oldest retained is flood 500 (3000 ring)', r.entries[0].line === 'flood 500', r.entries[0].line)
r = getSince(100) // client saw seq<=100, ring discarded up to 500
check('overflow flags dropped', r.dropped === true)
// catch-up: walk the cursor to the end
let cursor = 0
let total = 0
for (let hop = 0; hop < 10; hop++) {
  const page = getSince(cursor)
  total += page.entries.length
  cursor = page.nextSeq
  if (page.entries.length === 0) break
}
check('cursor catch-up drains full ring', total === 3000, `got ${total}`)

// ── 4. sink: write, redact, rotate ─────────────────────────────────────────
console.log('disk sink:')
_resetForTest()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-logbuf-'))
initSink(tmp, { rotateBytes: 400 })
const logPath = path.join(tmp, 'app.log')
check('sink file created with session header', fs.readFileSync(logPath, 'utf8').includes('app session start'))
append('agent', 'token spill xoxb-1111111111-1111111111111-AaBbCcDdEeFfGgHhIiJjKkLl end')
check('sink line redacted', !fs.readFileSync(logPath, 'utf8').includes('xoxb-1111111111'))
for (let i = 0; i < 20; i++) append('main', `rotation filler line number ${i} padded to make bytes`)
check('rotation produced .1 generation', fs.existsSync(`${logPath}.1`))
check('active file under limit + slack', fs.statSync(logPath).size < 800, `${fs.statSync(logPath).size}B`)
check('getSince reports sink path', getSince(0).file === logPath)

// ── 5. no sink = buffer-only, no throw ─────────────────────────────────────
console.log('buffer-only mode:')
_resetForTest()
let threw = false
try {
  append('main', 'no sink initialized')
} catch {
  threw = true
}
check('append without sink never throws', !threw)
check('file pointer null without sink', getSince(0).file === null)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
