"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "./icons";
import { short } from "@/lib/format";

/** Small status marks: live pulse, running arc, waiting ring, drawn check. */
export function Ind({ kind, color }: { kind: "live" | "spin" | "wait" | "done" | "off"; color?: string }) {
  const style = color ? ({ ["--c" as any]: color } as React.CSSProperties) : undefined;
  if (kind === "done")
    return (
      <svg className="ind ind-check" viewBox="0 0 12 12" style={{ color: color || "var(--pos)" }} aria-hidden="true">
        <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (kind === "off")
    return (
      <span className="ind" aria-hidden="true">
        <span style={{ position: "absolute", inset: 3, borderRadius: "50%", background: color || "var(--neg)" }} />
      </span>
    );
  if (kind === "live")
    // Three ticks firing in turn: a tiny salvo.
    return (
      <span className="ind ind-live" style={style} aria-hidden="true">
        <i style={{ animationDelay: "0.15s" }} />
      </span>
    );
  return <span className={`ind ind-${kind}`} style={style} aria-hidden="true" />;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn"
      aria-label={label || "Copy"}
      title={label || "Copy"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function Addr({ value, head = 4, tail = 4, copy = true }: { value: string; head?: number; tail?: number; copy?: boolean }) {
  return (
    <span className="addr" title={value}>
      {short(value, head, tail)}
      {copy && <CopyButton text={value} />}
    </span>
  );
}

/** A number that eases to its new value instead of jumping. */
export function Tween({ value, format, duration = 500 }: { value: number | null | undefined; format: (v: number) => string; duration?: number }) {
  const [shown, setShown] = useState<number | null>(null);
  // The value currently on screen; each new target eases from here, and the first one from zero.
  const current = useRef<number>(0);
  const raf = useRef(0);
  useEffect(() => {
    if (value == null) return;
    const start = current.current;
    const t0 = performance.now();
    cancelAnimationFrame(raf.current);
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      const v = start + (value - start) * e;
      current.current = v;
      setShown(v);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);
  return <>{shown == null ? "—" : format(shown)}</>;
}

export function Stat({ label, value, unit, sub, ind }: { label: React.ReactNode; value: React.ReactNode; unit?: string; sub?: React.ReactNode; ind?: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {ind}
        {label}
      </div>
      <div className="stat-value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** A tiny ring that empties as `remaining` goes from `total` to zero. */
export function CountdownRing({ remaining, total, size = 14 }: { remaining: number; total: number; size?: number }) {
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, remaining / total));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        strokeLinecap="round"
      />
    </svg>
  );
}
