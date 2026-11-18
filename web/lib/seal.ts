// Sealed transactions, browser side. The same format as node/src/seal.rs:
//   "SLV1" | t | n | ephemeral X25519 public (32) | nonce (12) | ct_len u32 LE | ct
//   | n × share box (48) | n × sha256(share) (32)
// The transaction is encrypted under a fresh key K; K is split so any t validators can rebuild
// it, and each piece is locked to one validator. No leader can read the transaction before the
// block that carries it is final.

import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// GF(2^8) with polynomial 0x11b, as in the node.
function gfMul(a: number, b: number): number {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

/** Share i (0-based) is the polynomial evaluated at x = i + 1. */
export function split(secret: Uint8Array, t: number, n: number): Uint8Array[] {
  const coeffs = [secret, ...Array.from({ length: t - 1 }, () => random(32))];
  return Array.from({ length: n }, (_, i) => {
    const x = i + 1;
    const share = new Uint8Array(32);
    for (let b = 0; b < 32; b++) {
      let y = 0;
      for (let c = coeffs.length - 1; c >= 0; c--) y = gfMul(y, x) ^ coeffs[c][b];
      share[b] = y;
    }
    return share;
  });
}

async function aesGcm(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, k, data as BufferSource));
}

export type SealKeys = { n: number; threshold: number; keys: string[] };

/** Seal a serialized Solana transaction for the net's validators. */
export async function seal(tx: Uint8Array, sk: SealKeys): Promise<Uint8Array> {
  const pubs = sk.keys.map(hexToBytes);
  const n = pubs.length;
  const t = sk.threshold;
  const k = random(32);
  const nonce = random(12);
  const ct = await aesGcm(k, nonce, tx);
  const ephSk = random(32);
  const eph = x25519.getPublicKey(ephSk);
  const shares = split(k, t, n);
  const boxes: Uint8Array[] = [];
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const shared = x25519.getSharedSecret(ephSk, pubs[i]);
    const key = sha256(concat(enc.encode("salvo/share-key"), shared, eph, pubs[i]));
    const shareNonce = sha256(concat(enc.encode("salvo/share-nonce"), new Uint8Array([i]))).slice(0, 12);
    boxes.push(await aesGcm(key, shareNonce, shares[i]));
    hashes.push(sha256(shares[i]));
  }
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, ct.length, true);
  return concat(enc.encode("SLV1"), new Uint8Array([t, n]), eph, nonce, len, ct, ...boxes, ...hashes);
}

/** The envelope's id: what the net calls it until it opens. */
export function envelopeId(env: Uint8Array): string {
  return toHex(sha256(env));
}
