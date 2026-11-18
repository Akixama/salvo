// Everything that names the product lives here, so a rename is one file.
export const BRAND = {
  name: "Salvo",
  net: "Salvo Net",
  tagline: "Solana, a block every 10 ms",
  description:
    "A Solana-compatible chain that runs many consensus rounds side by side on staggered timers and merges them into one log. Built from the Gatling paper.",
  paper: {
    title: "Gatling: Rapid-Fire Consensus from Parallel Composition",
    authors: "Giulia Scaffino, Max Resnick, Joachim Neu",
    url: "https://arxiv.org/abs/2606.18220",
    code: "https://github.com/scaffino/Gatling",
  },
};

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8899";
export const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || RPC_URL.replace(/^http/, "ws") + "/events";
export const PUBLIC_RPC_LABEL = process.env.NEXT_PUBLIC_RPC_LABEL || RPC_URL;
// Solana pubsub: its own host when deployed (wss://ws.<domain>), the RPC port + 1 locally.
export const PUBSUB_URL =
  process.env.NEXT_PUBLIC_PUBSUB_URL || RPC_URL.replace(/^http/, "ws").replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`);
