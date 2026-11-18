"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useNet, useNetStore, useNow, type BlockSummary } from "@/lib/net";
import { ago, CITY_NAMES, int, ms, uptime } from "@/lib/format";
import { DiagramLegend, TimingDiagram } from "./TimingDiagram";
import { Ind, Stat, Tween } from "./ui";
import { ArrowRight } from "./icons";

export function LiveBadge() {
  const net = useNet();
  const live = net.connected && net.stats?.live;
  return (
    <span className="pill" style={{ gap: 8 }}>
      {live ? <Ind kind="live" /> : net.everConnected ? <Ind kind="off" /> : <Ind kind="spin" />}
      {live ? "Updating live" : net.everConnected ? "Not reachable" : "Connecting"}
    </span>
  );
}

export function LiveDiagramCard({ rowHeight = 9 }: { rowHeight?: number }) {
  const net = useNet();
  const s = net.stats;
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="card-title">
            {s ? `${s.instances} instances, staggered by ${ms(s.targetGapMs, 1)} ms` : "Instances, staggered"}
          </span>
          <LiveBadge />
        </div>
        <span className="muted mono hide-sm" style={{ fontSize: 12 }}>
          {s ? `slot ${int(s.slot)} · up ${uptime(s.uptimeSeconds)}` : ""}
        </span>
      </div>
      <div style={{ padding: "16px 20px 12px" }}>
        {net.everConnected || s ? (
          <TimingDiagram rowHeight={rowHeight} />
        ) : (
          <div className="empty" style={{ height: 268, display: "grid", placeItems: "center" }}>
            <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
              <Ind kind="spin" /> Connecting to the net
            </span>
          </div>
        )}
      </div>
      <div style={{ padding: "12px 20px 16px", borderTop: "1px solid var(--line)" }}>
        <DiagramLegend />
      </div>
    </div>
  );
}

export function LiveStats() {
  const net = useNet();
  const s = net.stats;
  const f1 = (v: number) => ms(v, 1);
  const f0 = (v: number) => ms(v, 0);
  return (
    <div className="stats">
      <Stat
        label="Between blocks"
        ind={<Ind kind={s?.live ? "live" : "wait"} color="var(--accent)" />}
        value={<Tween value={s?.gapMs.p50} format={f1} />}
        unit="ms"
        sub={s ? `median · target ${ms(s.targetGapMs, 1)} ms · p90 ${ms(s.gapMs.p90, 1)} ms` : "median time between merged blocks"}
      />
      <Stat
        label="Block finality"
        value={<Tween value={s?.blockFinalityMs.p50} format={f0} />}
        unit="ms"
        sub={s ? `proposal to merged log · p90 ${ms(s.blockFinalityMs.p90, 0)} ms` : "proposal to merged log"}
      />
      <Stat
        label="Transaction finality"
        value={<Tween value={s?.txFinalityMs.p50} format={f0} />}
        unit="ms"
        sub={s ? `sent to executed · p90 ${ms(s.txFinalityMs.p90, 0)} ms` : "sent to executed"}
      />
      <Stat
        label="Blocks per second"
        value={<Tween value={s?.blocksPerSecond} format={(v) => int(v)} />}
        sub={s ? `${int(s.transactions)} transactions · ${int(s.sealedRevealed)} arrived sealed` : "over the last minute"}
      />
    </div>
  );
}

export function BlocksTable({ limit = 12, compact = false }: { limit?: number; compact?: boolean }) {
  const net = useNetStore();
  // A block lands every few ms; refresh the rows a few times a second so they can be read.
  const now = useNow(400);
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [rows, setRows] = useState<BlockSummary[]>([]);
  useEffect(() => {
    if (!paused) setRows(net.blocks.slice(0, limit));
  }, [paused, now, net, limit]);
  if (!rows.length) {
    return <div className="empty">{net.everConnected ? "Waiting for the first block to enter the merged log." : "Connecting to the net."}</div>;
  }
  return (
    <div className="table-wrap" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <table className="t">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Instance · view</th>
            <th className="hide-sm">Leader</th>
            <th className="r">Txs</th>
            <th className="r">Finality</th>
            {!compact && <th className="r hide-sm">Merged</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.slot} className="clickable" onClick={() => router.push(`/net/block/${b.slot}`)}>
              <td className="mono">
                <Link href={`/net/block/${b.slot}`}>{int(b.slot)}</Link>
              </td>
              <td className="mono text-2">
                k{b.instance} · v{b.view}
              </td>
              <td className="hide-sm text-2">
                <span className="mono">#{b.leader}</span> <span className="muted">{CITY_NAMES[b.city] ?? b.city}</span>
              </td>
              <td className="r mono">{b.txs}</td>
              <td className="r mono">{ms((b.mergedAtUs - b.proposedAtUs) / 1000, 0)} ms</td>
              {!compact && <td className="r mono muted hide-sm">{ago(b.mergedAtUs, now)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LatestBlocks() {
  return (
    <div className="card">
      <div className="card-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="card-title">Latest blocks in the merged log</span>
          <LiveBadge />
        </div>
        <Link href="/net" className="btn btn-ghost" style={{ height: 32 }}>
          All of the net
          <ArrowRight size={16} />
        </Link>
      </div>
      <BlocksTable limit={8} />
    </div>
  );
}
