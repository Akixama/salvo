// End-to-end check of sealed transactions against a running node:
//   node scripts/sealed-test.mts [rpc url]
// Seals a transfer in the browser format, sends it, and waits for it to open and run.
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { seal, envelopeId, type SealKeys } from "../lib/seal.ts";

const RPC = process.argv[2] || "http://127.0.0.1:8899";
const c = new Connection(RPC, { commitment: "finalized", wsEndpoint: RPC.replace(/^http/, "ws").replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`) });
const get = async (path: string) => (await fetch(RPC + path)).json();

const a = Keypair.generate();
const b = Keypair.generate();
const drop = await c.requestAirdrop(a.publicKey, 2 * LAMPORTS_PER_SOL);
await c.confirmTransaction({ signature: drop, ...(await c.getLatestBlockhash()) }, "finalized");

const keys: SealKeys = await get("/v1/seal");
const { blockhash } = await c.getLatestBlockhash();
const tx = new Transaction({ feePayer: a.publicKey, recentBlockhash: blockhash }).add(
  SystemProgram.transfer({ fromPubkey: a.publicKey, toPubkey: b.publicKey, lamports: 0.25 * LAMPORTS_PER_SOL })
);
tx.sign(a);
const env = await seal(tx.serialize(), keys);
const t0 = performance.now();
const res = await (await fetch(RPC + "/v1/sealed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: Buffer.from(env).toString("base64") }) })).json();
if (res.id !== envelopeId(env)) throw new Error(`id mismatch: ${JSON.stringify(res)}`);

let rec: any;
for (let i = 0; i < 100; i++) {
  rec = (await get(`/v1/tx/${res.id}`)).tx;
  if (rec?.status === "finalized" || rec?.status === "failed") break;
  await new Promise((r) => setTimeout(r, 50));
}
console.log("status", rec.status, "in", Math.round(performance.now() - t0), "ms");
console.log("sealed id", res.id.slice(0, 16), "opened as", rec.signature.slice(0, 16), "slot", rec.slot);
console.log("revealed after final:", rec.revealedAtUs >= rec.includedAtUs, "err", rec.err);
console.log("recipient balance", (await c.getBalance(b.publicKey)) / LAMPORTS_PER_SOL);
process.exit(rec.status === "finalized" ? 0 : 1);
