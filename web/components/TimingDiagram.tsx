"use client";

import { useEffect, useRef } from "react";
import { useNetStore } from "@/lib/net";

const C = {
  text: "#eef0f5",
  text2: "#a3a9b8",
  muted: "#7a8296",
  line: "rgba(238,240,245,0.07)",
  ghost: "rgba(238,240,245,0.16)",
  accent: "#f5a524",
  accentMid: "rgba(245,165,36,0.55)",
  skip: "rgba(229,72,77,0.75)",
};

/**
 * One row per consensus instance. Each mark is a proposal at the time its leader sent it:
 * hollow when proposed, half when notarized, solid when finalized, red when the view was
 * skipped. Faint ticks to the right of "now" are the schedule still to come. The strip at the
 * bottom is the merged log: every block in the order the whole net agreed on.
 */
export function TimingDiagram({ rowHeight = 9, pastMs = 1400, futureMs = 360, labels = true, height }: { rowHeight?: number; pastMs?: number; futureMs?: number; labels?: boolean; height?: number }) {
  const store = useNetStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const k = store.stats?.instances ?? 24;
  const stripH = 28;
  const topPad = 20;
  const total = height ?? topPad + k * rowHeight + 14 + stripH + 8;

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      const r = box.current!.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box.current!);
    let raf = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Canvas fonts cannot read CSS variables, so resolve the mono family once.
    const monoFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim() || "ui-monospace, monospace";
    const font = `10px ${monoFamily}`;
    let lastDraw = 0;

    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (reduce && ts - lastDraw < 500) return;
      lastDraw = ts;
      const s = store.stats;
      const K = s?.instances ?? k;
      const narrow = w < 560;
      const past = narrow ? pastMs * 0.55 : pastMs;
      const future = narrow ? futureMs * 0.6 : futureMs;
      const labelW = labels && !narrow ? 64 : 8;
      const plotW = Math.max(10, w - labelW - 8);
      const pxPerMs = plotW / (past + future);
      const now = store.now();
      const xNow = labelW + past * pxPerMs;
      const X = (t: number) => xNow + (t - now) * pxPerMs;
      const rh = rowHeight;
      const rowsTop = topPad;
      const stripTop = rowsTop + K * rh + 14;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // time grid every 100 ms
      ctx.font = font;
      ctx.textBaseline = "middle";
      const step = 100;
      const first = Math.ceil((now - past) / step) * step;
      for (let t = first; t <= now + future; t += step) {
        const x = Math.round(X(t)) + 0.5;
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, rowsTop - 4);
        ctx.lineTo(x, stripTop + stripH);
        ctx.stroke();
        const rel = Math.round((t - now) / 100) * 100;
        if (rel % 500 === 0 && rel !== 0) {
          ctx.fillStyle = C.muted;
          ctx.textAlign = "center";
          ctx.fillText(`${rel > 0 ? "+" : ""}${rel} ms`, x, 8);
        }
      }

      // row labels
      if (labels && !narrow && s) {
        ctx.textAlign = "left";
        for (let i = 0; i < K; i++) {
          if (rh < 10 && i % 4 !== 0) continue;
          const y = rowsTop + i * rh + rh / 2;
          ctx.fillStyle = C.muted;
          ctx.fillText(`+${Math.round((i * s.deltaMs) / K)} ms`, 0, y);
        }
        ctx.fillStyle = C.text2;
        ctx.fillText("merged", 0, stripTop + stripH / 2);
      }

      // the schedule still to come
      if (s) {
        for (let i = 0; i < K; i++) {
          const y = rowsTop + i * rh;
          const off = (i * s.deltaMs) / K;
          const base = s.genesisUs / 1000 + off;
          let v = Math.ceil((now - 30 - base) / s.deltaMs);
          for (; ; v++) {
            const t = base + v * s.deltaMs;
            if (t > now + future) break;
            const x = X(t);
            ctx.fillStyle = C.ghost;
            ctx.fillRect(Math.round(x), y + 2, 1, rh - 3);
          }
        }
      }

      // proposals
      const mw = Math.max(2, Math.min(4, pxPerMs * 4));
      for (const c of store.cells.values()) {
        const x = X(c.t);
        if (x < labelW - 4 || x > w) continue;
        const y = rowsTop + c.i * rh + 1;
        const hh = rh - 2;
        if (c.s === "f") {
          ctx.fillStyle = C.accent;
          ctx.fillRect(x - mw / 2, y, mw, hh);
        } else if (c.s === "n") {
          ctx.fillStyle = C.accentMid;
          ctx.fillRect(x - mw / 2, y, mw, hh);
        } else if (c.s === "p") {
          ctx.strokeStyle = C.accent;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - mw / 2 + 0.5, y + 0.5, mw - 1, hh - 1);
        } else if (c.s === "x") {
          ctx.strokeStyle = C.skip;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x - 2.5, y + 1);
          ctx.lineTo(x + 2.5, y + hh - 1);
          ctx.moveTo(x + 2.5, y + 1);
          ctx.lineTo(x - 2.5, y + hh - 1);
          ctx.stroke();
        }
      }

      // the merged log
      ctx.fillStyle = "rgba(238,240,245,0.03)";
      ctx.fillRect(labelW - 4, stripTop, plotW + 8, stripH);
      ctx.fillStyle = C.text;
      for (const b of store.blocks) {
        const t = b.proposedAtUs / 1000;
        if (t < now - past - 50) break;
        const x = X(t);
        if (x < labelW - 2) continue;
        const age = now - b.mergedAtUs / 1000;
        ctx.globalAlpha = age < 250 ? 0.55 + 0.45 * (age / 250) : 1;
        ctx.fillRect(Math.round(x), stripTop + 5, Math.max(1.5, mw * 0.6), stripH - 10);
      }
      ctx.globalAlpha = 1;

      // now
      ctx.strokeStyle = "rgba(245,165,36,0.5)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(xNow) + 0.5, rowsTop - 6);
      ctx.lineTo(Math.round(xNow) + 0.5, stripTop + stripH + 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.accent;
      ctx.textAlign = "center";
      ctx.fillText("now", xNow, 8);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [store, k, rowHeight, pastMs, futureMs, labels]);

  return (
    <div ref={box} style={{ position: "relative", width: "100%", height: total }}>
      <canvas ref={canvas} role="img" aria-label="Live timing diagram: proposals from each consensus instance and the merged log" />
    </div>
  );
}

export function DiagramLegend() {
  const item = (el: React.ReactNode, label: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {el}
      {label}
    </span>
  );
  const box = (style: React.CSSProperties) => <span style={{ display: "inline-block", width: 4, height: 10, borderRadius: 1, ...style }} />;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", fontSize: 13, color: "var(--text-2)" }}>
      {item(box({ border: "1px solid var(--accent)" }), "Proposed")}
      {item(box({ background: "var(--accent-dim)" }), "Notarized")}
      {item(box({ background: "var(--accent)" }), "Finalized")}
      {item(<span style={{ color: "var(--neg)", fontSize: 12, lineHeight: 1 }}>✕</span>, "Skipped view")}
      {item(box({ background: "var(--text)", width: 2 }), "In the merged log")}
    </div>
  );
}
