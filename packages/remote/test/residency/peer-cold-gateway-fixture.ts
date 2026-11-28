import type { PeerNode } from "@llamactl/core/config/peers";
import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { routingCatalog } from "@llamactl/core";

import { createProxy } from "../../src/proxy/create-proxy.js";
import { recordPeerDeclarationDenials } from "../../src/server/peer-declaration-denials.js";

const fixture = (await Bun.stdin.json()) as {
  peers: PeerNode[];
  snapshots: [string, PeerSnapshot][];
  token: string;
  body: { model: string };
  now: number;
  request?: { method?: string; query?: string; session?: string; unavailableCatalog?: boolean };
};
const nodeId = "fixture-gateway";
const snapshots = new Map(fixture.snapshots);
recordPeerDeclarationDenials(new Map(), fixture.peers, new Set(), snapshots);
const gateway = createProxy({
  env: { LLAMACTL_UNIFIED_PROXY: "1" },
  peers: fixture.peers,
  peerSnapshots: snapshots,
  nodeId,
  now: () => fixture.now,
  peerCold: { models: [fixture.body.model], credentialFor: () => fixture.token },
  catalog: () => {
    if (fixture.request?.unavailableCatalog === true)
      throw new Error("fixture catalog unavailable");
    return routingCatalog.buildRouteCatalog({ routes: [], nodeId, now: fixture.now });
  },
});
const response = await gateway.handleRequest(
  new Request(`http://gateway.invalid/v1/completions${fixture.request?.query ?? ""}`, {
    method: fixture.request?.method ?? "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gateway-client",
      ...(fixture.request?.session === undefined
        ? {}
        : { "x-llamactl-session": fixture.request.session }),
    },
    body: JSON.stringify(fixture.body),
  }),
);
process.stdout.write(
  JSON.stringify({ status: response.status, body: (await response.json()) as unknown }),
);
