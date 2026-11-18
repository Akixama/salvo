"use client";

import { Fragment } from "react";
import CountUp from "./bits/CountUp";
import { useNet } from "@/lib/net";
import { useFacts } from "./Facts";
import { LiveBadge } from "./Live";

/** Three live numbers beside the main button: what the net is doing right now. */
export function LiveCounts() {
  const s = useNet().stats;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Right now
        </span>
        <LiveBadge />
      </div>
      <div className="live-counts">
        <div>
          <div className="stat-label">Blocks a second</div>
          <div className="v">{s ? <CountUp to={Math.round(s.blocksPerSecond)} duration={0.6} trigger="load" /> : "—"}</div>
          <div className="stat-sub">one every {s ? s.gapMs.p50?.toFixed(1) ?? "—" : "—"} ms</div>
        </div>
        <div>
          <div className="stat-label">Final in</div>
          <div className="v">
            {s?.blockFinalityMs.p50 != null ? <CountUp to={Math.round(s.blockFinalityMs.p50)} duration={0.6} trigger="load" /> : "—"}
            <small>ms</small>
          </div>
          <div className="stat-sub">median, block to log</div>
        </div>
        <div>
          <div className="stat-label">Sealed, opened</div>
          <div className="v">{s ? <CountUp to={s.sealedRevealed} duration={0.6} separator="," trigger="load" /> : "—"}</div>
          <div className="stat-sub">read only after final</div>
        </div>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const f = useFacts();
  const n = f.n ?? "…";
  const t = f.threshold ?? "…";
  const c = f.colluders ?? "…";
  const q = f.quorum ?? "…";
  const k = f.k ?? "…";
  const d = f.delta ?? "…";
  const gap = f.gap != null ? Math.round(f.gap) : "…";
  const steps = [
    {
      n: "01",
      title: "Seal",
      body: `Your wallet encrypts the transaction and splits the key into ${n} pieces, one locked to each validator. Any ${t} pieces open it; ${c} colluding validators cannot.`,
    },
    {
      n: "02",
      title: "Stagger",
      body: `${k} consensus instances run side by side on the same ${n} validators. Instance k proposes on the same ${d} ms beat as the others, shifted by k × ${gap} ms, so a new block goes out every ${gap} ms.`,
    },
    {
      n: "03",
      title: "Vote",
      body: `Each instance is a small Simplex protocol. Validators sign a notarize vote for the proposal, then a finalize vote. ${q} of ${n} matching votes make a certificate. A silent leader's view times out and is skipped.`,
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
  return (
    <div className="grid-3" style={{ marginTop: 32 }}>
      {steps.map((s) => (
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
  );
}

export function RealTable() {
  const f = useFacts();
  const n = f.n ?? "…";
  const rows: [string, string][] = [
    ["Consensus", `Real. Each of the ${n} validators is its own actor with its own key; votes are Ed25519-signed and checked. ${f.quorum ?? "…"} matching votes make a certificate.`],
    ["Merge rule", "Real. The (view, instance) cursor from the paper's reference prototype."],
    ["Solana runtime", "Real. LiteSVM runs your transactions, fees and programs."],
    [
      "Sealing",
      `Real. AES-256-GCM and X25519, with the key split ${f.threshold ?? "…"}-of-${n} (Shamir). Up to ${f.colluders ?? "…"} colluding validators cannot open a transaction early. Fees cannot be checked before it opens, so sealed sends are rate limited.`,
    ],
    ["Numbers", "Measured on this net, live. Targets are labelled as targets."],
    ["Geography", "Simulated. All validators run on one machine; messages between Frankfurt, London, New York, Tokyo and Singapore are delayed by real-world one-way times."],
    ["Execution", "One executor follows the merged log and publishes a log hash per block."],
    ["Hosting", "Right now the net runs on one PC behind a free tunnel, so it can go offline, and pages load slower than the chain itself."],
    ["State", "Starts fresh on every restart. Test SOL has no value."],
  ];
  return (
    <div className="kv">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <div>{k}</div>
          <div className="text-2">{v}</div>
        </Fragment>
      ))}
    </div>
  );
}
