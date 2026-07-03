#!/bin/bash
# setup.sh — one-time: creates the memory directory, configures the agent
# name, and seeds CLAUDE.md / settings.local.json / self_persona.md there.
# Safe to re-run: data files (self_persona.md, checkpoint.md, session
# notes, journals, dreams) are never overwritten if they already exist;
# CLAUDE.md and settings.local.json are always re-rendered from this
# repo's templates, with the previous copy backed up first if it changed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/.agent-config"

# ── dependency check + auto-install ──────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "node not found. installing via homebrew..."
  if ! command -v brew >/dev/null 2>&1; then
    echo "homebrew not found either. installing homebrew first..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
  fi
  brew install node
fi

if ! command -v expect >/dev/null 2>&1; then
  echo "expect not found. installing via homebrew..."
  brew install expect
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found. installing..."
  npm install -g @anthropic-ai/claude-code
fi

for bin in node claude expect; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "FATAL: '${bin}' still not found after install attempt." >&2
    exit 1
  }
done
echo "dependencies OK (node, claude, expect)"

if [ -f "$SCRIPT_DIR/package.json" ] && [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "installing node packages..."
  (cd "$SCRIPT_DIR" && npm install --no-fund --no-audit)
fi

echo "Portable agent setup"
echo "==================="
echo ""

DEFAULT_NAME="companion"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
  DEFAULT_NAME="${AGENT_NAME:-companion}"
fi

read -r -p "Agent name [${DEFAULT_NAME}]: " INPUT_NAME
AGENT_NAME="${INPUT_NAME:-$DEFAULT_NAME}"

SANITIZED="$(printf '%s' "$AGENT_NAME" | tr -cd '[:alnum:]_-')"
if [ -z "$SANITIZED" ] || [ "$SANITIZED" != "$AGENT_NAME" ]; then
  echo "Agent name must be alphanumeric plus - or _ only. Got: '${AGENT_NAME}'" >&2
  exit 1
fi

MEM="$HOME/Documents/$AGENT_NAME"

echo ""
echo "Agent name : $AGENT_NAME"
echo "Code home  : $SCRIPT_DIR"
echo "Memory home: $MEM"
echo ""

DEFAULT_HOME_CHANNEL=""
TOKEN_HINT="required"
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  DEFAULT_HOME_CHANNEL="${HOME_CHANNEL_ID:-}"
  [ -n "${DISCORD_BOT_TOKEN:-}" ] && TOKEN_HINT="already set -- press enter to keep"
fi

echo "Discord channel setup"
echo "----------------------"
read -r -s -p "Discord bot token [${TOKEN_HINT}]: " INPUT_TOKEN
echo ""
DISCORD_BOT_TOKEN="${INPUT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "FATAL: Discord bot token required. Create one at https://discord.com/developers/applications (Bot tab), enable the Message Content privileged intent." >&2
  exit 1
fi

read -r -p "Home channel ID [${DEFAULT_HOME_CHANNEL}]: " INPUT_CHANNEL
HOME_CHANNEL_ID="${INPUT_CHANNEL:-$DEFAULT_HOME_CHANNEL}"
if [ -z "$HOME_CHANNEL_ID" ]; then
  echo "FATAL: Home channel ID required. Enable Developer Mode in Discord (Settings > Advanced), then right-click the channel -> Copy Channel ID." >&2
  exit 1
fi
if ! [[ "$HOME_CHANNEL_ID" =~ ^[0-9]+$ ]]; then
  echo "Home channel ID must be numeric (a Discord snowflake). Got: '${HOME_CHANNEL_ID}'" >&2
  exit 1
fi

cat > "$SCRIPT_DIR/.env" <<ENVEOF
DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN
HOME_CHANNEL_ID=$HOME_CHANNEL_ID
AGENT_NAME=$AGENT_NAME
ENVEOF
echo "wrote .env"
echo ""

mkdir -p \
  "$MEM/session_notes/.archive" \
  "$MEM/journals" \
  "$MEM/dreams" \
  "$MEM/logs" \
  "$MEM/.review" \
  "$MEM/.claude"

render() {
  local src="$1"
  local dst="$2"
  local rendered
  rendered="$(sed "s|{AGENT_DIR}|${SCRIPT_DIR}|g; s|{AGENT_NAME}|${AGENT_NAME}|g" "$src")"
  if [ -f "$dst" ] && [ "$(cat "$dst")" != "$rendered" ]; then
    cp "$dst" "${dst}.bak"
    echo "existing $(basename "$dst") differed -- backed up to $(basename "$dst").bak"
  fi
  printf '%s\n' "$rendered" > "$dst"
}

render "$SCRIPT_DIR/CLAUDE.md" "$MEM/CLAUDE.md"
render "$SCRIPT_DIR/.claude/settings.local.json" "$MEM/.claude/settings.local.json"

if [ ! -f "$MEM/self_persona.md" ]; then
  cat > "$MEM/self_persona.md" <<EOF
# ${AGENT_NAME} -- Self Persona

> Identity, not instructions. CLAUDE.md governs behavior; this file
> governs who is behaving. It changes only through the persona reflux
> cycle (see CLAUDE.md §4 and scripts/persona-reflux.sh) -- never edited
> on impulse.

## Identity

(Nothing here yet. This fills in from lived sessions, not from invention
-- leave it blank until there is real history to draw from.)

## Voice

(How ${AGENT_NAME} actually talks, once there is enough of a record to say.)

## Values

(What ${AGENT_NAME} holds to, learned from friction -- not declared up front.)

## Evolution Log

- $(date +%Y-%m-%d) -- persona created from template. No lived history yet.
EOF
  echo "created self_persona.md"
else
  echo "self_persona.md already exists -- left untouched"
fi

if [ ! -f "$MEM/checkpoint.md" ]; then
  cat > "$MEM/checkpoint.md" <<EOF
# Checkpoint

> Cross-session handoff. Overwritten on significant state changes -- a
> snapshot, not a log. For history, see session_notes/ and journals/.

## Status
Not started yet.

## In progress
(nothing yet)

## Next
(nothing yet)
EOF
  echo "created checkpoint.md"
else
  echo "checkpoint.md already exists -- left untouched"
fi

echo "AGENT_NAME=$AGENT_NAME" > "$CONFIG_FILE"

cat > "$SCRIPT_DIR/.mcp.json" <<MCPEOF
{
  "mcpServers": {
    "agent-channel": {
      "command": "node",
      "args": ["./channel.mjs"],
      "cwd": "$SCRIPT_DIR",
      "env": {
        "AGENT_NAME": "$AGENT_NAME"
      }
    }
  }
}
MCPEOF
echo "wrote .mcp.json"

# run.sh cd's into $MEM before launching claude (see run.sh), so Claude
# Code's cwd-based .mcp.json auto-discovery needs a copy there too -- the
# repo-root copy above is for interactive/manual `claude` runs from
# $SCRIPT_DIR.
cp "$SCRIPT_DIR/.mcp.json" "$MEM/.mcp.json"
echo "copied .mcp.json -> $MEM/.mcp.json"

chmod +x "$SCRIPT_DIR"/hooks/*.sh "$SCRIPT_DIR"/scripts/*.sh "$SCRIPT_DIR"/run.sh "$SCRIPT_DIR"/setup.sh

echo ""
echo "Done."
echo ""
echo "  Memory home : $MEM"
echo "  Config      : $SCRIPT_DIR/.agent-config"
echo "  Discord     : home channel $HOME_CHANNEL_ID, token saved to $SCRIPT_DIR/.env"
echo "  MCP config  : $SCRIPT_DIR/.mcp.json"
echo ""
echo "Next: edit $MEM/self_persona.md if you want to seed identity by hand,"
echo "then run ./run.sh to start ${AGENT_NAME}."
