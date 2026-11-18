"use client";

import { Ind } from "./ui";

export type Status = "final" | "sealed" | "revealed" | "included" | "received" | "failed" | "running" | "done" | "skipped";

const LOOK: Record<Status, { label: string; cls: string; ind: React.ReactNode }> = {
  final: { label: "Final", cls: "pill-pos", ind: <Ind kind="done" /> },
  done: { label: "Done", cls: "pill-pos", ind: <Ind kind="done" /> },
  sealed: { label: "Sealed", cls: "pill-accent", ind: <span className="seal-glyph" aria-hidden="true" /> },
  revealed: { label: "Revealed", cls: "pill-accent", ind: <Ind kind="done" color="var(--accent)" /> },
  included: { label: "In a block", cls: "", ind: <Ind kind="spin" /> },
  received: { label: "Waiting", cls: "", ind: <Ind kind="wait" /> },
  running: { label: "Running", cls: "pill-accent", ind: <Ind kind="spin" /> },
  failed: { label: "Failed", cls: "pill-neg", ind: <Ind kind="off" /> },
  skipped: { label: "Skipped", cls: "pill-neg", ind: <Ind kind="off" /> },
};

/** One pill per lifecycle state, each with its own small indicator. */
export function StatusPill({ status, label }: { status: Status; label?: string }) {
  const l = LOOK[status];
  return (
    <span className={`pill ${l.cls}`} style={{ gap: 6 }}>
      {l.ind}
      {label ?? l.label}
    </span>
  );
}

export function txStatus(status: string, sealed: boolean): Status {
  if (status === "finalized") return "final";
  if (status === "failed") return "failed";
  if (status === "revealed") return "revealed";
  if (status === "included") return sealed ? "sealed" : "included";
  return sealed ? "sealed" : "received";
}
