#!/bin/bash
# checkpoint-nudge.sh — Stop hook: reminds to write checkpoint.md after
# 30min with no update. Self-throttled via .last_checkpoint_nudge so it
# fires at most once per 30min no matter how many Stop events land in that
# window. Advisory only, exit 0 always.

set -o pipefail

MEM="${MEM:-$PWD}"
CHECKPOINT_FILE="$MEM/checkpoint.md"
NUDGE_FILE="$MEM/.last_checkpoint_nudge"
THRESHOLD_SEC=1800

[ -f "$CHECKPOINT_FILE" ] || exit 0

NOW_TS=$(date +%s)
CP_TS=$(date -r "$CHECKPOINT_FILE" +%s 2>/dev/null || echo "$NOW_TS")
STALE_SEC=$((NOW_TS - CP_TS))

[ "$STALE_SEC" -lt "$THRESHOLD_SEC" ] && exit 0

if [ -f "$NUDGE_FILE" ]; then
  LAST_NUDGE_TS="$(cat "$NUDGE_FILE" 2>/dev/null || echo 0)"
  SINCE_NUDGE=$((NOW_TS - LAST_NUDGE_TS))
  [ "$SINCE_NUDGE" -lt "$THRESHOLD_SEC" ] && exit 0
fi

echo "$NOW_TS" > "$NUDGE_FILE"
STALE_MIN=$((STALE_SEC / 60))

cat <<JSON
{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "checkpoint.md has not been touched in ${STALE_MIN}min. If there is state worth handing off, write it now."}}
JSON

exit 0
