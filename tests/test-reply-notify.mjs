// test-reply-notify.mjs — background-reply OS notification watcher
// (notify-agent-reply.cjs, v0.1.11). Real tmp transcript file + fake
// Electron surfaces; the watcher's own fs.watchFile polling (1.5s) drives
// the ticks, so this suite spends a few real seconds waiting on purpose.
//
// Pins the contract:
//   1. history never notifies: messages already on disk at init are silent.
//   2. a new agent message with no focused window -> exactly one
//      notification, body = reply first line (truncated shape not pinned).
//   3. a batch of agent messages in one flush -> ONE notification, count in
//      title.
//   4. focused window -> suppressed AND the cursor still advances (no
//      retroactive fire on the next unfocused message).
//   5. user messages / reactions alone never notify.
//   6. unsupported Notification platform or init throw -> init returns
//      without arming anything, never throws.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { initReplyNotifications } = require(path.join(REPO_ROOT, 'notify-agent-reply.cjs'))

let ok = 0, bad = 0
const pass = (m) => { ok++; console.log(`  ok: ${m}`) }
const fail = (m) => { bad++; console.log(`  FAIL: ${m}`) }
const check = (cond, m) => (cond ? pass(m) : fail(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// One watcher poll is 1.5s; 2.5s guarantees at least one tick saw the change.
const TICK_WAIT = 2500

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-reply-notify-'))
const FILE = path.join(tmpRoot, 'chat-transcript.json')

let seq = 0
const queue = []
const append = (kind, role, text) => { queue.push({ seq: ++seq, kind, role, text, ts: Date.now() }) }
const flush = () => {
  // tmp+rename like the real writer
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ seq, queue }, null, 1))
  fs.renameSync(tmp, FILE)
}

const fired = []
let focused = false
class FakeNotification {
  static isSupported() { return true }
  constructor(opts) { this.opts = opts }
  on() {}
  show() { fired.push(this.opts) }
}
const fakeBW = {
  getAllWindows: () => [{ isFocused: () => focused, isMinimized: () => false, restore() {}, show() {}, focus() {} }],
}
const fakeApp = { setAppUserModelId() {}, on() {} }
const logs = []
const log = (m) => logs.push(m)

try {
  // --- 1. history is silent ---------------------------------------------
  console.log('init on existing history')
  append('message', 'user', 'hi')
  append('message', 'agent', 'old reply from yesterday')
  flush()
  initReplyNotifications({ app: fakeApp, Notification: FakeNotification, BrowserWindow: fakeBW, DATA_HOME: tmpRoot, log })
  check(logs.some((l) => l.includes('watching')), 'watcher armed')
  await sleep(TICK_WAIT)
  check(fired.length === 0, 'pre-existing history never notifies')

  // --- 2. new agent reply, unfocused ------------------------------------
  console.log('new reply, window unfocused')
  append('message', 'agent', 'first line of answer\nsecond line')
  flush()
  await sleep(TICK_WAIT)
  check(fired.length === 1, 'exactly one notification fired')
  check(fired[0] && fired[0].body === 'first line of answer', 'body is the reply first line')

  // --- 3. batch -> one notification with count --------------------------
  console.log('batch flush')
  append('message', 'agent', 'part one')
  append('message', 'agent', 'part two')
  flush()
  await sleep(TICK_WAIT)
  check(fired.length === 2, 'one more notification for the whole batch')
  check(fired[1] && /\(2\)/.test(fired[1].title), 'batch count surfaces in title')

  // --- 4. focused suppression + cursor advance --------------------------
  console.log('focused window')
  focused = true
  append('message', 'agent', 'seen live')
  flush()
  await sleep(TICK_WAIT)
  check(fired.length === 2, 'focused window suppresses notification')
  focused = false
  append('message', 'user', 'user talks')
  flush()
  await sleep(TICK_WAIT)
  check(fired.length === 2, 'suppressed reply does not fire retroactively (cursor advanced)')

  // --- 5. non-reply items silent ----------------------------------------
  console.log('non-reply items')
  append('reaction', 'agent', '👍')
  flush()
  await sleep(TICK_WAIT)
  check(fired.length === 2, 'reactions and user messages never notify')

  // --- 6. unsupported / broken init never throws ------------------------
  console.log('fail-soft init')
  const logs2 = []
  initReplyNotifications({
    app: fakeApp, BrowserWindow: fakeBW, DATA_HOME: tmpRoot, log: (m) => logs2.push(m),
    Notification: { isSupported: () => false },
  })
  check(logs2.some((l) => l.includes('unsupported')), 'unsupported platform disables cleanly')
  let threw = false
  try {
    initReplyNotifications({ app: null, Notification: null, BrowserWindow: null, DATA_HOME: null, log })
  } catch { threw = true }
  check(!threw, 'init with broken surfaces never throws')
} catch (err) {
  fail(`unexpected throw: ${err.stack || err.message}`)
} finally {
  fs.unwatchFile(FILE)
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${ok} passed, ${bad} failed`)
process.exit(bad > 0 ? 1 : 0)
