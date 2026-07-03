#!/bin/bash
# journal-compress.sh — finds session notes ready for compression and, once
# the agent has written the compressed journal entries, archives the
# originals. The compression itself (summarize, preserve 🔥/🔒 verbatim) is
# an agent judgment call driven by CLAUDE.md -- this script only does the
# mechanical parts: find, list, verify, move.
#
# Usage:
#   journal-compress.sh scan     list session notes older than today that
#                                 still need a journal entry (default)
#   journal-compress.sh archive  move already-journaled originals into
#                                 session_notes/.archive/

set -o pipefail

MEM="${MEM:-$PWD}"
TODAY="$(TZ=Asia/Seoul date +%Y-%m-%d)"
SESSION_DIR="$MEM/session_notes"
JOURNAL_DIR="$MEM/journals"
ARCHIVE_DIR="$SESSION_DIR/.archive"
LAST_COMPRESS_FILE="$MEM/.last_compress"

MODE="${1:-scan}"

mkdir -p "$SESSION_DIR" "$JOURNAL_DIR" "$ARCHIVE_DIR"

old_notes() {
  for f in "$SESSION_DIR"/*.md; do
    [ -f "$f" ] || continue
    fdate="$(basename "$f" .md)"
    [[ "$fdate" < "$TODAY" ]] && printf '%s\n' "$f"
  done
}

case "$MODE" in
  scan)
    FOUND=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      fdate="$(basename "$f" .md)"
      journal="$JOURNAL_DIR/${fdate}.md"
      [ -f "$journal" ] && continue
      echo "$f"
      FOUND=$((FOUND + 1))
    done < <(old_notes)

    if [ "$FOUND" -eq 0 ]; then
      echo "no session notes pending compression" >&2
    else
      echo "${FOUND} session note(s) above need a journal entry before archiving. For each: write journals/<date>.md keeping ## 🔥 Felt and any 🔒 lines verbatim, summarize the rest, then run 'journal-compress.sh archive'." >&2
    fi
    ;;
  archive)
    ARCHIVED=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      fdate="$(basename "$f" .md)"
      journal="$JOURNAL_DIR/${fdate}.md"
      [ -f "$journal" ] || continue
      mv "$f" "$ARCHIVE_DIR/${fdate}.md"
      ARCHIVED=$((ARCHIVED + 1))
      echo "archived ${fdate}.md"
    done < <(old_notes)
    date +%s > "$LAST_COMPRESS_FILE"
    echo "${ARCHIVED} session note(s) archived" >&2
    ;;
  *)
    echo "usage: journal-compress.sh [scan|archive]" >&2
    exit 1
    ;;
esac
