import type { routingCatalog } from "@llamactl/core";
import type { PeerNode } from "@llamactl/core/config/peers";
import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { PEER_ROUTE_STALE_MS } from "@llamactl/core/workloadRuntime";

import { peerDeclarationIdentity } from "../server/peer-declaration-denials.js";

type Declaration = routingCatalog.PeerDeclarationProvenanceV1["entries"][number];

export function selectPeerColdOwner(
  model: string,
  peers: readonly PeerNode[],
  snapshots: ReadonlyMap<string, PeerSnapshot>,
  now: number,
): Declaration | undefined {
  const configured = new Set(peers.map((peer) => peer.id));
  if (configured.size !== peers.length || [...snapshots.keys()].some((id) => !configured.has(id))) {
    return undefined;
  }
  let owner: Declaration | undefined;
  for (const peer of peers) {
    const snapshot = snapshots.get(peer.id);
    if (
      snapshot === undefined ||
      !snapshotIsFresh(snapshot, model, now) ||
      snapshot.declarationIdentity !== peerDeclarationIdentity(peer)
    )
      return undefined;
    const declarations = snapshot.declaredProvenance?.entries.filter((entry) => entry.id === model);
    const candidate = declarations?.[0];
    if (candidate === undefined) {
      if (
        snapshot.declaredInventory?.ownerNodeId !== peer.id ||
        snapshot.declaredDenials?.aliases.has(model) === true
      )
        return undefined;
      continue;
    }
    if (
      owner !== undefined ||
      declarations?.length !== 1 ||
      candidate.ownerNodeId !== peer.id ||
      candidate.kind !== "ModelRun" ||
      candidate.state !== "cold"
    )
      return undefined;
    owner = candidate;
  }
  return owner;
}

function snapshotIsFresh(snapshot: PeerSnapshot, model: string, now: number): boolean {
  const age = now - snapshot.fetchedAt;
  return (
    Number.isFinite(age) &&
    age >= 0 &&
    age <= PEER_ROUTE_STALE_MS &&
    snapshot.pressure === "NORMAL" &&
    snapshot.declaredDenials?.saturated !== true &&
    !snapshot.workloads.some((workload) => workload.modelId === model)
  );
}
