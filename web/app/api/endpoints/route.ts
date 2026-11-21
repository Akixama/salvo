import { EVENTS_URL, PUBSUB_URL, RPC_URL } from "@/lib/brand";

// The chain's addresses as of this deployment. When go-live replaces a tunnel it redeploys the
// site, so this always answers with the current ones, at an address that never changes. Pages
// that were opened before the swap ask here when their connection drops (see lib/endpoints.ts).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ rpc: RPC_URL, events: EVENTS_URL, pubsub: PUBSUB_URL }, { headers: { "cache-control": "no-store" } });
}
