export function short(s: string | undefined | null, head = 4, tail = 4): string {
  if (!s) return "";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function ms(v: number | null | undefined, digits?: number): string {
  if (v == null || !isFinite(v)) return "—";
  const d = digits ?? (v < 10 ? 1 : 0);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function int(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-US");
}

export function sol(lamports: number | null | undefined): string {
  if (lamports == null) return "—";
  const v = lamports / 1e9;
  if (v === 0) return "0";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function ago(us: number | null | undefined, nowMs: number): string {
  if (!us) return "—";
  const d = nowMs - us / 1000;
  if (d < 1000) return `${Math.max(0, Math.round(d))} ms ago`;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

export function uptime(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

export const CITY_NAMES: Record<string, string> = {
  FRA: "Frankfurt",
  LON: "London",
  NYC: "New York",
  TYO: "Tokyo",
  SIN: "Singapore",
};
