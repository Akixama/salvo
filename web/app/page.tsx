import Link from "next/link";
import { BRAND, PUBLIC_RPC_LABEL } from "@/lib/brand";
import { LiveBadge, LiveDiagramCard } from "@/components/Live";
import { ActivityStrip } from "@/components/Activity";
import { HeroNumbers, HowItWorks, RealTable } from "@/components/HomeSections";
import { SalvoBeams } from "@/components/SalvoBeams";
import { ArrowRight, External } from "@/components/icons";
import { CopyButton } from "@/components/ui";

export default function Home() {
  return (
    <>
      <section className="hero-xl">
        <SalvoBeams />
        <div className="wrap hero-xl-in">
          <LiveBadge />
          <h1 className="display">
            Solana, a block
            <br />
            every <span className="accent">10 ms.</span>
          </h1>
          <p className="hero-sub">Many leaders at once, merged into one log. Seal a trade and no leader can read it until its place in the order is final.</p>
          <div className="hero-actions">
            <Link href="/send" className="btn btn-accent btn-xl">
              Send a sealed transaction
            </Link>
            <Link href="/net" className="btn btn-xl btn-quiet">
              Watch the net
            </Link>
          </div>
          <HeroNumbers />
        </div>
      </section>

      <section className="wrap band">
        <div className="band-head">
          <div>
            <div className="eyebrow">The net, live</div>
            <h2 className="h2xl">Watch it run.</h2>
          </div>
          <Link href="/net" className="link-arrow">
            Open the explorer <ArrowRight size={16} />
          </Link>
        </div>
        <ActivityStrip count={3} />
        <div style={{ height: 16 }} />
        <LiveDiagramCard />
      </section>

      <section className="wrap band">
        <div className="eyebrow">How a salvo works</div>
        <h2 className="h2xl">
          Lock it, line it up,
          <br />
          then unlock it.
        </h2>
        <p className="lead" style={{ marginTop: 16 }}>
          On Solana, one block maker works at a time, making a block every 400 ms, and it can see every trade it puts in. {BRAND.name} runs many block makers at once, so a block comes every 10 ms, and it locks your trade so none of them can see it.
        </p>
        <HowItWorks />
      </section>

      <section className="wrap band">
        <div className="open-grid">
          <div>
            <div className="eyebrow">Builders</div>
            <h3 className="h3xl">Point any Solana client at it.</h3>
            <p className="text-2">The gateway speaks the JSON-RPC methods wallets and @solana/web3.js use: balances, accounts, blockhashes, send, simulate, signature status, airdrops.</p>
            <div className="code" style={{ marginTop: 20 }}>
              <span>solana config set --url {PUBLIC_RPC_LABEL}</span>
              <CopyButton text={`solana config set --url ${PUBLIC_RPC_LABEL}`} />
            </div>
            <Link href="/docs" className="link-arrow" style={{ marginTop: 20 }}>
              Read the docs <ArrowRight size={16} />
            </Link>
          </div>
          <div>
            <div className="eyebrow">Skeptics</div>
            <h3 className="h3xl">Try to break it.</h3>
            <p className="text-2">Crash three validators, slow one down, drop 5% of messages or cut Asia off. Each Fault Lab run starts a separate net, switches the fault on for 6 seconds and reports what the log did.</p>
            <div style={{ display: "flex", gap: 20, marginTop: 20, flexWrap: "wrap" }}>
              <Link href="/lab" className="link-arrow">
                Open the Fault Lab <ArrowRight size={16} />
              </Link>
              <a href={BRAND.paper.url} target="_blank" rel="noreferrer" className="link-arrow">
                The Gatling paper <External size={14} />
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap band">
        <div className="eyebrow">Said plainly</div>
        <h2 className="h2xl" style={{ marginBottom: 32 }}>
          What is real, and what is not.
        </h2>
        <RealTable />
      </section>
    </>
  );
}
