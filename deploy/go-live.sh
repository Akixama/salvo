#!/usr/bin/env bash
# Puts Salvo online from this PC: starts the node, opens two free Cloudflare quick tunnels
# (RPC and pubsub), and redeploys the site on Vercel pointed at them. Keep this window open;
# closing it or turning the PC off takes the net offline. Run from Git Bash:
#
#   bash deploy/go-live.sh
#
# Settings, all optional:
#   SALVO_BIN     path to salvo.exe (default: bin/salvo.exe)
#   CLOUDFLARED   path to cloudflared.exe (default: bin/cloudflared.exe)
#   VERCEL        command for the Vercel CLI (default: npx vercel)
#   STATE_DIR     where the seed and logs live (default: ~/.salvo)
set -euo pipefail
cd "$(dirname "$0")/.."

# Defaults look in bin/ (not committed) first, then PATH.
SALVO_BIN="${SALVO_BIN:-$( [ -x bin/salvo.exe ] && echo bin/salvo.exe || echo ./node/target/release/salvo.exe )}"
CLOUDFLARED="${CLOUDFLARED:-$( [ -x bin/cloudflared.exe ] && echo "$PWD/bin/cloudflared.exe" || echo cloudflared )}"
VC_CACHED="$HOME/AppData/Local/npm-cache/_npx/67eb4586ca667318/node_modules/vercel/dist/vc.js"
VERCEL="${VERCEL:-$( [ -f "$VC_CACHED" ] && echo "node $VC_CACHED" || echo "npx vercel" )}"
STATE_DIR="${STATE_DIR:-$HOME/.salvo}"
mkdir -p "$STATE_DIR"

# The faucet and validator keys come from this seed; it never leaves this PC.
[ -f "$STATE_DIR/seed" ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$STATE_DIR/seed"

if ! curl -s -o /dev/null localhost:8899/health; then
  echo "Starting the node"
  "$SALVO_BIN" up --bind 127.0.0.1 --trust-proxy --n 7 --traffic 10 --lab-k 8 --seed "$(cat "$STATE_DIR/seed")" > "$STATE_DIR/node.log" 2>&1 &
  for _ in $(seq 1 30); do curl -s -o /dev/null localhost:8899/health && break; sleep 1; done
fi

tunnel() {
  local port=$1 log="$STATE_DIR/tunnel-$1.log"
  : > "$log"
  "$CLOUDFLARED" tunnel --no-autoupdate --url "http://localhost:$port" > "$log" 2>&1 &
  for _ in $(seq 1 60); do
    url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" | head -1 || true)
    [ -n "$url" ] && { echo "$url"; return; }
    sleep 1
  done
  echo "No tunnel address for port $port; see $log" >&2
  exit 1
}

echo "Opening tunnels"
RPC=$(tunnel 8899)
PUB=$(tunnel 8900)
echo "RPC:    $RPC"
echo "Pubsub: ${PUB/https/wss}"

echo "Deploying the site"
cd web
$VERCEL deploy --prod --yes \
  --build-env NEXT_PUBLIC_RPC_URL="$RPC" \
  --build-env NEXT_PUBLIC_RPC_LABEL="$RPC" \
  --build-env NEXT_PUBLIC_EVENTS_URL="${RPC/https/wss}/events" \
  --build-env NEXT_PUBLIC_PUBSUB_URL="${PUB/https/wss}"

echo
echo "Live. Keep this window open to stay online."
wait
