#!/usr/bin/env node
// test-chat-surface.mjs — P1 chat-surface redesign pins (design-research
// 2026-08 → docs/design-p1-chat-surface.md; Mino 2026-08-05 16:15 "P1이랑
// 같이"). The page is DOM-in-browser, so these are text pins on the wiring
// plus the injection-posture invariant (no innerHTML) that every new node
// type must keep.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

const js = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'chat.js'), 'utf8')
const html = readFileSync(path.join(root, 'onboarding', 'public', 'chat.html'), 'utf8')
const css = readFileSync(path.join(root, 'onboarding', 'public', 'css', 'app.css'), 'utf8')
const copy = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'copy.js'), 'utf8')

console.log('1. injection posture survives P1 (the original invariant)')
assert(!js.includes('.innerHTML'), 'chat.js still has NO innerHTML use — every new node is createElement/textContent (the comment naming the rule is allowed)')

console.log('\n2. scroll: 100px threshold + jump pill')
assert(js.includes('< 100'), 'atBottom threshold is 100px (was 8 — any upward wheel broke the stick)')
assert(html.includes('id="ct-jump"') && html.includes('chat-pane-wrap'), 'jump pill overlays via the pane wrap (not in scroll flow)')
assert(js.includes("showJump()") && js.includes("if (atBottom()) hideJump()"), 'pill shows on off-screen agent content, retires when the reader reaches bottom')
assert(css.includes('.chat-jump-pill'), 'pill styled')
assert(copy.includes('jumpToLatest'), 'pill label in copy')

console.log('\n3. full-width flat turns')
assert(css.includes('.chat-msg + .chat-msg { border-top: 1px solid var(--border); }'), 'hairline separators between turns (Warp: lines, not card borders)')
assert(/\.chat-msg \{[^}]*max-width: 100%/s.test(css), 'turns are full-width (bubbles read messenger; full-width reads tool)')
assert(js.includes("roleTag.className = 'chat-role'"), 'role carried by a small caps label, not bubble sides')
assert(css.includes('.chat-user .chat-role { color: var(--accent); }'), 'user label picks up the accent (the one place accent marks role)')
assert(!/\.chat-user \{[^}]*background: var\(--accent\)/s.test(css), 'the accent-filled user bubble is gone')

console.log('\n4. error left-rail (dormant until the feed carries an error kind)')
assert(css.includes('.chat-msg.chat-error'), 'error rail CSS present')
assert(/border-left: 2px solid transparent/.test(css), 'every turn reserves the rail slot (no layout shift when it colors)')

console.log('\n5. empty state = example prompts')
assert(js.includes('C.emptyExamples') && js.includes('input.value = example'), 'examples fill the composer')
assert(!js.match(/input\.value = example[\s\S]{0,80}sendMsg|sendNow|doSend/), 'examples never auto-send (user keeps the trigger)')
assert(copy.includes('emptyExamples'), 'example prompts live in copy')

console.log('\n6. activity fold')
assert(js.includes('buildActivityFold') && js.includes("document.createElement('details')"), 'labels fold into a <details> above the landed reply')
assert(js.includes('TYPING_SHOW_MAX_MS) { activityLog = []; return }'), 'stale-wait guard: a dead wait cannot mislabel a later reply')
assert(js.includes('activityLog.push') && js.includes('MAX_FOLD_LINES'), 'labels accumulate with a cap')
assert(copy.includes('activityFoldSummary'), 'fold summary copy present')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
