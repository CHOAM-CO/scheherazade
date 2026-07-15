# Permission Visibility — P0 checklist + P1 failure translation

Source: 춘식3's `permission-improvement-proposal.md` (2026-07-15, receipts his own
onboarding run). Adopted by Idea/PO same day, folded per Mino 13:02 "이거 참고부탁".
This doc records what we adopted, HOW it maps onto this repo's existing surfaces,
and what was deliberately deferred.

## Problem (his framing, kept)

Two distinct failures, two distinct fixes:

1. **Setup-time**: the agent lands on a machine with unknown permission state and
   discovers walls one crash at a time, mid-task. → P0: show the wall map BEFORE
   work starts.
2. **Run-time**: when a wall IS hit, the agent goes silent and diagnoses (worst
   receipt: 16 minutes of quiet while the user asked "됐어? 대답 빨리"). The wall
   is fine — the silence is the failure. → P1: translate the failure into user
   speech at the moment it happens.

P1 kills the silence, not the wall. P0 shrinks how often P1 is needed. Neither
grants anything — every toggle stays a human hand on System Settings.

## P1 — SHIPPED (0cb6f9b, v0.0.12 lane)

**Chosen shape: P1-A, a PostToolUse hook** (`hooks/post-bash-permission-translator.mjs`).

Why hook and not the alternative (P1-B, supervisor-side stderr scanning on the
channel process):

- The hook fires INSIDE the agent turn, so the translation lands as
  `additionalContext` while the agent still holds the failed command in context —
  it can reply to the user in the same turn. Supervisor-side detection would have
  to inject a message back into a turn that already moved on.
- The hook sees `tool_input.command` + `tool_response` as structured fields; the
  supervisor sees an interleaved log stream and would re-derive the
  command↔stderr pairing heuristically.
- Pack convention already exists: advisory fail-open hooks, rumination gate as
  the sole blocker. One more advisory hook is zero new machinery; a supervisor
  scanner is a new machine (fail_loud: a new machine's silent paths are unimagined
  failures by definition).

Cost accepted: hook only covers Bash tool walls. A permission wall hit by an MCP
tool or by Electron itself doesn't pass through it. That residue is P0's job
(pre-declared state) — not a reason to build the supervisor scanner.

Rules table (5 classes, command+stderr both required, rc alone never fires):

| class | cmd pattern | out pattern | layer |
|---|---|---|---|
| Automation | `osascript\|AppleScript` | `-1743\|-1712\|Not authorized to send Apple events\|AppleEvent` | TCC |
| Screen Recording | `screencapture` | `could not create image` | TCC |
| Keystroke injection | `TIOCSTI\|ioctl` | `EPERM\|Operation not permitted` | **SIP — not TCC** |
| sudo | `sudo` | `password is required\|a terminal is required` | **sudo — not TCC** |
| Full Disk Access | `Library/(Mail\|Safari\|Messages\|Calendars)` | `Operation not permitted\|EPERM` | TCC |

The TCC/SIP/sudo layer split is 춘식3's and is load-bearing: "어디서 켜야
하는데?" has three different answers, and collapsing them sends the user to a
Settings pane that cannot fix their problem. The `-1712` caveat (timeout ≠
denial) is also his and kept verbatim.

Wiring: template `claude-settings.local.json` PostToolUse/Bash + additive
migration in `ensureSettingsLocalAdditions()` (same contract as the
negation-check precedent: existing installs pick it up on next boot, never
rewrites what's there). Tests: `scripts/test-permission-translator.mjs` (19).

## P0 — checklist UI (next block, v0.0.12)

**Principle: extend the existing FDA lane, don't invent a parallel one.**
`/api/onboarding/fda/{status,open,relaunch}` (http-server.cjs, 2026-07-07 block)
already encodes the three hard-won macOS facts:

1. No official status API for most TCC classes — probes are HEURISTIC and must
   say so in the payload (`heuristic: true`).
2. Deep links are flaky on Sequoia — fire twice with a beat.
3. TCC caches at process launch — grant is invisible until app RELAUNCH.

### Probe table

Generalize to `/api/permissions/status` (GET) returning all rows at once:

| class | probe | kind |
|---|---|---|
| Full Disk Access | `fs.readFileSync('/Library/Preferences/com.apple.TimeMachine.plist')` | heuristic (existing) |
| Screen Recording | `systemPreferences.getMediaAccessStatus('screen')` | OFFICIAL Electron API |
| Microphone / Camera | `getMediaAccessStatus('microphone'/'camera')` — only if roadmap needs them; default OMIT | official |
| Accessibility | `systemPreferences.isTrustedAccessibilityClient(false)` — `false` arg = query without prompting | official |
| Automation | per-target `osascript -e 'tell app "X" to count windows'` with short timeout; `-1743`=denied, `-1712`=indeterminate | heuristic, PER-TARGET (Automation is app×app, a single boolean is a lie) |
| sudo | `sudo -n true` → rc 0 = passwordless available | heuristic |
| SIP | `csrutil status` | informational only — no toggle to offer, display as "고정 조건" |

All probes run server-side in http-server.cjs via the existing `getElectron()`
bridge (renderer stays no-Node/contextIsolation — the 2026-07 architecture note
in main.cjs holds).

### Endpoints

- `GET /api/permissions/status` — full table, each row `{ class, granted:
  true|false|'indeterminate', kind: 'official'|'heuristic'|'info',
  needsRelaunch: bool }`.
- `POST /api/permissions/open` — `{ class }` → deep link, double-fire pattern
  reused. Links: `Privacy_AllFiles`, `Privacy_ScreenCapture`,
  `Privacy_Accessibility`, `Privacy_Automation`.
- Relaunch: reuse `/api/onboarding/fda/relaunch` as-is (rename to
  `/api/permissions/relaunch` with the old path kept as alias — external
  callers may exist in wizard.js).

### UI

`settings.html`에 카드 한 장 (wizard 단계 추가 아님 — 온보딩 필수화는 P0 원문
스코프 밖, 아래 Deferred): class별 row = 상태 뱃지(✅/❌/❓heuristic) + [설정
열기] 버튼 + relaunch 배너 (하나라도 토글 후 재실행 전이면 "재실행해야 반영"
고정 노출). `settings.js`가 status를 카드 오픈 시 1회 + [설정 열기] 클릭 후
폴링(3s × 최대 20회)으로 재조회.

### Agent-side consumption

Checklist state file `{AGENT_DATA_HOME}/permission-status.json`을 상태 조회
때마다 갱신 → session-start hook이 읽어서 "이 기계에서 안 되는 것" 한 줄을
부팅 컨텍스트에 주입. P1 훅이 잡은 벽도 여기에 `lastHit` 타임스탬프로 기록해
P0 표가 실측으로 살아있게 (P0가 지도, P1이 지도 갱신).

## Deferred (explicit, with reasons)

- **P2 원격 접속 온보딩 / P3 Tailscale SSH**: 춘식3 본인이 미검증 표기.
  제품 로드맵상 원격 레인이 열릴 때 재평가. 지금 넣으면 검증 안 된 설치 지시가
  제품에 실림.
- **P4 sudo 자율화**: sudoers 화이트리스트는 보안 표면 확장이라 Mino 판정
  필요. `sudo -S`(stdin 비번) 제외는 이미 P1 훅 caveat에 박제 — 그 금지는
  선적됨, 허용 쪽만 보류.
- **P1-B supervisor scanner**: 위 P1-A 근거 참조. Bash 밖 벽 커버리지가 실측
  으로 문제 되면 그때 재론 (지금은 상상된 실패).
- **온보딩 wizard 필수 단계화**: FDA만 이미 wizard에 있음. 나머지 클래스는
  실제로 에이전트가 첫 세션에서 쓰는 게 아니라서 (screencapture는 쓸 때만)
  설치 마찰만 늘림. settings 카드 + 부팅 컨텍스트 주입으로 시작.

## Receipts

- P1 ship: commit 0cb6f9b (hook + template + migration + 19 tests, suite 20/20 green).
- 원문: 춘식3 permission-improvement-proposal.md — Mino 첨부 2026-07-15 13:02.
- FDA 선례: http-server.cjs `── Full Disk Access onboarding routes (2026-07-07)` 블록.
