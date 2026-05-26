export * from './types.js';
export * from './node-probe.js';
export * from './workload-probe.js';
export { appendFleetJournal, defaultFleetAuditPath, defaultFleetJournalPath } from './journal.js';
export * from './policy.js';
export * from './loop.js';
export * from './executor.js';
export * from './measured-memory.js';
export * from './status-reader.js';
export * from './audit-reader.js';
export * from './snapshot-reader.js';
export { makePlacementDecision, chooseBestNode, scoreNodes } from './placement.js';
export * from './aggregator.js';
export * from './peer-fetch.js';
export * from './aggregator-db.js';
export * from './infra-rollout.js';
export * from './migration-controller.js';

import { MigrationController, type MigrationControllerDeps } from './migration-controller.js';

// Phase 4 gate — set LLAMACTL_FLEET_MOVE_ENABLED=1 to enable cross-node moves
export function createMigrationController(deps: MigrationControllerDeps): MigrationController | null {
  if (process.env.LLAMACTL_FLEET_MOVE_ENABLED === '1') {
    return new MigrationController(deps);
  }
  return null;
}
