#!/usr/bin/env bash
# One-time setup of a NAMED Cloudflare tunnel for a real domain.
#
#   ./scripts/tunnel-named.sh wacli.me
#
# Unlike the quick tunnel, the hostname is stable and survives restarts.
# Requires `cloudflared tunnel login` to have been run for the account that
# holds the zone (that writes ~/.cloudflared/cert.pem).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

domain="${1:?usage: tunnel-named.sh <domain>}"
name="${TUNNEL_NAME:-wacli-me}"
port="${PORT:-8787}"
cfdir="$HOME/.cloudflared"

# This project has its own origin certificate, so the other Cloudflare account
# on this host keeps working. Never point it at the shared cert.pem.
export TUNNEL_ORIGIN_CERT="${TUNNEL_ORIGIN_CERT:-$cfdir/wacli-me-cert.pem}"
[ -f "$TUNNEL_ORIGIN_CERT" ] || {
  echo "missing $TUNNEL_ORIGIN_CERT — run: ./scripts/cf-login.sh" >&2
  exit 1
}

# Create the tunnel unless it already exists, then find its UUID.
cloudflared tunnel list | grep -q " $name " || cloudflared tunnel create "$name"
uuid="$(cloudflared tunnel list --output json | python3 -c "
import json,sys
print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$name'))")"

cat > "$cfdir/$name.yml" <<YML
tunnel: $uuid
credentials-file: $cfdir/$uuid.json

ingress:
  - hostname: $domain
    service: http://127.0.0.1:$port
  - hostname: www.$domain
    service: http://127.0.0.1:$port
  - service: http_status:404
YML

# Point the hostnames at the tunnel (idempotent; updates an existing record).
cloudflared tunnel route dns --overwrite-dns "$name" "$domain"
cloudflared tunnel route dns --overwrite-dns "$name" "www.$domain"

echo "tunnel $name ($uuid) configured for $domain -> 127.0.0.1:$port"
echo "start it with: ./scripts/tunnel-named-install.sh   (keeps it running via launchd)"
