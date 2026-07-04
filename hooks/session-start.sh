#!/bin/bash
# session-start.sh — SessionStart hook: restores continuity at boot.
# Non-blocking. Prints hookSpecificOutput so the summary reaches Claude's
# context as a system reminder, not just a user-facing log line.
#
# Wired under "SessionStart" in settings.local.json. (The spec that
# generated this package named the event "Notification" — Notification
# hooks are documented as side-effect-only, forwarding rather than
# injecting context, and are not guaranteed to fire at boot. SessionStart
# is the event Claude Code actually fires when a session opens, so that is
# what this is wired to.)
#
# Reads AGENT_NAME / MEM from the environment (set by run.sh). Falls back
# to the current directory when they are unset, so a manually-started
# `claude` session (cwd = the memory dir) still restores correctly.

set -o pipefail

MEM="${MEM:-$PWD}"
AGENT_NAME="${AGENT_NAME:-$(basename "$MEM")}"
TODAY="$(TZ=Asia/Seoul date +%Y-%m-%d)"

mkdir -p "$MEM/session_notes" "$MEM/journals" "$MEM/dreams" "$MEM/logs"

NOTES_FILE="$MEM/session_notes/${TODAY}.md"
NOTE_STATUS="found"
if [ ! -f "$NOTES_FILE" ]; then
  cat > "$NOTES_FILE" <<EOF
# ${TODAY}

## 🔥 Felt


### Pending


### Handoff

EOF
  NOTE_STATUS="created fresh"
fi

CHECKPOINT_FILE="$MEM/checkpoint.md"
if [ -f "$CHECKPOINT_FILE" ]; then
  NOW_TS=$(date +%s)
  CP_TS=$(date -r "$CHECKPOINT_FILE" +%s 2>/dev/null || echo "$NOW_TS")
  CP_AGE_MIN=$(( (NOW_TS - CP_TS) / 60 ))
  CHECKPOINT_STATUS="last updated ${CP_AGE_MIN}min ago"
else
  CHECKPOINT_STATUS="none yet"
fi

PENDING_COUNT=0
for f in "$MEM"/session_notes/*.md; do
  [ -f "$f" ] || continue
  FDATE="$(basename "$f" .md)"
  [[ "$FDATE" < "$TODAY" ]] && PENDING_COUNT=$((PENDING_COUNT + 1))
done

DREAM_COUNT=0
if [ -d "$MEM/dreams" ]; then
  DREAM_COUNT=$(find "$MEM/dreams" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')
fi

# skills/ listing (design doc R1 consumption pair -- stop-skill-extraction-
# nudge.mjs is the write side, this is the read side; a nudge with no
# listing here would be a dead drawer). Purely additive: no dir is created
# here (skills/ is lazy-created by whoever writes the first skill file, not
# by this boot-time read), and a missing/empty dir produces no lines at all
# -- same "handle absence gracefully" posture as the rest of this script.
SKILL_LINES=()
if [ -d "$MEM/skills" ]; then
  for f in "$MEM"/skills/*.md; do
    [ -f "$f" ] || continue
    SKILL_NAME="$(basename "$f")"
    # Trigger line lives in the file's YAML frontmatter (between the first
    # two "---" delimiter lines), key "trigger:" per the design doc's
    # frontmatter spec (name/trigger/extracted_from/date). Scoped to the
    # frontmatter block specifically (not a whole-file grep) so a "trigger:"
    # word appearing in the skill body text can't be picked up by mistake.
    FRONTMATTER="$(awk '/^---[[:space:]]*$/{c++; next} c==1' "$f" 2>/dev/null)"
    TRIGGER_LINE="$(printf '%s\n' "$FRONTMATTER" | grep -m1 '^trigger:' | sed -E 's/^trigger:[[:space:]]*//; s/^"(.*)"$/\1/')"
    if [ -n "$TRIGGER_LINE" ]; then
      SKILL_LINES+=("- ${SKILL_NAME}: ${TRIGGER_LINE}")
    else
      SKILL_LINES+=("- ${SKILL_NAME}: (no trigger field found)")
    fi
  done
fi

LINES=()
LINES+=("Session note for ${TODAY}: ${NOTE_STATUS}.")
LINES+=("Checkpoint: ${CHECKPOINT_STATUS}.")
if [ "$PENDING_COUNT" -gt 0 ]; then
  LINES+=("${PENDING_COUNT} prior-date session note(s) waiting on journal compression -- run journal-compress.sh scan.")
fi
if [ "$DREAM_COUNT" -gt 0 ]; then
  LINES+=("${DREAM_COUNT} dream fragment(s) in dreams/ -- read the 5 most recent for context.")
fi
if [ "${#SKILL_LINES[@]}" -gt 0 ]; then
  LINES+=("${#SKILL_LINES[@]} skill(s) in skills/ (Read the file when one looks relevant):")
  LINES+=("${SKILL_LINES[@]}")
fi
LINES+=("Restore order: today's session note (Felt first), then checkpoint.md, then self_persona.md, then recent dreams.")

SUMMARY=""
for line in "${LINES[@]}"; do
  ESCAPED="${line//\"/\\\"}"
  if [ -z "$SUMMARY" ]; then
    SUMMARY="$ESCAPED"
  else
    SUMMARY="${SUMMARY}\\n${ESCAPED}"
  fi
done

cat <<JSON
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "${SUMMARY}"}}
JSON
