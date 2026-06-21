import { listPeers } from "@llamactl/core/config/peers";

import type { AggregatorPeer } from "./aggregator.js";
import type { FleetSnapshotEntry } from "./types.js";

import { defaultFleetJournalPath, readRecentMovesFromJournal } from "./journal.js";
import {
  MigrationController,
  type MigrationControllerDeps,
  type NodeSnapshot,
} from "./migration-controller.js";
import { createPeerFetch } from "./peer-fetch.js";

export * from "./aggregator-db.js";
export * from "./aggregator.js";
export * from "./audit-reader.js";
export * from "./completion-probe.js";
export * from "./executor.js";
export * from "./infra-rollout.js";
export {
  appendFleetJournal,
  defaultFleetAuditPath,
  defaultFleetJournalPath,
  readCurrentLeaseHolder,
  readRecentMovesFromJournal,
} from "./journal.js";
export * from "./loop.js";
export * from "./measured-memory.js";
export * from "./migration-controller.js";
export * from "./node-probe.js";
export * from "./peer-fetch.js";
export { chooseBestNode, makePlacementDecision, scoreNodes } from "./placement.js";
export * from "./policy.js";
export * from "./slot-progress.js";
export * from "./snapshot-reader.js";
export * from "./status-reader.js";
export * from "./types.js";
export * from "./workload-probe.js";

export function createMigrationController(deps: MigrationControllerDeps): MigrationController {
  return new MigrationController(deps);
}

export function createEnabledMigrationController(
  deps: Omit<MigrationControllerDeps, "peers" | "fetchSnapshot" | "leaseholder"> & {
    peers?: AggregatorPeer[];
    leaseholder: string;
    fetchSnapshot: (node: string) => Promise<NodeSnapshot>;
  },
): MigrationController | null {
  if (process.env["LLAMACTL_FLEET_MOVE_ENABLED"] !== "1") return null;
  return createMigrationController({
    ...deps,
    getNowMs: deps.getNowMs ?? ((): number => Date.now()),
    peers: deps.peers?.map((peer) => peer.id) ?? listPeers().map((peer) => peer.id),
    fetchSnapshot: deps.fetchSnapshot,
    leaseholder: deps.leaseholder,
    readRecentMoves:
      deps.readRecentMoves ??
      ((): { workload: string; movedAtMs: number }[] =>
        readRecentMovesFromJournal(defaultFleetJournalPath())),
  });
}

export function createPeerSnapshotFetcher(
  peer: AggregatorPeer,
): () => Promise<FleetSnapshotEntry | null> {
  return createPeerFetch(peer);
}
