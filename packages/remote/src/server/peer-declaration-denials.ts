import type { PeerNode } from "@llamactl/core/config/peers";
import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { createHash } from "node:crypto";

const MAX_RETAINED_ALIASES_PER_PEER = 1024;

type Denials = NonNullable<PeerSnapshot["declaredDenials"]>;
type History = Denials & { identity: string | undefined };
export type PeerDeclarationHistory = Map<string, History>;

export function admitsPeerDeclarationEvidence(peer: PeerNode): boolean {
  // Relay hello names are insufficient to bind a declaration to one owner.
  return (
    peer.tunnelPreferred !== true &&
    peer.endpoint.startsWith("https://") &&
    Boolean(peer.certificate?.trim()) &&
    Boolean(peer.token?.trim())
  );
}

function peerIdentity(peer: PeerNode): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        peer.id,
        peer.endpoint,
        peer.certificate,
        peer.fingerprint,
        peer.tlsServerName,
      ]),
    )
    .digest("hex");
}

function appendAliases(
  previous: History | undefined,
  identity: string,
  rows: NonNullable<PeerSnapshot["declaredProvenance"]>["entries"],
): History {
  const aliases = new Set(previous?.aliases);
  let saturated = false;
  for (const { id } of rows) {
    if (aliases.has(id)) continue;
    if (aliases.size === MAX_RETAINED_ALIASES_PER_PEER) {
      saturated = true;
      break;
    }
    aliases.add(id);
  }
  return {
    aliases,
    saturated: saturated || previous?.saturated === true,
    // A different TLS identity under the same configured name cannot clear
    // entries added by the first identity, or vice versa.
    identity: previous === undefined || previous.identity === identity ? identity : undefined,
  };
}

function applyPeerObservation(
  history: PeerDeclarationHistory,
  peer: PeerNode,
  snapshot: PeerSnapshot | undefined,
): void {
  const previous = history.get(peer.id);
  if (snapshot?.declaredProvenance !== undefined) {
    history.set(
      peer.id,
      appendAliases(previous, peerIdentity(peer), snapshot.declaredProvenance.entries),
    );
  } else if (
    snapshot?.declaredInventory?.ownerNodeId === peer.id &&
    previous?.identity === peerIdentity(peer)
  ) {
    history.delete(peer.id);
  }
}

export function recordPeerDeclarationDenials(
  history: PeerDeclarationHistory,
  peers: readonly PeerNode[],
  duplicates: ReadonlySet<string>,
  snapshots: Map<string, PeerSnapshot>,
): void {
  const configured = new Set(peers.map(({ id }) => id));
  for (const id of history.keys()) {
    if (!configured.has(id)) history.delete(id);
  }
  for (const peer of peers) {
    if (duplicates.has(peer.id) || !admitsPeerDeclarationEvidence(peer)) continue;
    applyPeerObservation(history, peer, snapshots.get(peer.id));
  }
  for (const [id, snapshot] of snapshots) {
    const { declaredInventory: _inventory, declaredDenials: _denials, ...current } = snapshot;
    const recorded = history.get(id);
    snapshots.set(
      id,
      recorded === undefined
        ? current
        : {
            ...current,
            declaredDenials: { aliases: recorded.aliases, saturated: recorded.saturated },
          },
    );
  }
}
