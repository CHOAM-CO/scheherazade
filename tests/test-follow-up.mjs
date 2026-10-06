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
// 0.3.13 field fix (Mino's box, 10-06): a lesson under "## 살아있는 교훈" containing "다음 턴에" was
// picked over the real open items; bare 다음 is not a promise and rule sections are skipped.
const cp = record('## 살아있는 교훈\n- **턴이 도는 중에 온 지시는 그 턴을 못 멈춘다** — 큐에 남아 다음 턴에 들어온다.\n## 열린 스레드\n- 지휘관 미답 4건: ① 겨울 반전 ② 부록2 순서\n- ⚠ 루틴 하나 삭제된 것 확인 필요\n## 도구 / 자산\n- 내일 tools/boot.mjs 손볼게')
assert.equal(pick({ checkpoint: cp }).text, '⚠ 루틴 하나 삭제된 것 확인 필요')
assert.equal(pick({ checkpoint: record('## 교훈\n- 내일 또 틀리지 말 것') }), null)
assert.equal(pick({ checkpoint: record('- 큐에 남아 다음 턴에 들어온다') }), null)
console.log('PASS follow-up: section skip, bare 다음 excluded')
