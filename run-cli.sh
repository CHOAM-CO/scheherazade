#!/bin/bash
# run-cli.sh — interactive Claude Code session with MCP + full permission bypass.
# No daemon, no tmux. Just a live terminal session.

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
MODEL="${MODEL:-claude-opus-4-6}"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  set +a
fi

MEM="$HOME/Documents/$AGENT_NAME"
mkdir -p "$MEM"

cd "$SCRIPT_DIR"
exec claude \
  --model "$MODEL" \
  --name "$AGENT_NAME" \
  --dangerously-skip-permissions
