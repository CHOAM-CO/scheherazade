import assert from 'node:assert/strict'
import { pickFollowUp } from '../memory/follow-up.mjs'
const now = '2026-10-06T12:00:00Z'
const record = text => ({ text, timestamp: '2026-10-05T12:00:00Z' })
const pick = input => pickFollowUp({ now, ...input })
assert.equal(pick({}), null)
assert.equal(pick({ sessionNoteTail: record('내일 보고서 확인할게') }).text, '내일 보고서 확인할게')
assert.equal(pick({ checkpoint: record('NEXT: tomorrow I will review the draft') }).source, 'checkpoint')
assert.equal(pick({ checkpoint: record('NEXT: review the draft') }).text, 'NEXT: review the draft')
assert.equal(pick({ sessionNoteTail: record('Mino: 내일 보고서 해\n> tomorrow review\n- “내일 확인할게”\n```\nTODO: quoted code\n```') }), null)
assert.equal(pick({ checkpoint: { text: 'TODO: review draft', timestamp: '2026-09-29T11:59:59Z' } }), null)
assert.equal(pick({ checkpoint: { text: 'TODO: review draft', timestamp: '2026-09-29T12:00:00Z' } }).age_hours, 168)
assert.equal(pick({ checkpoint: record('다음\n## NEXT\nTODO:') }), null)
assert.equal(pick({ checkpoint: { text: 'TODO: review draft' } }), null)
assert.equal(pick({ checkpoint: record('TODO: review draft'), openThreads: [{ summary: '아침에 운동하기로 했음', status: 'open', last_touched_at: '2026-10-06T10:00:00Z' }] }).source, 'open_thread')
assert.equal(pick({ openThreads: [{ summary: 'tomorrow review draft', status: 'closed', last_touched_at: now }] }), null)
assert.equal(pick({ sessionNoteTail: record('next session review draft\n내일 운동하기로 했음') }).text, '내일 운동하기로 했음')
console.log('PASS follow-up: Korean/English, recency, cutoff, echo, empty input')
