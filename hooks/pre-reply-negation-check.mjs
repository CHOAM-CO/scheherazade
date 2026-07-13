#!/usr/bin/env node
// pre-reply-negation-check.mjs -- denial gate (PreToolUse on
// mcp__agent-channel__reply).
//
// Port of MAGI fleet hooks/pre-reply-negation-check.mjs (v0.0.4 roadmap item,
// Mino 2026-07-13 19:40). Blocks "그런 적 없어 / 못 해 / 안 했는데" -class
// claims when the reply text shows no sign of having checked the records
// first. For a companion whose whole value is remembering, a confabulated
// denial ("we never talked about that") is worse than a wrong fact -- this
// forces one memory_query / notes check before the denial goes out.
//
// The Korean negation regexes carry the MAGI originals VERBATIM, including
// the false-positive fixes earned in fleet operation (epistemic-limit verbs
// exempted 2026-05-30, bare "안 돼" feel-register exempted 2026-06-01,
// particle-bridge char classes). Do not "simplify" them -- each oddity is a
// documented FP fix.

const NEGATION_PATTERNS = [
  /접근.{0,4}(없|불가)/,
  /수단.{0,4}없/,
  /도구.{0,4}없/,
  /API.{0,4}없/,
  /방법.{0,4}없/,
  // Epistemic-limit verbs ("증명 못 해") are facts, not capability denials.
  /(?<!(증명|입증|구분|보증|단정|확신|장담)[을를은는이가도만및과와의\s조차마저까지부터라하지기해서]{0,4})못.{0,3}(해|함|받|읽|돌|씀)/,
  // Bare "안 돼" is feel-register; only capability-noun + 안 돼 is a denial.
  /(접근|수단|도구|사용|실행|연결|지원|설치|설정|작동|구동|로드|호출|배포|적용|반영).{0,6}안.{0,3}(돼|됨)/,
  /그런.{0,4}(적|거).{0,3}없/,
  /한.{0,3}적.{0,3}없/,
  /(얘기|이야기|말|대화)한?.{0,4}적.{0,3}없/,
  /지원.{0,4}(안|불가)/,
  /불가능(?:해|임|이야|이다)/,
  /no.{0,3}(access|tool|api|way)/i,
  /can['’]?t.{0,6}(access|read|do|recall|remember)/i,
  /cannot.{0,6}(access|read|do|recall|remember)/i,
  /don['’]?t.{0,6}(remember|recall)/i,
  /not.{0,5}(available|possible|supported)/i,
  /never.{0,6}(talked|discussed|mentioned|said)/i,
]

// Signs the agent actually checked something before denying. memory_query /
// memory_recall_material are this app's record surfaces; session notes and
// checkpoint are the file layer.
const EXEMPT_RE = /memory_query|memory_recall|세션.?노트|체크포인트|기록.{0,6}(확인|찾|뒤|봤)|확인했|찾아봤|뒤져봤|grep|session_notes|checkpoint|checked|verified|searched/i

// Narrative/philosophical register -- negation there is not a records claim.
const NARRATIVE_RE = /꿈|꾸고|잠|인생|삶|하루|상상|비유|그때|옛날|어릴 때|철학|서사|캐릭터|씬|대사|영화|노래|게임 속/

// Descriptive/attribute register -- negation describes system properties.
const DESCRIPTIVE_RE = /속성|특성|특징|설계|전제|가설|정의|패턴|구조|원리|원칙|메커니즘|시스템적|사양|조건|기준|관측|측정|실험|증거|데이터|결과|분석/

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let hook
  try { hook = JSON.parse(raw || '{}') } catch { process.exit(0) }

  const text = hook?.tool_input?.text || ''
  if (!text) process.exit(0)

  if (EXEMPT_RE.test(text)) process.exit(0)
  if (NARRATIVE_RE.test(text)) process.exit(0)
  if (DESCRIPTIVE_RE.test(text)) process.exit(0)

  for (const pat of NEGATION_PATTERNS) {
    if (pat.test(text)) {
      const match = text.match(pat)?.[0] || ''
      process.stderr.write(
        `부정 답변 감지 ("${match}"). 기억을 근거로 부정하려면 먼저 기록을 확인해야 한다 -- ` +
        `memory_query로 관련 기억을 조회하거나 세션노트/체크포인트를 확인한 뒤, ` +
        `확인했다는 사실과 함께 다시 답해. 기록에 없으면 "기록엔 없다"가 정직한 답이다.\n`
      )
      process.exit(2)
    }
  }
  process.exit(0)
}

main().catch((e) => {
  process.stderr.write(`[pre-reply-negation-check] fatal: ${e.stack || e.message}\n`)
  process.exit(0) // fail-open
})
