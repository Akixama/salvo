// Hear about finality the moment it happens, instead of asking over and over.
// One Solana pubsub socket, opened when the page mounts so it is warm before the first click.

import { PUBSUB_URL } from "./brand";

type Done = { err: unknown };
type Waiter = (d: Done) => void;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58, for turning a signed transaction's first signature into its id. */
export function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export class FinalityWatch {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private byReq = new Map<number, string>();
  private bySub = new Map<number, string>();
  private waiters = new Map<string, Waiter>();
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private url = PUBSUB_URL) {
    this.open();
  }

  private open() {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      // Subscriptions do not survive a reconnect; ask again for anything still waiting.
      for (const sig of this.waiters.keys()) this.subscribe(sig);
    };
    ws.onmessage = (e) => {
      let m: any;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (typeof m.id === "number" && typeof m.result === "number") {
        const sig = this.byReq.get(m.id);
        this.byReq.delete(m.id);
        if (sig) this.bySub.set(m.result, sig);
      } else if (m.method === "signatureNotification") {
        const sig = this.bySub.get(m.params?.subscription);
        if (!sig) return;
        this.bySub.delete(m.params.subscription);
        const w = this.waiters.get(sig);
        this.waiters.delete(sig);
        w?.({ err: m.params?.result?.value?.err ?? null });
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.bySub.clear();
      this.byReq.clear();
      if (!this.closed) this.retry = setTimeout(() => this.open(), 1500);
    };
  }

  private subscribe(sig: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    this.byReq.set(id, sig);
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "signatureSubscribe", params: [sig, { commitment: "finalized" }] }));
  }

  /** Calls back once when the transaction is final (or failed). Subscribe before sending it. */
  watch(sig: string, cb: Waiter) {
    this.waiters.set(sig, cb);
    this.subscribe(sig);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }
}

let shared: FinalityWatch | null = null;

/** One socket for the whole site, opened on the first page so it is ready before anyone sends. */
export function sharedWatch(): FinalityWatch | null {
  if (typeof window === "undefined") return null;
  return (shared ??= new FinalityWatch());
}
