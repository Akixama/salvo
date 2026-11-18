"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BlocksTable, LiveBadge, LiveDiagramCard, LiveStats, matchesFilter, type BlockFilter } from "@/components/Live";
import { FinalityChart } from "@/components/FinalityChart";
import { useNet, useNow, usePoll } from "@/lib/net";
import { CITY_NAMES, int, ms, short } from "@/lib/format";
import { CountdownRing, CopyButton, Ind } from "@/components/ui";

function Search() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = q.trim();
        if (!v) return;
        if (/^\d+$/.test(v)) router.push(`/net/block/${v}`);
        else router.push(`/tx/${v}`);
      }}
      style={{ display: "flex", gap: 8, width: "100%", maxWidth: 520 }}
    >
      <input className="input" placeholder="Slot number or transaction signature" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      <button className="btn" type="submit" style={{ height: 44 }}>
        Look up
      </button>
    </form>
  );
}

function Instances() {
  const net = useNet();
  const now = useNow(100);
  const s = net.stats;
  const list = net.instances;
  if (!s || !list.length) return <div className="empty">Waiting for the net.</div>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Instance</th>
            <th className="r">View</th>
            <th className="r">Height</th>
            <th className="r">Skipped</th>
            <th>Next leader</th>
          </tr>
        </thead>
        <tbody>
          {list.map((i) => {
            const remaining = Math.max(0, i.nextProposalUs / 1000 - now);
            const v = net.validators[i.leader];
            return (
              <tr key={i.instance}>
                <td className="mono">
                  k{i.instance} <span className="muted">+{ms((i.instance * s.deltaMs) / s.instances, 0)} ms</span>
                </td>
                <td className="r mono">{int(i.view)}</td>
                <td className="r mono">{int(i.finalizedHeight)}</td>
                <td className={`r mono ${i.skipped ? "" : "muted"}`}>{int(i.skipped)}</td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <CountdownRing remaining={remaining} total={s.deltaMs} />
                    <span className="mono">#{i.leader}</span>
                    <span className="muted">{v ? v.city : ""}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Validators() {
  const net = useNet();
  const now = useNow(1000);
  if (!net.validators.length) return <div className="empty">Waiting for the net.</div>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Validator</th>
            <th>City</th>
            <th>Identity</th>
            <th className="r">Blocks proposed</th>
            <th className="r hide-sm">Last proposal</th>
          </tr>
        </thead>
        <tbody>
          {net.validators.map((v) => {
            const recent = v.lastProposedAtUs && now - v.lastProposedAtUs / 1000 < 3000;
            return (
              <tr key={v.id}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {recent ? <Ind kind="live" /> : <Ind kind="wait" />}
                    <span className="mono">#{v.id}</span>
                  </span>
                </td>
                <td>{CITY_NAMES[v.city] ?? v.city}</td>
                <td>
                  <span className="addr">
                    {short(v.identity, 6, 6)}
                    <CopyButton text={v.identity} />
                  </span>
                </td>
                <td className="r mono">{int(v.proposed)}</td>
                <td className="r mono muted hide-sm">{v.lastProposedAtUs ? `${ms(now - v.lastProposedAtUs / 1000, 0)} ms ago` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FilterTabs({ value, onChange }: { value: BlockFilter; onChange: (f: BlockFilter) => void }) {
  const net = useNet();
  const tabs: [BlockFilter, string][] = [
    ["all", "All"],
    ["txs", "With transactions"],
    ["sealed", "Sealed"],
  ];
  return (
    <div className="tabs" role="tablist" aria-label="Filter blocks">
      {tabs.map(([f, label]) => (
        <button key={f} className="tab" role="tab" aria-selected={value === f} onClick={() => onChange(f)}>
          {label}
          <span className="count">{net.blocks.filter((b) => matchesFilter(b, f)).length}</span>
        </button>
      ))}
    </div>
  );
}

export default function NetPage() {
  const net = useNet();
  const [filter, setFilter] = useState<BlockFilter>("all");
  const { data: latency } = usePoll<{ blockFinalityMs: number[]; gapMs: number[]; txFinalityMs: number[] }>("/v1/latency", 3000);
  const s = net.stats;
  return (
    <>
      <div className="wrap page-head">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
          <div>
            <h1 className="page-title">{s?.name ?? "The net"}</h1>
            <p className="text-2" style={{ margin: 0 }}>
              {s
                ? `${s.validators} validators, ${s.instances} instances, a view every ${s.deltaMs} ms per instance. Views time out after ${s.timeoutMs} ms.`
                : "Connecting to the net."}
            </p>
          </div>
          <Search />
        </div>
      </div>
      <div className="wrap stack">
        <LiveStats />
        <LiveDiagramCard rowHeight={11} />
        <div className="split">
          <div className="card">
            <div className="card-head" style={{ flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="card-title">Merged log</span>
                <LiveBadge />
              </div>
              <FilterTabs value={filter} onChange={setFilter} />
            </div>
            <BlocksTable limit={16} compact filter={filter} />
            <div className="muted" style={{ fontSize: 12, padding: "10px 20px", borderTop: "1px solid var(--line)" }}>
              Hover the list to pause it. Counts are over the latest {net.blocks.length} blocks.
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <span className="card-title">Block finality</span>
              <span className="muted" style={{ fontSize: 13 }}>
                last {latency?.blockFinalityMs.length ?? 0} blocks
              </span>
            </div>
            <div style={{ padding: 20 }}>
              <FinalityChart samples={latency?.blockFinalityMs ?? []} />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Instances</span>
            <span className="muted" style={{ fontSize: 13 }}>
              The ring empties until that instance&apos;s next proposal
            </span>
          </div>
          <Instances />
        </div>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Validators</span>
            <span className="muted" style={{ fontSize: 13 }}>
              Gateway in Frankfurt
            </span>
          </div>
          <Validators />
        </div>
      </div>
    </>
  );
}
