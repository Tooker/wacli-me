#!/usr/bin/env bash
# Publish the loopback server through a Cloudflare quick tunnel (random *.trycloudflare.com host).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
mkdir -p logs

# NEVER pkill by the cloudflared name on this host: other, unrelated named
# tunnels run here and a broad kill takes them down with it. Only ever stop
# this project's tunnel through logs/tunnel.pid (scripts/stop.sh tunnel).
if [ -f logs/tunnel.pid ] && kill -0 "$(cat logs/tunnel.pid)" 2>/dev/null; then
  echo "tunnel already running: $(cat logs/tunnel.url 2>/dev/null)"
  exit 0
fi
: > logs/tunnel.log
nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT:-8787}" \
  >> logs/tunnel.log 2>&1 &
echo "$!" > logs/tunnel.pid
for _ in $(seq 1 30); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | head -1 || true)
  [ -n "$url" ] && { echo "$url" | tee logs/tunnel.url; exit 0; }
  sleep 1
done
echo "no tunnel URL after 30s — see logs/tunnel.log" >&2
exit 1
