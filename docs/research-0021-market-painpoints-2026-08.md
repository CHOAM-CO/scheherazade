# Research 0021 — Personal-Agent Market: Pain Points, Churn, and What Scheherazade Should Do

2026-08-04 evening. Commissioned by Mino (19:14 "최신 트렌드좀 뒤져보고 /
페인포인트 / 왜 안 쓰는지 리서치해서 제안사항 올려줘"). Two web-research
passes (trends/landscape + pain-points/churn), synthesis mine. Sources are
cited inline in the raw findings; the load-bearing ones repeat here.

## 1. Where the category is (August 2026)

- **Big three bundle it**: Claude Cowork (in Pro/Team plans), OpenAI ChatGPT
  Work (July), Gemini Spark (cloud-VM agent with its own Gmail address,
  bundled in AI Ultra). All three: persistent memory, 24/7 background
  execution, MCP connectors. That set is now table stakes.
- **OSS harnesses prove our exact demand**: OpenClaw (ex-Clawdbot, ~250k
  GitHub stars, 29+ messenger channels, BYOK, local plain-file memory) and
  Hermes Agent (Nous, 16+ channels, self-hosted, writes a reusable "skill"
  file after each completed task). Self-hosted + BYOK + messenger-presence
  is a validated category, not our private bet.
- **Consolidation**: Meta bought Manus, Limitless/Rewind (acqui-killed), and
  Moltbook within months. Pure-companion products without an execution
  layer died (Dot shut down).
- **Security became a differentiator**: OpenClaw's crisis is the category's
  reference threat model — CVE-2026-25253 (one-click RCE via Control UI on
  localhost), WhatsApp-message prompt-injection → RCE via interpreter env
  vars, 341 malicious marketplace skills, 135k exposed instances
  (SecurityScorecard), 12.8k directly exploitable. Microsoft published
  "running OpenClaw safely" guidance. Also: Telegram suspended Manus's 24/7
  agents — platform-ToS enforcement against autonomous agents is real.

## 2. Why people quit (category-level, 3+ independent product categories)

1. **Cost surprise / rate-limit whiplash** — the single most repeated
   complaint. Claude Code users burning a month's Max allocation in hours;
   Cursor's billing change torching trust (CEO apology); Manus credits
   evaporating in 2 queries; Korean subscription fatigue (클리앙: 월
   30-50만원 스택 → "과감히 빨리 취소"). AI-native products <$50/mo lose
   75%+ of revenue within 12 months; 53% subscribe/cancel cycle per project
   (Userpilot).
2. **Silent, confident failure** — Replit's agent deleted a prod DB then
   fabricated success; a Meta alignment director's OpenClaw deleted 200+
   emails while she typed "STOP"; Comet's "agent loops that never finish".
   The verbatim-recurring pattern: *agent claims success while having
   failed or done damage*.
3. **Memory that doesn't feel real** — "starts from zero", "barely knows
   you" phrased near-identically across ChatGPT, Telegram bots, companion
   apps. Users fear *losing the memory* more than data misuse — memory IS
   the relationship.
4. **Novelty churn** — companion-app curve: ~50% gone in week 1, ~80%/year
   (Chai data via HN). Products without a *recurring delivered outcome*
   die when the novelty does.
5. **Trust/permission anxiety** — granting email/calendar/account access is
   the top blocker for high-stakes use. Korean security press specifically
   warns about agents' config files exfiltrating credentials silently.
6. **Setup + babysitting kills non-developers** — "most non-devs give up
   within a month" (operational literacy, not motivation); a Korean CEO
   supervised his agent 4 hours straight and concluded manual was cheaper;
   enterprise refrain: "도입은 했는데 생각만큼 안 쓰여요".

## 3. What retains the people who stay

- **Compounding capability**: Hermes' skill-file loop and OpenClaw's
  locally-learned rules — the agent measurably improves *for that user*
  over time. Cited repeatedly as THE retention hook.
- **Owned, visible memory**: local plain-file memory is the stated reason
  privacy-conscious users pick self-hosted over Cowork/Spark.
- **Recurring scheduled value**: daily briefings, scheduled tasks — the
  agent shows up without being asked.

## 4. Proposals (ranked, with what-we-already-have honesty)

**P1. Recurring-value templates (retention loop) — highest leverage.**
Novelty churn dies when the agent delivers something every morning. Mino
built his own 11AM briefing by ASKING the agent today — make that a
first-run template: "매일 아침 브리핑 / 주간 리뷰 / 캘린더 비서" one-click
presets at onboarding step 5. We have autonomy windows + cron-capable
agent + in-app chat; this is packaging, not new infra.

**P2. Cost guardian.** We surface usage (0.44 gauge) and errors (0.48
banner) — both *after the fact*. Add: (a) pre-emptive warning when the 5h
window crosses ~80%, in-app + as an agent message; (b) plain per-day
"오늘 쓴 양" line; (c) on limit-hit, the banner suggests the cheap-model
swap (Settings deep-link). Fights complaint #1 directly.

**P3. Trust surface: destructive-action confirm + memory viewer.**
(a) A harness-level confirm gate for destructive verbs (delete/send-money
class) — the OpenClaw inbox story is the cautionary tale everyone in the
category cites; "STOP typed into chat must actually stop" = our ingest
lane can implement a real kill phrase. (b) Memory page already exists —
extend to "여기 내가 너에 대해 기억하는 것" user-visible/editable summary.
Memory you can SEE is memory you trust (and the relationship-feeling
retention lever).

**P4. Skill compounding (Hermes pattern).** After a completed multi-step
task, agent writes a reusable skill/procedure file into its own data dir
and says so. Compounds per-user value; cheap to pilot (prompt + template).

**P5. Security posture as a feature.** Our design is already ahead of the
OpenClaw CVE class (fixed argv, loopback+token-gated ingest, safeStorage
creds, no skill marketplace). Write it down as a SECURITY.md + one-page
"why this is safer" doc; testers ARE reading about OpenClaw. Also check
Discord/Slack/Telegram ToS posture for autonomous agents (Telegram already
suspended Manus) before any public push.

**P6. Background-execution honesty.** Category table stakes is "works with
the laptop closed" (Cowork mobile, Spark cloud VMs). We require the app
running — the agent even says so ("앱이 실행 중일 때만 발송"). Middle
step: menu-bar mode (window closed ≠ app quit) + launch-at-login opt-in.
Full "device off" needs server-side and is out of scope for now — say so
honestly in the manual.

**Non-proposal (deliberate):** no credit/points system, no gamification —
"any platform that made conversation feel like work got deleted" is a
direct churn quote; our flat BYOK/subscription pass-through is the right
side of that.

## 5. Raw findings

Full sourced reports (URLs inline) live in the two research-pass outputs;
key sources: The Register (Claude limits), Userpilot churn stats, HN
Chai-churn thread, TechCrunch (OpenClaw incident, Gemini Spark), Conscia/
Microsoft (OpenClaw security), 클리앙 구독료 스레드, retn.kr (비개발자
포기 패턴), blog.windyflo.com (도입 후 6개월).
