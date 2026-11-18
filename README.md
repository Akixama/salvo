# Salvo

A Solana-compatible test chain built on Gatling (Scaffino, Resnick, Neu, arXiv 2606.18220):
24 consensus instances run side by side on staggered timers and merge into one log, so a block
lands every ~10 ms. Transactions can be sealed: encrypted in the wallet with the key split 4-of-10
across validators, and opened only after their block is final, so no leader can read what it orders.
Solana transactions and programs run unchanged on LiteSVM.

| Folder | What |
|---|---|
| `node/` | `salvo` (Rust): the validators, the Gatling merge, LiteSVM execution, the gateway (Solana JSON-RPC subset, REST, event stream, pubsub) and the Fault Lab |
| `web/` | The site (Next.js): home, Net explorer, Send, Faucet, Fault Lab, Docs |
| `deploy/` | Dockerfile, compose and Caddy for one Linux server |

## Run locally

```bash
cd node && cargo run --release -- up          # RPC on 127.0.0.1:8899, pubsub on 8900
cd web && npm install && npm run dev          # site on http://localhost:3010
```

`salvo up --help` lists the knobs: validators (`--n`), instances (`--k`), view time (`--delta-ms`),
timeout, background traffic and seed.

## What is real and what is simulated

- Real: every validator is its own actor with its own Ed25519 key, votes are signed and checked,
  certificates need 7 of 10, the merge is the paper's (view, instance) rule, execution is the
  Solana runtime via LiteSVM, and every number on the site is measured live.
- Simulated: all validators run in one process on one server; the distances between Frankfurt,
  London, New York, Tokyo and Singapore are delays on the wire. One executor follows the merged
  log. Each restart is a fresh genesis.

## Deploy

On a Linux server with Docker: point `rpc.<domain>` and `ws.<domain>` at it, then

```bash
cd deploy && SALVO_DOMAIN=<domain> docker compose up -d --build
```

Deploy `web/` to Vercel with `NEXT_PUBLIC_RPC_URL=https://rpc.<domain>` and
`NEXT_PUBLIC_EVENTS_URL=wss://rpc.<domain>/events`.

## Credits

The merge follows the Gatling reference prototype (github.com/scaffino/Gatling, MIT/Apache-2.0).
Salvo is an independent implementation and not affiliated with the paper's authors, Anza or a16z.
