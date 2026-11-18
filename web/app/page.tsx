import Link from "next/link";
import { BRAND, PUBLIC_RPC_LABEL } from "@/lib/brand";
import { LiveStats, LiveDiagramCard, LatestBlocks } from "@/components/Live";
import { ActivityStrip } from "@/components/Activity";
import { HowItWorks, LiveCounts, RealTable } from "@/components/HomeSections";
import { ArrowRight, External } from "@/components/icons";
import { CopyButton } from "@/components/ui";

export default function Home() {
  return (
    <>
      <section className="wrap" style={{ paddingTop: 48 }}>
        <div className="hero fade-up">
          <div>
            <div className="eyebrow">Gatling consensus · live test net</div>
            <h1 style={{ fontSize: "clamp(38px, 5.6vw, 64px)", lineHeight: 1.04, letterSpacing: "-0.03em", fontWeight: 500, margin: "14px 0 16px" }}>
              Solana, a block
              <br />
              every <span className="accent">10 ms</span>
            </h1>
            <p className="lead" style={{ maxWidth: 560 }}>
              Many leaders at once, merged into one log. Send it sealed and no leader can read it until its place in the order is final.
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
              <Link href="/send" className="btn btn-primary btn-lg">
                Send a sealed transaction
              </Link>
              <Link href="/net" className="btn btn-lg">
                Watch the net
              </Link>
            </div>
          </div>
          <LiveCounts />
        </div>
      </section>

      <section className="wrap" style={{ paddingTop: 28 }}>
        <ActivityStrip />
      </section>

      <section className="wrap" style={{ paddingTop: 12 }}>
        <LiveDiagramCard />
      </section>

      <section className="wrap" style={{ paddingTop: 16 }}>
        <LiveStats />
      </section>

      <section className="wrap section">
        <div className="eyebrow">How a salvo works</div>
        <h2 className="h2">Order first, reveal after</h2>
        <p className="lead">
          Solana mainnet has one leader at a time and a slot every 400 ms, and that leader sees every transaction it orders. {BRAND.name} runs many leaders at once so blocks come every 10 ms, and seals transactions so the leaders ordering them cannot read them.
        </p>
        <HowItWorks />
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
              <Link href="/mine" className="btn btn-ghost">
                Look up an address
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
          <RealTable />
        </div>
      </section>
    </>
  );
}
