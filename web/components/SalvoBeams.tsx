"use client";

import { useEffect, useRef } from "react";
import { useNetStore } from "@/lib/net";

/**
 * The hero: one beam per consensus instance, fanned out on the left and converging into a single
 * line, the merged log. A pulse runs down beam k whenever instance k is due to propose, on the
 * net's real schedule, and a pulse runs along the merged line for every block that enters the log.
 */
export function SalvoBeams() {
  const store = useNetStore();
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    let w = 0;
    let h = 0;
    let dpr = 1;

    // A soft glow sprite, drawn once and stamped for every pulse.
    const sprite = document.createElement("canvas");
    const S = 64;
    sprite.width = sprite.height = S;
    const sg = sprite.getContext("2d")!;
    const grad = sg.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, "rgba(255,236,200,1)");
    grad.addColorStop(0.12, "rgba(255,196,92,0.9)");
    grad.addColorStop(0.4, "rgba(245,165,36,0.25)");
    grad.addColorStop(1, "rgba(245,165,36,0)");
    sg.fillStyle = grad;
    sg.fillRect(0, 0, S, S);

    type Pulse = { beam: number; t0: number; dur: number };
    let pulses: Pulse[] = [];
    let merged: { t0: number }[] = [];
    let queue = 0;
    let lastScheduleCheck = store.now();

    const resize = () => {
      const r = cv.parentElement!.getBoundingClientRect();
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
    ro.observe(cv.parentElement!);

    const offBlock = store.onBlock(() => {
      queue = Math.min(queue + 1, 60);
    });

    const K = () => store.stats?.instances ?? 24;
    const focal = () => ({ x: w < 640 ? w * 0.56 : w * 0.5, y: h * (w < 640 ? 0.9 : 0.86) });

    // Beam k: a cubic curve from the left edge into the focal point.
    const beamPoint = (k: number, t: number) => {
      const n = K();
      const f = focal();
      const spread = h * 0.62;
      const y0 = f.y - spread * 0.55 + (spread * k) / Math.max(1, n - 1);
      const x0 = -w * 0.04;
      const c1x = w * 0.22;
      const c1y = y0;
      const c2x = f.x - w * 0.16;
      const c2y = f.y;
      const u = 1 - t;
      return {
        x: u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * f.x,
        y: u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * f.y,
      };
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = store.now();
      const s = store.stats;
      const n = K();
      const f = focal();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // The horizon glow where the beams meet.
      const hg = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, Math.max(w, h) * 0.55);
      hg.addColorStop(0, "rgba(245,165,36,0.16)");
      hg.addColorStop(0.35, "rgba(245,165,36,0.05)");
      hg.addColorStop(1, "rgba(245,165,36,0)");
      ctx.fillStyle = hg;
      ctx.fillRect(0, 0, w, h);

      // Beams.
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1;
      for (let k = 0; k < n; k++) {
        ctx.strokeStyle = `rgba(245,165,36,${0.11 + 0.08 * Math.sin((k / n) * Math.PI)})`;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const p = beamPoint(k, i / 40);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      // The merged log: one line out to the right.
      const lg = ctx.createLinearGradient(f.x, 0, w, 0);
      lg.addColorStop(0, "rgba(255,226,170,0.55)");
      lg.addColorStop(1, "rgba(255,226,170,0.12)");
      // A wide soft pass, then the bright core.
      const lw = ctx.createLinearGradient(f.x, 0, w, 0);
      lw.addColorStop(0, "rgba(245,165,36,0.22)");
      lw.addColorStop(1, "rgba(245,165,36,0.03)");
      ctx.strokeStyle = lw;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(w + 10, f.y);
      ctx.stroke();
      ctx.strokeStyle = lg;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(w + 10, f.y);
      ctx.stroke();

      if (!reduce && s) {
        // Fire beam pulses on the real proposal schedule: instance k at genesis + v·Δ + k·Δ/K.
        const gap = s.deltaMs / n;
        const base = s.genesisUs / 1000;
        const from = Math.max(lastScheduleCheck, now - 200);
        const firstTick = Math.ceil((from - base) / gap);
        for (let j = firstTick; base + j * gap <= now; j++) {
          pulses.push({ beam: ((j % n) + n) % n, t0: base + j * gap, dur: 700 });
        }
        lastScheduleCheck = now;

        // Release merged-block pulses smoothly: blocks arrive from the stream in small batches.
        if (queue > 0 && (!merged.length || now - merged[merged.length - 1].t0 > Math.max(4, gap * 0.6))) {
          merged.push({ t0: now });
          queue--;
        }

        pulses = pulses.filter((p) => now - p.t0 < p.dur);
        for (const p of pulses) {
          const t = Math.min(1, (now - p.t0) / p.dur);
          const e = t * t * (3 - 2 * t);
          for (let tr = 0; tr < 6; tr++) {
            const tt = Math.max(0, e - tr * 0.025);
            const q = beamPoint(p.beam, tt);
            const a = (1 - tr / 6) * (0.35 + 0.65 * e);
            const size = (tr === 0 ? 22 : 14) * (0.6 + 0.4 * e);
            ctx.globalAlpha = a;
            ctx.drawImage(sprite, q.x - size / 2, q.y - size / 2, size, size);
          }
        }

        const runMs = 1600;
        merged = merged.filter((m) => now - m.t0 < runMs);
        for (const m of merged) {
          const t = (now - m.t0) / runMs;
          const x = f.x + (w - f.x + 20) * t;
          ctx.globalAlpha = 1 - t * 0.7;
          ctx.drawImage(sprite, x - 14, f.y - 14, 28, 28);
        }
        ctx.globalAlpha = 1;

        // The meeting point burns steadily while blocks are flowing.
        const flowing = merged.length > 0;
        ctx.globalAlpha = flowing ? 1 : 0.5;
        ctx.drawImage(sprite, f.x - 34, f.y - 34, 68, 68);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offBlock();
    };
  }, [store]);

  return <canvas ref={canvas} className="beams" aria-hidden="true" />;
}
