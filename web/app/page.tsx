import Link from "next/link";
import { Fragment } from "react";
import { BRAND, PUBLIC_RPC_LABEL } from "@/lib/brand";
import { LiveStats, LiveDiagramCard, LatestBlocks } from "@/components/Live";
import { ArrowRight, External } from "@/components/icons";
import { CopyButton } from "@/components/ui";

const STEPS = [
  {
    n: "01",
    title: "Seal",
    body: "Your wallet encrypts the transaction and splits the key into 10 pieces, one locked to each validator. Any 4 pieces open it; 3 colluding validators cannot.",
  },
  {
    n: "02",
    title: "Stagger",
    body: "24 consensus instances run side by side on the same 10 validators. Instance k proposes on the same 240 ms beat as the others, shifted by k × 10 ms, so a new block goes out every 10 ms.",
  },
  {
    n: "03",
    title: "Vote",
    body: "Each instance is a small Simplex protocol. Validators sign a notarize vote for the proposal, then a finalize vote. 7 of 10 matching votes make a certificate. A silent leader's view times out and is skipped.",
  },
  {
    n: "04",
    title: "Merge",
    body: "Finalized blocks from all instances are read in (view, instance) order, the Gatling rule. Every node gets the same single log without another round of voting.",
  },
  {
    n: "05",
    title: "Reveal",
    body: "Only once a block is final does each validator release its piece of the key for the sealed transactions in it. The order was fixed before anyone could see what was being ordered.",
  },
  {
    n: "06",
    title: "Execute",
    body: "The merged log runs on the Solana runtime (LiteSVM). Transactions and programs are unchanged. A transaction two leaders both picked up runs once.",
  },
];

const REAL = [
  ["Consensus", "Real. Every validator is its own actor with its own key; votes are Ed25519-signed and checked."],
  ["Merge rule", "Real. The (view, instance) cursor from the paper's reference prototype."],
  ["Solana runtime", "Real. LiteSVM runs your transactions, fees and programs."],
  ["Sealing", "Real. AES-256-GCM and X25519, with the key split 4-of-10 (Shamir). Up to 3 colluding validators cannot open a transaction early. Fees cannot be checked before it opens, so sealed sends are rate limited."],
  ["Numbers", "Measured on this net, live. Targets are labelled as targets."],
  ["Geography", "Simulated. All validators run on one server; messages between Frankfurt, London, New York, Tokyo and Singapore are delayed by real-world one-way times."],
  ["Execution", "One executor follows the merged log and publishes a log hash per block."],
  ["State", "Starts fresh on every restart. Test SOL has no value."],
];

export default function Home() {
  return (
    <>
      <section className="wrap" style={{ paddingTop: 72 }}>
        <div className="fade-up" style={{ maxWidth: 760 }}>
          <div className="eyebrow">Gatling consensus · live test net</div>
          <h1 style={{ fontSize: "clamp(40px, 6.4vw, 68px)", lineHeight: 1.04, letterSpacing: "-0.03em", fontWeight: 500, margin: "16px 0 20px" }}>
            Solana, a block
            <br />
            every <span className="accent">10 ms</span>
          </h1>
          <p className="lead">
            {BRAND.name} runs 24 consensus rounds side by side and merges them into one log, so a block lands every 10 ms. Transactions can go in sealed: no leader can read them until their place in the order is final. Your Solana programs run unchanged.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 32, flexWrap: "wrap" }}>
            <Link href="/net" className="btn btn-primary btn-lg">
              Open the net
            </Link>
            <Link href="/send" className="btn btn-lg">
              Send a transaction
            </Link>
          </div>
        </div>
      </section>

      <section className="wrap" style={{ paddingTop: 48 }}>
        <LiveDiagramCard />
      </section>

      <section className="wrap" style={{ paddingTop: 16 }}>
        <LiveStats />
      </section>

      <section className="wrap section">
        <div className="eyebrow">How a salvo works</div>
        <h2 className="h2">Order first, reveal after</h2>
        <p className="lead">Solana mainnet has one leader at a time and a slot every 400 ms, and that leader sees every transaction it orders. Salvo runs many leaders at once so blocks come every 10 ms, and seals transactions so the leaders ordering them cannot read them.</p>
        <div className="grid-3" style={{ marginTop: 32 }}>
          {STEPS.map((s) => (
            <div key={s.n} className="card card-pad">
              <div className="mono accent" style={{ fontSize: 13 }}>
                {s.n}
              </div>
              <div style={{ fontSize: 18, fontWeight: 500, margin: "8px 0 8px" }}>{s.title}</div>
              <div className="text-2" style={{ fontSize: 14 }}>
                {s.body}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="wrap section-tight">
        <LatestBlocks />
      </section>

      <section className="wrap section">
        <div className="grid-2">
          <div className="card card-pad">
            <div className="eyebrow">Builders</div>
            <div style={{ fontSize: 20, fontWeight: 500, margin: "8px 0" }}>Point any Solana client at it</div>
            <p className="text-2" style={{ fontSize: 14, margin: "0 0 16px" }}>
              The gateway speaks the Solana JSON-RPC methods wallets and @solana/web3.js use: balances, accounts, blockhashes, send, simulate, signature status, airdrops.
            </p>
            <div className="code">
              <span>solana config set --url {PUBLIC_RPC_LABEL}</span>
              <CopyButton text={`solana config set --url ${PUBLIC_RPC_LABEL}`} />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <Link href="/docs" className="btn">
                Read the docs
                <ArrowRight size={16} />
              </Link>
              <Link href="/send" className="btn btn-ghost">
                Try it in the browser
              </Link>
            </div>
          </div>
          <div className="card card-pad">
            <div className="eyebrow">Skeptics</div>
            <div style={{ fontSize: 20, fontWeight: 500, margin: "8px 0" }}>Break it in the Fault Lab</div>
            <p className="text-2" style={{ fontSize: 14, margin: "0 0 16px" }}>
              Crash three validators, slow one down, drop 5% of messages or cut Asia off. Each run starts a separate net, switches the fault on for 6 seconds, and reports what the log did.
            </p>
            <div className="code">
              <span>three validators down → views skipped, log keeps growing</span>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <Link href="/lab" className="btn">
                Open the Fault Lab
                <ArrowRight size={16} />
              </Link>
              <a href={BRAND.paper.url} target="_blank" rel="noreferrer" className="btn btn-ghost">
                The paper
                <External size={14} />
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap section-tight">
        <div className="card">
          <div className="card-head">
            <span className="card-title">What is real here, and what is not</span>
            <span className="muted" style={{ fontSize: 13 }}>
              Said plainly, so you do not have to dig
            </span>
          </div>
          <div className="kv">
            {REAL.map(([k, v]) => (
              <Fragment key={k}>
                <div>{k}</div>
                <div className="text-2">{v}</div>
              </Fragment>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
