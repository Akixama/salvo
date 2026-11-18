"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EVENTS_URL, RPC_URL } from "./brand";

export type Stats = {
  name: string;
  instances: number;
  validators: number;
  deltaMs: number;
  targetGapMs: number;
  timeoutMs: number;
  slot: number;
  transactions: number;
  failedTransactions: number;
  duplicateCopies: number;
  skippedViews: number;
  sealedSubmitted: number;
  sealedRevealed: number;
  revealMs: { p50: number | null; p90: number | null };
  gapMs: { p50: number | null; p90: number | null; p99: number | null };
  blockFinalityMs: { p50: number | null; p90: number | null; p99: number | null };
  txFinalityMs: { p50: number | null; p90: number | null; p99: number | null };
  blocksPerSecond: number;
  uptimeSeconds: number;
  genesisUs: number;
  nowUs: number;
  live: boolean;
  quorum: number;
  sealThreshold: number;
};

/** A real event from the net, with the time it happened. */
export type Activity = {
  kind: "sealed" | "send" | "faucet" | "lab";
  atUs: number;
  signature?: string;
  sealedId?: string;
  lamports?: number | null;
  source?: string;
  slot?: number;
  ms?: number;
  failed?: boolean;
  to?: string;
  runId?: string;
  title?: string;
  status?: string;
  verdict?: string;
};

export type Instance = {
  instance: number;
  view: number;
  finalizedView: number;
  finalizedHeight: number;
  blocks: number;
  skipped: number;
  nextProposalUs: number;
  leader: number;
};

export type Validator = {
  id: number;
  city: string;
  cityName: string;
  identity: string;
  proposed: number;
  lastProposedAtUs: number;
  down: boolean;
};

export type BlockSummary = {
  slot: number;
  instance: number;
  view: number;
  leader: number;
  city: string;
  txs: number;
  proposedAtUs: number;
  finalizedAtUs: number;
  mergedAtUs: number;
  executedAtUs: number;
  blockhash: string;
  sealed?: number;
};

/** One (instance, view) cell of the timing diagram. */
export type Cell = { i: number; v: number; s: "p" | "n" | "f" | "x"; t: number; l?: number; n?: number; tf?: number };

export type TxEvent = { signature: string; status: string; slot?: number; err?: string | null; instance?: number; view?: number; atUs?: number };

type Listener = () => void;

/** One live connection to the net per tab. Components read from it with hooks. */
class NetStore {
  stats: Stats | null = null;
  instances: Instance[] = [];
  validators: Validator[] = [];
  blocks: BlockSummary[] = [];
  cells = new Map<string, Cell>();
  activity: Activity[] = [];
  /** Notable events (not background load) since this tab opened. */
  unseen = 0;
  connected = false;
  everConnected = false;
  clockOffsetMs = 0;
  version = 0;
  private listeners = new Set<Listener>();
  private txListeners = new Set<(e: TxEvent) => void>();
  private blockListeners = new Set<(b: BlockSummary) => void>();
  private activityListeners = new Set<(a: Activity) => void>();
  private ws: WebSocket | null = null;
  private started = false;
  private retry = 0;
  private emitScheduled = false;

  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.connect();
  }

  private connect() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(EVENTS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.everConnected = true;
      this.retry = 0;
      this.emit();
    };
    ws.onclose = () => {
      this.connected = false;
      this.emit();
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (m) => {
      try {
        this.handle(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
  }

  private scheduleReconnect() {
    this.retry = Math.min(this.retry + 1, 6);
    setTimeout(() => this.connect(), 500 * 2 ** this.retry);
  }

  /** Server time in ms, corrected for the difference between this browser's clock and the node's. */
  now() {
    return Date.now() + this.clockOffsetMs;
  }

  private setStats(s: Stats) {
    const offset = s.nowUs / 1000 - Date.now();
    // Smooth the offset so the diagram does not jump.
    this.clockOffsetMs = this.stats ? this.clockOffsetMs * 0.8 + offset * 0.2 : offset;
    this.stats = s;
  }

  private handle(msg: any) {
    if (msg.type === "snapshot") {
      this.setStats(msg.stats);
      this.instances = msg.instances;
      this.validators = msg.validators;
      this.blocks = msg.recentBlocks;
      if (msg.recentActivity) this.activity = [...msg.recentActivity].reverse();
    } else if (msg.type === "stats") {
      this.setStats(msg.stats);
      this.instances = msg.instances;
      if (msg.validators) this.validators = msg.validators;
    } else if (msg.type === "batch") {
      for (const e of msg.events) this.event(e);
      this.pruneCells();
    }
    this.emit();
  }

  private event(e: any) {
    if (e.type === "cell") {
      const key = `${e.i}:${e.v}`;
      const prev = this.cells.get(key);
      if (e.s === "p") {
        this.cells.set(key, { i: e.i, v: e.v, s: prev && prev.s !== "p" ? prev.s : "p", t: e.t / 1000, l: e.l, n: e.n, tf: prev?.tf });
      } else if (e.s === "n") {
        if (prev) {
          if (prev.s === "p") prev.s = "n";
        } else this.cells.set(key, { i: e.i, v: e.v, s: "n", t: this.expectedTime(e.i, e.v) });
      } else if (e.s === "f") {
        if (prev) {
          prev.s = "f";
          prev.tf = e.t / 1000;
        } else this.cells.set(key, { i: e.i, v: e.v, s: "f", t: this.expectedTime(e.i, e.v), tf: e.t / 1000 });
      } else if (e.s === "x") {
        if (!prev || prev.s === "p") this.cells.set(key, { i: e.i, v: e.v, s: "x", t: prev?.t ?? this.expectedTime(e.i, e.v), l: prev?.l });
      }
    } else if (e.type === "block") {
      const b: BlockSummary = e;
      // The first batch after connecting can repeat blocks already in the snapshot.
      if (this.blocks.length && b.slot <= this.blocks[0].slot) return;
      this.blocks.unshift(b);
      if (this.blocks.length > 400) this.blocks.length = 400;
      this.blockListeners.forEach((f) => f(b));
    } else if (e.type === "tx") {
      this.txListeners.forEach((f) => f(e));
    } else if (e.type === "activity") {
      const a: Activity = e;
      if (this.activity.some((x) => x.kind === a.kind && x.atUs === a.atUs && x.signature === a.signature && x.runId === a.runId)) return;
      this.activity.unshift(a);
      if (this.activity.length > 40) this.activity.length = 40;
      if (a.source !== "traffic") this.unseen++;
      this.activityListeners.forEach((f) => f(a));
    }
  }

  /** When the leader of (instance, view) was due to propose, in ms. */
  expectedTime(i: number, v: number) {
    const s = this.stats;
    if (!s) return this.now();
    return s.genesisUs / 1000 + v * s.deltaMs + (i * s.deltaMs) / s.instances;
  }

  private pruneCells() {
    const cutoff = this.now() - 4000;
    for (const [k, c] of this.cells) if (c.t < cutoff) this.cells.delete(k);
  }

  private emit() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    const run = () => {
      this.emitScheduled = false;
      this.version++;
      this.listeners.forEach((l) => l());
    };
    // A short timer, not an animation frame: frames pause in background and embedded views,
    // and the net's data arrives in 100 ms batches anyway.
    setTimeout(run, 30);
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  onTx(f: (e: TxEvent) => void) {
    this.txListeners.add(f);
    return () => {
      this.txListeners.delete(f);
    };
  }

  onActivity(f: (a: Activity) => void) {
    this.activityListeners.add(f);
    return () => {
      this.activityListeners.delete(f);
    };
  }

  markSeen() {
    this.unseen = 0;
    this.emit();
  }

  onBlock(f: (b: BlockSummary) => void) {
    this.blockListeners.add(f);
    return () => {
      this.blockListeners.delete(f);
    };
  }
}

const store = new NetStore();
const Ctx = createContext<NetStore>(store);

export function NetProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => store.start(), []);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useNetStore() {
  return useContext(Ctx);
}

// What the server renders: no connection, no data. Components see this until they have mounted,
// so the first client render always matches the server HTML, even for late-hydrating sections.
const BEFORE_MOUNT: Record<string, unknown> = {
  stats: null,
  connected: false,
  everConnected: false,
  blocks: [],
  instances: [],
  validators: [],
  activity: [],
  unseen: 0,
};

function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/** Re-render on every update (batched to a short timer). */
export function useNet() {
  const s = useContext(Ctx);
  useSyncExternalStore(
    s.subscribe,
    () => s.version,
    () => 0
  );
  const mounted = useMounted();
  if (!mounted) return new Proxy(s, { get: (t, k) => (typeof k === "string" && k in BEFORE_MOUNT ? BEFORE_MOUNT[k] : (t as any)[k]) }) as NetStore;
  return s;
}

/** A clock that ticks every `everyMs`, in server time. */
export function useNow(everyMs = 1000) {
  const s = useContext(Ctx);
  const [now, setNow] = useState(() => s.now());
  useEffect(() => {
    const id = setInterval(() => setNow(s.now()), everyMs);
    return () => clearInterval(id);
  }, [s, everyMs]);
  return now;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(RPC_URL + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) }, cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body as T;
}

export async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await r.json();
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

/** Poll a REST path while mounted. */
export function usePoll<T>(path: string | null, everyMs = 1000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!path) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await api<T>(path);
        if (alive.current) {
          setData(d);
          setError(null);
        }
      } catch (e: any) {
        if (alive.current) setError(e.message || "Request failed");
      }
      if (alive.current && everyMs > 0) t = setTimeout(tick, everyMs);
    };
    tick();
    return () => {
      alive.current = false;
      clearTimeout(t);
    };
  }, [path, everyMs]);
  return { data, error };
}
