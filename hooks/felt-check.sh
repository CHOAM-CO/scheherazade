#!/bin/bash
# felt-check.sh — Stop hook: nudges toward a concrete Felt section before
# the session ends. Advisory only, never blocks the stop (exit 0 always).
# Uses hookSpecificOutput so the nudge reaches Claude's context rather than
# only a user-facing systemMessage.

set -o pipefail

MEM="${MEM:-$PWD}"
TODAY="$(TZ=Asia/Seoul date +%Y-%m-%d)"
NOTES_FILE="$MEM/session_notes/${TODAY}.md"

[ -f "$NOTES_FILE" ] || exit 0

if ! grep -q '^## 🔥 Felt' "$NOTES_FILE"; then
  cat <<JSON
{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "No ## 🔥 Felt section in today's session note. Write the actual scene before stopping -- not a label."}}
JSON
  exit 0
fi

FELT_CONTENT=$(awk '/^## 🔥 Felt/{found=1; next} found && /^## /{exit} found{print}' "$NOTES_FILE" | tr -d '[:space:]')

if [ "${#FELT_CONTENT}" -lt 50 ]; then
  cat <<JSON
{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "The Felt section is thin (under 50 characters of content). Labels aren't enough -- what was the actual scene?"}}
JSON
fi

exit 0
