"use client";

// Numbers the copy depends on, read from the live net so the words never drift from the code.
import { useNet } from "@/lib/net";

export function useFacts() {
  const s = useNet().stats;
  const n = s?.validators ?? null;
  const t = s?.sealThreshold ?? null;
  return {
    n,
    k: s?.instances ?? null,
    delta: s?.deltaMs ?? null,
    gap: s?.targetGapMs ?? null,
    quorum: s?.quorum ?? null,
    threshold: t,
    colluders: t != null ? t - 1 : null,
    timeout: s?.timeoutMs ?? null,
  };
}

type Key = keyof ReturnType<typeof useFacts>;

/** One live number inline in a sentence. */
export function Fact({ k, fallback = "…" }: { k: Key; fallback?: string }) {
  const v = useFacts()[k];
  return <span className="num">{v == null ? fallback : Math.round(v as number).toString()}</span>;
}
