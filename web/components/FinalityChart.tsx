"use client";

import { ms } from "@/lib/format";

/** Histogram of finality samples in 10 ms bins. The bin holding the median carries the accent. */
export function FinalityChart({ samples, height = 220 }: { samples: number[]; height?: number }) {
  if (!samples.length) return <div className="empty" style={{ height }}>Waiting for samples.</div>;
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.round((sorted.length - 1) * p)];
  const p50 = pct(0.5);
  const p90 = pct(0.9);
  const p99 = pct(0.99);
  const bin = 10;
  const lo = Math.floor(pct(0.005) / bin) * bin;
  const hi = Math.ceil(pct(0.995) / bin) * bin + bin;
  const n = Math.max(1, Math.min(40, Math.round((hi - lo) / bin)));
  const counts = new Array(n).fill(0);
  for (const v of samples) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((v - lo) / bin)));
    counts[i]++;
  }
  const max = Math.max(...counts);
  const medianBin = Math.min(n - 1, Math.max(0, Math.floor((p50 - lo) / bin)));
  const W = 340;
  const H = height - 44;
  const bw = W / n;
  return (
    <div>
      <div style={{ display: "flex", gap: 20, marginBottom: 12, fontSize: 13 }}>
        <span>
          <span className="muted">p50 </span>
          <span className="mono accent">{ms(p50, 0)} ms</span>
        </span>
        <span>
          <span className="muted">p90 </span>
          <span className="mono">{ms(p90, 0)} ms</span>
        </span>
        <span>
          <span className="muted">p99 </span>
          <span className="mono">{ms(p99, 0)} ms</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 20}`} width="100%" height={H + 20} preserveAspectRatio="none" role="img" aria-label={`Block finality histogram, median ${Math.round(p50)} ms`}>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={H - H * g} y2={H - H * g} stroke="rgba(238,240,245,0.06)" />
        ))}
        {counts.map((c, i) => {
          const h = max ? (c / max) * (H - 4) : 0;
          return <rect key={i} x={i * bw + 1} y={H - h} width={Math.max(1, bw - 2)} height={h} rx={1.5} fill={i === medianBin ? "#f5a524" : "rgba(238,240,245,0.28)"} />;
        })}
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="rgba(238,240,245,0.12)" />
        <text x={0} y={H + 15} fill="#7a8296" fontSize="10" style={{ fontFamily: "var(--mono)" }}>
          {lo} ms
        </text>
        <text x={W} y={H + 15} fill="#7a8296" fontSize="10" textAnchor="end" style={{ fontFamily: "var(--mono)" }}>
          {lo + n * bin} ms
        </text>
      </svg>
      <p className="muted" style={{ fontSize: 13, margin: "12px 0 0" }}>
        From a leader sending its proposal to the block entering the merged log at the gateway.
      </p>
    </div>
  );
}
