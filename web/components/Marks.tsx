"use client";

// Every item gets a mark built from the signature shape: staggered ticks.

function hashBytes(s: string): number[] {
  // FNV-1a over the string, expanded to a few bytes. Deterministic, no crypto needed.
  let h = 2166136261;
  const out: number[] = [];
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) + r;
      h = Math.imul(h, 16777619) >>> 0;
    }
    out.push(h & 0xff);
  }
  return out;
}

/**
 * A block's place in the salvo: one tick per instance, staggered like the timing diagram,
 * with this block's instance lit.
 */
export function BlockMark({ instance, k = 24, size = 28 }: { instance: number; k?: number; size?: number }) {
  const cols = Math.min(k, 12);
  const rows = Math.ceil(k / cols);
  const pad = 4;
  const w = (size - pad * 2) / cols;
  const lit = instance;
  const bars = [];
  for (let i = 0; i < k; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const h = (size - pad * 2) / rows - 2;
    const y = pad + r * ((size - pad * 2) / rows) + (c / cols) * 2;
    bars.push(<rect key={i} x={pad + c * w + w * 0.25} y={y} width={Math.max(1, w * 0.5)} height={h} rx={0.6} fill={i === lit ? "#f5a524" : "rgba(238,240,245,0.18)"} />);
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mark" aria-hidden="true">
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} rx={7} fill="#11141c" stroke="rgba(238,240,245,0.1)" />
      {bars}
    </svg>
  );
}

/** A transaction's mark: five ticks whose heights come from its id; sealed ones get a closed frame. */
export function TxMark({ id, sealed = false, size = 28 }: { id: string; sealed?: boolean; size?: number }) {
  const b = hashBytes(id || "x");
  const ticks = [0, 1, 2, 3, 4].map((i) => {
    const h = 6 + (b[i] % 11);
    const x = 6 + i * 4;
    return <rect key={i} x={x} y={size / 2 - h / 2 + (i - 2) * 0.8} width={2} height={h} rx={1} fill={i === b[5] % 5 ? "#f5a524" : "rgba(238,240,245,0.55)"} />;
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mark" aria-hidden="true">
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} rx={7} fill="#11141c" stroke={sealed ? "rgba(245,165,36,0.6)" : "rgba(238,240,245,0.1)"} strokeDasharray={sealed ? "2 2" : undefined} />
      {ticks}
    </svg>
  );
}

/** A small mark for events that are not blocks or transactions. */
export function GlyphMark({ glyph, size = 28 }: { glyph: "faucet" | "lab"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mark" aria-hidden="true">
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} rx={7} fill="#11141c" stroke="rgba(238,240,245,0.1)" />
      <g transform={`translate(${size / 2 - 8} ${size / 2 - 8}) scale(0.667)`} fill="none" stroke="#a3a9b8" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {glyph === "faucet" ? (
          <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5.5 12 3c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7z" />
        ) : (
          <path d="M10 2v7.5L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V2M8.5 2h7M7 16h10" />
        )}
      </g>
    </svg>
  );
}
