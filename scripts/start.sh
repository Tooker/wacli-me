#!/usr/bin/env bash
# Start the MCP gateway on loopback. Logs to logs/server.log.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
mkdir -p logs
PORT="${PORT:-8787}" HOST="${HOST:-127.0.0.1}" \
  nohup node server/server.mjs >> logs/server.log 2>&1 &
echo "$!" > logs/server.pid
sleep 1
curl -fsS "http://${HOST:-127.0.0.1}:${PORT:-8787}/healthz" && echo
