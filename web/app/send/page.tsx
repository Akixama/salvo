"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { api, rpc, useNetStore } from "@/lib/net";
import { ms, short, sol } from "@/lib/format";
import { Addr, Ind } from "@/components/ui";
import { TxTrail, type TxRec } from "@/components/TxTrail";
import { seal, type SealKeys } from "@/lib/seal";
import { toast } from "@/components/Activity";
import { Refresh } from "@/components/icons";

const KEY = "salvo-burner-v1";
const toasted = new Set<string>();

function loadBurner(): Keypair {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    /* storage blocked or corrupt: fall through to a fresh key */
  }
  const k = Keypair.generate();
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.from(k.secretKey)));
  } catch {
    /* fine: the key lives for this page only */
  }
  return k;
}

function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

type Sent = { signature: string; clickedAt: number; acceptedAt?: number; finalSeenAt?: number; tx?: TxRec; error?: string; label: string };

function useTxWatch(sig: string | null, onUpdate: (t: TxRec) => void) {
  useEffect(() => {
    if (!sig) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await api<{ tx: TxRec }>(`/v1/tx/${sig}`);
        if (!alive) return;
        onUpdate(d.tx);
        if (d.tx.status === "finalized" || d.tx.status === "failed") return;
      } catch {
        /* not seen yet */
      }
      if (alive) t = setTimeout(tick, 60);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [sig, onUpdate]);
}

export default function SendPage() {
  const store = useNetStore();
  const [me, setMe] = useState<Keypair | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [sealed, setSealed] = useState(true);
  const sealKeys = useRef<SealKeys | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Sent | null>(null);
  const [history, setHistory] = useState<Sent[]>([]);
  const currentRef = useRef<Sent | null>(null);
  currentRef.current = current;

  useEffect(() => {
    setMe(loadBurner());
    setTo(Keypair.generate().publicKey.toBase58());
  }, []);

  const refresh = useCallback(async () => {
    if (!me) return;
    try {
      const r = await rpc<{ value: number }>("getBalance", [me.publicKey.toBase58()]);
      setBalance(r.value);
    } catch {
      /* offline; keep the last value */
    }
  }, [me]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const onUpdate = useCallback(
    (t: TxRec) => {
      setCurrent((c) => {
        // A sealed send is tracked by its envelope id; once opened, the record is the real transaction.
        if (!c || (c.signature !== t.signature && c.signature !== t.sealedId)) return c;
        const done = t.status === "finalized" || t.status === "failed";
        const next = { ...c, tx: t, finalSeenAt: done && !c.finalSeenAt ? performance.now() : c.finalSeenAt };
        if (done && !c.finalSeenAt) {
          const took = Math.round((next.finalSeenAt ?? performance.now()) - c.clickedAt);
          // State updaters can run twice in development; toast once per transaction.
          if (!toasted.has(c.signature)) toasted.add(c.signature) && toast({
            title: t.status === "failed" ? "Your transaction failed" : t.sealedId ? "Your sealed transfer opened and is final" : "Your transaction is final",
            body: t.status === "failed" ? t.err ?? undefined : `${took.toLocaleString("en-US")} ms from your click`,
            href: `/tx/${t.signature}`,
          });
          setHistory((h) => [next, ...h.filter((x) => x.signature !== next.signature)].slice(0, 8));
          refresh();
        }
        return next;
      });
    },
    [refresh]
  );
  useTxWatch(current?.signature ?? null, onUpdate);

  async function faucet() {
    if (!me) return;
    setBusy(true);
    setError(null);
    const clickedAt = performance.now();
    try {
      const r = await api<{ signature: string }>("/v1/faucet", { method: "POST", body: JSON.stringify({ address: me.publicKey.toBase58() }) });
      setCurrent({ signature: r.signature, clickedAt, acceptedAt: performance.now(), label: "Faucet grant, 2 SOL" });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!me) return;
    setError(null);
    let dest: PublicKey;
    try {
      dest = new PublicKey(to.trim());
    } catch {
      setError("That is not a valid Solana address.");
      return;
    }
    const lamports = Math.round(Number(amount) * 1e9);
    if (!lamports || lamports < 0) {
      setError("Enter an amount above zero.");
      return;
    }
    setBusy(true);
    const clickedAt = performance.now();
    try {
      const bh = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", []);
      const tx = new Transaction({ feePayer: me.publicKey, recentBlockhash: bh.value.blockhash }).add(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: dest, lamports }));
      tx.sign(me);
      const label = `${amount} SOL to ${short(dest.toBase58())}`;
      if (sealed) {
        // Sealed sends skip the gateway's preflight: nobody can read them to simulate.
        if (!sealKeys.current) sealKeys.current = await api<SealKeys>("/v1/seal");
        const env = await seal(tx.serialize(), sealKeys.current);
        const r = await api<{ id: string }>("/v1/sealed", { method: "POST", body: JSON.stringify({ envelope: toBase64(env) }) });
        setCurrent({ signature: r.id, clickedAt, acceptedAt: performance.now(), label: `${label}, sealed` });
      } else {
        const sig = await rpc<string>("sendTransaction", [toBase64(tx.serialize()), { encoding: "base64" }]);
        setCurrent({ signature: sig, clickedAt, acceptedAt: performance.now(), label });
      }
    } catch (e: any) {
      setError(e.message?.includes("insufficient") || e.message?.includes("AccountNotFound") ? "Not enough test SOL. Get some from the faucet first." : e.message);
    } finally {
      setBusy(false);
    }
  }

  const address = me?.publicKey.toBase58() ?? "";
  const empty = balance === 0;
  return (
    <>
      <div className="wrap page-head">
        <h1 className="page-title">Send a transaction</h1>
        <p className="text-2" style={{ margin: 0, maxWidth: 640 }}>
          A throwaway wallet lives in this browser. Fill it from the faucet, send a transfer, and watch each stage land with its time.
        </p>
      </div>
      <div className="wrap split">
        <div className="stack">
          <div className="card card-pad">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div className="label">Your browser wallet</div>
                {address ? <Addr value={address} head={6} tail={6} /> : <span className="muted">Creating a key</span>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="label">Balance</div>
                <div style={{ fontSize: 28, lineHeight: 1, fontWeight: 500 }} className="num">
                  {balance == null ? "—" : sol(balance)}
                  <span className="muted" style={{ fontSize: 14, marginLeft: 6 }}>
                    SOL
                  </span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
              <button className={empty ? "btn btn-accent" : "btn"} onClick={faucet} disabled={busy || !me}>
                Get 2 test SOL
              </button>
              <button className="btn btn-ghost" onClick={refresh} aria-label="Refresh balance">
                <Refresh size={16} />
                Refresh
              </button>
            </div>
          </div>

          <div className="card card-pad">
            <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 160px" }}>
              <div>
                <label className="label" htmlFor="to">
                  To
                </label>
                <input id="to" className="input" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
              </div>
              <div>
                <label className="label" htmlFor="amt">
                  Amount, SOL
                </label>
                <input id="amt" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              </div>
            </div>
            <label className="seal-toggle" style={{ marginTop: 16 }}>
              <input type="checkbox" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
              <span className="seal-switch" aria-hidden="true" />
              <span>
                <span style={{ color: "var(--text)" }}>Seal it</span>
                <span className="muted" style={{ display: "block", fontSize: 13 }}>
                  Encrypted in this browser. No leader can read it until its place in the order is final.
                </span>
              </span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
              <button className="btn btn-primary btn-lg" onClick={send} disabled={busy || !me || empty}>
                {sealed ? "Seal and send" : "Send"}
              </button>
              <span className="muted" style={{ fontSize: 13 }}>
                The address is a fresh random one. Paste any Solana address instead.
              </span>
            </div>
            {error && (
              <div className="notice" style={{ marginTop: 16, color: "var(--neg)", borderColor: "rgba(229,72,77,0.25)" }}>
                {error}
              </div>
            )}
          </div>

          {history.length > 0 && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Sent from this browser</span>
              </div>
              <div className="table-wrap">
                <table className="t">
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.signature}>
                        <td>{h.label}</td>
                        <td className="mono">
                          <Link href={`/tx/${h.signature}`}>{short(h.signature, 6, 6)}</Link>
                        </td>
                        <td className="r mono">{h.finalSeenAt ? `${ms(h.finalSeenAt - h.clickedAt, 0)} ms` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="card" style={current?.finalSeenAt ? undefined : current ? { boxShadow: "0 0 0 1px rgba(245,165,36,0.35)" } : undefined}>
          <div className="card-head">
            <span className="card-title">{current ? current.label : "Your next transaction"}</span>
            {current && !current.finalSeenAt && <Ind kind="spin" />}
            {current?.finalSeenAt && <Ind kind="done" />}
          </div>
          {current?.tx ? (
            <>
              <TxTrail tx={current.tx} />
              <div style={{ padding: "16px 20px", borderTop: "1px solid var(--line)", display: "grid", gap: 8, fontSize: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">Click to accepted by the gateway</span>
                  <span className="mono">{current.acceptedAt ? `${ms(current.acceptedAt - current.clickedAt, 0)} ms` : "—"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">Click to final, seen in this browser</span>
                  <span className="mono accent">{current.finalSeenAt ? `${ms(current.finalSeenAt - current.clickedAt, 0)} ms` : "—"}</span>
                </div>
                <Link href={`/tx/${current.signature}`} className="btn" style={{ marginTop: 8 }}>
                  Open the transaction
                </Link>
              </div>
            </>
          ) : current ? (
            <div className="empty" style={{ display: "flex", gap: 10, justifyContent: "center", alignItems: "center" }}>
              <Ind kind="spin" /> Waiting for the gateway
            </div>
          ) : (
            <div className="empty">
              Stages show here as they happen: received, put in a block, finalized, executed.
              {!store.connected && <div style={{ marginTop: 8 }}>Connecting to the net.</div>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
