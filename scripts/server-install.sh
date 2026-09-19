#!/usr/bin/env bash
# Keep the MCP gateway running across reboots, via a user LaunchAgent.
set -euo pipefail
label="me.wacli.server"
plist="$HOME/Library/LaunchAgents/$label.plist"
root="$HOME/wacli-me"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$root/server/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>8787</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>WACLI_DEVICE_LABEL</key><string>wacli.me</string>
    <key>WACLI_DEVICE_PLATFORM</key><string>DESKTOP</string>
  </dict>
  <key>WorkingDirectory</key><string>$root</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$root/logs/server.log</string>
  <key>StandardErrorPath</key><string>$root/logs/server.log</string>
</dict>
</plist>
PLIST

mkdir -p "$root/logs"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "launchagent $label installed and started"
