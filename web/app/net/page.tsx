"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BlocksTable, LiveBadge, LiveDiagramCard, matchesFilter, type BlockFilter } from "@/components/Live";
import { BigNumbers, PageHero, Panel } from "@/components/PageHero";
import CountUp from "@/components/bits/CountUp";
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
      className="field-xl"
    >
      <input className="input" placeholder="Slot number or transaction signature" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      <button className="btn btn-primary" type="submit">
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
      <PageHero
        eyebrow={s?.name ?? "The net"}
        title={
          <>
            The net,
            <br />
            live.
          </>
        }
        sub={
          s
            ? `${s.validators} validators run ${s.instances} instances on staggered timers, a view every ${s.deltaMs} ms each. Everything below is measured as it happens.`
            : "Connecting to the net."
        }
        aside={<Search />}
      />
      <div className="wrap page-body">
        <BigNumbers
          items={[
            { v: s?.gapMs.p50 != null ? <CountUp to={s.gapMs.p50} decimals={1} duration={0.6} trigger="load" /> : "—", unit: "ms", label: `between blocks · target ${s ? ms(s.targetGapMs, 1) : "—"} ms` },
            { v: s?.blockFinalityMs.p50 != null ? <CountUp to={Math.round(s.blockFinalityMs.p50)} duration={0.6} trigger="load" /> : "—", unit: "ms", label: `block to final · p90 ${s ? ms(s.blockFinalityMs.p90, 0) : "—"} ms` },
            { v: s?.txFinalityMs.p50 != null ? <CountUp to={Math.round(s.txFinalityMs.p50)} duration={0.6} trigger="load" /> : "—", unit: "ms", label: "transaction, sent to run" },
            { v: s ? <CountUp to={Math.round(s.blocksPerSecond)} duration={0.6} trigger="load" /> : "—", label: `blocks a second · ${s ? int(s.skippedViews) : "—"} views skipped` },
          ]}
        />
        <LiveDiagramCard rowHeight={11} />
        <div className="split" style={{ gap: 48 }}>
          <Panel
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                Merged log <LiveBadge />
              </span>
            }
            action={<FilterTabs value={filter} onChange={setFilter} />}
            note={`Hover the list to pause it. Counts are over the latest ${net.blocks.length} blocks.`}
          >
            <BlocksTable limit={16} compact filter={filter} />
          </Panel>
          <Panel title="Block finality" action={<span className="muted" style={{ fontSize: 13 }}>last {latency?.blockFinalityMs.length ?? 0} blocks</span>}>
            <div style={{ paddingTop: 20 }}>
              <FinalityChart samples={latency?.blockFinalityMs ?? []} />
            </div>
          </Panel>
        </div>
        <Panel title="Instances" action={<span className="muted" style={{ fontSize: 13 }}>The ring empties until that instance&apos;s next proposal</span>}>
          <Instances />
        </Panel>
        <Panel title="Validators" action={<span className="muted" style={{ fontSize: 13 }}>Gateway in Frankfurt</span>}>
          <Validators />
        </Panel>
      </div>
    </>
  );
}
