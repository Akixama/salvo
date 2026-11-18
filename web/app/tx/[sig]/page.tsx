"use client";

import Link from "next/link";
import { Fragment, use } from "react";
import { usePoll } from "@/lib/net";
import { int, ms, sol } from "@/lib/format";
import { Addr, Ind } from "@/components/ui";
import { TxTrail, type TxRec } from "@/components/TxTrail";
import { BigNumbers, PageHero, Panel } from "@/components/PageHero";
import { TxMark } from "@/components/Marks";

export default function TxPage({ params }: { params: Promise<{ sig: string }> }) {
  const { sig } = use(params);
  const { data, error } = usePoll<{ tx: TxRec }>(`/v1/tx/${sig}`, 1000);
  const t = data?.tx;
  if (error && !t)
    return (
      <PageHero live={false} eyebrow={<span className="mono">{sig.slice(0, 12)}…{sig.slice(-8)}</span>} title="Not found." sub={`${error}. The net starts fresh on restart and keeps the most recent 100,000 transactions.`}>
        <Link href="/net" className="btn btn-accent btn-xl">
          Back to the live net
        </Link>
      </PageHero>
    );
  if (!t)
    return (
      <PageHero
        live={false}
        eyebrow="Transaction"
        title="Looking it up."
        sub={
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
            <Ind kind="spin" /> Loading
          </span>
        }
      />
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
      <PageHero
        live={false}
        eyebrow={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <TxMark id={t.signature} sealed={!!t.sealedId} size={22} />
            Transaction{t.sealedId ? " · sent sealed" : ""}{t.source === "traffic" ? " · demo load" : ""}
          </span>
        }
        title={
          t.status === "finalized" && t.receivedAtUs && t.executedAtUs ? (
            <>
              Final in
              <br />
              <span className="accent num">{ms((t.executedAtUs - t.receivedAtUs) / 1000, 0)} ms.</span>
            </>
          ) : t.err ? (
            "Failed."
          ) : (
            "On its way."
          )
        }
        sub={t.sealedId ? "No leader could read it until its block was final; then the validators released their key pieces and it ran." : "Received by the gateway, put in a block by a leader, finalized, merged and run."}
        aside={
          <BigNumbers
            items={[
              { v: t.slot ? int(t.slot) : "—", label: "slot" },
              { v: sol(t.fee), unit: "SOL", label: "fee" },
              { v: t.copies, label: t.copies === 1 ? "copy proposed" : "copies proposed" },
            ]}
          />
        }
      />
      <div className="wrap split" style={{ paddingTop: 48, gap: 48 }}>
        <div className="stack" style={{ gap: 56 }}>
          <Panel title="Details">
            <div className="kv">
              {rows.map(([k, v]) => (
                <Fragment key={k}>
                  <div>{k}</div>
                  <div>{v}</div>
                </Fragment>
              ))}
            </div>
          </Panel>
          {t.accounts.length > 0 && (
            <Panel title="Balance changes">
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
            </Panel>
          )}
          {t.logs.length > 0 && (
            <Panel title="Program logs">
              <pre className="code mono" style={{ display: "block", marginTop: 20, fontSize: 12, lineHeight: "20px", color: "var(--text-2)", whiteSpace: "pre" }}>
                {t.logs.join("\n")}
              </pre>
            </Panel>
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
