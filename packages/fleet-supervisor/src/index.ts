export * from "./types.js";
export * from "./node-probe.js";
export * from "./workload-probe.js";
export {
  appendFleetJournal,
  defaultFleetAuditPath,
  defaultFleetJournalPath,
  readCurrentLeaseHolder,
  readRecentMovesFromJournal,
} from "./journal.js";
export * from "./policy.js";
export * from "./loop.js";
export * from "./executor.js";
export * from "./measured-memory.js";
export * from "./status-reader.js";
export * from "./audit-reader.js";
export * from "./snapshot-reader.js";
export { makePlacementDecision, chooseBestNode, scoreNodes } from "./placement.js";
export * from "./aggregator.js";
export * from "./peer-fetch.js";
export * from "./aggregator-db.js";
export * from "./infra-rollout.js";
export * from "./migration-controller.js";

import { MigrationController, type MigrationControllerDeps } from "./migration-controller.js";
import { createPeerFetch } from "./peer-fetch.js";
import type { AggregatorPeer } from "./aggregator.js";
import { listPeers } from "../../remote/src/config/peers.js";
import { defaultFleetJournalPath, readRecentMovesFromJournal } from "./journal.js";

export function createMigrationController(deps: MigrationControllerDeps): MigrationController {
  return new MigrationController(deps);
}

export function createEnabledMigrationController(
  deps: Omit<MigrationControllerDeps, "peers" | "fetchSnapshot" | "leaseholder"> & {
    peers?: AggregatorPeer[];
    leaseholder: string;
    fetchSnapshot: (node: string) => Promise<import("./migration-controller.js").NodeSnapshot>;
  },
): MigrationController | null {
  if (process.env.LLAMACTL_FLEET_MOVE_ENABLED !== "1") return null;
  return createMigrationController({
    ...deps,
    getNowMs: deps.getNowMs ?? (() => Date.now()),
    peers: deps.peers?.map((peer) => peer.id) ?? listPeers().map((peer) => peer.id),
    fetchSnapshot: deps.fetchSnapshot,
    leaseholder: deps.leaseholder,
    readRecentMoves:
      deps.readRecentMoves ?? (() => readRecentMovesFromJournal(defaultFleetJournalPath())),
  });
}

export function createPeerSnapshotFetcher(
  peer: AggregatorPeer,
): () => Promise<import("./types.js").FleetSnapshotEntry | null> {
  return createPeerFetch(peer);
}
