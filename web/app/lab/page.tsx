"use client";

import { useEffect, useState } from "react";
import { api, usePoll } from "@/lib/net";
import { ms } from "@/lib/format";
import { Ind } from "@/components/ui";
import { Play } from "@/components/icons";
import { PageHero, Panel } from "@/components/PageHero";

type Scenario = { id: string; title: string; fault: string; expect: string };
type Phase = { blocks: number; blocksPerSecond: number; gapP50: number | null; gapMax: number | null; finalityP50: number | null; finalityMax: number | null; transactions: number };
type Run = {
  id: string;
  scenario: string;
  title: string;
  status: "starting" | "settling" | "fault" | "recovering" | "done";
  startedAtUs: number;
  timeline?: { t: number; merged: number; skipped: number; fault: boolean }[];
  phases?: { before: Phase; during: Phase; after: Phase };
  evidence?: string[];
  verdict?: string;
  logHash?: string;
  slot?: number;
};
type Catalog = { scenarios: Scenario[]; busy: boolean; durations: { settleSeconds: number; faultSeconds: number; recoverSeconds: number }; recent: Run[] };

const STAGES: { id: Run["status"]; label: string }[] = [
  { id: "settling", label: "Settling" },
  { id: "fault", label: "Fault on" },
  { id: "recovering", label: "Fault off" },
  { id: "done", label: "Report" },
];

function Stages({ status }: { status: Run["status"] }) {
  const idx = status === "starting" ? 0 : STAGES.findIndex((s) => s.id === status);
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {STAGES.map((s, i) => {
        const kind = i < idx || status === "done" ? "done" : i === idx ? "spin" : "wait";
        return (
          <span key={s.id} className={`pill ${i === idx && status !== "done" ? "pill-accent" : ""}`} style={{ gap: 8 }}>
            <Ind kind={kind as any} color={s.id === "fault" && kind === "spin" ? "var(--neg)" : undefined} />
            {s.label}
          </span>
        );
      })}
    </div>
  );
}

function TimelineChart({ run }: { run: Run }) {
  const tl = run.timeline ?? [];
  const W = 600;
  const H = 120;
  const total = 15;
  const max = Math.max(4, ...tl.map((p) => p.merged));
  const bw = W / (total / 0.25);
  const faultFrom = tl.find((p) => p.fault)?.t;
  const faultTo = [...tl].reverse().find((p) => p.fault)?.t;
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} width="100%" height={H + 18} preserveAspectRatio="none" role="img" aria-label="Blocks entering the merged log every quarter second">
      {faultFrom != null && faultTo != null && <rect x={(faultFrom / total) * W - bw} y={0} width={((faultTo - faultFrom) / total) * W + bw} height={H} fill="rgba(229,72,77,0.08)" />}
      {tl.map((p, i) => {
        const h = (p.merged / max) * (H - 6);
        return <rect key={i} x={(p.t / total) * W - bw + 1} y={H - h} width={Math.max(1, bw - 2)} height={h} rx={1} fill={p.fault ? "rgba(229,72,77,0.75)" : "rgba(238,240,245,0.5)"} />;
      })}
      <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="rgba(238,240,245,0.12)" />
      {[0, 5, 10, 15].map((s) => (
        <text key={s} x={(s / total) * W} y={H + 14} fontSize="10" fill="#7a8296" textAnchor={s === 0 ? "start" : s === 15 ? "end" : "middle"} style={{ fontFamily: "var(--mono)" }}>
          {s}s
        </text>
      ))}
    </svg>
  );
}

function PhaseTable({ p }: { p: NonNullable<Run["phases"]> }) {
  const rows: [string, (x: Phase) => string][] = [
    ["Blocks per second", (x) => ms(x.blocksPerSecond, 0)],
    ["Between blocks, median", (x) => (x.gapP50 == null ? "—" : `${ms(x.gapP50, 1)} ms`)],
    ["Longest gap", (x) => (x.gapMax == null ? "—" : `${ms(x.gapMax, 0)} ms`)],
    ["Finality, median", (x) => (x.finalityP50 == null ? "—" : `${ms(x.finalityP50, 0)} ms`)],
    ["Finality, slowest", (x) => (x.finalityMax == null ? "—" : `${ms(x.finalityMax, 0)} ms`)],
    ["Transactions", (x) => String(x.transactions)],
  ];
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th></th>
            <th className="r">Before</th>
            <th className="r">During the fault</th>
            <th className="r">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}>
              <td className="text-2">{label}</td>
              <td className="r mono">{f(p.before)}</td>
              <td className="r mono">{f(p.during)}</td>
              <td className="r mono">{f(p.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LabPage() {
  const { data: cat, error } = usePoll<Catalog>("/v1/lab/scenarios", 3000);
  const [runId, setRunId] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const { data: run } = usePoll<Run>(runId ? `/v1/lab/runs/${runId}` : null, 500);
  const running = run && run.status !== "done";

  useEffect(() => {
    if (run?.status === "done") window.dispatchEvent(new Event("lab-done"));
  }, [run?.status]);

  async function start(id: string) {
    setStartErr(null);
    try {
      const r = await api<{ id: string }>("/v1/lab/runs", { method: "POST", body: JSON.stringify({ scenario: id }) });
      setRunId(r.id);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      setStartErr(e.message);
    }
  }

  const d = cat?.durations;
  return (
    <>
      <PageHero
        eyebrow="Fault Lab"
        title={
          <>
            Try to
            <br />
            break it.
          </>
        }
        sub={`Each run starts a separate net of 10 validators for ${d ? d.settleSeconds + d.faultSeconds + d.recoverSeconds : 15} seconds: ${d?.settleSeconds ?? 4} to settle, ${d?.faultSeconds ?? 6} with the fault on, ${d?.recoverSeconds ?? 5} to recover. The live net is not touched.`}
        live={false}
      />
      <div className="wrap page-body">
        {run && (
          <div className="card" style={running ? { boxShadow: "0 0 0 1px rgba(245,165,36,0.35)" } : undefined}>
            <div className="card-head" style={{ flexWrap: "wrap" }}>
              <span className="card-title">{run.title}</span>
              <Stages status={run.status} />
            </div>
            <div style={{ padding: 20 }}>
              <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                Blocks entering the merged log, per quarter second. Red is while the fault is on.
              </div>
              <TimelineChart run={run} />
            </div>
            {run.status === "done" && run.phases && (
              <>
                <div style={{ padding: "0 20px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span className={`pill ${run.verdict === "Kept finalizing" ? "pill-pos" : "pill-accent"}`} style={{ gap: 8 }}>
                    <Ind kind="done" color={run.verdict === "Kept finalizing" ? "var(--pos)" : "var(--accent)"} />
                    {run.verdict}
                  </span>
                </div>
                <div style={{ borderTop: "1px solid var(--line)" }}>
                  <PhaseTable p={run.phases} />
                </div>
                <div style={{ borderTop: "1px solid var(--line)", padding: "16px 20px" }}>
                  <div className="card-title" style={{ marginBottom: 8 }}>
                    Evidence
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 14, display: "grid", gap: 6 }}>
                    {run.evidence?.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                    {run.logHash && (
                      <li>
                        Log hash at slot {run.slot}: <span className="mono">{run.logHash.slice(0, 16)}…</span>
                      </li>
                    )}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}
        {(startErr || error) && <div className="notice" style={{ color: "var(--neg)" }}>{startErr || "The lab cannot be reached right now."}</div>}
        <Panel title="Scenarios" action={<span className="muted" style={{ fontSize: 13 }}>One run at a time, six an hour per connection</span>}>
          {(cat?.scenarios ?? []).map((sc, i) => (
            <div key={sc.id} className="scenario-row">
              <span className="row-n mono">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className="row-t" style={{ display: "block" }}>
                  {sc.title}
                </span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {sc.fault}
                </span>
              </span>
              <span className="row-b">{sc.expect}</span>
              <button className="btn" onClick={() => start(sc.id)} disabled={!!running || cat?.busy}>
                <Play size={14} />
                Run it
              </button>
            </div>
          ))}
          {!cat && (
            <div className="empty" style={{ display: "flex", gap: 10 }}>
              <Ind kind="spin" /> Loading the scenarios
            </div>
          )}
        </Panel>
        {cat && cat.recent.length > 0 && (
          <Panel title="Recent runs" action={<span className="muted" style={{ fontSize: 13 }}>anyone&apos;s, newest first</span>}>
            <div className="table-wrap">
              <table className="t">
                <tbody>
                  {cat.recent.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => setRunId(r.id)}>
                      <td>{r.title}</td>
                      <td>{r.verdict ? <span className="text-2">{r.verdict}</span> : <span className="muted">{r.status}</span>}</td>
                      <td className="r mono muted">{new Date(r.startedAtUs / 1000).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
