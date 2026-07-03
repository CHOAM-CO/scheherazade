#!/bin/bash
# run.sh — launches {AGENT_NAME} headless: nohup + auto-restart with
# exponential backoff, expect-driven trust-prompt handling, KST-aware
# backoff reset. `./run.sh stop` shuts it down.
#
# Reference: MAGI's doze-portable/launcher.sh and run-doze-isolated.sh for
# the restart-loop/expect shape. Backoff numbers here (5/10/20/40/120) are
# a simpler ladder than MAGI's production values (3/30/120/300/600) --
# deliberate simplification for a single lightweight agent, not a copy
# error. --dangerously-skip-permissions is intentionally NOT used here;
# .claude/settings.local.json's permissions.allow already covers the only
# tools this agent needs (Bash/Read/Write/Edit), more scoped than a
# blanket bypass, and the CLI itself recommends that flag only for
# no-internet sandboxes -- not this use case.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/.agent-config"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "no .agent-config found -- run ./setup.sh first" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"
AGENT_NAME="${AGENT_NAME:?AGENT_NAME missing from .agent-config}"

MEM="$HOME/Documents/$AGENT_NAME"
MODEL="${MODEL:-claude-opus-4-6}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

# Claude Code tuning knobs carried over from the source launchers -- all
# overridable via env, all optional (Claude Code defaults these itself if
# unset).
export CLAUDE_CODE_EFFORT_LEVEL="${EFFORT_LEVEL:-max}"
export CLAUDE_STREAM_IDLE_TIMEOUT_MS="${STREAM_IDLE_TIMEOUT:-300000}"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${AUTO_COMPACT_WINDOW:-500000}"
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="${AUTOCOMPACT_PCT:-80}"

PIDFILE="$MEM/.agent.pid"
LOGFILE="$MEM/logs/agent.log"
STOPFLAG="$MEM/.stop_requested"
PKILL_PATTERN="${CLAUDE_BIN} --model ${MODEL} --name ${AGENT_NAME}"

# Session timeout: forces the expect-wrapped claude process to exit after
# SESSION_TIMEOUT seconds (default 12h) even if the stream is stuck but
# alive -- the restart loop below then picks it back up. Prefers real
# timeout(1)/gtimeout(1) (homebrew coreutils); stock macOS ships neither by
# default, so run_expect() falls back to a manual sleep+kill watchdog.
SESSION_TIMEOUT="${SESSION_TIMEOUT:-43200}"
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  TIMEOUT_BIN=""
fi

log() {
  printf '[%s] %s\n' "$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S %Z')" "$*"
}

require_claude() {
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || {
    echo "FATAL: '${CLAUDE_BIN}' not found on PATH" >&2
    exit 1
  }
}

is_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

run_expect() {
  # Runs the expect script at path $1 under the SESSION_TIMEOUT ceiling.
  # Prefers real timeout(1)/gtimeout(1): it puts its child in its own
  # process group and signals the whole group on timeout, so expect and
  # whatever it spawned both go down together. Plain `cmd &` in bash does
  # NOT get a new process group (verified empirically), so the fallback
  # below can't safely do a group-wide kill -- that would risk hitting the
  # supervisor loop itself. Instead it kills known descendants by PID
  # (pkill -P), and does so *before* killing each parent, since a dead
  # parent's children are reparented to init almost immediately -- too
  # fast to reliably find by ppid afterward.
  #
  # It also reads the script from a file rather than stdin, because a
  # plain `expect -f - <<EOF ... &` would have its heredoc stdin silently
  # replaced with /dev/null the instant it's backgrounded (POSIX rule for
  # asynchronous lists without an explicit redirect of their own).
  local script="$1"
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --kill-after=10 --signal=TERM "$SESSION_TIMEOUT" /usr/bin/expect -f "$script"
    return $?
  fi

  /usr/bin/expect -f "$script" &
  local cmd_pid=$!
  (
    sleep "$SESSION_TIMEOUT"
    if kill -0 "$cmd_pid" 2>/dev/null; then
      pkill -TERM -P "$cmd_pid" 2>/dev/null || true
      kill -TERM "$cmd_pid" 2>/dev/null
      sleep 10
      pkill -KILL -P "$cmd_pid" 2>/dev/null || true
      kill -KILL "$cmd_pid" 2>/dev/null
    fi
  ) &
  local watchdog_pid=$!
  wait "$cmd_pid" 2>/dev/null
  local exit_code=$?
  pkill -P "$watchdog_pid" 2>/dev/null || true
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$exit_code"
}

run_loop() {
  trap 'log "signal received, exiting loop"; rm -f "$PIDFILE"; exit 0' TERM INT

  mkdir -p "$MEM/logs"
  cd "$MEM"
  export AGENT_NAME MEM
  export CLAUDE_CMD="${CLAUDE_BIN} --model ${MODEL} --name ${AGENT_NAME}"

  EXPECT_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/agent-portable-expect.XXXXXX")"
  trap 'rm -f "$EXPECT_SCRIPT"' EXIT
  cat > "$EXPECT_SCRIPT" <<'EXPECT_EOF'
    log_user 1
    set env(TERM) xterm-256color
    set stty_init "rows 50 cols 200"
    spawn -noecho {*}$env(CLAUDE_CMD)
    set timeout 25
    expect {
      -re "trust"             { send "\r"; exp_continue }
      -re "confirm"           { send "\r"; exp_continue }
      -re "local development" { send "\r"; exp_continue }
      -re "text style"        { send "\r"; exp_continue }
      -re "Yes, use this"     { send "\r"; exp_continue }
      timeout {}
    }
    trap exit {SIGTERM SIGINT}
    set timeout -1
    expect eof
EXPECT_EOF

  RESTART_COUNT=0
  LAST_KST_DATE="$(TZ=Asia/Seoul date +%Y-%m-%d)"

  while true; do
    if [ -f "$STOPFLAG" ]; then
      rm -f "$STOPFLAG" "$PIDFILE"
      log "stop requested, exiting"
      exit 0
    fi

    CURRENT_KST_DATE="$(TZ=Asia/Seoul date +%Y-%m-%d)"
    if [ "$CURRENT_KST_DATE" != "$LAST_KST_DATE" ]; then
      log "KST date rolled over (${LAST_KST_DATE} -> ${CURRENT_KST_DATE}), backoff reset"
      RESTART_COUNT=0
      LAST_KST_DATE="$CURRENT_KST_DATE"
    fi

    pkill -f "$PKILL_PATTERN" 2>/dev/null || true
    STARTED="$(date +%s)"

    set +e
    run_expect "$EXPECT_SCRIPT"
    EXIT_CODE=$?
    set -e

    if [ -f "$STOPFLAG" ]; then
      rm -f "$STOPFLAG" "$PIDFILE"
      log "stop requested, exiting"
      exit 0
    fi

    UPTIME=$(( $(date +%s) - STARTED ))
    if [ "$UPTIME" -gt 300 ]; then
      RESTART_COUNT=0
    else
      RESTART_COUNT=$((RESTART_COUNT + 1))
    fi

    case "$RESTART_COUNT" in
      0|1) BACKOFF=5 ;;
      2)   BACKOFF=10 ;;
      3)   BACKOFF=20 ;;
      4)   BACKOFF=40 ;;
      *)   BACKOFF=120 ;;
    esac

    log "exited (code ${EXIT_CODE}, uptime ${UPTIME}s, restart #${RESTART_COUNT}), retrying in ${BACKOFF}s"
    sleep "$BACKOFF"
  done
}

start_agent() {
  require_claude
  if [ -f "$PIDFILE" ] && is_alive "$(cat "$PIDFILE" 2>/dev/null)"; then
    echo "${AGENT_NAME} already running (pid $(cat "$PIDFILE"))"
    exit 0
  fi
  rm -f "$STOPFLAG"
  mkdir -p "$MEM/logs"
  nohup "$SCRIPT_DIR/run.sh" __loop >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  disown
  sleep 1
  echo "${AGENT_NAME} started (pid $(cat "$PIDFILE")), log: $LOGFILE"
}

stop_agent() {
  if [ ! -f "$PIDFILE" ]; then
    echo "${AGENT_NAME} is not running"
    exit 0
  fi
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if ! is_alive "$PID"; then
    echo "stale pidfile, cleaning up"
    rm -f "$PIDFILE"
    exit 0
  fi

  echo "stopping ${AGENT_NAME} (pid ${PID})..."
  touch "$STOPFLAG"
  pkill -f "$PKILL_PATTERN" 2>/dev/null || true

  for _ in $(seq 1 15); do
    is_alive "$PID" || { echo "stopped"; rm -f "$STOPFLAG"; exit 0; }
    sleep 1
  done

  echo "did not stop in time, forcing"
  kill -KILL "$PID" 2>/dev/null || true
  pkill -f "$PKILL_PATTERN" 2>/dev/null || true
  rm -f "$PIDFILE" "$STOPFLAG"
}

case "${1:-start}" in
  start) start_agent ;;
  stop)  stop_agent ;;
  __loop) run_loop ;;
  *)
    echo "usage: $0 [start|stop]" >&2
    exit 1
    ;;
esac
