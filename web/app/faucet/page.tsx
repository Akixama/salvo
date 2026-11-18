"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/net";
import { short } from "@/lib/format";
import { Ind } from "@/components/ui";

export default function FaucetPage() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ signature: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ signature: string }>("/v1/faucet", { method: "POST", body: JSON.stringify({ address: address.trim() }) });
      setResult(r);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="wrap page-head">
        <h1 className="page-title">Faucet</h1>
        <p className="text-2" style={{ margin: 0 }}>
          2 test SOL to any Solana address. Test SOL only works on this net and has no value.
        </p>
      </div>
      <div className="wrap split">
        <form className="card card-pad" onSubmit={submit}>
          <label className="label" htmlFor="addr">
            Address
          </label>
          <input id="addr" className="input" placeholder="A Solana address, for example from Phantom or solana-keygen" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-lg" disabled={busy || address.trim().length < 32}>
              {busy ? "Sending" : "Send 2 test SOL"}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              No wallet? <Link href="/send" className="accent">Use one in the browser</Link>
            </span>
          </div>
          {result && (
            <div className="notice" style={{ marginTop: 16 }}>
              <Ind kind="done" />
              <span>
                Sent. <Link href={`/tx/${result.signature}`} className="accent mono">{short(result.signature, 8, 8)}</Link> should be final in well under a second.
              </span>
            </div>
          )}
          {error && (
            <div className="notice" style={{ marginTop: 16, color: "var(--neg)", borderColor: "rgba(229,72,77,0.25)" }}>
              {error}
            </div>
          )}
        </form>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Rules</span>
          </div>
          <div className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
            <div>Per grant</div>
            <div className="mono">2 SOL</div>
            <div>Per address</div>
            <div className="mono">3 a day</div>
            <div>Per connection</div>
            <div className="mono">10 a day</div>
            <div>Lasts until</div>
            <div>the net restarts</div>
          </div>
        </div>
      </div>
    </>
  );
}
