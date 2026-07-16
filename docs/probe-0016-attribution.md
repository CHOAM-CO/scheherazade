# 0016 attribution probe — rehearsal receipts + 춘식 kit

> Companion to design-0016-attach-topology.md (implementation step 1).
> Author: Idea. 2026-07-16. Status: REHEARSED on MAGI host; awaiting 춘식 run.

## Why probe at all
The attach design only wins if the TCC grant lands on an identity that
survives our release cadence. "Which identity" is attribution, and macOS
resolves it via the *responsible process*, not the leaf binary. Assumed
attribution has already been wrong once today (see rehearsal result 3).

## Rehearsal results (MAGI host, macOS 15.6.1, tmux 3.6a brew)

1. **exit code lies.** `screencapture -x` with NO screen-recording grant
   returns **exit=0** and writes a full-size PNG containing wallpaper +
   menu bar and **zero windows**. Judge by image content (are windows
   visible?), never by exit code or file existence. Two denied captures
   a minute apart were byte-identical (deterministic denial render).
2. **Terminal-descended tmux → grant subject = the terminal app.**
   Fresh tmux server (`tmux -L probe new-session -d`) spawned from a
   shell whose ancestry traces to iTerm2 (even through bash reparented
   to launchd and tmux daemonized): the denial auto-added a Settings row
   `com.googlecode.iterm2 auth=0` at the exact probe second. TCC
   responsibility sticks to the original spawner across daemonization.
3. **launchd-bootstrapped tmux → NO row at all.** Same probe via a
   temporary LaunchAgent (RunAtLoad → tmux new-session -d → screencapture):
   denied, and **no Settings row appeared** — nothing for the user to
   toggle. Likely cause: brew tmux is `Signature=adhoc`, `TeamIdentifier=
   not set` (codesign -dv verified) — no stable csreq for TCC to key on.
   Same identity disease as our ad-hoc app.
4. **What actually holds grants on this box** (FDA rows, auth=2):
   `sshd-keygen-wrapper`, `com.googlecode.iterm2`, `com.microsoft.VSCode`.
   The MAGI fleet's "tmux attach로 권한 탄다" is really "responsibility
   resolves to a stably-signed terminal/sshd identity."

## Design consequences (feed into 0.1.0 bootstrap design)

- **The app must NEVER bootstrap the tmux session** (except in the
  feature-flagged legacy fallback lane, which knowingly keeps the old
  disease). App-spawned server → responsible proc = per-release app
  identity → stale-grant class returns.
- **Bootstrap lane = terminal-descended** (login item opening the
  terminal, or a documented one-liner the user runs in their terminal).
  Grant then lands on Terminal.app/iTerm (Apple/Dev-ID signed, survives
  everything). sshd-descended sessions inherit the same stability.
- **launchd user-agent bootstrap is dead for TCC-gated features** on
  this box's evidence: the grant is not even offerable. If 춘식 differs,
  revisit; otherwise launchd may only bootstrap surfaces that need no
  TCC (or be dropped from the design).
- tmux-under-brew re-sign caveat from the design doc still stands but is
  now secondary: with terminal-descended bootstrap the subject is the
  terminal, not tmux, so brew upgrades stop mattering for grants.

## Replication addendum (12:2x, same host) — finding 3 DOWNGRADED

Re-runs after `tccutil reset ScreenCapture com.googlecode.iterm2`:
- nohup-orphaned bash screencapture (clean state): denied, **no row**.
- Fresh tmux server case re-run (clean state): denied, **no row** — the
  12:05 iTerm2 row did NOT reproduce.
- tccd unified log inaccessible without root (redacted/empty) — cannot
  read attribution decisions directly.

Interpretation: Settings-row creation appears to fire only on a first
attempt and then be throttled (per-boot or timed; mechanism unverified).
Therefore **finding 3 (launchd lane = no row) is SUSPECT**: that run came
60s after the first probe and may have been throttled, not structurally
row-less. Finding 2 stands as n=1 with second-level timestamp match, not
replicated. Finding 1 (exit=0 + wallpaper-only) replicated 4x, solid.

Consequence for 춘식: the kit below is ORDER-SENSITIVE and cut to the one
case the design actually needs (terminal-descended). 춘식 has no tmux
(Mino 12:18) — irrelevant for permissions, since the 12:05 evidence shows
tmux does not break the terminal attribution chain; multiplexer choice is
a transport/UX decision, decoupled from TCC. launchd lane stays
dead-by-default (unneeded), no longer claimed dead-by-evidence.

## 춘식 kit v2 — tmux-free, single-case (paste when Mino's 0.15 test wraps)

BEFORE anything: System Settings > Privacy & Security > Screen & System
Audio Recording — screenshot the current list (fresh state matters; run
step 1 only once, first).

```bash
# 1) 첫 시도 (거부 예상 — 목적은 설정 목록에 행을 만들어 attribution을 보는 것)
screencapture -x /tmp/p1.png; open /tmp/p1.png
```
→ 설정 목록 다시 보기: 새 행이 생겼나, 생겼다면 무엇으로 (Terminal? 다른 것?
아무것도 없음?). 스크린샷. 프롬프트가 떴다면 그것도.

```bash
# 2) 새 행 토글 ON (터미널 재시작하라고 하면 재시작) 후 재시도
screencapture -x /tmp/p2.png; open /tmp/p2.png
```
→ 이번엔 창들이 보여야 함. 벽지+메뉴바만이면 실패 보고.

```bash
# 3) 고아 프로세스 계승 테스트 — 설계 코어.
#    터미널에서 시작해 백그라운드로 떨어진 프로세스(0.1.0의 에이전트 모양)가
#    터미널의 그랜트를 계승하는지.
nohup bash -c 'sleep 1; screencapture -x /tmp/p3.png' >/dev/null 2>&1 & disown
sleep 3; open /tmp/p3.png
```
→ 창 보이면: 터미널발 상주 에이전트가 터미널 그랜트로 화면을 읽을 수 있음 =
부트스트랩 설계 확정. 이게 이 프로브의 단 하나의 진짜 질문.

```bash
# 4) 뒷정리 (원하면): 설정에서 방금 켠 행 다시 OFF, /tmp/p*.png 삭제
rm -f /tmp/p1.png /tmp/p2.png /tmp/p3.png
```

## Outcome matrix (v2)

| Observation on 춘식 | Design branch |
|---|---|
| step1 adds terminal row + step2 windows + step3 windows | terminal-descended bootstrap LOCKED; build 0.1.0 on it |
| step1 adds terminal row + step2 windows + step3 wallpaper | orphan loses grant → agent must stay terminal-childed (login item keeps a Terminal session) or revisit O3 |
| step1 adds NO row | manual add via Settings "+" (drag Terminal.app), then step2; if still nothing, escalate to O1/O3 |
| step2 still wallpaper after toggle ON | terminal restart missed, or per-OS quirk — rerun once, then report raw |

App-must-not-bootstrap rule unchanged (independent of outcomes).

Pre-step, eyeball only: System Settings > Privacy & Security >
Screen & System Audio Recording — note which rows exist BEFORE (screenshot).

```bash
# 0) tmux 있나 + 서명 상태
which tmux && tmux -V && codesign -dv $(which tmux) 2>&1 | grep -E 'Signature|TeamIdentifier'

# 1) 터미널발 tmux 캡처 (지금 쓰는 터미널에서 그대로 실행)
tmux -L probe new-session -d 'screencapture -x /tmp/p1.png; sleep 2'
sleep 3 && open /tmp/p1.png

# 2) launchd발 tmux 캡처
cat > /tmp/com.schz.probe.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.schz.probe</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/tmux</string>
    <string>-L</string><string>probe2</string>
    <string>new-session</string><string>-d</string>
    <string>screencapture -x /tmp/p2.png; sleep 2</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) /tmp/com.schz.probe.plist
sleep 4 && open /tmp/p2.png

# 3) 뒷정리
launchctl bootout gui/$(id -u)/com.schz.probe
tmux -L probe kill-server 2>/dev/null; tmux -L probe2 kill-server 2>/dev/null
rm /tmp/com.schz.probe.plist
```

Record three things per case:
- (a) PNG에 실제 창이 보이나, 벽지+메뉴바뿐인가
- (b) Settings 녹음 목록에 새 행이 생겼나 — 생겼다면 무엇으로
  (터미널 앱? tmux? 아무것도?)
- (c) 시스템 프롬프트가 떴나

## Outcome matrix

| Observation on 춘식 | Design branch |
|---|---|
| p1 windows visible (terminal row pre-granted) | terminal-descended bootstrap confirmed; build as-is |
| p1 wallpaper-only + terminal row appears OFF | toggle it ON, rerun case 1; windows → same branch as above |
| p2 adds a grantable tmux row | launchd lane lives on 춘식; document brew-upgrade re-grant caveat |
| p2 adds NO row (MAGI-host behavior) | launchd lane dead for TCC surfaces; terminal-descended bootstrap locked |
| no tmux on 춘식 | decision point: brew install as onboarding step vs O3 fallback |

Either way, the app-must-not-bootstrap rule (above) is already settled by
rehearsal result 2+3 logic and does not depend on 춘식's outcome.
