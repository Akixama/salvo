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
      <div className="wrap page-head">
        <h1 className="page-title">Mine</h1>
        <p className="text-2" style={{ margin: 0 }}>
          The balance and recent transactions of any address on this net.
        </p>
      </div>
      <div className="wrap stack">
        <form
          className="card card-pad"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) go(input);
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <input className="input" style={{ flex: "1 1 320px" }} placeholder="A Solana address" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} aria-label="Address" />
          <button className="btn" type="submit" style={{ height: 44 }}>
            Look up
          </button>
          {mine && mine !== addr && (
            <button type="button" className="btn btn-ghost" style={{ height: 44 }} onClick={() => go(mine)}>
              Use my browser wallet
            </button>
          )}
        </form>

        {!addr && (
          <div className="card empty">
            Paste an address above{mine ? ", or use the wallet this browser already has" : ""}. No wallet yet?{" "}
            <Link href="/send" className="accent">
              Make one on the Send page →
            </Link>
          </div>
        )}

        {addr && error && <div className="notice" style={{ color: "var(--neg)" }}>{error}</div>}

        {addr && !error && (
          <>
            <div className="stats" style={{ gridTemplateColumns: "minmax(0, 2fr) repeat(2, minmax(0, 1fr))" }}>
              <div className="stat">
                <div className="stat-label">
                  <TxMark id={addr} size={20} />
                  {addr === mine ? "Your browser wallet" : "Address"}
                </div>
                <div style={{ margin: "12px 0 6px" }}>
                  <Addr value={addr} head={8} tail={8} />
                </div>
                <div className="stat-sub">{data ? `seen at slot ${int(data.tip)}` : "Loading"}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Balance</div>
                <div className="stat-value">
                  {data ? sol(data.lamports) : "—"}
                  <span className="unit">SOL</span>
                </div>
                <div className="stat-sub">test SOL, no value</div>
              </div>
              <div className="stat">
                <div className="stat-label">Transactions</div>
                <div className="stat-value">{data ? txs.length : "—"}</div>
                <div className="stat-sub">{sealed ? `${sealed} sent sealed` : "latest 50 kept"}</div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <span className="card-title">Recent transactions</span>
                {data && (
                  <span className="pill" style={{ gap: 8 }}>
                    <Ind kind="live" />
                    Refreshing every 2 s
                  </span>
                )}
              </div>
              {!data ? (
                <div className="empty" style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <Ind kind="spin" /> Loading
                </div>
              ) : txs.length === 0 ? (
                <div className="empty">
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
            </div>
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
