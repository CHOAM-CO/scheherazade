import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createUtteranceAggregator } = createRequire(import.meta.url)('../onboarding/public/js/call-core.cjs')
function fixture(options = {}) {
  let now = 0, seq = 0; const timers = new Map(), sent = []
  const a = createUtteranceAggregator({ send: t => sent.push(t),
    setTimer(fn, ms) { timers.set(++seq, { at: now + ms, fn }); return seq }, clearTimer(id) { timers.delete(id) }, ...options })
  function advance(ms) { const end = now + ms; for (;;) { const next = [...timers].sort((a,b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; timers.delete(next[0]); next[1].fn() }; now = end }
  return { a, sent, advance, timers }
}
{
  const { a, sent, advance } = fixture()
  a.final(' one '); advance(1199); assert.deepEqual(sent, [])
  a.final('two'); advance(1199); assert.deepEqual(sent, []); advance(1)
  assert.deepEqual(sent, ['one two']); assert.equal(a.waiting, false)
}
{
  const { a, sent, advance } = fixture()
  a.final('one'); advance(1000); a.partial('next'); advance(2000)
  assert.deepEqual(sent, []); a.final('next words'); advance(1200)
  assert.deepEqual(sent, ['one next words'])
}
{
  const { a, sent, advance } = fixture()
  a.final('one'); a.partial('long speech'); advance(11999); assert.deepEqual(sent, [])
  advance(1); assert.deepEqual(sent, ['one']); a.final('tail'); advance(1200)
  assert.deepEqual(sent, ['one', 'tail'])
}
{
  const { a, sent, advance, timers } = fixture({ capChars: 5 })
  a.final('ab'); a.final('cd'); assert.deepEqual(sent, ['ab cd']); assert.equal(timers.size, 0)
  a.final('tail'); a.reset(); advance(20000); assert.deepEqual(sent, ['ab cd'])
}
console.log('utterance quiet window, concatenation, resumed speech, time/character caps and reset passed')

{
  const { a, sent, advance } = fixture()
  a.final('sent'); advance(1200); a.setBlocked(true)
  a.final('older'); advance(1200); a.final('newer'); advance(1200)
  assert.deepEqual(sent, ['sent']); a.setBlocked(false)
  assert.deepEqual(sent, ['sent', 'older newer'], 'replace pending, prepend older text')
}
{
  const { a, sent, advance } = fixture()
  a.setBlocked(true); a.final('waiting'); advance(1200)
  a.partial('resuming'); a.setBlocked(false); advance(1000)
  assert.deepEqual(sent, []); a.final('resumed'); advance(1200)
  assert.deepEqual(sent, ['waiting resumed'])
}
{
  const { a, sent, advance } = fixture({ capChars: 4 })
  a.setBlocked(true); a.final('first'); a.final('second'); advance(12000)
  assert.deepEqual(sent, []); a.setBlocked(false)
  assert.deepEqual(sent, ['first second'], 'caps do not bypass the in-flight gate')
  a.setBlocked(true); a.final('cancelled'); a.reset(); a.setBlocked(false)
  assert.equal(sent.length, 1)
}
console.log('single pending turn replacement, prepend, resumed-speech merge and gated caps passed')
