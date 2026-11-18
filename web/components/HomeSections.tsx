"use client";

import { Fragment } from "react";
import CountUp from "./bits/CountUp";
import { useNet } from "@/lib/net";
import { useFacts } from "./Facts";

/** Three big live numbers under the hero buttons, no boxes. */
export function HeroNumbers() {
  const s = useNet().stats;
  const items: [React.ReactNode, string, string][] = [
    [s?.gapMs.p50 != null ? <CountUp to={s.gapMs.p50} decimals={1} duration={0.6} trigger="load" /> : "—", "ms", "between blocks"],
    [s?.blockFinalityMs.p50 != null ? <CountUp to={Math.round(s.blockFinalityMs.p50)} duration={0.6} trigger="load" /> : "—", "ms", "to final"],
    [s ? <CountUp to={s.sealedRevealed} separator="," duration={0.6} trigger="load" /> : "—", "", "sealed sends opened"],
  ];
  return (
    <div className="hero-numbers">
      {items.map(([v, unit, label]) => (
        <div key={label}>
          <div className="hn-v">
            {v}
            {unit && <span className="hn-u">{unit}</span>}
          </div>
          <div className="hn-l">{label}</div>
        </div>
      ))}
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
  const gap = f.gap != null ? Math.round(f.gap) : "…";
  const steps = [
    {
      n: "01",
      title: "Lock",
      body: `Your wallet locks your trade before it's sent. The key is cut into ${n} pieces, one for each validator, and it takes ${t} pieces to unlock it. So even ${c} validators working together can't peek.`,
    },
    {
      n: "02",
      title: "Take turns",
      body: `${k} block makers work at the same time, each starting ${gap} ms after the last. So a new block comes out every ${gap} ms.`,
    },
    {
      n: "03",
      title: "Vote",
      body: `Validators vote on every block. Once ${q} of the ${n} agree, the block is accepted. If a block maker goes quiet, its turn is skipped and the others keep going.`,
    },
    {
      n: "04",
      title: "Line up",
      body: "All the accepted blocks are put into one list, in an order everyone agrees on without another vote.",
    },
    {
      n: "05",
      title: "Unlock",
      body: "Only after a block is locked into the list do the validators hand over their key pieces. By then the order can't change, so seeing your trade is too late to jump ahead of it.",
    },
    {
      n: "06",
      title: "Run",
      body: "Trades run on the same engine Solana uses, so Solana apps work as they are. If two block makers grab the same trade, it still only runs once.",
    },
  ];
  return (
    <div className="rows">
      {steps.map((s) => (
        <div key={s.n} className="row">
          <span className="row-n mono">{s.n}</span>
          <span className="row-t">{s.title}</span>
          <span className="row-b">{s.body}</span>
        </div>
      ))}
    </div>
  );
}

export function RealTable() {
  const f = useFacts();
  const n = f.n ?? "…";
  const rows: [string, string][] = [
    ["Voting", `Real. Each of the ${n} validators has its own key and signs its votes. ${f.quorum ?? "…"} votes are needed to accept a block.`],
    ["Ordering", "Real. Blocks are lined up using the exact rule from the Gatling paper."],
    ["Running trades", "Real. Solana's own engine runs your trades, fees and programs."],
    [
      "Locked trades",
      `Real encryption. It takes ${f.threshold ?? "…"} of the ${n} validators to unlock a trade, so ${f.colluders ?? "…"} working together can't. You can send 30 locked trades a minute, because fees can't be checked until a trade unlocks.`,
    ],
    ["Numbers", "Measured live on this net. Anything that's a goal rather than a measurement says so."],
    ["Locations", "Pretend. All the validators run on one computer. The distance between Frankfurt, London, New York, Tokyo and Singapore is copied by adding real travel delays to every message."],
    ["Results", "One machine runs the final list of trades and posts a fingerprint of the result after every block."],
    ["Hosting", "For now it runs on one PC through a free connection, so it can go offline, and pages load slower than the chain really is."],
    ["Resets", "Starts from scratch on every restart. Test SOL is worth nothing."],
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
