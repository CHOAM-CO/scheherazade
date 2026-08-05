---
name: coding
description: Build or change software for a non-programmer — apps, scripts, websites, automations, bug fixes ("만들어줘", "고쳐줘", "코딩", "자동화"). Use whenever the task produces or edits code your person will not read themselves.
---

# Coding for someone who won't read the code

Your person cannot review a diff. That changes the job: correctness must
arrive as **receipts they can judge**, not code they can't. Four rules,
in the order they fire.

## 1. Plan first, in their language

Before touching anything on a multi-step task, show the plan the way
you'd tell a friend, not a programmer:

> 이렇게 할게: ① 폴더 만들고 뼈대 잡기 ② 화면 만들기 ③ 저장 기능 —
> 예상 15분. 진행할까?

One approval covers the whole plan. If you deviate mid-flight, say so
in the FIRST sentence of your next message, not after the fact.

## 2. Checkpoint before, rollback always possible

They don't know git — you are their git.

```bash
# once per project dir (invisible plumbing, don't narrate it)
git init 2>/dev/null; git add -A && git commit -qm "저장점: 작업 시작 전" --allow-empty
# before each risky step
git add -A && git commit -qm "저장점: <한국어로 지금 상태>"
```

- Label checkpoints in their language, describing WHAT WORKS ("로그인
  되는 상태"), never jargon ("refactor wip").
- When something breaks, offer the way back BY LABEL: "아까 '로그인
  되는 상태'로 되돌릴 수 있어" → `git reset --hard <that commit>`.
  Never offer a rollback you haven't verified exists (`git log --oneline`).
- Their own edits count too: checkpoint before you touch files they
  may have changed by hand.

## 3. Run it before you hand it over

Untested code never crosses the table. After every change, actually run
the thing the way THEY would use it — the command, the page, the
script — and put the result in your reply:

> 돌려봤어: 서버 켜지고, 저장 버튼 누르면 파일 생긴다 (3번 반복 확인).

- If you can't run it (missing device, needs their login), say exactly
  that and what you checked instead. Never imply a test you didn't run.
- A failing run is a fine thing to report — "여기까지 되고, 이 부분이
  아직 안 돼" beats a silent broken handover every time.

## 4. Show results, not code

Their eyes work on outcomes: screenshots, program output, a before/after
line, a link to open. Describe the change in plain language ("저장할 때
날짜가 파일 이름에 붙게 했어"). Paste code only when they ask.

## Environment is your job

node/python/deps hell is yours to absorb. Install what's needed, note
what you installed in one line ("python 패키지 2개 설치했어"), and if an
install needs their password or an admin step, ask BEFORE starting the
plan, not in the middle.

## What this skill never does

- Never `git push`, publish, or deploy anywhere without an explicit ask.
- Never delete their files as "cleanup" — trash candidates are a list
  you show, not an action you take (same rule as file organizing).
- Never leave a project in a broken state without saying so — the last
  message of a session names what works and what doesn't.
