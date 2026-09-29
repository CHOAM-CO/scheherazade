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
assert(html.includes('chat-pill-hidden') && css.includes('.chat-jump-pill.chat-pill-hidden') && /chat-pill-hidden \{[^}]*scale\(0\)/s.test(css), 'pill scales/fades via its own hidden class (aside affordance; global .hidden cannot animate)')

console.log('\n3. asymmetric turns (P1 v2 — Mino 19:40 "누가 누군지 잘 안보이잖아" + aside ref)')
assert(!css.includes('.chat-msg + .chat-msg { border-top'), 'v1 hairline separators are gone (clean canvas, aside-style)')
assert(/\.chat-user \{[^}]*align-self: flex-end/s.test(css), 'user turns are right-aligned bubbles')
assert(/\.chat-user \{[^}]*max-width: 72%/s.test(css), 'user bubble is compact, not full-width')
assert(/\.chat-user \{[^}]*rgb\(var\(--accent-rgb\) \/ 0\.16\)/s.test(css), 'bubble is translucent accent GLASS derived from the seed — never a solid accent fill')
assert(/\.chat-user \{[^}]*backdrop-filter: blur/s.test(css), 'bubble carries the frosted material (glassmorphism ask)')
// P1 v3 (Mino 2026-08-06 14:47): flat agent flow retired — consecutive agent
// turns read as one wall. Agent turns carry a NEUTRAL glass container
// (asymmetry survives via side + material: left neutral vs right accent).
assert(/\.chat-agent \{[^}]*align-self: flex-start/s.test(css), 'agent turns are left-aligned containers (v3)')
assert(/\.chat-agent \{[^}]*rgba\(255, 255, 255, 0\.05\)/s.test(css), 'agent container is NEUTRAL glass — no accent tint (identity stays asymmetric)')
assert(!/\.chat-agent \{[^}]*accent/s.test(css), 'agent container never borrows the user accent')
assert(!js.includes('chat-role') && !css.includes('.chat-role'), 'role labels removed — the asymmetry itself carries identity')
assert(!/\.chat-user \{[^}]*background: var\(--accent\)/s.test(css), 'no solid accent-filled user bubble')

console.log('\n3b. --accent-rgb derives from the accent seed (consistency contract)')
const model = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'appearance-model.cjs'), 'utf8')
assert(model.includes("'--accent-rgb': triplet(c.accent)"), 'model emits the raw accent triplet for alpha-composed surfaces')

console.log('\n3c. sender-row avatar (2026-09-28) — the picture beside the name')
// The agent's profile picture opens the run's sender row. Pinned here rather
// than in a browser test because the two failure modes worth catching are
// both source-level: a hand-built innerHTML node (section 1 above is the
// general invariant) and a src pointed straight at the token-gated /api
// route, which renders a 403 instead of a face.
assert(/createElement\('img'\)[\s\S]{0,400}?chat-meta-avatar/.test(js),
  'the avatar is an <img> built with createElement (never innerHTML)')
assert(/createElement\('img'\)[\s\S]{0,400}?chat-meta-avatar[\s\S]{0,400}?\.alt = ''/.test(js),
  '...and it is decorative: alt = "" (the name span beside it is the label)')
assert(js.indexOf('chat-meta-avatar') !== -1 && js.indexOf('chat-meta-avatar') < js.indexOf('chat-meta-name'),
  'the avatar is created BEFORE the name span — the picture leads the row')
assert(js.includes('window.avatarUrl()') && js.includes('AVATAR_FALLBACK_URL'),
  'src comes from nav.js\'s shared resolver and starts on the static fallback (no 403, no broken-image frame)')
assert(js.includes('.onerror') && /onerror[\s\S]{0,200}?AVATAR_FALLBACK_URL/.test(js),
  'a failed load resets to the fallback instead of leaving a broken image')
assert(/\.chat-meta-avatar \{[^}]*width: 32px/s.test(css) && /\.chat-meta-avatar \{[^}]*height: 32px/s.test(css)
  && /\.chat-meta-avatar \{[^}]*border-radius: 50%/s.test(css) && /\.chat-meta-avatar \{[^}]*object-fit: cover/s.test(css)
  && /\.chat-meta-avatar \{[^}]*align-self: center/s.test(css) && /\.chat-meta-avatar \{[^}]*flex: 0 0 auto/s.test(css),
  'avatar styled: a 32px round cover-fit square that cannot be squeezed by the flex line')
assert(/\.chat-meta \{[^}]*align-items: baseline/s.test(css),
  'the meta row KEEPS align-items: baseline — align-self: center on the img is what keeps it off its own bottom edge')
assert(!/\.chat-meta \{[^}]*align-items: center/s.test(css),
  '...and was not "fixed" to center, which would move the name off the time line instead')

console.log('\n3d. user-row avatar (0.3.5, 2026-09-29): the user\'s own picture, no label')
// The 08-05 "no role labels" rule was retired for the PICTURE only (the owner
// 2026-09-29 15:07): a user run opens with a row holding the picture and
// nothing else. The pins: same 32px class, fed by the 'user' slot of the
// shared resolver, no name/text on the row, hidden while the slot is empty.
{
  const i = js.indexOf("'chat-meta chat-meta-user'")
  assert(i !== -1, 'a user run opens with a chat-meta-user row')
  const userRow = js.slice(i, js.indexOf('pane.appendChild(meta)', i))
  assert(userRow.includes("createElement('img')") && userRow.includes("'chat-meta-avatar'") && userRow.includes(".alt = ''"),
    '...holding a decorative <img> with the same 32px chat-meta-avatar class')
  assert(!/textContent|chat-meta-name|chat-meta-time|innerHTML/.test(userRow),
    '...and NOTHING else: no name, no "You", no text of any kind on the user row')
  assert(userRow.includes('meta.hidden = true'), '...hidden until the user slot resolves to a picture')
  assert(js.includes("window.avatarUrl('user')"), 'the user picture comes from the shared resolver\'s user slot')
  assert(!/AVATAR_FALLBACK_URL/.test(userRow), 'the user row never falls back to the agent/app icon')
  assert(/\.chat-meta\[hidden\] \{[^}]*display: none/s.test(css),
    '[hidden] is restated for .chat-meta (display: flex would otherwise keep an empty row on screen)')
  assert(/\.chat-meta-user \{[^}]*align-self: flex-end/s.test(css), 'the user row sits on the user\'s side')
}

console.log('\n3d. memory mark (2026-09-28) — a quiet tell on a reply that came out of memory')
// The owner's "기억을 꺼낸 티 내기" → "완전 굿". The flagged item is the ONLY
// input (channel-local's POST /memory-read arms it; the next agent message
// carries it), so these pins are about the three ways this could go wrong on
// the page: rendering for the wrong items, building the node by hand, and
// shouting. Source-level because the page is DOM-in-browser, same convention
// as the sections above.
assert(js.includes('m.fromMemory === true'),
  'the mark is gated on the item\'s own flag — an item without it changes nothing (strict === true, no truthy accident)')
assert(js.includes('role === \'agent\' && m.fromMemory === true'),
  '...and only on agent turns: a user bubble can never be marked as coming from the agent\'s memory')
assert(/function memoryMarkNode\(\)[\s\S]{0,300}?createElement\('span'\)[\s\S]{0,300}?chat-memory-mark[\s\S]{0,300}?textContent = C\.memoryMarkGlyph/.test(js),
  'the node is a createElement span whose text is the copy glyph (innerHTML stays absent — section 1)')
assert(/memoryMarkNode\(\)[\s\S]{0,400}?setAttribute\('aria-label'/.test(js),
  'the glyph carries its meaning in words (aria-label), so it is not a symbol only a sighted reader can read')
assert(js.includes('meta.appendChild(memoryMarkNode())'),
  'the mark rides the sender row when the flagged reply opens a run — beside the name and time, not inside the text')
assert(js.includes('if (memoryMark && !placedMemoryMark)') && js.includes("cornerMark.dataset.place = 'corner'"),
  'a flagged reply that continues a run has no row to ride, so it falls back to the bubble corner instead of dropping the mark')
assert(copy.includes('memoryMarkGlyph') && copy.includes('memoryMarkAria'),
  'both the glyph and its label live in copy.js like every other string on this surface')
assert(/\.chat-memory-mark \{[^}]*font-size: 0\.68rem/s.test(css) && /\.chat-memory-mark \{[^}]*color: var\(--fg-faint\)/s.test(css),
  'the mark is smaller than both the name (0.8rem) and the time (0.72rem) and uses the existing faint token — no new colour')
assert(!/\.chat-memory-mark[^{]*\{[^}]*(background|border):/s.test(css),
  'no fill and no border: it is a tell, not a badge (a badge would be the thing that changes the message)')
assert(/\.chat-memory-mark\[data-place='corner'\] \{[^}]*position: absolute/s.test(css),
  'the corner placement is absolutely positioned, so it can never add a line to the bubble or shift the text it marks')
assert(!/\.chat-memory-mark[^{]*\{[^}]*position: (static|relative)/s.test(css),
  'neither placement puts a mark back into the text flow')
assert(/\.chat-meta \{[^}]*gap: 8px/s.test(css),
  'the row it rides keeps its own spacing contract (the mark is one more item on the baseline, not a new row)')

console.log('\n3e. sender-row name (2026-09-28) — the probe\'s name reaches every row')
// The name span starts empty and is filled from the status probe, which can
// answer AFTER the retained transcript has painted. Source-level pins, same
// convention as the sections above: the three failure modes are all visible
// in the text — a placeholder shipped instead of a blank span, a re-label
// that never reaches the rows already on screen, and a trim that leaks.
assert(!js.includes("|| 'Agent'"),
  'no invented placeholder: the name fallback is a blank span, never a made-up \'Agent\' label shipped as if it were the real name')
assert(/const nameNodes = \[\]/.test(js) && js.includes('nameNodes.push(nm)')
  && /for \(const node of nameNodes\) node\.textContent = agentName/.test(js),
  'arrival re-labels rows already painted: every sender row\'s span is pushed into nameNodes and setStatus\'s up branch loops it to assign agentName')
assert(/gone\.remove\(\)[\s\S]{0,300}?nameNodes[\s\S]{0,300}?splice\(i, 1\)/.test(js) && js.includes('!nameNodes[i].isConnected'),
  'the row trim drops the detached spans it just removed — without this the array (and every dead node in it) grows for the whole session; splice, not shift(), because spans are not 1:1 with messages')

console.log('\n4. error left-rail (dormant until the feed carries an error kind)')
assert(css.includes('.chat-msg.chat-error'), 'error rail CSS present')
assert(/border-left: 2px solid transparent/.test(css), 'every turn reserves the rail slot (no layout shift when it colors)')

console.log('\n5. empty state = example prompts')
assert(js.includes('C.emptyExamples') && js.includes('input.value = example'), 'examples fill the composer')
assert(!js.match(/input\.value = example[\s\S]{0,80}sendMsg|sendNow|doSend/), 'examples never auto-send (user keeps the trigger)')
assert(copy.includes('emptyExamples'), 'example prompts live in copy')

console.log('\n6. live run timeline (aside port: open while working, "Worked for" at rest)')
assert(js.includes('runEl.open = true'), 'steps render into an OPEN <details> while the agent works')
assert(js.includes('runEl.open = false'), 'the reply that ends the wait closes the SAME element (no rebuild)')
assert(js.includes('finalizeActivityFold') && js.includes("document.createElement('details')"), 'reply finalizes the timeline into its resting summary')
assert(js.includes('TYPING_SHOW_MAX_MS) { discardRun(); return }'), 'stale-wait guard kept: a dead run cannot mislabel a later reply')
assert(js.includes('activityLog.push') && js.includes('MAX_FOLD_LINES'), 'steps accumulate with a cap (DOM rows shift with the log)')
assert(js.includes("st.state === 'working' && !runEl && !draftEl"), 'typing dots yield once the live timeline is the liveness signal (design-0025: the dots read the derived state, not a re-derived `waiting`)')
assert(copy.includes('Worked for'), 'resting summary uses the Worked-for wording')
assert(copy.includes('activityRunning'), 'live summary copy present')
assert(/\.fold-line::before \{[^}]*border-radius: 50%/s.test(css), 'timeline nodes: a dot per step (aside process-row anatomy)')
assert(/\.fold-line::after \{[^}]*width: 1px/s.test(css) && css.includes('.fold-line:last-child::after { display: none; }'), 'per-row connector segments thread node to node, suppressed on the last row')

console.log('\n7. one catalog, one list (Engine picker adds nothing — the owner 2026-09-28)')
// The Engine page (connectors.js) used to splice live-discovered ids (the
// installed CLI's own claude model table, live ollama.com tags) onto the
// shared static catalog, so its picker could offer rows the chat composer's
// dropdown did not show. The owner chose one catalog ("이거 한쪽으로 통합해줘,
// 카탈로그 하나로"). These pins hold that: the splicer is gone, and the
// load-bearing survivors it must NOT have taken with it stay. Same
// source-pin convention as the sections above (the page is DOM-in-browser).
const connectors = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'connectors.js'), 'utf8')
assert(!connectors.includes('mergeDynamicClaudeModels') && !connectors.includes('claudeLabelOf'),
  'connectors.js no longer carries the dynamic splicer (mergeDynamicClaudeModels / claudeLabelOf deleted, not just unreferenced)')
assert(!/api\('\/api\/model-catalog\//.test(connectors),
  'connectors.js no longer fetches /api/model-catalog/claude or /api/model-catalog/ollama — the Engine list is the static catalog alone')
assert(connectors.includes('(current)') && /MODEL_CATALOG\.some\(\(m\) => m\.id === model\)/.test(connectors),
  'the "(current)" passthrough survives — a stored non-catalog id still surfaces (reality, never a pickable option)')
assert(connectors.includes('__custom__') && connectors.includes('__ollama_url__') && connectors.includes('custom: true'),
  'both action sentinels and their custom:true provider-gate opt-out survive the merge removal')
assert(connectors.includes('!m.custom && !m.providers.some(') && connectors.includes('if (m.disabled) opt.disabled = true'),
  'the provider-gate disabled logic and the m.disabled withdrawal survive')
assert(!js.includes('Engine-page nicety'),
  'chat.js no longer claims the Engine page merges extras the chat dropdown lacks — both surfaces read the one catalog')

console.log('\n3f. pending signal (design-0024, 2026-09-28) — the "!" above the chat')
// The owner's "채팅창 위에서 퀘스트처럼 ! 떠있고 누르면 바로 세라가 반응해서" →
// "밀린 거 -> 페르소나 / 환류 / 꿈 등등". Source-level pins, same convention as
// the sections above (the page is DOM-in-browser). The failure modes worth
// catching are all visible in the text: a mark that ships VISIBLE (a phantom
// "!" on a fresh install), a glyph not from copy, wiring that never reads the
// route or never posts the click, and a failed read that lights the mark
// instead of hiding it.
const header = html.slice(html.indexOf('class="page-header"'), html.indexOf('class="subtitle"'))
assert(header.includes('id="ct-pending"') && header.includes('class="chat-pending"'),
  'the mark is a button in .page-header (chat.html)')
assert(/<button class="chat-pending" id="ct-pending"[^>]*\bhidden\b/.test(header),
  '...and it ships hidden — no phantom "!" before the first read answers')
assert(header.indexOf('ct-lane-chip') < header.indexOf('ct-pending')
  && header.indexOf('ct-pending') < header.indexOf('ct-new-convo'),
  'it sits between the lane chip and the new-conversation button (the header order the owner asked for)')
assert(copy.includes("pendingSignalGlyph: '!'") && js.includes('C.pendingSignalGlyph'),
  'the glyph is the owner\'s own "!" and it comes from copy.js, set on the node by chat.js')
assert(copy.includes('pendingSignalLabel'),
  'its title/aria label lives in copy.js too (the mark is readable in words, not symbol only)')
assert(/btn\.setAttribute\('aria-label', C\.pendingSignalLabel\)/.test(js) && /btn\.title = C\.pendingSignalLabel/.test(js),
  'both the hover (title) and the screen-reader label (aria-label) read that one string')
assert(js.includes("window.api('/api/pending-signal')"),
  'chat.js reads the pile with GET /api/pending-signal (the mark is a read of the route, not a second calculation)')
assert(js.includes("window.api('/api/pending-signal/recite'"),
  'a click POSTs /api/pending-signal/recite (one recital per press)')
assert(js.includes('if (pendingBusy) return') && /pendingBusy = true[\s\S]{0,120}?btn\.disabled = true/.test(js),
  'the button is disabled while the request is in flight, so a double-click cannot inject two recitals')
assert(/PENDING_MS = 30000/.test(js) && /setInterval\(refreshPending, PENDING_MS\)/.test(js),
  'the read rides its own 30s interval, never the 1s transcript poll')
assert(/catch \(err\) \{\s*console\.error\('pending signal failed:', err\)\s*setPendingMark\(0\)/.test(js),
  'a failed read HIDES the mark rather than lighting it (fail toward silence)')
assert(/setPendingMark[\s\S]{0,120}?btn\.hidden = !\(Number\.isFinite\(n\) && n > 0\)/.test(js),
  'the mark is shown only when the total is a positive number — no truthy accident')
assert(!/recitePending[\s\S]{0,700}?showToast/.test(js),
  'a failed recite shows no toast: the divider the inject produces and her words are the only visible result')
assert(/\.chat-pending \{[^}]*margin-left: 0\.6rem/s.test(css)
  && /\.chat-pending \{[^}]*color: var\(--accent\)/s.test(css)
  && /\.chat-pending \{[^}]*border: 1px solid var\(--accent-ring\)/s.test(css),
  'the badge keeps the header gap and is accent-lit from the existing tokens (--accent, --accent-ring)')
assert(css.includes('.chat-pending[hidden] { display: none; }'),
  'the hidden attribute is honoured in CSS, so the mark cannot flash before its first read')
assert(/\.chat-pending \{[^}]*border-radius: var\(--radius-s\)/s.test(css),
  'square-ish (--radius-s), not the pill — it is a badge, not a chip')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
