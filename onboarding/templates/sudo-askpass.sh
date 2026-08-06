#!/bin/bash
# sudo-askpass.sh -- SUDO_ASKPASS helper for the Scheherazade agent.
#
# `sudo -A <cmd>` runs this and uses its stdout as the password. The password
# itself lives ONLY in the app's safeStorage vault (Keychain-backed); this
# script fetches it over loopback from the running app, authorized by a
# per-boot random token in a 0600 file. Consequences, stated honestly:
#   - sudo works only while the app is running (app closed -> fetch fails ->
#     sudo -A fails loudly; that is the containment boundary, not a bug)
#   - the password never lands on disk in plaintext and never appears in
#     chat/log/transcript surfaces (the app logs the EVENT of a fetch, never
#     the value)
#   - the sudo toggle in Settings must be ON (default OFF); the endpoint
#     refuses otherwise
#
# FAILURE TAXONOMY (red-team 2026-08-05 item 6): the old `curl -sf` collapsed
# every server-side refusal into a bare exit 22, and the harness's permission
# translator could only shrug "비밀번호 없이는 실행 불가" -- which mislabeled a
# dead gate as a missing password the same day the report landed (08-05 live
# incident). Now each distinct cause emits its own "askpass:" stderr line;
# sudo -A passes helper stderr through, so the translator (and a human
# reading the transcript) sees WHICH wall it was:
#   app is not running / cannot reach the app  -> start the app
#   endpoint file is malformed                 -> app rewrites it on next boot
#   sudo toggle is OFF                         -> Settings toggle
#   token mismatch                             -> stale endpoint; app restarted?
#   no sudo password stored                    -> store one in Settings
#
# Rendered by the app (harness file, re-rendered every boot). Do not edit.
set -euo pipefail

EP="{MEMORY_DIR}/.sudo-askpass-endpoint.json"
if [ ! -f "$EP" ]; then
  echo "askpass: app is not running (no endpoint file at $EP)" >&2
  exit 1
fi
PORT="$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$EP")"
TOKEN="$(sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p' "$EP")"
if [ -z "$PORT" ] || [ -z "$TOKEN" ]; then
  echo "askpass: endpoint file is malformed" >&2
  exit 1
fi
# Status line to a temp file (headers carry no secret; the body -- the
# password -- stays in memory only). --max-time: if the app dies mid-request,
# fail in seconds, not forever -- a hung askpass would hang the agent's sudo
# call with it.
HDRS="$(mktemp)"
trap 'rm -f "$HDRS"' EXIT
if ! BODY="$(/usr/bin/curl -s --max-time 10 -D "$HDRS" -H "X-Askpass-Token: $TOKEN" "http://127.0.0.1:$PORT/api/sudo/password")"; then
  echo "askpass: cannot reach the app on 127.0.0.1:$PORT (app not running, or the endpoint file is stale)" >&2
  exit 1
fi
CODE="$(awk 'NR==1{print $2}' "$HDRS")"
case "$CODE" in
  200)
    printf '%s' "$BODY"
    ;;
  403)
    case "$BODY" in
      *disabled*) echo "askpass: sudo toggle is OFF in the app Settings -- turn it on there, then retry" >&2 ;;
      *) echo "askpass: token mismatch (endpoint file is stale -- the app probably restarted; retry after its next boot rewrites $EP)" >&2 ;;
    esac
    exit 1
    ;;
  404)
    echo "askpass: no sudo password stored in the app vault -- store one in Settings first" >&2
    exit 1
    ;;
  *)
    echo "askpass: unexpected HTTP ${CODE:-<none>} from the app" >&2
    exit 1
    ;;
esac
