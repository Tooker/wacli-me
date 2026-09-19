#!/usr/bin/env bash
# Keep the named tunnel running across reboots, via a user LaunchAgent.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
name="${TUNNEL_NAME:-wacli-me}"
label="me.wacli.tunnel"
plist="$HOME/Library/LaunchAgents/$label.plist"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>--config</string>
    <string>$HOME/.cloudflared/$name.yml</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/wacli-me/logs/tunnel-named.log</string>
  <key>StandardErrorPath</key><string>$HOME/wacli-me/logs/tunnel-named.log</string>
</dict>
</plist>
PLIST

mkdir -p "$HOME/wacli-me/logs"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "launchagent $label installed and started"
