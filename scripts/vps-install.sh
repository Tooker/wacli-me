#!/usr/bin/env bash
# Install the gateway as a systemd service on the VPS. Mirrors
# scripts/server-install.sh, which does the same job with launchd on macOS.
set -euo pipefail
root="$HOME/wacli-me"
unit=/etc/systemd/system/wacli-server.service

mkdir -p "$root/logs"

sudo tee "$unit" >/dev/null <<UNIT
[Unit]
Description=wacli.me MCP gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$root
ExecStart=/usr/bin/node $root/server/server.mjs
Environment=PORT=8787
Environment=HOST=127.0.0.1
# Without this the server's own hostname shows up in a stranger's WhatsApp
# device list. Never let it fall back.
Environment=WACLI_DEVICE_LABEL=wacli.me
Environment=WACLI_DEVICE_PLATFORM=DESKTOP
Environment=WACLI_BIN=$root/bin/wacli
Restart=always
RestartSec=3
StandardOutput=append:$root/logs/server.log
StandardError=append:$root/logs/server.log

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now wacli-server
sleep 2
systemctl is-active wacli-server
