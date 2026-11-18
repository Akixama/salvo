# Salvo: build plan

Working name. Easy to change in one place (`web/lib/brand.ts` and the node's `--name`).

## Status (2026-11-18)

Done:
- **Node:** Gatling consensus and merge, sealed transactions, LiteSVM execution, the Solana JSON-RPC subset, REST, the event stream and the Fault Lab.
- **Site:** home with the live beams hero, Net, block and transaction pages, Send, Mine, Faucet, Fault Lab and Docs, all in one design.
- **Live:** [salvo-net.vercel.app](https://salvo-net.vercel.app). The net runs on the user's PC behind Cloudflare quick tunnels (`deploy/go-live.sh`). GitHub Actions builds the Linux node.

Next:
- A permanent server, using `deploy/server-setup.sh`. Oracle Always Free needs a physical card; Azure for Students failed at sign-in.
- Feedback from users.
- A launch video.
- The token.

The sections below are the original plan; the README describes the system as built.

## What it is

A Solana-compatible test chain that runs Gatling (Scaffino, Resnick, Neu, arXiv 2606.18220).
K consensus instances run side by side on the same validators, each on a staggered timer, and
their finalized blocks merge into one log in (view, instance) order. Solana programs and
transactions run unchanged on LiteSVM.

With K = 12 instances and a 480 ms view per instance, a block lands about every 40 ms.
The site always shows the measured number next to any target.

## Honest limits (shown on the site)

- One server. The validators are separate actors with their own keys, but the distances between
  cities are simulated delays on the wire, as on Acrux.
- Every restart is a fresh genesis.
- One executor follows the merged log and publishes a state hash after every block. Validators
  agree on order; execution is deterministic.
- Votes are Ed25519-signed; certificates are lists of signatures, not threshold signatures.

## Parts

| Folder | What | Stack |
|---|---|---|
| `node/` | `salvo` binary: the net, the gateway (Solana JSON-RPC subset + event stream), the Fault Lab runner | Rust, tokio, axum, LiteSVM 0.6.1, solana-sdk 2.2.1 |
| `web/` | The site: home, Net, Send, Faucet, Fault Lab, Docs | Next.js, TypeScript, @solana/web3.js |

## Node design

- **Validators:** N = 10, two each in FRA, NYC, SGP, TYO, SAO. One tokio task each, with an inbox.
- **Wire:** a bus that delivers every message after `latency(a, b) + jitter`, using real-world
  one-way delays between the cities. Optional loss and partitions for the Fault Lab.
- **Consensus per instance:** Simplex. Leader of (k, v) is drawn from a seeded hash. It proposes at
  `t = genesis + v·Δ + k·Δ/K` (or immediately if it is late), validators vote notarize, then
  finalize; a timeout makes them vote nullify and skip the view. 2f+1 of N = 7 of 10.
- **Merge (Gatling thread):** per-instance queues by view, cursor walks (view, instance) in
  lexicographic order, gaps fill as skipped. Follows GATLING_SPEC §7 exactly.
- **Mempool:** shared across the K instances on each validator, so one validator never puts the
  same transaction in two blocks. Transactions gossip to all validators over the bus.
- **Execution:** the gateway's executor drains the merged log into LiteSVM. Duplicates (the same
  transaction picked by two leaders) are dropped by signature.
- **Gateway:** JSON-RPC on 8899-style methods so `@solana/web3.js` and the Solana CLI work:
  getHealth, getVersion, getSlot, getBlockHeight, getLatestBlockhash, getBalance, getAccountInfo,
  getMultipleAccounts, sendTransaction, simulateTransaction, getSignatureStatuses, getTransaction,
  requestAirdrop, getMinimumBalanceForRentExemption, getFeeForMessage, getEpochInfo,
  getGenesisHash, isBlockhashValid. Custom: salvo_stats, salvo_recentBlocks, salvo_block,
  salvo_validators, salvo_lab. WebSocket `/events` streams blocks, votes and stats for the site.
- **Fault Lab:** runs a fresh small net in the same process with a fault injected (leaders crash,
  a region is cut off, 5% packet loss, a slow leader) and reports what happened, with evidence.

## Site pages

1. **Home:** live timing diagram (K rows of staggered ticks and the merged line underneath),
   measured stats strip, how it works, builders and operators blocks.
2. **Net:** the live explorer. Timing diagram, recent merged blocks, per-instance state, validators
   by city, latency histogram. Block and transaction detail pages.
3. **Send:** a browser burner wallet: get test SOL, send a transfer, watch each stage with timings.
4. **Faucet:** test SOL to any address, rate limited.
5. **Fault Lab:** pick a scenario, run it, watch the result and evidence.
6. **Docs:** RPC URL, Solana CLI setup, method list, the paper, honest limits.

## Order of work

1. Node: wire + Simplex + merge, with logs showing ~40 ms merged cadence.
2. Node: LiteSVM executor + JSON-RPC + event stream. Check with web3.js.
3. Site: data layer and pages, then polish (launch-polish, unslop).
4. Fault Lab.
5. Deploy notes: one Linux server, Docker, Caddy.

## Sealed transactions ("order first, reveal after"), built 2026-11-18

Geography: 10 validators, 2 each in FRA, LON, NYC, TYO, SIN. With K=24, Δ=240 and
timeout 400 we measured: 10.0 ms between blocks, 253 ms block finality, 271 ms tx finality,
0 skipped views. `aes-gcm` and `curve25519-dalek` were added to node/Cargo.toml; the fetch may
need re-running.

Envelope format, the same in Rust (`node/src/seal.rs`) and TS (`web/lib/seal.ts`):
- `"SLV1"`, t (u8), n (u8), ephemeral X25519 pub (32), nonce (12), u32 ct_len, AES-256-GCM(K, tx).
- n share boxes of 48 bytes: AES-256-GCM(k_i, nonce_i, share_i), where k_i = sha256("salvo/share-key" ‖ X25519(eph, V_i) ‖ eph_pub ‖ V_i) and nonce_i = sha256("salvo/share-nonce" ‖ i)[..12].
- n share hashes: sha256(share_i).
- id = sha256(envelope).
- Shamir over GF(256) (poly 0x11b), x = i+1, t = f+1 = 4.

Flow:
- Validator X25519 keys come from the seed. Served at `GET /v1/seal`; submitted via `POST /v1/sealed` or `salvo_sendSealed`.
- Leaders include envelopes as opaque txs.
- When a validator finalizes a block, it decrypts its share of each envelope in it and broadcasts `Msg::Reveal { id, index, share }`.
- The observer checks each share against its hash, rebuilds K from 4 shares and decrypts.
- The chain task holds merged blocks, in order, until their envelopes are revealed. After 2 s an unrevealed envelope is dropped.
- TxRecord gets `sealedId` and `revealedAtUs`, and `/v1/tx/{sealed id}` resolves to the real signature.
- Browser: `@noble/curves` x25519 plus WebCrypto AES-GCM; the Send page gets a "Sealed" toggle (default on) and TxTrail gets a "Revealed" step.
- No preflight for sealed txs. Rate-limit sealed submits per IP, since fees are only known after the reveal.

## Later

- Token ($SALVO) with fee buybacks, only when the user decides.
- Real multi-server validators.
- Threshold signatures, Constellation-style multiple proposers per instance.

Status 2026-11-18: built and tested. Rust seal.rs has unit tests; web/scripts/sealed-test.mts checks
the browser format against a live node (`node scripts/sealed-test.mts http://127.0.0.1:8899`). About
30% of the demo traffic is sealed. Measured: reveal adds ~0 ms after merge; a sealed browser send
was final 454 ms after the click (273 ms unsealed). Block spacing is now measured over runs of 25
blocks, because leaders' proposal clocks are not always in log order.
