#!/usr/bin/env bash
# Supervisor for the claude-channel-teams tmux session.
#
# Started by the systemd unit. Creates the session if missing, then blocks
# until the session disappears — at which point we exit non-zero and
# systemd's Restart=always brings us back.
#
# This is the only reliable way to detect that claude (or the tmux server)
# died: forking units with RemainAfterExit can't, and a bare
# `tmux new-session -d` from ExecStart leaves systemd thinking the service
# completed successfully when the tmux server later dies.
#
# Copy to /usr/local/bin/claude-channel-teams-supervisor.sh, chmod +x,
# and reference from your systemd unit's ExecStart.

set -uo pipefail

SESSION="claude-channel-teams"
CWD="<working-directory>"
CLAUDE="/home/<service-user>/.npm-global/bin/claude"
MARKETPLACE="<your-marketplace>"

if ! command -v tmux >/dev/null 2>&1; then
  echo "claude-channel-teams-supervisor: tmux not found in PATH" >&2
  exit 2
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "claude-channel-teams-supervisor: creating tmux session $SESSION" >&2
  tmux new-session -d -s "$SESSION" -c "$CWD" \
    "exec '$CLAUDE' --channels plugin:teams@$MARKETPLACE --dangerously-skip-permissions" \
    || { echo "claude-channel-teams-supervisor: failed to create session" >&2; exit 3; }
  # Give claude a few seconds to actually start before we begin polling.
  sleep 5
fi

echo "claude-channel-teams-supervisor: watching $SESSION" >&2
while tmux has-session -t "$SESSION" 2>/dev/null; do
  sleep 10
done

echo "claude-channel-teams-supervisor: session $SESSION is gone — exiting for restart" >&2
exit 1
