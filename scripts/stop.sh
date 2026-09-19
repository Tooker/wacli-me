#!/usr/bin/env bash
# stop.sh [server|tunnel|all]   default: server only — the tunnel URL is expensive
# to lose, so a deploy must not take it down by accident.
set -euo pipefail
cd "$(dirname "$0")/.."
what="${1:-server}"

stop_pid() {
  local file="$1" name="$2"
  [ -f "$file" ] || { echo "$name: not running"; return; }
  kill "$(cat "$file")" 2>/dev/null || true
  rm -f "$file"
  echo "$name: stopped"
}

case "$what" in
  server) stop_pid logs/server.pid server ;;
  tunnel) stop_pid logs/tunnel.pid tunnel ;;
  all)    stop_pid logs/server.pid server; stop_pid logs/tunnel.pid tunnel ;;
  *)      echo "usage: stop.sh [server|tunnel|all]" >&2; exit 2 ;;
esac
