#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="alice-agent-tmux.service"
WORKDIR="/home/yf/Alice"
START_SCRIPT="$WORKDIR/infra/start-agent-tmux.sh"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SYSTEMD_USER_DIR/$SERVICE_NAME"
USER_NAME="${USER:-$(id -un)}"

if [ ! -x "$START_SCRIPT" ]; then
  printf 'start script is not executable: %s\n' "$START_SCRIPT" >&2
  printf 'run: chmod +x %s\n' "$START_SCRIPT" >&2
  exit 1
fi

mkdir -p "$SYSTEMD_USER_DIR"

cat > "$SERVICE_PATH" <<SERVICE
[Unit]
Description=Alice agent tmux session
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$WORKDIR
ExecStart=$START_SCRIPT start
ExecStop=$START_SCRIPT stop
TimeoutStartSec=60
TimeoutStopSec=30

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

if command -v loginctl >/dev/null 2>&1; then
  if loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null | grep -qx yes; then
    printf 'linger is already enabled for user: %s\n' "$USER_NAME"
  elif loginctl enable-linger "$USER_NAME" 2>/dev/null; then
    printf 'enabled linger for user: %s\n' "$USER_NAME"
  else
    printf 'could not enable linger automatically. Run this once with sudo:\n' >&2
    printf '  sudo loginctl enable-linger %s\n' "$USER_NAME" >&2
  fi
else
  printf 'loginctl was not found; enable linger manually if this host uses systemd-logind.\n' >&2
fi

printf 'installed user service: %s\n' "$SERVICE_PATH"
printf 'start now: systemctl --user start %s\n' "$SERVICE_NAME"
printf 'attach tmux: tmux attach -t alice-agent\n'
