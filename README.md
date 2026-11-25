# Salvo

Salvo is a Solana-compatible chain built from Anza and a16z's Gatling research. It makes blocks
40 times as often: Solana makes one every 400 ms, and Salvo makes one every 10 ms.

Trades can be sent sealed. They stay hidden until their spot in line is locked in, so bots can't
see them and jump ahead.

**Live test net:** [salvo-net.vercel.app](https://salvo-net.vercel.app). Test SOL only, no value.

## What it does

- **A block every 10 ms.** 24 consensus instances run side by side on the same validators, each on
  its own staggered timer, and their blocks merge into one log in a fixed order. There is always a
  block about to land.
- **Sealed transactions.** The wallet encrypts the transaction and splits the key between the
  validators. Leaders order a blob they can't read. Validators only release their key pieces once
  the block is final, so the order is fixed before anyone sees what was ordered.
- **Solana programs run unchanged.** Execution is the Solana runtime (LiteSVM), and the gateway
  speaks the Solana JSON-RPC that wallets, `@solana/web3.js` and the Solana CLI use.

## Measured on the live net

7 validators across Frankfurt, London, New York, Tokyo and Singapore, 24 instances, a view every
240 ms per instance:

| | Median |
|---|---|
| Time between blocks | 10.0 ms |
| Block, proposed to final | about 260 ms |
| Transaction, sent to executed | about 285 ms |
| Extra delay for a sealed transaction | a few ms |
| CPU | about a third of one core |

The site shows these live, along with p90 and p99.

## How it works

1. **Seal.** The wallet encrypts the transaction (AES-256-GCM) and splits the key with Shamir
   sharing, one piece locked to each validator (X25519). Any f + 1 pieces open it: 3 of 7 on the
   live net, 4 of 10 by default. So up to f colluding validators can't open it early.
2. **Stagger.** Instance k proposes at `genesis + v·Δ + k·Δ/K`, so with K = 24 and Δ = 240 ms a
   proposal goes out every 10 ms.
3. **Vote.** Each instance votes by Alpenglow's rules (Votor, Solana's next consensus), with
   Ed25519-signed votes. 80% notarize votes finalize a block in one round (the fast lane: 6 of 7);
   otherwise 60% notarize and then 60% finalize votes do it in two (5 of 7). A silent leader's view
   times out and is skipped; fallback votes keep a split view from getting stuck. Safe while fewer
   than 20% misbehave, live with up to 40% offline. On the live net about 98% of blocks take the
   fast lane: ~210 ms to final, down from ~280 ms with two-round Simplex.
4. **Merge.** Finalized blocks are read in (view, instance) order, following the Gatling paper's
   reference prototype. Skipped views are gaps.
5. **Reveal.** When a block is final, each validator publishes its key piece for the sealed
   transactions in it. The gateway rebuilds the key and opens the transaction.
6. **Execute.** The merged log runs on LiteSVM. A transaction that two leaders both included runs
   once.

## What is real and what is simulated

- **Real:**
  - Every validator is its own actor with its own keys.
  - Votes are signed and checked, and certificates need two-thirds.
  - The merge is the paper's rule.
  - Sealing is real encryption.
  - Execution is the Solana runtime.
  - Every number on the site is measured live.
- **Simulated:**
  - All validators run in one process on one machine, and the distances between cities are
    real-world one-way delays added on the wire.
  - One executor follows the merged log.
  - Each restart is a fresh genesis.

## In this repo

| Folder | What |
|---|---|
| `node/` | `salvo` (Rust): validators, Gatling merge, sealing, LiteSVM execution, the gateway (Solana JSON-RPC subset, REST, event stream, pubsub) and the Fault Lab |
| `web/` | The site (Next.js 15): home, Net explorer with block and transaction pages, Send (browser wallet, sealed sends), Mine, Faucet, Fault Lab, Docs |
| `deploy/` | Ways to put it online: `go-live.sh` (this PC), `server-setup.sh` (a small Linux server), Docker compose with Caddy |
| `.github/workflows/` | Builds the Linux node on every push to `node/` and publishes it to the `node-latest` release |

## Run it locally

```bash
cd node && cargo run --release -- up        # RPC on 127.0.0.1:8899, pubsub on 8900
cd web && npm install && npm run dev        # site on http://localhost:3010
```

`salvo up --help` lists the knobs:
- `--n` validators, `--k` instances, `--delta-ms` view time and `--timeout-ms` timeout
- `--traffic` background transfers a second, about a third of them sealed
- `--seed`, and the Fault Lab size with `--lab-n` and `--lab-k`

On Windows, if the linker fails with a long-path error, build into a short folder with
`CARGO_TARGET_DIR=C:/tmp/salvo-target cargo build --release`.

## Put it online

**From this PC (free, works today).** This starts the node, opens two free Cloudflare quick
tunnels and redeploys the site on Vercel pointed at them. Keep the window open; the net is offline
whenever the PC is off. The tunnel addresses change on every restart, which is why the script
redeploys.

```bash
bash deploy/go-live.sh
```

**On a small Linux server (free tiers like Oracle Always Free).** This installs the node from the
`node-latest` release as a systemd service behind Caddy, with free HTTPS on `<ip>.sslip.io` names,
so no domain is needed. Then deploy `web/` to Vercel with these variables:
- `NEXT_PUBLIC_RPC_URL=https://rpc.<domain>`
- `NEXT_PUBLIC_EVENTS_URL=wss://rpc.<domain>/events`
- `NEXT_PUBLIC_PUBSUB_URL=wss://ws.<domain>`

```bash
gh release download node-latest --repo Akixama/salvo --pattern 'salvo-linux-x86_64.gz' && gunzip salvo-linux-x86_64.gz
bash deploy/server-setup.sh ./salvo-linux-x86_64
```

**With Docker:** `cd deploy && SALVO_DOMAIN=<domain> docker compose up -d --build`.

## API

- **JSON-RPC** on the RPC port:
  - Reading state: `getLatestBlockhash`, `getBalance`, `getAccountInfo`, `getMultipleAccounts`, `getSlot`, `getBlockHeight`, `getEpochInfo`, `getMinimumBalanceForRentExemption`, `getFeeForMessage`, `isBlockhashValid`
  - Sending and tracking: `sendTransaction`, `simulateTransaction`, `getSignatureStatuses`, `getTransaction`, `requestAirdrop`
  - Node info: `getHealth`, `getVersion`, `getGenesisHash`
  - Salvo extras: `salvo_stats`, `salvo_getSealKeys`, `salvo_sendSealed`
- **Pubsub** on the RPC port + 1: `signatureSubscribe`, `slotSubscribe`.
- **REST:**
  - Net and blocks: `/v1/net`, `/v1/blocks`, `/v1/blocks/{slot}`, `/v1/latency`
  - Transactions and addresses: `/v1/tx/{signature or sealed id}`, `/v1/address/{address}`
  - Sending: `/v1/faucet`, `/v1/seal`, `/v1/sealed`
  - Fault Lab: `/v1/lab/scenarios`, `/v1/lab/runs`
- **Event stream:** WebSocket `/events` with proposals, notarizations, finalizations, skipped views, merged blocks, transaction updates and activity, batched every 100 ms.

## Tests

```bash
cd node && cargo test --release                              # merge order, sealing, key splitting
cd web && node scripts/sealed-test.mts http://127.0.0.1:8899  # browser sealing against a live node
```

## Not done yet

- A permanent server. The live net runs from a PC behind free tunnels for now.
- A token.

## Credits

Gatling: Rapid-Fire Consensus from Parallel Composition, by Giulia Scaffino, Max Resnick and
Joachim Neu ([arXiv 2606.18220](https://arxiv.org/abs/2606.18220)). The merge follows their
reference prototype ([scaffino/Gatling](https://github.com/scaffino/Gatling), MIT/Apache-2.0).
CountUp is from React Bits (MIT with Commons Clause). Salvo is an independent implementation and
is not affiliated with the paper's authors, Anza or a16z.
