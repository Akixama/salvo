// Where the chain is reachable. These start as the addresses this page was built with, but on a
// home PC behind free tunnels they can change while the page is open: go-live replaces a dropped
// tunnel and redeploys the site. When a connection fails, callers ask the site for the current
// addresses and switch over, so an open page recovers without a refresh.

import { EVENTS_URL, PUBSUB_URL, RPC_URL } from "./brand";

export const endpoints = { rpc: RPC_URL, events: EVENTS_URL, pubsub: PUBSUB_URL };

let pending: Promise<boolean> | null = null;
let lastAsked = 0;

/** Asks the site for the chain's current addresses. Resolves true if they changed (and are now in use). */
export function refreshEndpoints(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (pending) return pending;
  // Several things notice a drop at once; one question every few seconds is plenty.
  if (Date.now() - lastAsked < 4000) return Promise.resolve(false);
  lastAsked = Date.now();
  pending = fetch(`/api/endpoints?t=${Date.now()}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: Partial<typeof endpoints> | null) => {
      if (!d?.rpc || !d.events || !d.pubsub) return false;
      if (d.rpc === endpoints.rpc && d.events === endpoints.events && d.pubsub === endpoints.pubsub) return false;
      endpoints.rpc = d.rpc;
      endpoints.events = d.events;
      endpoints.pubsub = d.pubsub;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      pending = null;
    });
  return pending;
}
