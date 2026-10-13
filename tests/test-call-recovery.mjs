import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const c = createRequire(import.meta.url)('../onboarding/public/js/call-core.cjs')
// B1: a cleared reply remains abandoned through drafts AND its final.
const spoken = [], reply = c.createReplySpeech(x => spoken.push(x))
reply.update('첫 문장. 다음', false); reply.abandon()
reply.update('첫 문장. 다음 문장.', false); reply.update('첫 문장. 다음 문장.', true)
assert.deepEqual(spoken, ['첫 문장.'])
reply.update('새 답장.', true); assert.deepEqual(spoken, ['첫 문장.', '새 답장.'])
const fresh = []; const beforeReply = c.createReplySpeech(x => fresh.push(x)); beforeReply.abandon(); beforeReply.update('새로운 답장.', true); assert.deepEqual(fresh, ['새로운 답장.'])
// S4: a final formatting correction does not replay the already spoken prefix.
const corrected = [], r = c.createReplySpeech(x => corrected.push(x))
r.update('**안녕**. 계속', false); r.update('안녕. 계속해요.', true)
assert.equal(corrected.length, 2); assert.equal(corrected[1], '계속해요.')
// S5: seed draft is already seen, not replayed.
const seeded = [], seed = c.createReplySpeech(x => seeded.push(x)); seed.prime('과거. ')
seed.update('과거. 새 문장.', true); assert.deepEqual(seeded, ['새 문장.'])
// B2: failure/manual-stop reconcile to off rather than active with dead capture.
assert.equal(c.micHealth(true, 'idle'), 'failed')
assert.equal(c.micHealth(true, 'listening'), 'ok')
assert.equal(c.micHealth(true, 'processing'), 'opening')
// B3: watchdog covers lost ended, pause, stall, unknown duration, hard cap.
assert.equal(c.playbackExpired({ paused: false, ended: false, duration: 2 }, 0, 8100), true)
assert.equal(c.playbackExpired({ paused: true, ended: false, duration: 2 }, 0, 1000), true)
assert.equal(c.playbackExpired({ paused: false, ended: false, duration: NaN }, 0, 120001), true)
assert.equal(c.playbackExpired({ paused: false, ended: false, duration: 999 }, 0, 120001), true)
assert.equal(c.playbackExpired({ paused: false, ended: false, duration: 2 }, 0, 1000), false)
// S3: synthesis and speaker tail are suppressed; stop restores listening.
assert.equal(c.suppressMic(true, false, 0, 1000), true)
assert.equal(c.suppressMic(false, false, 1000, 1200), true)
assert.equal(c.suppressMic(false, false, 1000, 1400), false)
// S1/S2: no decimal/file/URL fragmentation or fenced-code speech.
assert.deepEqual(c.split('버전 3.').sentences, [])
assert.deepEqual(c.split('버전 3.5 app.js a.b.cjs https://example.com 좋아요. ', false).sentences, ['버전 3.5 app.js a.b.cjs https://example.com 좋아요.'])
assert.deepEqual(c.split('생각... 아직', false).sentences, ['생각...'])
assert.deepEqual(c.split('설명.\n```js\nx.y();\ncode.\n```\n끝.', true).sentences, ['설명.', '끝.'])
assert.deepEqual(c.split('```js\na.\nb.').sentences, [])
// S8: duplicate endpoint within 2 s is not sent twice.
const sent = []; let now = 1000
const session = c.createSession({ send: x => sent.push(x), closeMic() {}, clearQueue() {}, now: () => now })
session.start(); session.final('같은 말'); session.final('같은 말'); now += 2100; session.final('같은 말')
assert.deepEqual(sent, ['같은 말', '같은 말'])
console.log('call recovery: abandoned reply, mic failure, watchdog, tail, splitter, final dedupe passed')
