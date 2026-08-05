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

console.log('\n3. asymmetric turns (P1 v2 — Mino 19:40 "누가 누군지 잘 안보이잖아" + aside ref)')
assert(!css.includes('.chat-msg + .chat-msg { border-top'), 'v1 hairline separators are gone (clean canvas, aside-style)')
assert(/\.chat-user \{[^}]*align-self: flex-end/s.test(css), 'user turns are right-aligned bubbles')
assert(/\.chat-user \{[^}]*max-width: 72%/s.test(css), 'user bubble is compact, not full-width')
assert(/\.chat-user \{[^}]*rgb\(var\(--accent-rgb\) \/ 0\.16\)/s.test(css), 'bubble is translucent accent GLASS derived from the seed — never a solid accent fill')
assert(/\.chat-user \{[^}]*backdrop-filter: blur/s.test(css), 'bubble carries the frosted material (glassmorphism ask)')
assert(/\.chat-agent \{[^}]*background: transparent/s.test(css), 'agent turns are flat document flow (no bubble, no tint)')
assert(!js.includes('chat-role') && !css.includes('.chat-role'), 'role labels removed — the asymmetry itself carries identity')
assert(!/\.chat-user \{[^}]*background: var\(--accent\)/s.test(css), 'no solid accent-filled user bubble')

console.log('\n3b. --accent-rgb derives from the accent seed (consistency contract)')
const model = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'appearance-model.cjs'), 'utf8')
assert(model.includes("'--accent-rgb': triplet(c.accent)"), 'model emits the raw accent triplet for alpha-composed surfaces')

console.log('\n4. error left-rail (dormant until the feed carries an error kind)')
assert(css.includes('.chat-msg.chat-error'), 'error rail CSS present')
assert(/border-left: 2px solid transparent/.test(css), 'every turn reserves the rail slot (no layout shift when it colors)')

console.log('\n5. empty state = example prompts')
assert(js.includes('C.emptyExamples') && js.includes('input.value = example'), 'examples fill the composer')
assert(!js.match(/input\.value = example[\s\S]{0,80}sendMsg|sendNow|doSend/), 'examples never auto-send (user keeps the trigger)')
assert(copy.includes('emptyExamples'), 'example prompts live in copy')

console.log('\n6. activity fold (opened = timeline rail, aside reference)')
assert(/\.chat-activity-fold \.fold-line \{[^}]*border-left: 1px solid var\(--border-strong\)/s.test(css), 'opened fold hangs steps off a continuous left rail')
assert(js.includes('buildActivityFold') && js.includes("document.createElement('details')"), 'labels fold into a <details> above the landed reply')
assert(js.includes('TYPING_SHOW_MAX_MS) { activityLog = []; return }'), 'stale-wait guard: a dead wait cannot mislabel a later reply')
assert(js.includes('activityLog.push') && js.includes('MAX_FOLD_LINES'), 'labels accumulate with a cap')
assert(copy.includes('activityFoldSummary'), 'fold summary copy present')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
