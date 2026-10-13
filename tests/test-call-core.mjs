import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { split, createSession } = createRequire(import.meta.url)('../onboarding/public/js/call-core.cjs')
assert.deepEqual(split('안녕하세요. 좋아요! 아직'), { sentences: ['안녕하세요.', '좋아요!'], rest: ' 아직' })
assert.deepEqual(split('はい。Really?…\n끝', true).sentences, ['はい。', 'Really?…', '끝'])
assert.deepEqual(split('미완성').sentences, [])
const sent = []; let closed = 0, cleared = 0
const s = createSession({ send: x => sent.push(x), closeMic: () => closed++, clearQueue: () => cleared++ })
s.final('off'); const g = s.start(); s.final('  '); s.final(' 답장 ', g)
s.partial('음성', () => cleared++); s.stop(); s.final('late', g)
assert.deepEqual(sent, ['답장']); assert.equal(closed, 1); assert.equal(cleared, 2)
s.start(); s.final('stale', g); assert.deepEqual(sent, ['답장'])
console.log('call splitter, endpoint auto-send, stale final and off cleanup passed')

// Dedupe at the final publication boundary, without changing the sent text.
let clock = 1000
const published = []
const dedupe = createSession({ send: x => published.push(x), closeMic() {}, clearQueue() {}, now: () => clock })
const first = dedupe.start()
dedupe.final('  Hello   세라  ')
clock += 500; dedupe.final('hello 세라')
dedupe.final('다른 말'); dedupe.final('HELLO\n세라')
assert.deepEqual(published, ['Hello   세라', '다른 말'])
clock = 3000; dedupe.final('hello 세라')
assert.equal(published.length, 3, 'same words are valid again at the two-second boundary')
dedupe.final('가'); dedupe.final('가'.normalize('NFD'))
assert.equal(published.length, 4, 'Unicode-equivalent transcripts are duplicates')
dedupe.stop(); dedupe.start(); dedupe.final('hello 세라', first)
assert.equal(published.length, 4, 'stale generations cannot publish or poison dedupe')
dedupe.final('hello 세라'); assert.equal(published.length, 5, 'a new call resets dedupe')
console.log('normalized final dedupe, window, interleaving and call reset passed')
