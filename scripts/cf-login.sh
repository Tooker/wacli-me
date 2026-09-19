#!/usr/bin/env bash
# Log cloudflared in to the SECOND Cloudflare account without disturbing the first.
#
# Running tunnels authenticate with their own per-tunnel credentials JSON, not
# with cert.pem — cert.pem is only used to create tunnels and write DNS records.
# But `cloudflared tunnel login` refuses to run while a cert.pem exists, and
# always writes to that one path. So: move the existing one out of the way, log
# in, file the new cert under this project's name, put the old one back.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cfdir="$HOME/.cloudflared"
target="$cfdir/wacli-me-cert.pem"
stash="$cfdir/cert.pem.before-wacli"

if [ -f "$target" ] && ! cmp -s "$target" "$cfdir/cert.pem"; then
  echo "already logged in for this project: $target"
  exit 0
fi
rm -f "$target"   # a leftover copy of the other account's cert is useless here

restore() {
  [ -f "$stash" ] || return 0
  mv -f "$stash" "$cfdir/cert.pem"
  echo "other account's cert.pem restored"
}
trap restore EXIT

if [ -f "$cfdir/cert.pem" ]; then
  mv "$cfdir/cert.pem" "$stash"
  echo "other account's cert.pem moved aside for the duration of this login"
fi

echo
echo "Open the URL below in a browser logged into the NEW Cloudflare account,"
echo "then pick the wacli.me zone."
echo
cloudflared tunnel login

if [ -f "$cfdir/cert.pem" ]; then
  mv "$cfdir/cert.pem" "$target"
  echo "project cert stored at $target"
else
  echo "login produced no certificate — nothing stored" >&2
fi
