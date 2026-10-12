import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const m = require('../companion/model.cjs')
const { coversMonitor } = require('../companion/fullscreen.cjs')
let count = 0
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`) }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-companion-'))
try {
  test('missing state is off, quiet, 45 minutes', () => {
    const s = m.readState(home); assert.equal(s.enabled, false); assert.equal(s.sound, false); assert.equal(s.intervalMinutes, 45)
  })
  test('read does not create a settings file', () => assert.deepEqual(fs.readdirSync(home), []))
  test('state persists per-display coordinates and preferences', () => {
    const expected = m.writeState(home, { enabled: true, sound: true, intervalMinutes: 60, displayId: '2', positions: { 2: { x: -1200, y: 43 } } })
    assert.deepEqual(m.readState(home), expected)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'companion.json'))).positions['2'].x, -1200)
    assert.deepEqual(fs.readdirSync(home), ['companion.json'])
  })
  test('write is private on POSIX', () => { if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'companion.json')).mode & 0o777, 0o600) })
  test('corrupt state reports and falls back off', () => {
    fs.writeFileSync(path.join(home, 'companion.json'), '{'); const logs = []
    assert.equal(m.readState(home, s => logs.push(s)).enabled, false); assert.equal(logs.length, 1)
  })
  test('null input is safe', () => assert.equal(m.normalize(null).enabled, false))
  test('only boolean true enables', () => assert.equal(m.normalize({ enabled: 'true' }).enabled, false))
  test('nonfinite interval defaults', () => assert.equal(m.normalize({ intervalMinutes: Infinity }).intervalMinutes, 45))
  test('low interval is clamped', () => assert.equal(m.normalize({ intervalMinutes: -1 }).intervalMinutes, 5))
  test('high interval is clamped', () => assert.equal(m.normalize({ intervalMinutes: 99999 }).intervalMinutes, 1440))
  test('coordinates validated, rounded, prototype keys excluded', () => {
    const p = m.normalize({ positions: JSON.parse('{"1":{"x":1.2,"y":2.8},"2":{"x":"3","y":4},"__proto__":{"x":0,"y":0}}') }).positions
    assert.deepEqual(Object.keys(p), ['1']); assert.deepEqual(p['1'], { x: 1, y: 3 }); assert.equal(Object.getPrototypeOf(p), null)
  })
  const primary = { id: 1, workArea: { x: 0, y: 30, width: 2560, height: 1370 } }
  const other = { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }
  test('DIP default leaves 12px inset below menu bar', () => assert.deepEqual(m.initialAnchor(m.normalize(), [primary], primary).anchor, { x: 2484, y: 42 }))
  test('remembered display restored', () => assert.equal(m.initialAnchor(m.normalize({ displayId: 2 }), [primary, other], primary).display.id, 2))
  test('unplugged display falls back to primary', () => assert.equal(m.initialAnchor(m.normalize({ displayId: 2 }), [primary], primary).display.id, 1))
  test('offscreen saved position clamped after resolution change', () => assert.deepEqual(m.clampAnchor({ x: 9999, y: -9999 }, primary.workArea), { x: 2496, y: 30 }))
  test('collapsed window is exactly 64 DIP', () => assert.deepEqual(m.layout({ x: 100, y: 50 }, primary.workArea, false).bounds, { x: 100, y: 50, width: 64, height: 64 }))
  test('bubble opens left when room', () => { const g = m.layout({ x: 2400, y: 42 }, primary.workArea, true); assert.equal(g.placement, 'left'); assert.equal(g.bounds.x + g.face.x, 2400) })
  test('bubble opens below when no left room', () => assert.equal(m.layout({ x: 20, y: 42 }, primary.workArea, true).placement, 'below'))
  test('bubble stays within work area at bottom-right', () => { const b = m.layout({ x: 2496, y: 1336 }, primary.workArea, true).bounds; assert.ok(b.y + b.height <= 1400); assert.ok(b.x + b.width <= 2560) })
  const eligible = { now: 120000, bootAt: 0, lastAt: null, enabled: true, known: true, fullscreen: false, busy: false, bubble: false }
  test('two-minute boot boundary permits proactive', () => assert.equal(m.canProactive(eligible), true))
  test('first two minutes are quiet', () => assert.equal(m.canProactive({ ...eligible, now: 119999 }), false))
  test('45-minute rate limit before boundary', () => assert.equal(m.canProactive({ ...eligible, now: 2819999, lastAt: 120000 }), false))
  test('45-minute boundary permits one turn', () => assert.equal(m.canProactive({ ...eligible, now: 2820000, lastAt: 120000 }), true))
  for (const [key, value] of [['enabled', false], ['known', false], ['fullscreen', true], ['busy', true], ['bubble', true]]) {
    test(`${key}=${value} suppresses proactive`, () => assert.equal(m.canProactive({ ...eligible, [key]: value }), false))
  }
  test('clock rollback suppresses proactive', () => assert.equal(m.canProactive({ ...eligible, lastAt: 999999 }), false))
  test('fullscreen hides enabled companion', () => assert.deepEqual(m.fullscreenDecision({ enabled: true, fullscreen: true }), { visible: false, hiddenByFullscreen: true, proactiveAllowed: false }))
  test('leaving fullscreen restores enabled companion', () => assert.equal(m.fullscreenDecision({ enabled: true, fullscreen: false }).visible, true))
  test('disabled stays hidden on fullscreen exit', () => assert.equal(m.fullscreenDecision({ enabled: false, fullscreen: false }).visible, false))
  test('unknown fullscreen never permits proactive', () => assert.equal(m.fullscreenDecision({ enabled: true, fullscreen: false, known: false }).proactiveAllowed, false))
  const rect = { left: 0, top: 0, right: 5120, bottom: 2880 }
  test('native physical-pixel monitor match at 200% DPI', () => assert.equal(coversMonitor(rect, rect), true))
  test('maximized work area is not fullscreen', () => assert.equal(coversMonitor({ ...rect, bottom: 2800 }, rect), false))
  test('negative monitor origins work', () => { const r = { left: -1920, top: 0, right: 0, bottom: 1080 }; assert.equal(coversMonitor(r, r), true) })
  test('unknown bounds never claim fullscreen', () => assert.equal(coversMonitor(null, rect), false))
  const msg = text => ({ role: 'agent', kind: 'message', text })
  test('ordinary completions remain in main window', () => assert.equal(m.classifyMessage(msg('Finished.')), null))
  test('chat questions get attention', () => assert.equal(m.classifyMessage(msg('어떤 색이 좋아요?')), 'question'))
  test('approval-shaped chat is explicitly a reply, not tool permission', () => assert.equal(m.classifyMessage(msg('변경을 진행할까요?')), 'approval-reply'))
  test('companion-requested completion returns inline', () => assert.equal(m.classifyMessage(msg('Finished.'), 'reply'), 'reply'))
  test('proactive replies remain timeout-eligible even with a question', () => assert.equal(m.classifyMessage(msg('How are you?'), 'proactive'), 'proactive'))
  test('activity and reasoning never open bubbles', () => assert.equal(m.classifyMessage({ ...msg('Do I?'), kind: 'think' }, 'reply'), null))
  test('user text never opens bubbles', () => assert.equal(m.classifyMessage({ ...msg('Do I?'), role: 'user' }), null))
  test('empty messages stay silent', () => assert.equal(m.classifyMessage(msg(' '), 'reply'), null))
} finally {
  for (const f of fs.readdirSync(home)) fs.unlinkSync(path.join(home, f))
  fs.rmdirSync(home)
}
console.log(`${count} companion model checks passed`)
