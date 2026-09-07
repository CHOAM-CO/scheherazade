#!/bin/bash
# attach-bootstrap.sh -- Scheherazade attach-topology bootstrap.
#
# ⚠️ RUN THIS IN YOUR OWN TERMINAL (Terminal.app / iTerm), NOT from the app:
#
#     bash "{MEMORY_DIR}/attach-bootstrap.sh"
#
# WHY THE TERMINAL MATTERS (the whole point of this topology): macOS TCC
# attributes permissions to the RESPONSIBLE PROCESS. A tmux server started
# from your terminal inherits the terminal's stable identity, so screen
# recording / automation grants survive every app release. If the APP started
# this server, grants would key to the app's per-release ad-hoc signature and
# break on every update -- the exact bug class this design kills (probe
# receipts: docs/probe-0016-attribution.md; launchd-bootstrapped tmux gets NO
# grantable Settings row at all, so terminal bootstrap is the blessed lane).
#
# This file is RE-RENDERED by the app on every boot (harness file, same as
# CLAUDE.md) so the paths below always match the installed app version.
# Do not edit by hand -- edits are overwritten.
set -euo pipefail

SOCKET="scheherazade"
SESSION="agent"
RUN_SH="{AGENT_DIR}/run.sh"
MEM="{MEMORY_DIR}"
CONFIG="$MEM/.agent-config"
PIDFILE="$MEM/.agent.pid"
LOGFILE="$MEM/logs/agent.log"

# tmux: the app ships its own portable copy into DATA_HOME (vendored,
# brew-free -- synced by harness-render on every app boot). Preferred even
# when the user has a PATH tmux, so the client here and the server the app
# later talks to are always the SAME binary (no client/server protocol skew
# within one install). PATH tmux is the dev/CLI-deployment fallback only.
TMUX_BIN="$MEM/bin/tmux-portable/tmux"
if [ ! -x "$TMUX_BIN" ]; then
  if command -v tmux >/dev/null 2>&1; then
    TMUX_BIN="$(command -v tmux)"
  else
    echo "tmux 준비가 아직 안 됐습니다. 앱을 한 번 실행하면 자동으로 준비됩니다 ($MEM/bin/tmux-portable)." >&2
    exit 1
  fi
fi

# Brew-less Macs have no compiled-in terminfo path the vendored ncurses can
# find; macOS ships a full db at /usr/share/terminfo (verified: xterm-/
# screen-/tmux-256color all present). No-op when the user already set one.
export TERMINFO_DIRS="${TERMINFO_DIRS:-/usr/share/terminfo}"
if [ ! -f "$RUN_SH" ]; then
  echo "run.sh가 없습니다: $RUN_SH" >&2
  echo "(앱 버전과 어긋난 상태 -- 앱을 한 번 실행하면 이 스크립트가 재렌더됩니다)" >&2
  exit 1
fi
if [ ! -f "$CONFIG" ]; then
  echo ".agent-config가 없습니다: $CONFIG -- 앱에서 온보딩을 먼저 완료하세요" >&2
  exit 1
fi

# Already bootstrapped? (has-session never spawns a server -- live-verified,
# see tests/test-attach-topology.mjs negative control). stderr is kept:
# after an app update the NEW client may meet a server still running the OLD
# binary, and tmux refuses with "protocol version mismatch" -- which without
# this branch would read as "no session" and drive new-session into the same
# wall. Name it and hand over the remedy instead.
set +e
HS_OUT="$("$TMUX_BIN" -L "$SOCKET" has-session -t "$SESSION" 2>&1)"
HS_RC=$?
set -e
if [ $HS_RC -eq 0 ]; then
  echo "이미 떠 있습니다."
  echo "  살펴보기:  \"$TMUX_BIN\" -L $SOCKET attach -t $SESSION   (빠져나오기: Ctrl-b d)"
  exit 0
fi
case "$HS_OUT" in
  *"protocol version mismatch"*)
    echo "앱 업데이트로 tmux 버전이 바뀌어 기존 세션과 통신할 수 없습니다." >&2
    echo "기존 세션을 정리한 뒤 이 스크립트를 다시 실행하세요:" >&2
    echo "  pkill -f 'tmux.*-L $SOCKET' && bash \"$MEM/attach-bootstrap.sh\"" >&2
    exit 1
    ;;
esac

# A spawn-lane supervisor already running would double-book the bot token.
# Same identity check run.sh's is_our_supervisor uses (command-line match).
if [ -f "$PIDFILE" ]; then
  EXISTING_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && ps -ww -o command= -p "$EXISTING_PID" 2>/dev/null | grep -q "run\.sh __loop"; then
    echo "에이전트가 이미 앱 스폰 레인으로 돌고 있습니다 (pid $EXISTING_PID)." >&2
    echo "앱 상단 바에서 정지시킨 뒤 이 스크립트를 다시 실행하세요." >&2
    exit 1
  fi
fi

mkdir -p "$MEM/logs"

# Claude binary: packaged installs bundle it at Resources/claude-cli/claude
# ({AGENT_DIR} = .../Resources/app.asar.unpacked, so ../claude-cli from
# there); a user terminal's PATH usually does NOT have a standalone `claude`
# on app-only machines, so bake the bundled path in when it exists and fall
# back to PATH resolution for dev/CLI deployments.
CLAUDE_CANDIDATE="{AGENT_DIR}/../claude-cli/claude"
if [ -x "$CLAUDE_CANDIDATE" ]; then
  CLAUDE_BIN_BAKED="$CLAUDE_CANDIDATE"
else
  CLAUDE_BIN_BAKED="${CLAUDE_BIN:-claude}"
fi

# Session command: env baked into the string (explicit > inherited), exec so
# the pane pid IS `bash run.sh __loop` -- the exact command-line signature
# run.sh's is_our_supervisor() and main.cjs's isOurSupervisor() both verify.
"$TMUX_BIN" -L "$SOCKET" new-session -d -s "$SESSION" \
  "AGENT_DATA_HOME='$MEM' AGENT_CONFIG_FILE='$CONFIG' CLAUDE_BIN='$CLAUDE_BIN_BAKED' SUDO_ASKPASS='$MEM/sudo-askpass.sh' exec bash '$RUN_SH' __loop"

# Server must outlive the agent process (live-verified 2026-07-16: default
# exit-empty kills the server with its last session, which would strand the
# app's restart lane):
#  - exit-empty off: zero-session server stays up
#  - remain-on-exit on: a dead agent leaves a dead PANE, not a dead session;
#    the app restarts it with respawn-pane (server-descended, so TCC
#    attribution never moves back to the app)
"$TMUX_BIN" -L "$SOCKET" set -s exit-empty off
"$TMUX_BIN" -L "$SOCKET" set-option -t "$SESSION" remain-on-exit on

# Mirror pane output to the logfile the app tails (/logs viewer) -- the pane
# stays fully visible for humans who attach.
"$TMUX_BIN" -L "$SOCKET" pipe-pane -o -t "$SESSION" "cat >> '$LOGFILE'"

# Participate in run.sh's PIDFILE convention so the app adopts this
# supervisor instead of spawning a second one (main.cjs Fix C seam).
PANE_PID="$("$TMUX_BIN" -L "$SOCKET" display-message -p -t "$SESSION" '#{pane_pid}')"
echo "$PANE_PID" > "$PIDFILE"

echo "부트스트랩 완료."
echo "  에이전트:   tmux 세션 '$SESSION' (pid $PANE_PID, 터미널 계보 = 권한이 릴리즈를 넘어 살아남음)"
echo "  살펴보기:   \"$TMUX_BIN\" -L $SOCKET attach -t $SESSION   (빠져나오기: Ctrl-b d)"
echo "  로그:       $LOGFILE (앱의 /logs 탭에도 흐릅니다)"
echo "이제 앱을 켜면 이 에이전트에 자동으로 붙습니다. 앱을 꺼도 에이전트는 계속 돕니다."
