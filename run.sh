#!/bin/bash
# run.sh — launches {AGENT_NAME} headless: nohup + auto-restart with
# exponential backoff, KST-aware backoff reset. `./run.sh stop` shuts it
# down. Since design-0020 the leaf is `node headless-lane.mjs` (claude -p
# stream-json) -- no expect, no PTY, no TUI dialog handling.
#
# Reference: the reference fleet's doze-portable/launcher.sh and run-doze-isolated.sh for
# the restart-loop shape (its expect layer is gone since design-0020).
# Backoff numbers here (5/10/20/40/120) are
# a simpler ladder than the reference fleet's production values (3/30/120/300/600) --
# deliberate simplification for a single lightweight agent, not a copy
# error. --dangerously-skip-permissions IS used here (REVERSAL, the owner
# directive 2026-07-04 16:26 "bypass까지만 바로 되도록": product concept =
# full agent autonomy inside its own DATA_HOME, no permission popups;
# Full Disk Access deliberately NOT requested at setup -- deferred to
# feature-need time, see the 16:2x home-channel verdict). The previous
# stance (settings.local.json permissions.allow as the narrower scope)
# still ships as a harmless belt, but the flag is now the product
# behavior; the honest disclosure line lives in onboarding copy
# (copy.js / scheherazade_onboarding_copy_v0 source doc, kept in sync).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# AGENT_CONFIG_FILE / AGENT_DATA_HOME overrides (agent-lifecycle fix,
# 2026-07-03): this script now has TWO callers with different filesystem
# shapes.
#   1. Standalone CLI (the agent-portable fork's own deployment path; its
#      setup.sh bootstrap was deleted 2026-09-07, design-0023 P2 -- the app's
#      onboarding is the only writer of .agent-config now): .agent-config
#      lives next to run.sh itself, at $SCRIPT_DIR/.agent-config -- unchanged
#      default below.
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
  echo "no .agent-config found at $CONFIG_FILE, and AGENT_NAME is not already set in the environment -- run the app once to complete onboarding (it writes .agent-config), or invoke with AGENT_NAME (and optionally CLAUDE_BIN/MODEL/AGENT_DATA_HOME) pre-exported" >&2
  exit 1
fi
AGENT_NAME="${AGENT_NAME:?AGENT_NAME missing from config/env}"

MEM="${AGENT_DATA_HOME:-$HOME/Documents/$AGENT_NAME}"
MODEL="${MODEL:-claude-opus-4-6}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
NODE_BIN="${NODE_BIN:-node}"

# Claude Code tuning knobs carried over from the source launchers -- all
# overridable via env, all optional (Claude Code defaults these itself if
# unset).
# Default effort max -> high (the owner 07-13 click-test: sonnet-5 felt slow;
# max buys thinking budget casual chat doesn't need). An effort selector
# next to the model dropdown is the real fix (click-test item 2); until it
# lands, EFFORT_LEVEL env remains the override.
export CLAUDE_CODE_EFFORT_LEVEL="${EFFORT_LEVEL:-high}"
export CLAUDE_STREAM_IDLE_TIMEOUT_MS="${STREAM_IDLE_TIMEOUT:-300000}"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${AUTO_COMPACT_WINDOW:-500000}"
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="${AUTOCOMPACT_PCT:-80}"

PIDFILE="$MEM/.agent.pid"
LOGFILE="$MEM/logs/agent.log"
STOPFLAG="$MEM/.stop_requested"
FAILFILE="$MEM/.agent-failed.json"
# Cross-model adversarial review fix (2026-07-03): PKILL_PATTERN used to
# include "--model ${MODEL}", coupling it to a MUTABLE field. main.cjs's
# killAgentSupervisor() spawns `run.sh stop` with a FRESHLY-read config --
# if MODEL changed (e.g. a settings edit) after the supervisor/leaf was
# spawned, the pattern built here at stop-time embeds the NEW model while
# the live claude leaf's actual argv (from the old expect spawn line)
# still has the OLD `--model` value baked in, so `pkill -f "$PKILL_PATTERN"`
# silently misses it -- orphaning the Discord-connected CLI on quit/fatal.
# This matters because it's the FALLBACK reaper for exactly that case: the
# direct group-SIGTERM path is already known-insufficient here (timeout(1)
# puts the lane/claude in their own process group, see run_headless() below),
# so pkill is the only mechanism actually reaching the leaf.
# Rebuilt on STABLE discriminators only: AGENT_NAME is product-fixed
# (onboarding/http-server.cjs's AGENT_NAME -- the only writer left since
# setup.sh was deleted 2026-09-07)
# and CLAUDE_BIN is stable within an install -- MODEL is the only
# post-spawn-mutable field of the three, so it's the only one dropped.
# CLAUDE_BIN can't be re-joined onto "--name ${AGENT_NAME}" as a literal
# substring either: the actual argv is
# "$CLAUDE_BIN --model $MODEL --name $AGENT_NAME" (the old expect spawn
# line), so anything bridging across the now-variable --model
# segment would have to be a regex wildcard, not a literal join -- more
# fragile than just anchoring on the tail. "--name ${AGENT_NAME}" alone is
# a CONTIGUOUS substring of that argv regardless of MODEL's value, so it
# always matches the live leaf, and AGENT_NAME is specific enough (a
# product-fixed or one-time-chosen identifier, not a generic flag value)
# not to over-match unrelated processes on the same machine.
# headless-topology (design-0020): the leaf is now `node headless-lane.mjs`
# with a `claude -p ...` child. Two patterns because there are two processes
# to reap when the group kill fails:
#   - the lane: matched by FULL script path, not basename -- the basename
#     alone cross-matched ANY process whose argv mentions the file (an
#     editor with it open, a grep, even the pkill that killed the E2E
#     driver shell -- live bite 2026-08-04 13:2x). Full path still matches
#     both the packaged app path and a repo checkout, per install.
#   - an orphaned claude leaf (lane SIGKILLed before it could TERM its
#     child): its argv carries "--mcp-config $MEM/.mcp.json" once onboarding
#     has seeded that file -- $MEM embeds AGENT_NAME, so this is per-agent
#     specific AND model-agnostic (the 2026-07-03 lesson: never key the
#     reaper to post-spawn-mutable fields like MODEL). Pre-onboarding there
#     is no channel to orphan, so the gap before .mcp.json exists is moot.
PKILL_PATTERN="${SCRIPT_DIR}/headless-lane.mjs"
PKILL_LEAF_PATTERN="--mcp-config ${MEM}/.mcp.json"
# dsh lane switch (0.2.2 full harness swap): dsh is the DEFAULT lane --
# every provider row emits LANE_KIND=dsh, and an absent value means dsh
# too. The claude lane survives only behind an explicit
# LANE_KIND=headless escape hatch (emergency rollback; needs a Claude
# Code CLI install). supervisor.mjs resolveConfig mirrors this exact
# check. The dsh orphan leaf is the engine's --patch argv (stable
# per-agent path under MEM; never a post-spawn-mutable field, same
# 2026-07-03 rule as the --mcp-config leaf).
LANE_SCRIPT="dsh-lane.mjs"
PKILL_PATTERN="${SCRIPT_DIR}/dsh-lane.mjs"
PKILL_LEAF_PATTERN="--patch ${MEM}/.dsh-lane-home/lane.patch.yml"
if [ "${LANE_KIND:-}" = "headless" ]; then
  LANE_SCRIPT="headless-lane.mjs"
  PKILL_PATTERN="${SCRIPT_DIR}/headless-lane.mjs"
  PKILL_LEAF_PATTERN="--mcp-config ${MEM}/.mcp.json"
fi

# Session timeout: forces the lane-wrapped claude process to exit after
# SESSION_TIMEOUT seconds (default 12h) even if the stream is stuck but
# alive -- the restart loop below then picks it back up. Prefers real
# timeout(1)/gtimeout(1) (homebrew coreutils); stock macOS ships neither by
# default, so run_headless() falls back to a manual sleep+kill watchdog.
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

# Bug 1 fix (agent-lifecycle, 2026-07-03, cross-model adversarial review):
# is_alive() alone is IDENTITY-BLIND -- kill -0 only proves *some* process
# holds this pid right now, not that it's actually this AGENT_NAME's own
# run.sh __loop supervisor. A stale PIDFILE surviving a crash/reboot,
# combined with macOS recycling that pid to an unrelated process, would
# otherwise make start_agent() silently no-op (thinks the agent is already
# running) or, worse, make stop_agent() force-kill (`kill -KILL`) a
# completely unrelated process at the end of its wait loop. Verify
# IDENTITY via the process's own command line -- require the CONTIGUOUS
# spawn signature "$SCRIPT_DIR/run.sh __loop", the exact signature both
# start_agent() (`nohup "$SCRIPT_DIR/run.sh" __loop &`) and main.cjs's
# spawnRealAgentChild() (`spawn(BASH_BIN, [RUN_SH_PATH, '__loop'])`) use to
# launch it. Fail SAFE: `ps` erroring, being unavailable, or returning
# nothing (permission, already-exited race) all resolve to "not verified"
# -- callers must treat that as NOT our supervisor (never trust it as
# already-running, never force-kill it).
#
# Cross-model adversarial review follow-up (2026-07-03), two compounding
# bugs fixed together:
#   Fix A -- `-ww` forces `ps` to print the FULL, un-truncated command
#     line. Stock BSD/macOS `ps` width-limits its `command=` output by
#     default; a legit supervisor running from a long install path (e.g.
#     deep inside a "*.app" bundle) can have `__loop` truncated clean off
#     the printed line, false-negating a REAL supervisor as unverified --
#     which then makes start_agent() treat a live agent as stale (double
#     spawn) and makes stop_agent() skip stopping a live one.
#   Fix B -- match the CONTIGUOUS substring "$SCRIPT_DIR/run.sh __loop" in
#     one `case`, instead of a nested double `case` that independently
#     tested for the script path ANYWHERE and '__loop' ANYWHERE in the
#     command line. Two independent substring tests pass even when the
#     two tokens are unrelated (e.g. a recycled pid now held by an
#     editor/grep/diagnostic process whose argv happens to mention both
#     tokens separately) -- a false positive that then gets trusted as a
#     live supervisor or force-killed as one. The actual spawn is always
#     "$SCRIPT_DIR/run.sh __loop" back-to-back, so matching that exact
#     contiguous substring is both necessary and sufficient, and depends
#     on Fix A: without `-ww`, truncation could also sever this same
#     contiguous match.
is_our_supervisor() {
  local pid="$1"
  is_alive "$pid" || return 1
  local cmd
  cmd="$(ps -ww -o command= -p "$pid" 2>/dev/null)" || return 1
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$SCRIPT_DIR/run.sh __loop"*) return 0 ;;
    *) return 1 ;;
  esac
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
#
# "code" (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1): the stable
# machine-readable cause main.cjs's pollFailureMarker() relays into
# setAgentStatus(). This function has exactly one call site (the quick-fail
# streak below), so the code is hardcoded literally rather than threaded
# through as a parameter -- there is only one thing this function ever
# reports.
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
  if ! printf '{\n  "status": "failed",\n  "code": "crash_loop",\n  "reason": "%s",\n  "since": "%s"\n}\n' \
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

run_headless() {
  # headless-topology (design-0020): runs `node headless-lane.mjs` (which
  # spawns and owns `claude -p` stream-json) under the SESSION_TIMEOUT
  # ceiling. The timeout(1) group-signal and manual-watchdog notes from the
  # old run_expect() carry over unchanged: timeout puts the lane in its own
  # process group and signals the whole group; the fallback kills known
  # descendants by PID before each parent. The lane itself forwards TERM to
  # its claude child and exits with the child's code, so a session-timeout
  # recycle is a GRACEFUL handoff -- the next loop iteration resumes the
  # same conversation via .headless-session.json / --resume.
  # NODE_BIN: hooks already depend on PATH-node (`node .../hooks/*.mjs` in
  # settings.local.json), so the lane introduces no new runtime dependency;
  # supervisor.mjs's node-shim covers the PATH-less-node case on the node
  # lane, and this bash lane keeps the same PATH assumption it always had.
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --kill-after=10 --signal=TERM "$SESSION_TIMEOUT" "$NODE_BIN" "$SCRIPT_DIR/$LANE_SCRIPT"
    return $?
  fi

  "$NODE_BIN" "$SCRIPT_DIR/$LANE_SCRIPT" &
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
  # Bug 3 fix (agent-lifecycle, 2026-07-03, cross-model adversarial
  # review, EMPIRICALLY REPRODUCED): CLAUDE_CMD used to flatten
  # CLAUDE_BIN/MODEL/AGENT_NAME into ONE whitespace-joined string, and the
  # old expect script Tcl-split it on whitespace -- a bundled CLI under a
  # spaced path split mid-path and the agent died in a permanent restart
  # loop. The Tcl layer is gone, but the lesson stays: CLAUDE_BIN/MODEL
  # ride as their OWN env vars (headless-lane.mjs reads them individually,
  # never a flattened command string), so spaced paths stay intact.
  export AGENT_NAME MEM CLAUDE_BIN MODEL
  # Custom personality prompt (2026-07-08): rides ABOVE the Claude Code
  # default system prompt via --append-system-prompt-file. Rendered by
  # onboarding-complete into $MEM/system_prompt.md (setup.sh used to render
  # it on the CLI path; deleted 2026-09-07, so the app is the only renderer). Guarded: a missing file must not become a CLI
  # arg error, so the flag is only added when the file exists (see the
  # expect-side extra_args branch). Own env var = one Tcl word, same
  # spaced-path reasoning as CLAUDE_BIN/MODEL above.
  if [ -f "$MEM/system_prompt.md" ]; then
    export SYSTEM_PROMPT_FILE="$MEM/system_prompt.md"
  fi

  # Context-bleed fix (2026-07-28, the owner live catch: 133K context AT BOOT on
  # his install; product's own share measured at ~40K). Without
  # --strict-mcp-config the spawned claude ALSO loads every MCP server from
  # the user's global ~/.claude.json -- schemas the agent never asked for,
  # paid on every request. Strict + an explicit --mcp-config keeps exactly
  # what $MEM/.mcp.json declares: the app's own servers, plus anything the
  # USER deliberately added to that file (it is seeded once and then
  # theirs). Guarded like SYSTEM_PROMPT_FILE: no file -> no strict flag, so
  # a broken seed degrades to today's behavior instead of an agent with no
  # channel at all. (User-level CLAUDE.md/plugins still ride in -- that is
  # the CLAUDE_CONFIG_DIR isolation question, a separate auth-design call.)
  if [ -f "$MEM/.mcp.json" ]; then
    export MCP_CONFIG_FILE="$MEM/.mcp.json"
  fi

  # headless-topology (design-0020): the expect script that used to live
  # here (trust/theme/dev-channels/BYOK dialog answering, 2026-07-05 "1" vs
  # "1\r" keystroke forensics and all) is GONE -- `claude -p` renders no TUI
  # dialogs to answer (probe 1). The BYOK first-approval behavior in -p mode
  # is an open verification item (design-0020 §open-questions); if headless
  # rejects a never-approved key outright, the fix belongs in the key-save
  # flow, not in resurrecting a dialog-answering layer.

  RESTART_COUNT=0
  SPAWN_SEQ=0
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

    pkill -f -- "$PKILL_PATTERN" 2>/dev/null || true
    pkill -f -- "$PKILL_LEAF_PATTERN" 2>/dev/null || true

    # Boot-event marker (v0.0.16): channel.mjs's announceBoot() reads this
    # after Discord login to post the deterministic "재기동" line + inject
    # the agent-voiced greeting turn. Written before EVERY leaf spawn (cold
    # boot and crash-restart alike -- iteration disambiguates); tmp+mv so
    # the reader never sees a torn JSON. Non-fatal on failure: a missing
    # marker only costs the boot ping, never the boot. Keep the shape in
    # sync with supervisor.mjs writeBootEvent() (lane parity).
    SPAWN_SEQ=$((SPAWN_SEQ + 1))
    if printf '{"ts":%s000,"iteration":%d,"lane":"bash","supervisor_pid":%d}\n' \
        "$(date +%s)" "$SPAWN_SEQ" "$$" > "$MEM/.boot-event.json.tmp" 2>/dev/null \
        && mv -f "$MEM/.boot-event.json.tmp" "$MEM/.boot-event.json" 2>/dev/null; then
      :
    else
      log "boot-event marker write failed (non-fatal)"
    fi

    STARTED="$(date +%s)"

    set +e
    run_headless
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
  if [ -f "$PIDFILE" ] && is_our_supervisor "$(cat "$PIDFILE" 2>/dev/null)"; then
    echo "${AGENT_NAME} already running (pid $(cat "$PIDFILE"))"
    exit 0
  elif [ -f "$PIDFILE" ]; then
    # Bug 1 fix: dead, or alive-but-not-ours (pid recycled) -- either way
    # stale from this PIDFILE's perspective. Clear it rather than silently
    # trusting an unverified pid to mean "already running".
    echo "stale/unverified PIDFILE (pid $(cat "$PIDFILE" 2>/dev/null) is dead, or was recycled to an unrelated process) -- clearing before start"
    rm -f "$PIDFILE"
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
  if ! is_our_supervisor "$PID"; then
    # Bug 1 fix: covers both "dead" and "alive but pid recycled to an
    # unrelated process" -- clean-exit as stale either way, never proceed
    # to the kill path below on an unverified pid.
    echo "stale/unverified pidfile (pid ${PID} is dead, or was recycled to an unrelated process), cleaning up"
    rm -f "$PIDFILE"
    exit 0
  fi

  echo "stopping ${AGENT_NAME} (pid ${PID})..."
  touch "$STOPFLAG"
  pkill -f -- "$PKILL_PATTERN" 2>/dev/null || true
  pkill -f -- "$PKILL_LEAF_PATTERN" 2>/dev/null || true

  for _ in $(seq 1 15); do
    is_alive "$PID" || { echo "stopped"; rm -f "$STOPFLAG"; exit 0; }
    sleep 1
  done

  # Bug 1 fix: re-verify identity before the raw kill -KILL below -- up to
  # 15s has elapsed since the is_our_supervisor check above, enough time
  # for the process to have died and its pid been recycled by macOS to an
  # unrelated process. Fail SAFE: only force-kill a pid still confirmed as
  # our supervisor; otherwise skip the direct kill and rely on the
  # identity-safe `pkill -f "$PKILL_PATTERN"` below (command-line pattern
  # match, unaffected by pid recycling) plus stale-state cleanup.
  if is_our_supervisor "$PID"; then
    echo "did not stop in time, forcing"
    kill -KILL "$PID" 2>/dev/null || true
  else
    echo "pid ${PID} no longer identifies as ${AGENT_NAME} supervisor (exited and recycled?) -- skipping force-kill of an unconfirmed pid"
  fi
  pkill -f -- "$PKILL_PATTERN" 2>/dev/null || true
  pkill -f -- "$PKILL_LEAF_PATTERN" 2>/dev/null || true
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
