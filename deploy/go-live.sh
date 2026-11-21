#!/usr/bin/env bash
# Puts Salvo online from this PC: starts the node, opens two free Cloudflare quick tunnels
# (RPC and pubsub), and redeploys the site on Vercel pointed at them. Keep this window open;
# closing it or turning the PC off takes the net offline. Run from Git Bash:
#
#   bash deploy/go-live.sh
#
# Then it keeps watch. Quick tunnels are temporary: Cloudflare can drop one at any time
# ("Tunnel not found"), and the site is left stuck on "Connecting". Every 20 s this checks the
# node and both tunnels from the outside; after three failed checks in a row it opens a new
# tunnel and redeploys the site with the new address. A node that stops is started again.
#
# Settings, all optional:
#   SALVO_BIN     path to salvo.exe (default: bin/salvo.exe)
#   CLOUDFLARED   path to cloudflared.exe (default: bin/cloudflared.exe)
#   VERCEL        command for the Vercel CLI (default: npx vercel)
#   STATE_DIR     where the seed and logs live (default: ~/.salvo)
#   CHECK_EVERY   seconds between checks (default: 20)
set -euo pipefail
cd "$(dirname "$0")/.."

# Defaults look in bin/ (not committed) first, then PATH.
SALVO_BIN="${SALVO_BIN:-$( [ -x bin/salvo.exe ] && echo bin/salvo.exe || echo ./node/target/release/salvo.exe )}"
CLOUDFLARED="${CLOUDFLARED:-$( [ -x bin/cloudflared.exe ] && echo "$PWD/bin/cloudflared.exe" || echo cloudflared )}"
VC_CACHED="$HOME/AppData/Local/npm-cache/_npx/67eb4586ca667318/node_modules/vercel/dist/vc.js"
VERCEL="${VERCEL:-$( [ -f "$VC_CACHED" ] && echo "node $VC_CACHED" || echo "npx vercel" )}"
STATE_DIR="${STATE_DIR:-$HOME/.salvo}"
CHECK_EVERY="${CHECK_EVERY:-20}"
mkdir -p "$STATE_DIR"

say() { echo "[$(date +%H:%M:%S)] $*"; }

# The faucet and validator keys come from this seed; it never leaves this PC.
[ -f "$STATE_DIR/seed" ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$STATE_DIR/seed"

node_up() { curl -s -m 5 -o /dev/null localhost:8899/health; }

start_node() {
  "$SALVO_BIN" up --bind 127.0.0.1 --trust-proxy --n 7 --traffic 10 --lab-k 8 --seed "$(cat "$STATE_DIR/seed")" >> "$STATE_DIR/node.log" 2>&1 < /dev/null &
  for _ in $(seq 1 30); do node_up && return 0; sleep 1; done
  return 1
}

# Starts a quick tunnel and sets TUNNEL_URL and TUNNEL_PID; returns 1 unless the tunnel is up
# and answering from the internet. It is called directly, not inside $(...): in Git Bash a
# background process started inside command substitution keeps it from returning.
tunnel() {
  local port=$1 log="$STATE_DIR/tunnel-$1.log" url=""
  rm -f "$log"
  "$CLOUDFLARED" tunnel --no-autoupdate --url "http://localhost:$port" > "$log" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  TUNNEL_URL=""
  for _ in $(seq 1 60); do
    # Only the address Cloudflare hands out, never one quoted in an error: when its service
    # is slow, the log says 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/..."'.
    url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" 2>/dev/null | grep -v '^https://api\.' | head -1 || true)
    [ -n "$url" ] && break
    if ! alive "$TUNNEL_PID"; then
      say "The tunnel for port $port could not start: $(grep -m1 -i 'failed\|error' "$log" 2>/dev/null | cut -c1-160)" >&2
      return 1
    fi
    sleep 1
  done
  if [ -z "$url" ]; then
    say "No tunnel address for port $port; see $log" >&2
    kill "$TUNNEL_PID" 2>/dev/null || true
    return 1
  fi
  # A new name can take a few seconds to resolve. Deploy only once it answers from outside
  # (anything but "unreachable" 000 or Cloudflare's "tunnel not connected" 530).
  local c=000
  for _ in $(seq 1 40); do
    c=$(status "$url/")
    [[ $c != 000 && $c != 530 ]] && { TUNNEL_URL=$url; return 0; }
    alive "$TUNNEL_PID" || break
    sleep 3
  done
  say "The tunnel for port $port never answered ($c); see $log" >&2
  kill "$TUNNEL_PID" 2>/dev/null || true
  return 1
}

deploy() {
  ( cd web && $VERCEL deploy --prod --yes \
      --build-env NEXT_PUBLIC_RPC_URL="$RPC" \
      --build-env NEXT_PUBLIC_RPC_LABEL="$RPC" \
      --build-env NEXT_PUBLIC_EVENTS_URL="${RPC/https/wss}/events" \
      --build-env NEXT_PUBLIC_PUBSUB_URL="${PUB/https/wss}" )
}

# HTTP status of a URL, or 000 when it cannot be reached (a dropped tunnel's name stops resolving).
# Names are looked up through Cloudflare's DNS (1.1.1.1) first: a brand-new tunnel name is not
# published for a moment, and Windows then remembers "no such name" for minutes, which made a
# healthy new tunnel look dead. The system resolver is the fallback if 1.1.1.1 is unreachable.
status() {
  local c
  c=$(curl -s -m 15 -o /dev/null -w '%{http_code}' --doh-url https://1.1.1.1/dns-query "$1" 2>/dev/null || true)
  [ "$c" = 000 ] && c=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true)
  echo "${c:-000}"
}
alive() { kill -0 "$1" 2>/dev/null; }
rpc_ok() { alive "$RPC_PID" && [ "$(status "$RPC/health")" = 200 ]; }
# The pubsub port answers a plain GET with 400 (it wants a WebSocket); any 4xx but 404 is ours.
pub_ok() {
  alive "$PUB_PID" || return 1
  local c
  c=$(status "$PUB/")
  [[ $c == 4?? && $c != 404 ]]
}

if ! node_up; then
  say "Starting the node"
  start_node || { say "The node did not start; see $STATE_DIR/node.log" >&2; exit 1; }
fi

say "Opening tunnels"
# Cloudflare's free tunnel service is sometimes slow or down for a while; keep trying rather
# than give up and leave the site offline.
until tunnel 8899; do say "Trying the RPC tunnel again in 15 s"; sleep 15; done
RPC=$TUNNEL_URL RPC_PID=$TUNNEL_PID
until tunnel 8900; do say "Trying the pubsub tunnel again in 15 s"; sleep 15; done
PUB=$TUNNEL_URL PUB_PID=$TUNNEL_PID
say "RPC:    $RPC"
say "Pubsub: ${PUB/https/wss}"

say "Deploying the site"
need_deploy=0
deploy || { need_deploy=1; say "The deploy failed; will try again" >&2; }

echo
say "Live. Keep this window open to stay online. Checking every ${CHECK_EVERY}s."

# From here on nothing may stop the watch: a stray failed command must not end the script
# (with set -e it did, and the site stayed down until someone noticed).
set +e
rpc_fails=0
pub_fails=0
while true; do
  sleep "$CHECK_EVERY"

  if ! node_up; then
    say "The node stopped; starting it again"
    start_node || say "The node did not start; will try again" >&2
  fi

  if rpc_ok; then rpc_fails=0; else rpc_fails=$((rpc_fails + 1)); fi
  if pub_ok; then pub_fails=0; else pub_fails=$((pub_fails + 1)); fi

  # Three misses in a row, so a short blip in the home connection does not cost a redeploy.
  if [ "$rpc_fails" -ge 3 ]; then
    say "The RPC tunnel is down; opening a new one"
    kill "$RPC_PID" 2>/dev/null || true
    if tunnel 8899; then
      RPC=$TUNNEL_URL RPC_PID=$TUNNEL_PID rpc_fails=0 need_deploy=1
      say "RPC:    $RPC"
    fi
  fi
  if [ "$pub_fails" -ge 3 ]; then
    say "The pubsub tunnel is down; opening a new one"
    kill "$PUB_PID" 2>/dev/null || true
    if tunnel 8900; then
      PUB=$TUNNEL_URL PUB_PID=$TUNNEL_PID pub_fails=0 need_deploy=1
      say "Pubsub: ${PUB/https/wss}"
    fi
  fi

  if [ "$need_deploy" = 1 ]; then
    say "Redeploying the site with the new address"
    if deploy; then
      need_deploy=0
      say "Live again."
    else
      say "The deploy failed; will try again" >&2
    fi
  fi
done
