"use client";

import Link from "next/link";
import { Fragment, use } from "react";
import { usePoll } from "@/lib/net";
import { CITY_NAMES, int, ms, short, sol } from "@/lib/format";
import { Addr, Ind } from "@/components/ui";
import { ArrowRight } from "@/components/icons";
import { BigNumbers, PageHero, Panel } from "@/components/PageHero";
import { BlockMark, TxMark } from "@/components/Marks";

type Block = {
  slot: number;
  instance: number;
  view: number;
  height: number;
  leader: number;
  leaderCity: string;
  proposedAtUs: number;
  notarizedAtUs: number | null;
  finalizedAtUs: number;
  mergedAtUs: number;
  executedAtUs: number;
  digest: string;
  parent: string;
  blockhash: string;
  logHash: string;
  txCount: number;
  failed: number;
  duplicates: number;
  sealed: number;
  fees: number;
  computeUnits: number;
  tip: number;
  transactions: { signature: string; status: string; fee: number; feePayer: string; source: string; err: string | null; computeUnits: number; sealed: boolean }[];
};

function Timeline({ b }: { b: Block }) {
  const t0 = b.proposedAtUs;
  const steps = [
    { label: "Proposed by the leader", at: b.proposedAtUs },
    { label: "Notarized, seen at the gateway", at: b.notarizedAtUs },
    { label: "Finalized", at: b.finalizedAtUs },
    { label: "Entered the merged log", at: b.mergedAtUs },
    { label: "Executed", at: b.executedAtUs },
  ];
  return (
    <div style={{ display: "grid" }}>
      {steps.map((s, i) => (
        <div key={s.label} style={{ display: "grid", gridTemplateColumns: "20px 1fr auto", gap: 12, alignItems: "center", padding: "10px 20px", borderBottom: i < steps.length - 1 ? "1px solid var(--line)" : "none" }}>
          {s.at ? <Ind kind="done" /> : <Ind kind="wait" />}
          <span style={{ fontSize: 14 }}>{s.label}</span>
          <span className="mono text-2" style={{ fontSize: 13 }}>
            {s.at ? `+${ms((s.at - t0) / 1000, 1)} ms` : "not seen"}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BlockPage({ params }: { params: Promise<{ slot: string }> }) {
  const { slot } = use(params);
  const { data: b, error } = usePoll<Block>(`/v1/blocks/${slot}`, 0);
  const n = Number(slot);
  if (error)
    return (
      <PageHero live={false} eyebrow="Block" title={<span className="num">Slot {slot}.</span>} sub={`${error}. The gateway keeps the latest 4,096 blocks, and the net starts fresh when it restarts.`}>
        <Link href="/net" className="btn btn-accent btn-xl">
          Back to the live net
        </Link>
      </PageHero>
    );
  if (!b)
    return (
      <PageHero
        live={false}
        eyebrow="Block"
        title={<span className="num">Slot {slot}.</span>}
        sub={
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
            <Ind kind="spin" /> Loading
          </span>
        }
      />
    );
  const rows: [string, React.ReactNode][] = [
    ["Slot", <span className="mono">{int(b.slot)}</span>],
    ["Instance and view", <span className="mono">k{b.instance} · view {int(b.view)} · height {int(b.height)}</span>],
    ["Leader", <span>
        <span className="mono">#{b.leader}</span> <span className="muted">{CITY_NAMES[b.leaderCity] ?? b.leaderCity}</span>
      </span>],
    ["Blockhash", <Addr value={b.blockhash} head={8} tail={8} />],
    ["Block digest", <Addr value={b.digest} head={8} tail={8} />],
    ["Parent in instance", <Addr value={b.parent} head={8} tail={8} />],
    ["Log hash after", <Addr value={b.logHash} head={8} tail={8} />],
    ["Transactions", <span className="mono">{b.txCount} executed · {b.failed} failed · {b.duplicates} duplicate copies dropped</span>],
    ["Arrived sealed", <span className="mono">{b.sealed}{b.sealed ? " (the leader ordered them without being able to read them)" : ""}</span>],
    ["Fees", <span className="mono">{sol(b.fees)} SOL · {int(b.computeUnits)} CU</span>],
  ];
  return (
    <>
      <PageHero
        live={false}
        eyebrow={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <BlockMark instance={b.instance} k={24} size={22} />
            Block · instance k{b.instance}, view {int(b.view)}
          </span>
        }
        title={<span className="num">Slot {int(b.slot)}.</span>}
        sub={`Its leader in ${CITY_NAMES[b.leaderCity] ?? b.leaderCity} sent it, and it became final ${ms((b.mergedAtUs - b.proposedAtUs) / 1000, 0)} ms later.`}
        aside={
          <BigNumbers
            items={[
              { v: ms((b.mergedAtUs - b.proposedAtUs) / 1000, 0), unit: "ms", label: "to final" },
              { v: b.txCount, label: "transactions" },
              { v: b.sealed, label: "arrived sealed" },
            ]}
          />
        }
      >
        {n > 1 && (
          <Link href={`/net/block/${n - 1}`} className="btn btn-quiet btn-xl">
            Previous
          </Link>
        )}
        {n < b.tip && (
          <Link href={`/net/block/${n + 1}`} className="btn btn-quiet btn-xl">
            Next
            <ArrowRight size={16} />
          </Link>
        )}
      </PageHero>
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
          <Panel title="Transactions" action={<span className="muted mono" style={{ fontSize: 13 }}>{b.transactions.length}</span>}>
            {b.transactions.length ? (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Signature</th>
                      <th className="hide-sm">Fee payer</th>
                      <th>Status</th>
                      <th className="r">Fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.transactions.map((t) => (
                      <tr key={t.signature}>
                        <td className="mono">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, verticalAlign: "middle" }}>
                            <TxMark id={t.signature} sealed={t.sealed} size={24} />
                            <Link href={`/tx/${t.signature}`}>{short(t.signature, 8, 8)}</Link>
                          </span>
                          {t.sealed && (
                            <span className="pill pill-accent" style={{ marginLeft: 8 }}>
                              sealed
                            </span>
                          )}
                          {t.source === "traffic" && (
                            <span className="pill" style={{ marginLeft: 8 }}>
                              demo load
                            </span>
                          )}
                        </td>
                        <td className="mono text-2 hide-sm">{short(t.feePayer)}</td>
                        <td>{t.err ? <span className="pill pill-neg">Failed</span> : <span className="pill pill-pos">Finalized</span>}</td>
                        <td className="r mono">{sol(t.fee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                No transactions in this block. Most blocks are empty when the net is quiet. <Link href="/send" className="accent">Send one →</Link>
              </div>
            )}
          </Panel>
        </div>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Timeline</span>
            <span className="muted" style={{ fontSize: 13 }}>
              from the proposal
            </span>
          </div>
          <Timeline b={b} />
        </div>
      </div>
    </>
  );
}
