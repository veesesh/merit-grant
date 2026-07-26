#!/usr/bin/env bash
# Read the current Cloudflare Quick Tunnel URL off the server and push it to
# Vercel as BACKEND_URL, then redeploy so the change takes effect.
#
# Quick Tunnel hostnames rotate whenever the tunnel restarts (including on
# reboot), so run this any time the frontend starts returning "Backend
# unreachable".
#
#   ./scripts/sync-tunnel.sh
set -euo pipefail

SSH_HOST="${SSH_HOST:-devfolio-brain}"

echo "Reading current tunnel URL from ${SSH_HOST}..."
URL=$(ssh "$SSH_HOST" 'sudo journalctl -u cf-quick --no-pager | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1')

if [ -z "$URL" ]; then
  echo "Could not find a tunnel URL. Is cf-quick running?" >&2
  echo "  ssh $SSH_HOST 'systemctl status cf-quick'" >&2
  exit 1
fi
echo "  found: $URL"

echo "Checking it responds..."
if ! curl -sf -m 20 -o /dev/null "$URL/api/health"; then
  echo "Tunnel URL is not responding, refusing to publish a broken backend." >&2
  exit 1
fi
echo "  backend healthy"

echo "Updating BACKEND_URL on Vercel..."
vercel env rm BACKEND_URL production --yes >/dev/null 2>&1 || true
printf '%s' "$URL" | vercel env add BACKEND_URL production >/dev/null
echo "  set"

echo "Redeploying so the new value is picked up..."
vercel deploy --prod
echo "Done."
