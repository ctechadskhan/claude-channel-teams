#!/usr/bin/env bash
#
# claude-channel-teams — local setup helper.
#
# Creates the state directory, writes a placeholder .env from .env.example,
# and chmods it correctly. Idempotent: safe to re-run.
#
# Phase 1: this script is a scaffold. Phase 3 wires it to the
# /teams:configure skill so the operator never has to touch it directly.

set -euo pipefail

STATE_DIR="${TEAMS_STATE_DIR:-$HOME/.claude/channels/teams}"
ENV_FILE="$STATE_DIR/.env"
EXAMPLE="$(dirname "$(readlink -f "$0")")/../.env.example"

umask 077
mkdir -p "$STATE_DIR" "$STATE_DIR/approved" "$STATE_DIR/inbox"
chmod 700 "$STATE_DIR" "$STATE_DIR/approved" "$STATE_DIR/inbox"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$EXAMPLE" ]]; then
    cp "$EXAMPLE" "$ENV_FILE"
    echo "wrote placeholder $ENV_FILE — edit and fill in the real values"
  else
    : > "$ENV_FILE"
    echo "created empty $ENV_FILE — copy values from .env.example"
  fi
fi
chmod 600 "$ENV_FILE"

echo
echo "state dir: $STATE_DIR"
echo "env file:  $ENV_FILE  (mode 0600)"
echo
echo "Next steps:"
echo "  1. Edit $ENV_FILE and fill in TEAMS_BOT_APP_ID / APP_PASSWORD / TENANT_ID"
echo "  2. Restart Claude Code with channels enabled (see docs/installation.md)"
