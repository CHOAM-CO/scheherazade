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
  assert(!/textContent|chat-meta-name|innerHTML/.test(userRow),
    '...no name, no "You", no text of any kind on the user row (the time comes from the shared helper)')
  assert(userRow.includes('makeTimeNode(m.ts)'), '...plus the time, built by the same helper as agent rows (0.3.6)')
  assert(js.includes('if (m.ts) meta.appendChild(makeTimeNode(m.ts))'), '...and agent rows use that helper too')
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
const header = html.slice(html.indexOf('class="page-header'), html.indexOf('class="subtitle"'))
assert(header.includes('id="ct-quickbar"'), 'quickbar sits in the header row (Mino 2026-10-07: horizontal, same row as lane chip + New conversation)')
assert(header.indexOf('id="ct-quickbar"') < header.indexOf('ct-lane-chip'), 'quickbar comes before the lane chip (left side)')
assert(!header.includes('ct-pending'), 'old pending mark removed from header')
assert(header.includes('ct-lane-chip') && header.includes('ct-new-convo'), 'lane and new conversation remain in header')
assert(html.includes('<nav class="chat-quickbar" id="ct-quickbar"'), 'quickbar nav present')
for (const name of ['whats-new', 'look-back', 'browse', 'dream', 'today']) assert(html.includes(`id="qb-${name}"`), `quickbar ${name} button present`)
assert(html.includes('class="qb-dot" hidden'), 'dot starts hidden')
assert(js.includes('initQuickbar()'), 'quickbar initialized')
assert(js.includes("window.api('/api/quickbar/whats-new/status')"), 'status uses quickbar route')
assert(js.includes("window.api('/api/quickbar/whats-new',"), 'click posts one system turn')
assert(js.includes('if (button.disabled) return'), 'double-click guarded')
assert(js.includes("button.dataset.state = 'busy'"), 'busy state exposed')
assert(js.includes('s.hasUpdate || s.unseenNotes || s.pending.total > 0'), 'all dot sources included')
assert(js.includes('setInterval(() => { refresh(); refreshBrowse() }, PENDING_MS)'), 'status uses existing polling cadence')
assert(js.includes("button.setAttribute('aria-label', text)") && js.includes('button.title = text'), 'tooltip and accessible labels share copy')
assert(copy.includes('quickbarKo:') && copy.includes('qbWhatsNew:'), 'Korean and English copy provided')
assert(css.includes('.chat-quickbar { display: flex; flex-direction: row') && css.includes('.chat-page-header .chat-lane-chip { margin-left: auto; }'), 'quickbar is a horizontal row in the header; lane chip + New conversation pushed right')
assert(css.includes('.qb-dot[hidden] { display: none; }'), 'hidden dot does not flash')
assert(js.includes("e.key === 'Escape'") && js.includes("document.addEventListener('pointerdown'"), 'popover dismisses with Escape and outside click')


const quickbarOrder = ['whats-new', 'look-back', 'browse', 'dream', 'today'].map(name => html.indexOf(`id="qb-${name}"`))
assert(quickbarOrder.every((pos, i) => i === 0 || pos > quickbarOrder[i - 1]), 'quickbar button order')

console.log('\ncomposer-grow (Mino 2026-10-07 15:21: image or long text makes the box grow, Discord-style)')
// 1. text growth: cap at ~40% of the viewport, scroll past it; the
//    .chat-shell override must not clamp the height; the pane yields.
assert(/\.chat-input-row textarea \{[^}]*max-height: min\(40vh, 18rem\)/s.test(css), 'textarea grows up to min(40vh, 18rem)')
assert(!css.includes('max-height: 9rem'), 'old 9rem cap is gone')
assert(/\.chat-input-row textarea \{[^}]*overflow-y: auto/s.test(css), 'past the cap the textarea scrolls inside itself')
assert(!/\.chat-shell \.chat-input-row textarea \{[^}]*\n\s*height:/s.test(css), 'the .chat-shell textarea override sets no fixed height')
assert(css.includes('.chat-shell .chat-input-row { flex: 0 0 auto; }'), 'composer card never shrinks below its content')
assert(css.includes('.chat-shell .chat-pane-wrap { min-height: 6rem; }') && /\.chat-pane-wrap \{[^}]*min-height: 0/s.test(css), 'transcript pane gives way to a tall composer (no overlap, no page scroll)')
assert(js.includes('function resizeInput()') && js.includes("input.style.height = 'auto'") && js.includes('input.style.height = `${input.scrollHeight}px`'), 'one resize helper measures from scrollHeight after an auto reset')
assert(js.includes("input.addEventListener('input', resizeInput)"), 'resize on typing')
assert(js.includes("window.addEventListener('resize', resizeInput)"), 'resize on window resize (cap is viewport-relative)')
assert(js.includes("input.addEventListener('paste', () => setTimeout(resizeInput, 0))"), 'resize after a text paste lands')
assert(js.includes("input.value = example; resizeInput()"), 'programmatic value set re-measures')
assert(js.includes("input.value = ''\n      resizeInput()"), 'send clear collapses the box through the same helper')
// 2. pending attachments: thumbnail strip INSIDE the composer card, above
//    the textarea; images via the same blob path as sent bubbles.
const composer = html.slice(html.indexOf('class="chat-input-row"'), html.indexOf('chat-composer-bar'))
assert(composer.includes('id="ct-attach-chips"'), 'pending strip lives inside the composer card')
assert(composer.indexOf('id="ct-attach-chips"') < composer.indexOf('id="ct-input"'), 'strip sits above the textarea')
assert(html.indexOf('id="ct-attach-chips"') === html.lastIndexOf('id="ct-attach-chips"'), 'strip exists once (old above-card copy removed)')
assert(js.includes('async function loadAttachmentBlobUrl(name)'), 'shared blob-fetch helper')
assert(js.includes('const url = await loadAttachmentBlobUrl(name)'), 'sent-bubble images use the shared helper')
assert(js.includes('loadAttachmentBlobUrl(att.name).then((url) =>'), 'pending image thumbnails use the same helper')
assert(js.includes("chip.className = isImage ? 'chat-attach-thumb' : 'chat-attach-chip'"), 'images are thumbs, other kinds keep the chip look')
assert(js.includes("x.className = isImage ? 'chat-attach-x' : 'link'") && js.includes('pendingAttachments = pendingAttachments.filter((a) => a !== att)'), 'the x removes the pending attachment as before')
assert(copy.includes("attachRemove: 'Remove attachment'") && js.includes("x.setAttribute('aria-label', C.attachRemove)"), 'remove control labelled from copy')
assert(/\.chat-attach-thumb \{[^}]*height: 72px/s.test(css) && /\.chat-attach-thumb \{[^}]*border-radius: var\(--radius-m\)/s.test(css), 'thumbs are ~72px tall and rounded')
assert(css.includes('.chat-attach-thumb:hover .chat-attach-x') && /\.chat-attach-thumb \.chat-attach-x \{[^}]*opacity: 0/s.test(css), 'x appears on hover')
assert(css.includes('.chat-attach-chips:empty { display: none; }'), 'strip hidden when empty')
// 3. marker contract untouched
assert(js.includes('const IMG_MARKER_RE = /^\\[image attached: (.+?)(?: — [^\\]]*)?\\]$/'), 'IMG_MARKER_RE unchanged')
assert(js.includes('const markers = pendingAttachments.map(markerFor).join(\'\\n\')'), 'send() still appends one marker per attachment')

console.log('\nN. live switches skip the confirm dialog (0.3.15, Mino 10-07 19:12)')
{
  const connectors = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'connectors.js'), 'utf8')
  assert(!js.includes('switchConfirmLive') && !js.includes('effortConfirmLive') && !connectors.includes('switchConfirmLive') && !connectors.includes('effortConfirmLive') && !copy.includes('ConfirmLive'), 'the live confirm wordings are gone from chat.js, connectors.js and copy.js')
  const modelBlock = js.slice(js.indexOf('modelSel.onchange = async'), js.indexOf('effortSel.onchange = async'))
  const effortBlock = js.slice(js.indexOf('effortSel.onchange = async'), js.indexOf('async function initModelSwitch') > 0 ? js.length : js.length)
  for (const [name, block] of [['chat model chip', modelBlock], ['chat effort chip', effortBlock]]) {
    assert(/if \(mode !== 'live'\) \{\s*\n\s*const ok = await window\.confirmDialog\(SET\.(switch|effort)Confirm\(/.test(block), `${name}: confirmDialog is reached ONLY when the preview is not live (restart wording)`)
    assert((block.match(/confirmDialog/g) || []).length === 1, `${name}: exactly one confirmDialog call (no live variant)`)
  }
  assert(js.includes('function flashLiveCue(') && /r\.mode === 'live'\) \{ resolveVisionState\(\); flashLiveCue\(SET\.switchedLive\(/.test(js), 'chat: a live apply flashes a short status-row cue (no modal, no toast)')
  assert(copy.includes('switchedLive:') && /Takes effect on the next message/.test(copy), 'copy: switchedLive wording names the next-message semantics')
  const connModel = connectors.slice(connectors.indexOf("const mode = await window.routeSwitchPreview(provider !== currentProvider"), connectors.indexOf("$('set-ollama-url-hint')"))
  const connUrl = connectors.slice(connectors.indexOf("const mode = await window.routeSwitchPreview(currentProvider !== 'ollama'"), connectors.indexOf("$('set-effort-select').onchange"))
  const connEffort = connectors.slice(connectors.indexOf("$('set-effort-select').onchange"), connectors.indexOf('settleApplyState()', connectors.indexOf("$('set-effort-select').onchange")) + 'settleApplyState()'.length)
  for (const [name, block] of [['engine model select', connModel], ['engine ollama-by-URL apply', connUrl], ['engine effort select', connEffort]]) {
    assert(/if \(mode !== 'live'\) \{[\s\S]{0,200}window\.confirmDialog\(/.test(block) && (block.match(/confirmDialog/g) || []).length === 1, `${name}: confirm only on restart, exactly one confirmDialog call`)
    assert(/accepted\.mode === 'live'\) renderApplyState\(\)/.test(block), `${name}: live apply re-renders the existing apply-state line as the cue`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
