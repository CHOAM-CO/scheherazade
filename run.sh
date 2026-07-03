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
# AGENT_CONFIG_FILE / AGENT_DATA_HOME overrides (agent-lifecycle fix,
# 2026-07-03): this script now has TWO callers with different filesystem
# shapes.
#   1. Standalone CLI (setup.sh's own deployment path, agent-portable fork,
#      this repo's own top-level use): .agent-config lives next to run.sh
#      itself, at $SCRIPT_DIR/.agent-config -- unchanged default below.
#   2. Electron-bundled internal launcher (main.cjs's spawnRealAgentChild):
#      a packaged app's run.sh lives inside
#      Contents/Resources/app.asar.unpacked/ (see main.cjs's RUN_SH_PATH /
#      toUnpackedPath), nowhere near DATA_HOME
#      (~/Documents/Scheherazade), which is where the onboarding wizard's
#      .agent-config, .mcp.json, and memory.db actually live. main.cjs
#      pre-exports AGENT_NAME/CLAUDE_BIN/MODEL/AGENT_DATA_HOME directly into
#      this process's own env instead of relying on a config file this
#      script's own directory doesn't have.
CONFIG_FILE="${AGENT_CONFIG_FILE:-$SCRIPT_DIR/.agent-config}"

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
elif [ -z "${AGENT_NAME:-}" ]; then
  echo "no .agent-config found at $CONFIG_FILE, and AGENT_NAME is not already set in the environment -- run ./setup.sh first, or invoke with AGENT_NAME (and optionally CLAUDE_BIN/MODEL/AGENT_DATA_HOME) pre-exported" >&2
  exit 1
fi
AGENT_NAME="${AGENT_NAME:?AGENT_NAME missing from config/env}"

MEM="${AGENT_DATA_HOME:-$HOME/Documents/$AGENT_NAME}"
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
FAILFILE="$MEM/.agent-failed.json"
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

# Critical B (agent-lifecycle model-divergent review, 2026-07-03): a bad/
# revoked provider key or bot token makes claude/the MCP handshake fail
# near-instantly every time, so run_loop() below restarts it forever with
# no on-disk signal -- main.cjs's onboarding UI stays on "connecting"
# indefinitely. write_failure() is called once RESTART_COUNT crosses a
# quick-fail-streak threshold (see run_loop()); clear_failure() is called
# when a run finally survives, or at a fresh loop start, so a since-fixed
# problem doesn't leave a stale failure marker behind forever. Shares its
# path/JSON shape with channel.mjs's own writeFailureMarker() (a Discord
# login failure can also write this same file) so main.cjs's poller only
# has to watch one path regardless of which layer caught the problem.
# Atomic write (temp file + mv) so main.cjs's poller never reads a
# half-written file.
write_failure() {
  local reason="$1"
  # JSON-escape: backslash and quote first (order matters -- backslash
  # must go first or the backslashes just-inserted for quote-escaping would
  # themselves get re-escaped), then control characters bash's ${//} can
  # produce standalone patterns for. Only RESTART_COUNT/UPTIME/EXIT_CODE
  # (bash-arithmetic integers) reach this today (see the one call site
  # below), so newline/tab can't actually occur yet -- hardened anyway
  # (code-review pass, 2026-07-03) since this is a general-purpose helper
  # and a future caller passing free text would otherwise emit invalid
  # JSON that main.cjs's JSON.parse (pollFailureMarker()) would throw on.
  local escaped="${reason//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  escaped="${escaped//$'\n'/\\n}"
  escaped="${escaped//$'\r'/\\r}"
  escaped="${escaped//$'\t'/\\t}"
  local tmp
  tmp="$(mktemp "${FAILFILE}.XXXXXX" 2>/dev/null || echo "${FAILFILE}.tmp$$")"
  # set -e safety (code-review pass, 2026-07-03): this whole file runs under
  # `set -euo pipefail`, and write_failure() is called from a plain if-BODY
  # (see the call site below) -- bodies are NOT exempt from -e the way a
  # condition is. Without the explicit `|| ...` guards below, a write
  # failure here (e.g. $MEM out of disk or gone read-only) would abort the
  # entire supervisor process -- exactly while it's trying to report the
  # bad-key/bad-token failure this feature exists for, losing the
  # diagnostic AND killing the restart ladder in one move. Best-effort: on
  # any failure here, log and move on: this marker write is diagnostic,
  # never load-bearing for the loop's own survival.
  if ! printf '{\n  "status": "failed",\n  "reason": "%s",\n  "since": "%s"\n}\n' \
    "$escaped" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp" 2>/dev/null; then
    log "write_failure: could not write ${tmp} (disk full/read-only $MEM?) -- skipping this round's failure marker"
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  mv -f "$tmp" "$FAILFILE" 2>/dev/null || log "write_failure: could not move ${tmp} -> ${FAILFILE}"
  return 0
}

clear_failure() {
  rm -f "$FAILFILE" 2>/dev/null || true
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
  # Fresh loop start (this bash process's own lifetime) -- don't carry a
  # failure marker over from a previous life of the supervisor (e.g. the
  # user fixed a bad key and relaunched the app).
  clear_failure

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
      clear_failure
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

    # Critical B: quick-fail streak (3+ restarts that each died inside the
    # 300s uptime window above) -- surface as a failure marker instead of
    # silently retrying forever. Re-written each time it re-triggers so the
    # "since"/reason stay current; main.cjs's poller is mtime-gated so this
    # doesn't spam repeated setAgentStatus calls.
    if [ "$RESTART_COUNT" -ge 3 ]; then
      write_failure "agent restarted ${RESTART_COUNT} times quickly (last uptime ${UPTIME}s, exit code ${EXIT_CODE}) -- likely a bad/revoked provider key or bot token, or an auth hang. Check the BYOK key and Discord bot token in Settings."
    fi

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
  clear_failure
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
