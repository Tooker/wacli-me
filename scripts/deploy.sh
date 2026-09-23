#!/usr/bin/env bash
# Push the working copy to the host and reload the gateway.
#
# config/ and runtime state stay untouched: tenants.json lives on the host, and
# the named tunnel keeps running so wacli.me never goes down for a deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
host="${WACLI_ME_HOST:-wacli-host}"

node scripts/build.mjs

# Local notes under docs/ stay on the workstation: they name hosts, paths and
# operator details that have no business on the server.
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude logs --exclude stores \
  --exclude bin --exclude config --exclude docs \
  ./ "$host:~/wacli-me/"

# The server runs under systemd (wacli-server) — restart the unit, never start a
# second copy by hand or the port is already taken. The tunnel is a separate
# unit and stays up, so wacli.me never goes down for a deploy.
ssh "$host" 'sudo systemctl restart wacli-server && sleep 3 && curl -sS localhost:8787/healthz'
echo
echo "https://wacli.me"
