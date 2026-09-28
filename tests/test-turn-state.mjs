#!/usr/bin/env node
// test-turn-state.mjs -- design-0025: the chat pane's ONE derived turn state.
//
// Two layers, the same split test-appearance.mjs uses:
//  1. functional -- js/turn-state.cjs, the derivation itself. It was given a
//     plain input object and no DOM on purpose, so all six states are pinned
//     here from fixed inputs with a frozen clock. This is the half that would
//     silently rot if the thresholds or the priority order drifted.
//  2. text pins -- the wiring in chat.js / copy.js / app.css / chat.html. The
//     page is DOM-in-browser, so these hold the seams the functional half
//     cannot see: that the render path READS the derivation instead of
//     re-deriving, that the new nodes are built without innerHTML, that the
//     abort item closes the folds, that the gone state's action is the app's
//     own restart route, and that the new strings are English, quiet, and
//     free of em dashes and emoji.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(path.join(root, 'package.json')).href)

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

const T = require(path.join(root, 'onboarding', 'public', 'js', 'turn-state.cjs'))
const js = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'chat.js'), 'utf8')
const copy = readFileSync(path.join(root, 'onboarding', 'public', 'js', 'copy.js'), 'utf8')
const css = readFileSync(path.join(root, 'onboarding', 'public', 'css', 'app.css'), 'utf8')
const html = readFileSync(path.join(root, 'onboarding', 'public', 'chat.html'), 'utf8')

console.log('1. the module loads both ways (the dual-environment contract)')
assert(typeof T.deriveTurnState === 'function',
  'node require()s the same bytes the browser loads as a <script> (window.SCHZ_TURN_STATE)')
assert(T.TYPING_SHOW_MAX_MS === 3 * 60 * 1000 && T.LINKING_GRACE_MS === 20 * 1000,
  'the thresholds are the design\'s own numbers: 3 min cap, ~20 s reconnecting grace')
assert(Array.isArray(T.STATES) && T.STATES.length === 6 && T.STATES.includes('gone') && T.STATES.includes('stopping'),
  'exactly the six states of the design table exist and are enumerable')

console.log('\n2. one state from a fixed pair of inputs (frozen clock)')
const NOW = 1_800_000_000_000 // arbitrary, frozen
const at = (msAgo) => NOW - msAgo
assert(T.deriveTurnState({ now: NOW, awaitingSince: null }).state === 'idle',
  'idle: awaitingReplySince null -> nothing in flight')
const working = T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true })
assert(working.state === 'working' && working.inFlight === true && working.elapsedMs === 1000,
  'working: a turn owed and the poll up, with its elapsed carried out')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(T.TYPING_SHOW_MAX_MS + 1), pollUp: true }).state === 'stalled',
  'stalled: same facts past the 3 min cap (the dots may go; the chip stays)')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(T.TYPING_SHOW_MAX_MS) , pollUp: true }).state === 'stalled',
  'the cap is inclusive: exactly TYPING_SHOW_MAX_MS is already stalled')
const linking = T.deriveTurnState({ now: NOW, awaitingSince: at(5000), pollUp: false })
assert(linking.state === 'linking' && linking.inFlight === true,
  'linking: poll failing under the grace reads as reconnecting, still in flight')
const gonePoll = T.deriveTurnState({ now: NOW, awaitingSince: at(T.LINKING_GRACE_MS), pollUp: false, tail: 'tool_result' })
assert(gonePoll.state === 'gone' && gonePoll.reason === 'death' && gonePoll.tail === 'tool_result',
  'gone: poll failing past the grace is an honest death, with where it landed')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, stoppingAt: at(1000) }).state === 'stopping',
  'stopping: between the Stop press and the abort item landing')

console.log('\n3. the inputs the pane alone knows')
const off = T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, lane: { state: 'stopped' } })
assert(off.state === 'gone' && off.agentOff === true,
  'a stopped lane is gone even on a tick the channel still answers, and is flagged as stopped-by-the-user')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, lane: { state: 'failed' } }).state === 'gone',
  'a failed lane is a death (the poll\'s opinion is not allowed to outvote it)')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, lane: { state: 'connecting' } }).state === 'working',
  'a lane mid-respawn (connecting) is NOT a death -- it is the turn still working')
const died = T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, died: true, tail: 'user' })
assert(died.state === 'gone' && died.reason === 'death' && died.tail === 'user',
  'the sticky died latch keeps a turn dead even after the poll comes back (no drifting back to working over a corpse)')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, restartingAt: at(1000) }).state === 'linking',
  'an asked-for restart reads as the same quiet reconnecting line, bounded by RESTART_GRACE_MS')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, restartingAt: at(T.RESTART_GRACE_MS + 1) }).state === 'working',
  'past the restart grace the derivation falls back to the honest reading rather than pretending a respawn is coming')

console.log('\n4. settling: the abort item is the settle, in both directions')
const settled = T.deriveTurnState({ now: NOW, awaitingSince: null, abortAt: at(500), abortReason: 'stop' })
assert(settled.state === 'idle' && settled.reason === 'stop' && settled.inFlight === false,
  'awaitingReplySince null + an abort item -> idle, carrying the reason for the settled line')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), abortAt: at(2000), abortReason: 'stop', pollUp: true }).state === 'working',
  'an OLD abort (before this turn began) does not settle the turn that came after it')
const bothDead = T.deriveTurnState({ now: NOW, awaitingSince: at(1000), abortAt: at(500), abortReason: 'stop', stoppingAt: at(800), pollUp: true })
assert(bothDead.state === 'idle' && bothDead.reason === 'stop',
  'the abort item beats the stopping hold it was waiting for (the item IS the settle, not the press)')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), stoppingAt: at(T.STOP_GRACE_MS + 1), pollUp: true }).state === 'working',
  'a Stop press whose item never lands times out of `stopping` instead of hanging the pane')

console.log('\n5. the shape is total (nothing is a guess)')
const bare = T.deriveTurnState()
assert(bare.state === 'idle' && bare.elapsedMs === null && bare.reason === null && bare.tail === null,
  'no inputs at all is idle with nothing invented, never a throw')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, tail: 'nonsense' }).tail === null,
  'a tail outside the enum is dropped, not passed through to the copy')
assert(T.deriveTurnState({ now: NOW, awaitingSince: at(1000), pollUp: true, abortReason: 'nope' }).reason === null,
  'a reason outside the enum is dropped too')
assert(T.deriveTurnState({ now: NOW, awaitingSince: NOW + 5000, pollUp: true }).elapsedMs === 0,
  'a clock that ran backwards clamps to 0 rather than printing a negative elapsed')

console.log('\n6. chat.js reads the derivation instead of re-deriving')
assert(!js.includes('function updatePresence'),
  'the scattered updatePresence() is gone -- there is no second place deriving "is a turn running"')
assert(js.includes('const TURN = window.SCHZ_TURN_STATE') && js.includes('TURN.deriveTurnState({'),
  'the render path reads window.SCHZ_TURN_STATE, the module chat.html loads before this file')
assert(js.includes('function deriveTurn()') && js.includes('function renderTurn()'),
  'one deriveTurn() feeding one renderTurn(): every render site reads the state, none recomputes it')
assert(js.includes('turnState = st.state'),
  'the derived state is stored once per tick (turnState) and the tick paints from it')
assert(js.includes('function applyAwaiting(') && js.includes('if (prev === null && next !== null) beginTurnLatches()'),
  'awaitingSince has a single writer, and a turn beginning is where the previous turn\'s latches go')

console.log('\n7. the elapsed chip: next to the step label, in every in-flight state')
assert(js.includes('runChipEl.textContent = chip') && js.includes('turnChipEl.textContent = chip'),
  'the chip paints in both homes -- the live run fold\'s summary while it is on screen, the rail otherwise')
assert(/const chip = st\.inFlight && C\.turnElapsed/.test(js),
  'the chip shows for EVERY in-flight state, stalled included (past the cap it is the point, not the exception)')
assert(js.includes("turnChipEl.setAttribute('aria-hidden', 'true')") && js.includes("runChipEl.setAttribute('aria-hidden', 'true')"),
  'both clocks are aria-hidden: a per-second ticking chip must not be read out over an aria-live pane')
assert(css.includes('.chat-turn-elapsed') && /\.chat-turn-elapsed \{[^}]*tabular-nums/s.test(css),
  'the chip uses tabular figures and the existing faint token -- no new colour')

console.log('\n8. the turn-abort item (settled line, folds closed)')
assert(js.includes("m.kind === 'turn-abort'") && js.includes('function showTurnAbort('),
  'renderItem routes the new kind to its own renderer')
assert(js.includes('function closeTurnFolds()') && js.includes('finalizeThinkFold()') && js.includes('discardDraft()'),
  'the abort line closes the run fold, the think fold and the draft bubble using the EXISTING closers')
assert(/showTurnAbort\(m\)[\s\S]{0,600}?closeTurnFolds\(\)/.test(js),
  'the close happens on render of the item, not one poll later')
assert(js.includes('el.dataset.seq = m.seq') || js.includes('dataset.seq = m.seq'),
  'the settled line carries the item\'s seq like every other transcript node')
assert(/lastAbort = \{[\s\S]{0,200}?reason:[\s\S]{0,200}?elapsedMs:[\s\S]{0,200}?at:/.test(js),
  'the item records {reason, elapsedMs, at} for the derivation to settle on')

console.log('\n9. gone: honest line, folds closed, Stop becomes Restart via the app route')
assert(js.includes('function restartLane()') && js.includes("dataset.mode = mode"),
  'the composer action swaps to a restart action only in the gone state')
assert(js.includes("window.api('/api/agent/restart'"),
  'the restart action fires the app\'s OWN lifecycle route -- no spawn path is invented')
assert(!/child_process|spawn\(|execFile/.test(js),
  'and nothing in chat.js reaches for a process spawn of its own')
assert(js.includes('if (st.inFlight && !running && prevState !== st.state) closeTurnFolds()'),
  'linking / gone / stopping close the folds on the transition (a streaming draft is not dropped every tick)')
assert(js.includes('if (st.state === \'gone\') diedInFlight = true'),
  'once gone, the pane latches it so a returning poll cannot resurrect the turn')

console.log('\n10. the new strings: English, quiet, one register')
// copy.js is browser JS: give it the two globals it reads and nothing else
// (the same evaluation trick tests/test-setup-token-copy.mjs and
// test-permission-probes.mjs use), so the settled line is pinned by CALLING it
// rather than by grepping its source text.
const evalCopy = new Function('window', 'document', `${copy}\nreturn window`)({}, { querySelector: () => null })
const CH = evalCopy.COPY.chat
assert(typeof CH.turnAbort === 'function' && typeof CH.turnGone === 'function' && typeof CH.turnElapsed === 'function',
  'copy.js evaluates in node and the turn-state strings ride window.COPY.chat')
assert(['Reconnecting…', 'The agent is off.', 'The session ended mid-run.'].every((s) => copy.includes(s)),
  'every turn-state line lives in copy.js, in the English register of the strings around it')
assert(CH.turnReconnecting === 'Reconnecting…' && CH.turnGoneOff === 'The agent is off.',
  'the reconnecting and agent-off lines are quiet English sentences, no spinner, no exclamation')
assert(CH.turnGone('tool_result') === 'The session ended while waiting on a tool result.'
  && CH.turnGone('user') === 'The session ended before the reply was written.'
  && CH.turnGone(null) === 'The session ended mid-run.',
  'the live gone line names where it landed, and says "mid-run" only when it cannot tell')
// The settled transcript line, BY VALUE: the same heads as the live line,
// WITHOUT a trailing period (a duration clause follows), and an unknown reason
// still says the one true thing.
const abortLine = CH.turnAbort
assert(abortLine('stop', null, null) === 'Stopped' && abortLine('stall', null, null) === 'Cut off after going quiet',
  'a stop and a stall settle as their own heads, with no duration when the item carries none')
assert(abortLine('death', null, 'tool_result') === 'Session ended while waiting on a tool result'
  && abortLine('death', null, 'user') === 'Session ended before the reply was written'
  && abortLine('death', null, null) === 'Session ended mid-run',
  'a death reuses the live line\'s three arms, minus the period')
assert(abortLine('nonsense', null, null) === 'The turn ended',
  'a reason outside the enum does not invent a sentence')
assert(abortLine('stop', 45_000, null) === 'Stopped · 45s'
  && abortLine('stall', 12 * 60 * 1000, null) === 'Cut off after going quiet · 12m'
  && abortLine('death', 5000, 'user') === 'Session ended before the reply was written · 5s',
  'with a duration the line is head · <duration>, in the run fold\'s own units')
assert(CH.turnElapsed(0) === '' && CH.turnElapsed(45_000) === '45s' && CH.turnElapsed(12 * 60 * 1000) === '12m',
  'the elapsed helper reads as "Worked for Ns": seconds under a minute, whole minutes above')
// no em dash and no emoji anywhere in the new block (the register rule: quiet,
// monochrome, one small glyph at most -- and there is not even the glyph here)
const block = copy.slice(copy.indexOf('turn state (design-0025'), copy.indexOf('DM interaction states'))
assert(!block.includes('—'), 'no em dash in any of the new turn strings')
assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(block), 'no emoji in the new turn strings')
// The block may carry no Korean LITERAL -- it sits on a pane whose every other
// string is English. Comments keep the owner's own Korean ask (provenance, not
// copy), so strip them before the scan; there is no block comment in the block.
const codeOnly = block.split('\n').map((l) => {
  const i = l.indexOf('//')
  return i === -1 ? l : l.slice(0, i)
}).join('\n')
assert(!/[가-힣]/.test(codeOnly),
  'no Korean literal in the new turn-state block (only comments keep the owner\'s Korean ask)')
assert(js.includes('C.turnElapsed') && js.includes('C.turnGone') && js.includes('C.turnAbort'),
  'chat.js reads them through COPY like every other string on the surface')
assert(html.indexOf('turn-state.cjs') !== -1 && html.indexOf('turn-state.cjs') < html.indexOf('/js/chat.js'),
  'chat.html loads turn-state.cjs BEFORE chat.js (chat.js reads it at load time)')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
