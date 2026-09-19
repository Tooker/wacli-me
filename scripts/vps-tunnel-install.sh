#!/usr/bin/env bash
# Run the named Cloudflare tunnel as a systemd service on the VPS.
# The tunnel keeps the origin IP off the public internet — that is the point of
# the move, so never expose 8787 directly instead.
set -euo pipefail
unit=/etc/systemd/system/wacli-tunnel.service

sudo tee "$unit" >/dev/null <<UNIT
[Unit]
Description=cloudflared tunnel for wacli.me
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/cloudflared --config $HOME/.cloudflared/wacli-me.yml --no-autoupdate tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now wacli-tunnel
sleep 3
systemctl is-active wacli-tunnel
