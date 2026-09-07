#!/usr/bin/env node
// test-reply-length-gate.mjs — pins for the rumination gate's v1.3 length
// branch (CLASS_D) and the marker-v2 subset-consume redesign.
//
// WHY (2026-08-05, Mino's Terra T2M session): the in-app agent pasted a ~5KB
// subagent report wholesale into reply. The harness never auto-forwards
// subagent output — the model pasted it — so the absorber is (a) a system
// prompt norm and (b) this one-bounce length gate. These tests pin the gate
// half: oversize bounces ONCE, a deliberate resend passes, and a summarized
// retry that still carries claim wording does NOT double-bounce (the exact
// UX failure the marker redesign exists to prevent).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hook = path.join(root, 'hooks', 'pre-reply-rumination-gate.mjs')

let passed = 0
let failed = 0
function assert(cond, name) {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`)
  }
}

function call(home, text, extraEnv = {}, channelId = 'chan-main') {
  const r = spawnSync(process.execPath, [hook], {
    env: { ...process.env, AGENT_DATA_HOME: home, ...extraEnv },
    input: JSON.stringify({
      tool_name: 'mcp__agent-channel__reply',
      tool_input: { channelId, text },
    }),
    encoding: 'utf8',
  })
  return {
    denied: r.stdout.includes('"permissionDecision":"deny"'),
    status: r.status,
    out: r.stdout,
    err: r.stderr,
  }
}

const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '.repeat(40) // ~2480 chars, no claim stems

console.log('1. oversize reply bounces once, deliberate resend passes')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const first = call(home, FILLER)
  assert(first.status === 0 && first.denied, 'oversize (no claim words): denied')
  assert(first.out.includes('자입니다') && first.out.includes('1500'), 'deny copy names the length and the threshold')
  const resend = call(home, FILLER)
  assert(!resend.denied && resend.status === 0, 'same oversize resent inside the window: allowed (one-bounce)')
  const third = call(home, FILLER)
  assert(third.denied, 'a NEW oversize after consumption bounces again (marker was consumed, not disabled)')
}

console.log('\n2. summarized retry with claim wording does NOT double-bounce (subset consume)')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const first = call(home, `배포 정리했어. ${FILLER}`)
  assert(first.denied, 'oversize + completion claim: denied')
  assert(first.out.includes('이미 처리했다') && first.out.includes('자입니다'), 'deny copy carries BOTH the claim check and the length check')
  const retry = call(home, '배포 정리했어. 핵심만: 서버 전환 끝났고 검증 남았어.')
  assert(!retry.denied && retry.status === 0, 'short summarized retry still containing the claim word: allowed (A ⊆ {A,D})')
}

console.log('\n3. a NEW class on the fresh retry bounces again, then the union passes')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const first = call(home, FILLER)
  assert(first.denied, 'oversize only: denied (marker = D)')
  const withClaim = call(home, `저장했어. ${FILLER}`)
  assert(withClaim.denied, 'retry adds a completion claim: denied again (A not in marked D)')
  const final = call(home, `저장했어. ${FILLER}`)
  assert(!final.denied && final.status === 0, 'second retry with same classes: allowed (AD ⊆ union AD)')
}

console.log('\n4. stale marker re-arms instead of wedging')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const first = call(home, FILLER)
  assert(first.denied, 'oversize: denied (marker written)')
  const gates = path.join(home, '.gates')
  const marker = readdirSync(gates).find((f) => f.startsWith('rumination.deny.'))
  assert(Boolean(marker), 'marker exists under the v1.3 naming scheme')
  const old = (Date.now() - 11 * 60 * 1000) / 1000
  utimesSync(path.join(gates, marker), old, old)
  const afterStale = call(home, FILLER)
  assert(afterStale.denied, 'past the window: bounces again (beat expired)')
  const retry = call(home, FILLER)
  assert(!retry.denied && retry.status === 0, 'retry after the re-arm: allowed (fresh marker, not a wedge)')
}

console.log('\n5. env knobs')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const off = call(home, FILLER, { SCHEHERAZADE_REPLY_MAX_CHARS: '0' })
  assert(!off.denied && off.status === 0, 'MAX=0 disables the length branch')
  const home2 = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const tight = call(home2, 'x'.repeat(150), { SCHEHERAZADE_REPLY_MAX_CHARS: '100' })
  assert(tight.denied && tight.out.includes('기준 100자'), 'MAX=100 bounces a 150-char reply and names the custom threshold')
  const home3 = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const short = call(home3, 'done, all good')
  assert(!short.denied && short.status === 0, 'short clean reply untouched')
}

console.log('\n6. legacy marker schemes are deleted on sight')
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'schz-len-'))
  const gates = path.join(home, '.gates')
  mkdirSync(gates, { recursive: true })
  writeFileSync(path.join(gates, 'rumination.last_deny'), String(Date.now()), 'utf8') // pre-P0-3 global
  writeFileSync(path.join(gates, 'rumination.last_deny.0123456789abcdef'), String(Date.now()), 'utf8') // P0-3 scoped
  const first = call(home, FILLER)
  assert(first.denied, 'bounce still fires with legacy markers present (they are never honored)')
  const left = readdirSync(gates).filter((f) => f.startsWith('rumination.last_deny'))
  assert(left.length === 0, 'both legacy marker schemes deleted')
  const fresh = readdirSync(gates).filter((f) => f.startsWith('rumination.deny.'))
  assert(fresh.length === 1 && readFileSync(path.join(gates, fresh[0]), 'utf8').trim() === 'D', 'v1.3 marker written with fired classes as content')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
if (!existsSync(hook)) process.exit(1)
