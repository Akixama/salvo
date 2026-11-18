"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BRAND } from "@/lib/brand";
import { useNet, useNow } from "@/lib/net";
import { describe } from "./Activity";
import { int, ms } from "@/lib/format";
import { Mark } from "./icons";
import { Ind } from "./ui";

const NAV = [
  { href: "/net", label: "Net" },
  { href: "/send", label: "Send" },
  { href: "/mine", label: "Mine" },
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
          <Bell />
          <Link href="/faucet" className="btn btn-primary">
            Get test SOL
          </Link>
        </div>
      </div>
    </header>
  );
}

/** Notable events since this tab opened (sends, faucet grants, lab runs), not the background load. */
function Bell() {
  const net = useNet();
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const items = net.activity.filter((a) => a.source !== "traffic").slice(0, 8);
  return (
    <div className="bell" ref={box}>
      <button
        className="btn btn-ghost"
        style={{ width: 36, padding: 0 }}
        aria-label={`Activity${net.unseen ? `, ${net.unseen} new` : ""}`}
        onClick={() => {
          setOpen((o) => !o);
          net.markSeen();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </button>
      {net.unseen > 0 && <span className="bell-count">{net.unseen > 99 ? "99+" : net.unseen}</span>}
      {open && (
        <div className="menu">
          <div className="muted" style={{ fontSize: 12, padding: "6px 8px" }}>
            On the net, newest first
          </div>
          {items.length ? (
            items.map((a) => {
              const d = describe(a);
              return (
                <Link key={`${a.kind}-${a.atUs}`} href={d.href ?? "/net"} className="menu-row" onClick={() => setOpen(false)}>
                  {d.mark}
                  <span style={{ display: "grid", minWidth: 0 }}>
                    <span>{d.title}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {d.meta} · {Math.max(0, Math.round((now - a.atUs / 1000) / 1000))}s ago
                    </span>
                  </span>
                </Link>
              );
            })
          ) : (
            <div className="menu-row muted">Nothing yet. Sends, faucet grants and Fault Lab runs show here.</div>
          )}
        </div>
      )}
    </div>
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
