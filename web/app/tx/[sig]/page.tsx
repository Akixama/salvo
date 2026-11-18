"use client";

import Link from "next/link";
import { Fragment, use } from "react";
import { usePoll } from "@/lib/net";
import { int, ms, sol } from "@/lib/format";
import { Addr, Ind } from "@/components/ui";
import { TxTrail, type TxRec } from "@/components/TxTrail";

export default function TxPage({ params }: { params: Promise<{ sig: string }> }) {
  const { sig } = use(params);
  const { data, error } = usePoll<{ tx: TxRec }>(`/v1/tx/${sig}`, 1000);
  const t = data?.tx;
  if (error && !t)
    return (
      <div className="wrap page-head">
        <div className="eyebrow">Transaction</div>
        <h1 className="page-title mono" style={{ marginTop: 8, wordBreak: "break-all", fontSize: 20 }}>
          {sig}
        </h1>
        <div className="notice">{error}. The net starts fresh on restart and keeps the most recent 100,000 transactions.</div>
      </div>
    );
  if (!t)
    return (
      <div className="wrap page-head">
        <div className="muted" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Ind kind="spin" /> Loading
        </div>
      </div>
    );
  const rows: [string, React.ReactNode][] = [
    ["Signature", <Addr value={t.signature} head={10} tail={10} />],
    ["Status", t.err ? <span className="pill pill-neg">Failed: {t.err}</span> : t.status === "finalized" ? <span className="pill pill-pos">Finalized</span> : <span className="pill pill-accent">{t.status}</span>],
    ["Slot", t.slot ? <Link className="mono" href={`/net/block/${t.slot}`}>{int(t.slot)}</Link> : "—"],
    ["Instance and view", t.instance != null ? <span className="mono">k{t.instance} · view {int(t.view)}</span> : "—"],
    ["Fee payer", t.feePayer ? <Addr value={t.feePayer} head={6} tail={6} /> : "—"],
    ["Fee", <span className="mono">{sol(t.fee)} SOL</span>],
    ["Compute units", <span className="mono">{int(t.computeUnits)}</span>],
    ["Arrived", t.sealedId ? <span><span className="pill pill-accent">Sealed</span> <span className="muted mono" style={{ fontSize: 12 }}>envelope {t.sealedId.slice(0, 16)}…</span></span> : <span className="text-2">In the clear</span>],
    ["Copies proposed", <span className="mono">{t.copies}{t.copies > 1 ? " (more than one leader picked it up; it ran once)" : ""}</span>],
  ];
  return (
    <>
      <div className="wrap page-head">
        <div className="eyebrow">Transaction{t.source === "traffic" ? " · demo load" : ""}</div>
        <h1 className="page-title" style={{ marginTop: 8 }}>
          {t.status === "finalized" && t.receivedAtUs && t.executedAtUs ? `Final in ${ms((t.executedAtUs - t.receivedAtUs) / 1000, 0)} ms` : t.err ? "Failed" : "On its way"}
        </h1>
      </div>
      <div className="wrap split">
        <div className="stack">
          <div className="card">
            <div className="kv">
              {rows.map(([k, v]) => (
                <Fragment key={k}>
                  <div>{k}</div>
                  <div>{v}</div>
                </Fragment>
              ))}
            </div>
          </div>
          {t.accounts.length > 0 && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Balance changes</span>
              </div>
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th className="r">Before</th>
                      <th className="r">After</th>
                      <th className="r">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.accounts.map((a, i) => {
                      const pre = t.preBalances[i];
                      const post = t.postBalances[i];
                      const d = pre != null && post != null ? post - pre : null;
                      return (
                        <tr key={a + i}>
                          <td>
                            <Addr value={a} />
                          </td>
                          <td className="r mono">{sol(pre)}</td>
                          <td className="r mono">{sol(post)}</td>
                          <td className={`r mono ${d && d > 0 ? "pos" : d && d < 0 ? "neg" : "muted"}`}>{d == null ? "—" : `${d > 0 ? "+" : ""}${sol(d)}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {t.logs.length > 0 && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Program logs</span>
              </div>
              <pre className="mono" style={{ margin: 0, padding: "16px 20px", fontSize: 12, lineHeight: "20px", color: "var(--text-2)", overflowX: "auto" }}>
                {t.logs.join("\n")}
              </pre>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Timeline</span>
          </div>
          <TxTrail tx={t} />
        </div>
      </div>
    </>
  );
}
