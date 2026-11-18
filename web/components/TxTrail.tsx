"use client";

import { ms } from "@/lib/format";
import { Ind } from "./ui";

export type TxRec = {
  signature: string;
  receivedAtUs: number;
  status: string;
  includedAtUs: number | null;
  instance: number | null;
  view: number | null;
  slot: number | null;
  finalizedAtUs: number | null;
  executedAtUs: number | null;
  err: string | null;
  logs: string[];
  fee: number;
  computeUnits: number;
  copies: number;
  feePayer: string;
  accounts: string[];
  preBalances: number[];
  postBalances: number[];
  source: string;
  sealedId: string | null;
  revealedAtUs: number | null;
  revealedAs: string | null;
};

/** The stages of one transaction with the time each took from the moment the gateway got it. */
export function TxTrail({ tx }: { tx: TxRec }) {
  const t0 = tx.receivedAtUs || tx.includedAtUs || 0;
  const failed = tx.status === "failed";
  const sealed = !!tx.sealedId;
  const steps = [
    { label: sealed ? "Received sealed by the gateway" : "Received by the gateway", at: tx.receivedAtUs || null, note: "Frankfurt" },
    {
      label: sealed ? "Ordered in a block, still sealed" : "Put in a block by a leader",
      at: tx.includedAtUs,
      note: tx.instance != null ? `instance k${tx.instance}, view ${tx.view}${sealed ? ", the leader could not read it" : ""}` : "",
    },
    ...(sealed ? [{ label: "Revealed", at: tx.revealedAtUs, note: "4 of 10 validators released their key pieces after the block was final" }] : []),
    { label: sealed ? "In the merged log" : "Finalized and merged", at: tx.finalizedAtUs, note: tx.slot ? `slot ${tx.slot}` : "" },
    { label: failed ? "Executed, and failed" : "Executed", at: tx.executedAtUs, note: failed ? tx.err ?? "" : "" },
  ];
  const current = steps.findIndex((s) => !s.at);
  const last = steps.length - 1;
  return (
    <div>
      {steps.map((s, i) => {
        const kind = s.at ? (failed && i === last ? "off" : "done") : failed ? "wait" : i === current ? "spin" : "wait";
        return (
          <div key={s.label} style={{ display: "grid", gridTemplateColumns: "20px 1fr auto", gap: 12, alignItems: "center", padding: "12px 20px", borderBottom: i < last ? "1px solid var(--line)" : "none" }}>
            <Ind kind={kind as any} />
            <div>
              <div style={{ fontSize: 14 }}>{s.label}</div>
              {s.note && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {s.note}
                </div>
              )}
            </div>
            <span className="mono text-2" style={{ fontSize: 13 }}>
              {s.at && t0 ? `+${ms((s.at - t0) / 1000, 0)} ms` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
