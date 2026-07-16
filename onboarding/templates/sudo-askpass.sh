#!/bin/bash
# sudo-askpass.sh -- SUDO_ASKPASS helper for the Scheherazade agent.
#
# `sudo -A <cmd>` runs this and uses its stdout as the password. The password
# itself lives ONLY in the app's safeStorage vault (Keychain-backed); this
# script fetches it over loopback from the running app, authorized by a
# per-boot random token in a 0600 file. Consequences, stated honestly:
#   - sudo works only while the app is running (app closed -> curl fails ->
#     sudo -A fails loudly; that is the containment boundary, not a bug)
#   - the password never lands on disk in plaintext and never appears in
#     chat/log/transcript surfaces (the app logs the EVENT of a fetch, never
#     the value)
#   - the sudo toggle in Settings must be ON (default OFF); the endpoint
#     refuses otherwise
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
# --max-time: if the app dies mid-request, fail in seconds, not forever --
# a hung askpass would hang the agent's sudo call with it.
exec /usr/bin/curl -sf --max-time 10 -H "X-Askpass-Token: $TOKEN" "http://127.0.0.1:$PORT/api/sudo/password"
