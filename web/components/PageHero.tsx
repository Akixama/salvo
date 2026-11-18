"use client";

import { SalvoBeams } from "./SalvoBeams";
import { LiveBadge } from "./Live";

/**
 * The top of every inner page: the same beams as the home hero, met on the right, with a big
 * bold title and one line on the calm left side. `aside` sits beside the title on wide screens.
 */
export function PageHero({
  eyebrow,
  title,
  sub,
  children,
  aside,
  live = true,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
  aside?: React.ReactNode;
  live?: boolean;
}) {
  return (
    <section className="page-hero">
      <SalvoBeams variant="header" />
      <div className="wrap page-hero-in">
        <div className="page-hero-main">
          <div className="page-hero-eyebrow">
            {live && <LiveBadge />}
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          </div>
          <h1 className="h-page">{title}</h1>
          {sub && <p className="page-sub">{sub}</p>}
          {children && <div className="page-hero-actions">{children}</div>}
        </div>
        {aside && <div className="page-hero-aside">{aside}</div>}
      </div>
    </section>
  );
}

/** Big numbers in a row, no boxes: the same treatment as the home hero numbers. */
export function BigNumbers({ items, align = "left" }: { items: { v: React.ReactNode; unit?: string; label: React.ReactNode }[]; align?: "left" | "center" }) {
  return (
    <div className={`bignums ${align === "center" ? "bignums-center" : ""}`}>
      {items.map((it, i) => (
        <div key={i}>
          <div className="hn-v">
            {it.v}
            {it.unit && <span className="hn-u">{it.unit}</span>}
          </div>
          <div className="hn-l">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

/** An open section: a bold title line with an optional action, then content on a hairline. */
export function Panel({ title, action, children, note }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {action}
      </div>
      <div className="panel-body">{children}</div>
      {note && <div className="panel-note">{note}</div>}
    </section>
  );
}
