#!/usr/bin/env bash
# Sets up Salvo on a small Ubuntu server (for example Azure B2ats v2 with 1 GB of memory),
# without Docker: the node runs under systemd and Caddy serves it over HTTPS on free
# <ip>.sslip.io names, so no domain is needed.
#
#   bash server-setup.sh /path/to/salvo-linux-x86_64
#
# Settings for a small server: 7 validators, 10 background transfers a second.
set -euo pipefail
BIN="${1:?path to the salvo binary}"

sudo install -m 755 "$BIN" /usr/local/bin/salvo

# A little swap so a busy moment cannot run the box out of memory.
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# The faucet and validator keys come from this seed, so it stays secret on the server.
sudo mkdir -p /etc/salvo
if [ ! -f /etc/salvo/seed ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | sudo tee /etc/salvo/seed >/dev/null
  sudo chmod 600 /etc/salvo/seed
fi

sudo tee /etc/systemd/system/salvo.service >/dev/null <<UNIT
[Unit]
Description=Salvo net
After=network-online.target

[Service]
ExecStart=/bin/sh -c 'exec /usr/local/bin/salvo up --bind 127.0.0.1 --trust-proxy --n 7 --traffic 10 --lab-k 8 --seed "\$(cat /etc/salvo/seed)"'
Restart=always
RestartSec=2
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
UNIT

if ! command -v caddy >/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

IP=$(curl -s https://api.ipify.org)
DOMAIN="${SALVO_DOMAIN:-${IP//./-}.sslip.io}"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
rpc.$DOMAIN {
	reverse_proxy 127.0.0.1:8899
}
ws.$DOMAIN {
	reverse_proxy 127.0.0.1:8900
}
CADDY

sudo systemctl daemon-reload
sudo systemctl enable --now salvo
sudo systemctl restart salvo caddy
sleep 3
systemctl --no-pager --lines 0 status salvo caddy | grep -E "Active|Loaded" || true
echo
echo "RPC:    https://rpc.$DOMAIN"
echo "Pubsub: wss://ws.$DOMAIN"
echo "Events: wss://rpc.$DOMAIN/events"
