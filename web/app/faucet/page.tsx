"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/net";
import { short } from "@/lib/format";
import { Ind } from "@/components/ui";
import { PageHero, Panel } from "@/components/PageHero";
import { toast } from "@/components/Activity";

const RULES: [string, string][] = [
  ["Per grant", "2 SOL"],
  ["Per address", "3 a day"],
  ["Per connection", "10 a day"],
  ["Lasts until", "the net restarts"],
  ["Worth", "nothing: test SOL only works on this net"],
];

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
      toast({ title: "2 test SOL on the way", body: `to ${short(address.trim())}`, href: `/tx/${r.signature}` });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHero
        eyebrow="Faucet"
        title={
          <>
            Test SOL,
            <br />
            free.
          </>
        }
        sub="2 test SOL to any Solana address, final in well under a second."
        aside={
          <form onSubmit={submit}>
            <div className="field-xl">
              <input className="input" placeholder="A Solana address" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} aria-label="Address" />
              <button className="btn btn-accent" disabled={busy || address.trim().length < 32}>
                {busy ? "Sending" : "Send 2 SOL"}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              No wallet?{" "}
              <Link href="/send" className="accent">
                Use one in the browser →
              </Link>
            </div>
            {result && (
              <div className="notice" style={{ marginTop: 16 }}>
                <Ind kind="done" />
                <span>
                  Sent.{" "}
                  <Link href={`/tx/${result.signature}`} className="accent mono">
                    {short(result.signature, 8, 8)}
                  </Link>
                </span>
              </div>
            )}
            {error && (
              <div className="notice" style={{ marginTop: 16, color: "var(--neg)", borderColor: "rgba(229,72,77,0.25)" }}>
                {error}
              </div>
            )}
          </form>
        }
      />
      <div className="wrap page-body">
        <Panel title="Rules">
          <div className="rows" style={{ marginTop: 0, borderTop: "none" }}>
            {RULES.map(([k, v], i) => (
              <div key={k} className="row">
                <span className="row-n mono">{String(i + 1).padStart(2, "0")}</span>
                <span className="row-t" style={{ fontSize: 18 }}>
                  {k}
                </span>
                <span className="row-b">{v}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
