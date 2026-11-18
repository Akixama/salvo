"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Keypair } from "@solana/web3.js";
import { usePoll, useNow } from "@/lib/net";
import { ago, int, sol } from "@/lib/format";
import { Addr, Ind } from "@/components/ui";
import { TxMark } from "@/components/Marks";
import { StatusPill, txStatus } from "@/components/StatusPill";
import { BigNumbers, PageHero, Panel } from "@/components/PageHero";

type Row = {
  signature: string;
  status: string;
  slot: number | null;
  err: string | null;
  sealed: boolean;
  source: string;
  fee: number;
  executedAtUs: number | null;
  receivedAtUs: number;
  change: number | null;
  feePayer: string;
};
type Data = { address: string; lamports: number; transactions: Row[]; tip: number };

function browserWallet(): string | null {
  try {
    const raw = localStorage.getItem("salvo-burner-v1");
    if (!raw) return null;
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))).publicKey.toBase58();
  } catch {
    return null;
  }
}

function Mine() {
  const params = useSearchParams();
  const router = useRouter();
  const addr = params.get("a") ?? "";
  const [input, setInput] = useState(addr);
  const [mine, setMine] = useState<string | null>(null);
  const now = useNow(1000);
  useEffect(() => setMine(browserWallet()), []);
  useEffect(() => setInput(addr), [addr]);
  const { data, error } = usePoll<Data>(addr ? `/v1/address/${addr}` : null, 2000);
  const go = (a: string) => router.push(`/mine?a=${encodeURIComponent(a.trim())}`);
  const txs = data?.transactions ?? [];
  const sealed = txs.filter((t) => t.sealed).length;

  return (
    <>
      <PageHero
        eyebrow="Any address on this net"
        title="Mine."
        sub="The balance and recent transactions of an address, refreshed every two seconds."
        aside={
          <form
            className="field-xl"
            onSubmit={(e) => {
              e.preventDefault();
              if (input.trim()) go(input);
            }}
            style={{ flexWrap: "wrap" }}
          >
            <input className="input" style={{ flex: "1 1 260px" }} placeholder="A Solana address" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} aria-label="Address" />
            <button className="btn btn-primary" type="submit">
              Look up
            </button>
            {mine && mine !== addr && (
              <button type="button" className="btn btn-quiet" onClick={() => go(mine)}>
                Use my browser wallet
              </button>
            )}
          </form>
        }
      />
      <div className="wrap page-body">
        {!addr && (
          <div className="empty" style={{ textAlign: "left", padding: 0 }}>
            Paste an address above{mine ? ", or use the wallet this browser already has" : ""}. No wallet yet?{" "}
            <Link href="/send" className="accent">
              Make one on the Send page →
            </Link>
          </div>
        )}

        {addr && error && <div className="notice" style={{ color: "var(--neg)" }}>{error}</div>}

        {addr && !error && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 32, flexWrap: "wrap" }}>
              <div>
                <div className="hn-l" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 0 }}>
                  <TxMark id={addr} size={22} />
                  {addr === mine ? "Your browser wallet" : "Address"}
                </div>
                <div style={{ marginTop: 10 }}>
                  <Addr value={addr} head={10} tail={10} />
                </div>
              </div>
              <BigNumbers
                items={[
                  { v: data ? sol(data.lamports) : "—", unit: "SOL", label: "balance, test SOL" },
                  { v: data ? txs.length : "—", label: "recent transactions" },
                  { v: data ? sealed : "—", label: "sent sealed" },
                ]}
              />
            </div>

            <Panel
              title="Recent transactions"
              action={
                data && (
                  <span className="pill" style={{ gap: 8 }}>
                    <Ind kind="live" />
                    Refreshing every 2 s
                  </span>
                )
              }
              note={data ? `Seen at slot ${int(data.tip)}. The latest 50 are kept per address.` : undefined}
            >
              {!data ? (
                <div className="empty" style={{ display: "flex", gap: 10 }}>
                  <Ind kind="spin" /> Loading
                </div>
              ) : txs.length === 0 ? (
                <div className="empty" style={{ textAlign: "left" }}>
                  Nothing here yet.{" "}
                  <Link href="/faucet" className="accent">
                    Get test SOL →
                  </Link>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Transaction</th>
                        <th>Status</th>
                        <th className="r">Change</th>
                        <th className="r hide-sm">Slot</th>
                        <th className="r hide-sm">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txs.map((t) => (
                        <tr key={t.signature} className="clickable" onClick={() => router.push(`/tx/${t.signature}`)}>
                          <td>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                              <TxMark id={t.signature} sealed={t.sealed} size={26} />
                              <Link href={`/tx/${t.signature}`} className="mono">
                                {t.signature.slice(0, 8)}…{t.signature.slice(-6)}
                              </Link>
                            </span>
                          </td>
                          <td>
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <StatusPill status={txStatus(t.status, t.sealed)} />
                              {t.sealed && t.status === "finalized" && <StatusPill status="revealed" label="Was sealed" />}
                            </span>
                          </td>
                          <td className={`r mono ${t.change && t.change > 0 ? "pos" : t.change && t.change < 0 ? "neg" : "muted"}`}>
                            {t.change == null ? "—" : `${t.change > 0 ? "+" : ""}${sol(t.change)}`}
                          </td>
                          <td className="r mono hide-sm">{t.slot ? int(t.slot) : "—"}</td>
                          <td className="r mono muted hide-sm">{ago(t.executedAtUs ?? t.receivedAtUs, now)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </>
  );
}

export default function MinePage() {
  return (
    <Suspense fallback={null}>
      <Mine />
    </Suspense>
  );
}
