"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { api, rpc, useNetStore } from "@/lib/net";
import { ms, short, sol } from "@/lib/format";
import { Addr, Ind } from "@/components/ui";
import { TxTrail, type TxRec } from "@/components/TxTrail";
import { envelopeId, seal, type SealKeys } from "@/lib/seal";
import { base58, sharedWatch, type FinalityWatch } from "@/lib/finality";
import { toast } from "@/components/Activity";
import { BigNumbers, PageHero, Panel } from "@/components/PageHero";
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

type Sent = {
  /** What the net calls it while it is in flight: the envelope id for a sealed send. */
  signature: string;
  /** The real Solana signature, known in this browser as soon as it is signed. */
  sig: string;
  sealed: boolean;
  clickedAt: number;
  acceptedAt?: number;
  finalSeenAt?: number;
  tx?: TxRec;
  label: string;
};

/** Stage times for the trail. Finality itself is pushed (see FinalityWatch); this only fills in the stages. */
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
  const blockhash = useRef<{ h: string; at: number } | null>(null);
  const watcher = useRef<FinalityWatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Sent | null>(null);
  const [history, setHistory] = useState<Sent[]>([]);
  const currentRef = useRef<Sent | null>(null);
  currentRef.current = current;

  const fetchBlockhash = useCallback(async () => {
    const r = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", []);
    blockhash.current = { h: r.value.blockhash, at: Date.now() };
    return r.value.blockhash;
  }, []);

  useEffect(() => {
    setMe(loadBurner());
    setTo(Keypair.generate().publicKey.toBase58());
    // Everything a send needs is fetched now, so the click itself is one request.
    watcher.current = sharedWatch();
    rpc<SealKeys>("salvo_getSealKeys")
      .then((k) => (sealKeys.current = k))
      .catch(() => {});
    fetchBlockhash().catch(() => {});
    const id = setInterval(() => fetchBlockhash().catch(() => {}), 15000);
    return () => {
      clearInterval(id);
    };
  }, [fetchBlockhash]);

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
    // Also keeps the connection to the node warm for the next send.
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  /** The send is final: stop the clock once, toast once. */
  const finish = useCallback(
    (sig: string, failed: boolean, err?: string | null) => {
      setCurrent((c) => {
        if (!c || c.sig !== sig || c.finalSeenAt) return c;
        const next = { ...c, finalSeenAt: performance.now() };
        const took = Math.round(next.finalSeenAt - c.clickedAt);
        // State updaters can run twice in development; toast once per transaction.
        if (!toasted.has(sig)) {
          toasted.add(sig);
          toast({
            title: failed ? "Your transaction failed" : c.sealed ? "Your sealed transfer opened and is final" : "Your transaction is final",
            body: failed ? err ?? undefined : `${took.toLocaleString("en-US")} ms from your click`,
            href: `/tx/${sig}`,
          });
        }
        setHistory((h) => [next, ...h.filter((x) => x.sig !== sig)].slice(0, 8));
        return next;
      });
      refresh();
    },
    [refresh]
  );

  const onUpdate = useCallback(
    (t: TxRec) => {
      // A sealed send is tracked by its envelope id; once opened, the record is the real transaction.
      const ours = (c: Sent | null): c is Sent => !!c && (c.signature === t.signature || c.signature === t.sealedId || c.sig === t.signature);
      const c = currentRef.current;
      if (!ours(c)) return;
      setCurrent((x) => (ours(x) ? { ...x, tx: t } : x));
      // If the push was missed, the stage poll still stops the clock.
      if (t.status === "finalized" || t.status === "failed") finish(c.sig, t.status === "failed", t.err);
    },
    [finish]
  );
  useTxWatch(current?.signature ?? null, onUpdate);

  /** Start the clock and listen for finality before the request leaves, so the push cannot be missed. */
  function start(s: Omit<Sent, "clickedAt">, clickedAt: number) {
    watcher.current?.watch(s.sig, (d) => finish(s.sig, d.err != null, d.err != null ? String(d.err) : null));
    setCurrent({ ...s, clickedAt });
  }
  const accepted = (sig: string) => {
    const at = performance.now();
    setCurrent((c) => (c?.sig === sig ? { ...c, acceptedAt: at } : c));
  };

  async function faucet() {
    if (!me) return;
    setBusy(true);
    setError(null);
    const clickedAt = performance.now();
    try {
      const sig = await rpc<string>("requestAirdrop", [me.publicKey.toBase58(), 2e9]);
      start({ signature: sig, sig, sealed: false, label: "Faucet grant, 2 SOL" }, clickedAt);
      accepted(sig);
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
    let sig = "";
    try {
      const fresh = blockhash.current && Date.now() - blockhash.current.at < 30000;
      const bh = fresh ? blockhash.current!.h : await fetchBlockhash();
      // A new blockhash for the next send, so two identical sends never share a signature.
      blockhash.current = null;
      fetchBlockhash().catch(() => {});
      const tx = new Transaction({ feePayer: me.publicKey, recentBlockhash: bh }).add(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: dest, lamports }));
      tx.sign(me);
      sig = base58(tx.signature!);
      const label = `${amount} SOL to ${short(dest.toBase58())}`;
      if (sealed) {
        // Sealed sends skip the gateway's preflight: nobody can read them to simulate.
        if (!sealKeys.current) sealKeys.current = await rpc<SealKeys>("salvo_getSealKeys");
        const env = await seal(tx.serialize(), sealKeys.current);
        start({ signature: envelopeId(env), sig, sealed: true, label: `${label}, sealed` }, clickedAt);
        await rpc<string>("salvo_sendSealed", [toBase64(env)]);
      } else {
        start({ signature: sig, sig, sealed: false, label }, clickedAt);
        await rpc<string>("sendTransaction", [toBase64(tx.serialize()), { encoding: "base64" }]);
      }
      accepted(sig);
    } catch (e: any) {
      if (sig) setCurrent((c) => (c?.sig === sig ? null : c));
      setError(e.message?.includes("insufficient") || e.message?.includes("AccountNotFound") ? "Not enough test SOL. Get some from the faucet first." : e.message);
    } finally {
      setBusy(false);
    }
  }

  const address = me?.publicKey.toBase58() ?? "";
  const empty = balance === 0;
  return (
    <>
      <PageHero
        eyebrow="A wallet in this browser"
        title={
          <>
            Send a
            <br />
            transaction.
          </>
        }
        sub="Fill the wallet from the faucet, seal a transfer, and watch each stage land with its time."
        aside={
          <div>
            <div className="hn-l" style={{ marginTop: 0, marginBottom: 10 }}>
              Your browser wallet {address ? <Addr value={address} head={6} tail={6} /> : <span className="muted">creating a key</span>}
            </div>
            <BigNumbers items={[{ v: balance == null ? "—" : sol(balance), unit: "SOL", label: "balance, test SOL" }]} />
            <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
              <button className={empty ? "btn btn-accent btn-xl" : "btn btn-quiet btn-xl"} onClick={faucet} disabled={busy || !me}>
                Get 2 test SOL
              </button>
              <button className="btn btn-ghost btn-xl" onClick={refresh} aria-label="Refresh balance">
                <Refresh size={16} />
                Refresh
              </button>
            </div>
          </div>
        }
      />
      <div className="wrap split" style={{ paddingTop: 48, gap: 48 }}>
        <div className="stack" style={{ gap: 56 }}>
          <Panel title="Transfer">
            <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 160px", paddingTop: 20 }}>
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
              <button className="btn btn-accent btn-xl" onClick={send} disabled={busy || !me || empty}>
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
          </Panel>

          {history.length > 0 && (
            <Panel title="Sent from this browser">
              <div className="table-wrap">
                <table className="t">
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.sig}>
                        <td>{h.label}</td>
                        <td className="mono">
                          <Link href={`/tx/${h.sig}`}>{short(h.sig, 6, 6)}</Link>
                        </td>
                        <td className="r mono">{h.finalSeenAt ? `${ms(h.finalSeenAt - h.clickedAt, 0)} ms` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
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
                <Link href={`/tx/${current.sig}`} className="btn" style={{ marginTop: 8 }}>
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
