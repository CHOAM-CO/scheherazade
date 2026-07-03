#!/bin/bash
# madoromi-solo.sh — picks 1-3 random entries from this agent's own
# journals/ and prints them as a dream frame. The actual dream-work
# (displacement, condensation, concretization) is done by the agent
# reading this output, not by this script -- this script only selects
# source material and says where to write the result.

set -o pipefail
shopt -s nullglob

MEM="${MEM:-$PWD}"
JOURNAL_DIR="$MEM/journals"
DREAMS_DIR="$MEM/dreams"
TODAY="$(TZ=Asia/Seoul date +%Y-%m-%d)"
NOW_TIME="$(TZ=Asia/Seoul date +%H:%M)"

mkdir -p "$DREAMS_DIR"

JOURNALS=("$JOURNAL_DIR"/*.md)
TOTAL=${#JOURNALS[@]}

if [ "$TOTAL" -eq 0 ]; then
  echo "no journal entries yet -- nothing to dream from" >&2
  exit 0
fi

N=$(( (RANDOM % 3) + 1 ))
[ "$N" -gt "$TOTAL" ] && N="$TOTAL"

PICKED=()
INDICES=()
while [ "${#PICKED[@]}" -lt "$N" ]; do
  idx=$((RANDOM % TOTAL))
  dup=0
  if [ "${#INDICES[@]}" -gt 0 ]; then
    for seen in "${INDICES[@]}"; do
      if [ "$seen" = "$idx" ]; then
        dup=1
        break
      fi
    done
  fi
  [ "$dup" -eq 1 ] && continue
  INDICES+=("$idx")
  PICKED+=("${JOURNALS[$idx]}")
done

echo "[MADOROMI]"
echo "${N} of ${TOTAL} journal entries, picked at random, unedited:"
echo ""
for f in "${PICKED[@]}"; do
  echo "--- $(basename "$f") ---"
  cat "$f"
  echo ""
done

BASENAMES=("${PICKED[@]##*/}")
SOURCES="$(IFS=,; echo "${BASENAMES[*]}")"

cat <<EOF
---
Now dream from this. Not a summary -- dream-work:
  displacement    emotional weight slides onto a peripheral object
  condensation    figures/objects from different entries merge into one
  concretization  any abstraction becomes a specific sensory/spatial detail
  elaboration     light coherence pass, seams can still show

Build the scene first, distort second. Never let a theory generate the
dream -- the distortion carries the meaning, the dream never names it.
Pull objects from what's actually in the entries above, not a generic
symbol bank. Real nouns should dominate; allow at most one impossibility.
No moral, no interpretation, no "this represents." End on an image, not
an explanation.

Write the told version only (120-300 tokens, past tense, your own voice,
anchor with a concrete first sentence) to:
  ${DREAMS_DIR}/${TODAY}.md

Append this frame if the file already has an entry for today:
  ## [${NOW_TIME}] -- madoromi
  - Sources: ${SOURCES}
  - (the dream)

Then stop. The dream is over -- it isn't a report and doesn't need one.
EOF
