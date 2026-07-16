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

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux가 없습니다. 먼저 설치하세요:  brew install tmux" >&2
  exit 1
fi
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
# see scripts/test-attach-topology.mjs negative control)
if tmux -L "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  echo "이미 떠 있습니다."
  echo "  살펴보기:  tmux -L $SOCKET attach -t $SESSION   (빠져나오기: Ctrl-b d)"
  exit 0
fi

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
tmux -L "$SOCKET" new-session -d -s "$SESSION" \
  "AGENT_DATA_HOME='$MEM' AGENT_CONFIG_FILE='$CONFIG' CLAUDE_BIN='$CLAUDE_BIN_BAKED' SUDO_ASKPASS='$MEM/sudo-askpass.sh' exec bash '$RUN_SH' __loop"

# Server must outlive the agent process (live-verified 2026-07-16: default
# exit-empty kills the server with its last session, which would strand the
# app's restart lane):
#  - exit-empty off: zero-session server stays up
#  - remain-on-exit on: a dead agent leaves a dead PANE, not a dead session;
#    the app restarts it with respawn-pane (server-descended, so TCC
#    attribution never moves back to the app)
tmux -L "$SOCKET" set -s exit-empty off
tmux -L "$SOCKET" set-option -t "$SESSION" remain-on-exit on

# Mirror pane output to the logfile the app tails (/logs viewer) -- the pane
# stays fully visible for humans who attach.
tmux -L "$SOCKET" pipe-pane -o -t "$SESSION" "cat >> '$LOGFILE'"

# Participate in run.sh's PIDFILE convention so the app adopts this
# supervisor instead of spawning a second one (main.cjs Fix C seam).
PANE_PID="$(tmux -L "$SOCKET" display-message -p -t "$SESSION" '#{pane_pid}')"
echo "$PANE_PID" > "$PIDFILE"

echo "부트스트랩 완료."
echo "  에이전트:   tmux 세션 '$SESSION' (pid $PANE_PID, 터미널 계보 = 권한이 릴리즈를 넘어 살아남음)"
echo "  살펴보기:   tmux -L $SOCKET attach -t $SESSION   (빠져나오기: Ctrl-b d)"
echo "  로그:       $LOGFILE (앱의 /logs 탭에도 흐릅니다)"
echo "이제 앱을 켜면 이 에이전트에 자동으로 붙습니다. 앱을 꺼도 에이전트는 계속 돕니다."
