import type { Metadata } from "next";
import Link from "next/link";
import { BRAND, PUBLIC_RPC_LABEL, PUBSUB_URL } from "@/lib/brand";
import { CopyButton } from "@/components/ui";
import { Fact } from "@/components/Facts";
import { PageHero, Panel } from "@/components/PageHero";
import { External } from "@/components/icons";

export const metadata: Metadata = { title: "Docs" };

const METHODS = [
  ["getLatestBlockhash", "Blockhash of the newest merged block; valid for about 90 seconds"],
  ["sendTransaction", "Base58 or base64; simulated first unless skipPreflight is set"],
  ["simulateTransaction", "Runs against current state without changing it"],
  ["getSignatureStatuses", "processed once a leader includes it, finalized once it is merged and executed"],
  ["getTransaction", "json or base64 encoding, with fee, balances and logs"],
  ["getBalance, getAccountInfo, getMultipleAccounts", "base64 or base58 account data"],
  ["requestAirdrop", "2 SOL, same limits as the faucet"],
  ["getSlot, getBlockHeight, getEpochInfo", "The slot is the position in the merged log"],
  ["getMinimumBalanceForRentExemption, getFeeForMessage", "5,000 lamports per signature"],
  ["getHealth, getVersion, getGenesisHash, isBlockhashValid", ""],
  ["signatureSubscribe, slotSubscribe", "On the pubsub port (RPC port + 1)"],
  ["salvo_getSealKeys, salvo_sendSealed", "Sealing keys, and send a sealed envelope (base64). Also GET /v1/seal and POST /v1/sealed"],
];

const FAQ: [string, React.ReactNode][] = [
  [
    "Can a leader front-run my trade?",
    <>
      Not if you seal it. A sealed transaction is encrypted in your wallet, and its key is split so that any <Fact k="threshold" /> of the <Fact k="n" /> validators can open it and no <Fact k="colluders" /> can. Validators only release their pieces after the block carrying it is final, when its place in the order can no longer change. The leader orders a blob it cannot read. What sealing does not hide: that you sent something, its size, and when.
    </>,
  ],
  [
    "What does sealing cost?",
    "Almost nothing in time: the key pieces arrive at about the moment the block is merged, so the reveal adds a few milliseconds. The catch is that the gateway cannot check a sealed transaction's fee before it opens, so sealed sends are limited to 30 a minute per connection, and there is no preflight simulation.",
  ],
  [
    "Is this Solana?",
    "No. It runs Solana transactions and programs, through the same runtime code (via LiteSVM), but the consensus is new and the net is separate. Nothing here touches Solana mainnet.",
  ],
  [
    "Why is a block every 10 ms possible?",
    "In a single-leader chain, the next leader has to hear about the last block before building on it, so block time is bounded by network delay. Gatling runs many independent instances on staggered timers. Each instance still waits for its own previous block, but there are 24 of them, so the merged log gets a new block every 240 / 24 = 10 ms.",
  ],
  [
    "Is finality also 10 ms?",
    "No. Votes still have to cross oceans. Most blocks are final after one round of votes (the fast lane, when 80% of validators agree), so finality is around a fifth of a second; the rest take a second round. The Net page shows the measured median and p90. What gets faster is how often a block can be proposed, which is what cuts the wait to get into one.",
  ],
  [
    "How many bad validators can it handle?",
    "It stays safe while fewer than 20% of validators misbehave, and keeps going with up to 40% offline. That's the trade the one-round fast lane needs: classic two-round voting survives up to a third misbehaving, but is slower. Solana makes the same trade with Alpenglow. The Fault Lab shows crashes, cut-off regions and lost messages live.",
  ],
  [
    "What happens if a leader is down?",
    "That instance's view times out after 400 ms and is skipped. The other instances keep going. The merged log waits at that cell until the skip is certified, then moves on. Try it in the Fault Lab.",
  ],
  [
    "Can the same transaction land twice?",
    "Two leaders can both put it in a block before either hears about the other. It runs once: the second copy is dropped by signature. The block page counts dropped copies.",
  ],
  [
    "Why one server?",
    "Running validators in five cities costs real money every month. The protocol does not care where its messages come from, so the net simulates the distances between cities on the wire using real-world one-way delays. The code is the same code that would run on separate machines.",
  ],
];

export default function DocsPage() {
  const rpc = PUBLIC_RPC_LABEL;
  const ws = PUBSUB_URL;
  const snippet = `import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const connection = new Connection("${rpc}", { commitment: "finalized", wsEndpoint: "${ws}" });
const me = Keypair.generate();
const sig = await connection.requestAirdrop(me.publicKey, 2 * LAMPORTS_PER_SOL);
await connection.confirmTransaction(sig, "finalized");
console.log(await connection.getBalance(me.publicKey));`;
  return (
    <>
      <PageHero
        eyebrow="Docs"
        title={
          <>
            Point any
            <br />
            client at it.
          </>
        }
        sub="Connect a wallet, the Solana CLI or @solana/web3.js, and what to expect from the net."
        live={false}
        aside={
          <div style={{ display: "grid", gap: 10 }}>
            <div className="hn-l" style={{ marginTop: 0 }}>
              JSON-RPC
            </div>
            <div className="code">
              <span>{rpc}</span>
              <CopyButton text={rpc} />
            </div>
            <div className="hn-l" style={{ marginTop: 8 }}>
              Pubsub
            </div>
            <div className="code">
              <span>{ws}</span>
              <CopyButton text={ws} />
            </div>
          </div>
        }
      />
      <div className="wrap page-body">
        <div className="open-grid">
          <Panel title="Solana CLI">
            <div style={{ display: "grid", gap: 8, paddingTop: 20 }}>
              {[`solana config set --url ${rpc}`, "solana airdrop 2", "solana transfer <ADDRESS> 0.5 --allow-unfunded-recipient"].map((c) => (
                <div key={c} className="code">
                  <span>{c}</span>
                  <CopyButton text={c} />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="@solana/web3.js" action={<CopyButton text={snippet} />}>
            <pre className="code mono" style={{ display: "block", marginTop: 20, fontSize: 13, lineHeight: "21px", whiteSpace: "pre", color: "var(--text-2)" }}>
              {snippet}
            </pre>
          </Panel>
        </div>

        <Panel title="Supported methods" action={<span className="muted" style={{ fontSize: 13 }}>A subset of Solana&apos;s JSON-RPC</span>}>
          <div className="table-wrap">
            <table className="t">
              <tbody>
                {METHODS.map(([m, d]) => (
                  <tr key={m}>
                    <td className="mono">{m}</td>
                    <td className="text-2" style={{ whiteSpace: "normal" }}>
                      {d}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Parameters">
          <div className="kv">
            <div>Validators</div>
            <div>
              <Fact k="n" /> spread across Frankfurt, London, New York, Tokyo and Singapore (simulated). <Fact k="fastQuorum" /> notarize votes finalize a block in one round (the fast lane); otherwise <Fact k="quorum" /> notarize votes and then <Fact k="quorum" /> finalize votes do it in two. No single region holds that many, so every certificate crosses an ocean.
            </div>
            <div>Instances</div>
            <div>
              <Fact k="k" /> consensus instances, each voting by Alpenglow's rules. Instance k proposes at genesis + v × <Fact k="delta" /> ms + k × <Fact k="gap" /> ms.
            </div>
            <div>Timeout</div>
            <div>
              <Fact k="timeout" /> ms after a view&apos;s proposal time, validators vote to skip it.
            </div>
            <div>Merge</div>
            <div>Finalized blocks are read in (view, instance) order; skipped views are gaps.</div>
            <div>Sealing</div>
            <div>
              AES-256-GCM for the transaction, X25519 to lock each key piece to one validator, Shamir sharing with <Fact k="threshold" /> of <Fact k="n" /> needed. Pieces are released only after the block is finalized. Format and code: node/src/seal.rs and web/lib/seal.ts.
            </div>
            <div>Execution</div>
            <div>LiteSVM, signature checks on, fees 5,000 lamports per signature, blockhashes valid for about 90 seconds.</div>
            <div>Gateway</div>
            <div>An observer node in Frankfurt that sees every vote, merges, executes and serves the RPC.</div>
          </div>
        </Panel>

        <Panel title="Questions">
          <div>
            {FAQ.map(([q, a], i) => (
              <details key={q} className="faq" style={{ borderBottom: i < FAQ.length - 1 ? "1px solid var(--line)" : "none" }}>
                <summary>{q}</summary>
                <div className="text-2" style={{ padding: "0 0 20px", fontSize: 15, lineHeight: 1.6, maxWidth: 760 }}>
                  {a}
                </div>
              </details>
            ))}
          </div>
        </Panel>

        <Panel title="The paper">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", paddingTop: 20 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{BRAND.paper.title}</div>
              <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                {BRAND.paper.authors}. {BRAND.name} is an independent implementation; the merge rule follows their MIT-licensed prototype.
              </div>
            </div>
            <div style={{ display: "flex", gap: 20 }}>
              <a className="link-arrow" href={BRAND.paper.url} target="_blank" rel="noreferrer">
                Paper <External size={14} />
              </a>
              <a className="link-arrow" href={BRAND.paper.code} target="_blank" rel="noreferrer">
                Prototype <External size={14} />
              </a>
            </div>
          </div>
        </Panel>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Something missing? The <Link href="/net" className="accent">Net page</Link> shows every number live.
        </p>
      </div>
    </>
  );
}
