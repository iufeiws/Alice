#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${ALICE_TMUX_SESSION:-alice-agent}"
WORKDIR="${ALICE_WORKDIR:-/home/yf/Alice}"
AGENT_COMMAND="${ALICE_AGENT_COMMAND:-npm run dev:api}"
LOGIN_SHELL="${SHELL:-/bin/bash}"
STARTUP_COMMAND="cd \"$WORKDIR\"; $AGENT_COMMAND; status=\$?; printf '\\n%s exited with status %s. Edit as needed, then run it again manually.\\n' \"$AGENT_COMMAND\" \"\$status\"; exec \"$LOGIN_SHELL\" -i"

usage() {
  printf 'Usage: %s {start|stop|restart|status}\n' "$0" >&2
}

require_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    printf 'tmux is required but was not found in PATH\n' >&2
    exit 1
  fi
}

start_agent() {
  require_tmux

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    printf 'tmux session already exists: %s\n' "$SESSION_NAME"
    return 0
  fi

  if [ ! -d "$WORKDIR" ]; then
    printf 'workspace does not exist: %s\n' "$WORKDIR" >&2
    exit 1
  fi

  tmux new-session -d -s "$SESSION_NAME" -c "$WORKDIR" "$LOGIN_SHELL" -lc "$STARTUP_COMMAND"
  printf 'started tmux session %s in %s: %s\n' "$SESSION_NAME" "$WORKDIR" "$AGENT_COMMAND"
}

stop_agent() {
  require_tmux

  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    printf 'tmux session is not running: %s\n' "$SESSION_NAME"
    return 0
  fi

  tmux kill-session -t "$SESSION_NAME"
  printf 'stopped tmux session: %s\n' "$SESSION_NAME"
}

status_agent() {
  require_tmux

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    printf 'running: %s\n' "$SESSION_NAME"
    tmux list-panes -t "$SESSION_NAME" -F 'pane=#{pane_index} active=#{pane_active} command=#{pane_current_command}'
  else
    printf 'stopped: %s\n' "$SESSION_NAME"
    exit 3
  fi
}

case "${1:-start}" in
  start)
    start_agent
    ;;
  stop)
    stop_agent
    ;;
  restart)
    stop_agent
    start_agent
    ;;
  status)
    status_agent
    ;;
  *)
    usage
    exit 2
    ;;
esac
