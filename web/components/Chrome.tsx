"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND } from "@/lib/brand";
import { useNet } from "@/lib/net";
import { int, ms } from "@/lib/format";
import { Mark } from "./icons";
import { Ind } from "./ui";

const NAV = [
  { href: "/net", label: "Net" },
  { href: "/send", label: "Send" },
  { href: "/faucet", label: "Faucet" },
  { href: "/lab", label: "Fault Lab" },
  { href: "/docs", label: "Docs" },
];

export function Header() {
  const path = usePathname();
  const net = useNet();
  const s = net.stats;
  const live = net.connected && s?.live;
  return (
    <header className="header">
      <div className="wrap header-in">
        <Link href="/" className="logo" aria-label={`${BRAND.name} home`}>
          <Mark size={20} />
          {BRAND.name}
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href || path.startsWith(n.href + "/") ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="header-right">
          <Link href="/net" className="chip chip-hide" title="Slot of the merged log, and the median time between blocks">
            {live ? <Ind kind="live" /> : net.everConnected ? <Ind kind="off" /> : <Ind kind="spin" />}
            <span className="mono">{s ? int(s.slot) : "—"}</span>
            <span className="muted mono">{s?.gapMs.p50 != null ? `${ms(s.gapMs.p50, 1)} ms` : ""}</span>
          </Link>
          <Link href="/faucet" className="btn btn-primary">
            Get test SOL
          </Link>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <div style={{ maxWidth: 440 }}>
          <div className="logo" style={{ color: "var(--text)", fontSize: 15, marginBottom: 8 }}>
            <Mark size={16} />
            {BRAND.net}
          </div>
          A test network. Test SOL has no value. The validators run on one server with the distances between cities simulated on the wire.
        </div>
        <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 8 }}>
            <span className="muted">Use it</span>
            <Link href="/send">Send a transaction</Link>
            <Link href="/faucet">Faucet</Link>
            <Link href="/docs">Connect a wallet or CLI</Link>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <span className="muted">Check it</span>
            <Link href="/net">Live net</Link>
            <Link href="/lab">Fault Lab</Link>
            <a href={BRAND.paper.url} target="_blank" rel="noreferrer">
              The Gatling paper
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

/** Shown in place of live data while the net cannot be reached. */
export function Offline() {
  const net = useNet();
  if (net.connected || !net.everConnected) return null;
  return (
    <div className="wrap" style={{ paddingTop: 16 }}>
      <div className="notice">
        <Ind kind="spin" color="var(--neg)" />
        <span>The connection to the net dropped. Reconnecting; the numbers below are from before it dropped.</span>
      </div>
    </div>
  );
}
