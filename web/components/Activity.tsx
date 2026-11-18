"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type Activity, useNetStore, useNow } from "@/lib/net";
import { ms, short, sol } from "@/lib/format";
import { GlyphMark, TxMark } from "./Marks";

function ago(us: number, now: number) {
  const d = Math.max(0, now - us / 1000);
  if (d < 1500) return "just now";
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

/** Words and a link for one real event. */
export function describe(a: Activity): { title: string; meta: string; href?: string; mark: React.ReactNode } {
  switch (a.kind) {
    case "sealed":
      return {
        title: a.source === "user" ? "Your sealed send" : "Sealed send opened",
        meta: a.lamports != null ? `${sol(a.lamports)} SOL, read after final` : "read after final",
        href: a.signature ? `/tx/${a.signature}` : undefined,
        mark: <TxMark id={a.signature ?? a.sealedId ?? ""} sealed />,
      };
    case "send":
      return {
        title: a.failed ? "Transfer failed" : "Transfer final",
        meta: a.ms != null ? `in ${ms(a.ms, 0)} ms` : "",
        href: a.signature ? `/tx/${a.signature}` : undefined,
        mark: <TxMark id={a.signature ?? ""} />,
      };
    case "faucet":
      return {
        title: "Faucet grant",
        meta: `${sol(a.lamports ?? 0)} SOL to ${short(a.to)}`,
        href: a.signature ? `/tx/${a.signature}` : undefined,
        mark: <GlyphMark glyph="faucet" />,
      };
    case "lab":
      return {
        title: `Fault Lab: ${a.title ?? "run"}`,
        meta: a.status === "done" ? a.verdict ?? "Finished" : "Running now",
        href: "/lab",
        mark: <GlyphMark glyph="lab" />,
      };
  }
}

/** The newest real events on the net, sliding in as they happen. */
export function ActivityStrip({ count = 5 }: { count?: number }) {
  const store = useNetStore();
  const now = useNow(1000);
  const [items, setItems] = useState<Activity[]>([]);
  useEffect(() => {
    // Show at most one new card every 900 ms so each can be read.
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sync = () => {
      timer = null;
      last = Date.now();
      setItems(store.activity.slice(0, count));
    };
    sync();
    const off = store.onActivity(() => {
      if (timer) return;
      timer = setTimeout(sync, Math.max(0, 900 - (Date.now() - last)));
    });
    const id = setInterval(() => setItems(store.activity.slice(0, count)), 3000);
    return () => {
      off();
      clearInterval(id);
      if (timer) clearTimeout(timer);
    };
  }, [store, count]);

  if (!items.length) {
    return (
      <div className="activity">
        <div className="activity-empty">Waiting for the first event on the net. <Link href="/send" className="accent">Send one →</Link></div>
      </div>
    );
  }
  return (
    <div className="activity" aria-live="polite" style={{ ["--cols" as string]: count } as React.CSSProperties}>
      {items.map((a) => {
        const d = describe(a);
        const body = (
          <>
            {d.mark}
            <span className="activity-text">
              <span className="activity-title">{d.title}</span>
              <span className="activity-meta">
                {d.meta}
                <span className="muted"> · {ago(a.atUs, now)}</span>
              </span>
            </span>
          </>
        );
        const key = `${a.kind}-${a.atUs}-${a.signature ?? a.runId ?? ""}`;
        return d.href ? (
          <Link key={key} href={d.href} className="activity-card">
            {body}
          </Link>
        ) : (
          <div key={key} className="activity-card">
            {body}
          </div>
        );
      })}
    </div>
  );
}

// ---------- toasts ----------

type Toast = { id: number; title: string; body?: string; href?: string };
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export function toast(t: Omit<Toast, "id">) {
  const item = { ...t, id: nextId++ };
  toasts = [item, ...toasts].slice(0, 3);
  // Notify after the current render, so a toast can be raised from inside a state update.
  setTimeout(() => listeners.forEach((l) => l()), 0);
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== item.id);
    listeners.forEach((l) => l());
  }, 5000);
}

/** Toasts for things worth interrupting for: your own transactions and Fault Lab results. */
export function Toaster() {
  const store = useNetStore();
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    const off = store.onActivity((a) => {
      if (a.kind === "lab" && a.status === "done") {
        toast({ title: `Fault Lab: ${a.title}`, body: a.verdict, href: "/lab" });
      }
    });
    return () => {
      listeners.delete(l);
      off();
    };
  }, [store]);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => {
        const inner = (
          <>
            <span className="toast-ticks" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              <span className="toast-title">{t.title}</span>
              {t.body && <span className="toast-body">{t.body}</span>}
            </span>
          </>
        );
        return t.href ? (
          <Link key={t.id} href={t.href} className="toast">
            {inner}
          </Link>
        ) : (
          <div key={t.id} className="toast">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
