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
