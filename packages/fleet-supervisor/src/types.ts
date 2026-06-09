export interface NodeMemSnapshot {
  free_mb: number; active_mb: number; inactive_mb: number;
  wired_mb: number; compressor_mb: number;
  swap_in: number; swap_out: number;
}

export interface WorkloadSnapshot {
  name: string;
  kind: 'ModelHost' | 'ModelRun';
  endpoint: string;
  /** Eviction priority (0-100). Lower = evict first. Defaults to 50 when omitted. */
  priority: number;
  rss_mb: number | null;
  request_rate_5m: number | null;
  error_rate_5m: number;
  p50_ms: number; p95_ms: number;
  models: string[];
  reachable: boolean;
  consecutiveErrors: number;
  /**
   * Boot token (the served model's `created` start time) used by cross-node
   * consumers to invalidate caches when this workload's server restarts/swaps.
   * Optional for back-compat: snapshots from older nodes omit it.
   */
  revision?: string | null;
}

export interface FleetSnapshotEntry {
  kind: 'fleet-snapshot';
  ts: string; node: string;
  node_mem: NodeMemSnapshot;
  workloads: WorkloadSnapshot[];
}

export interface FleetHeartbeatEntry { kind: 'fleet-heartbeat'; ts: string; node: string; }

export interface FleetTransitionEntry {
  kind: 'fleet-transition';
  ts: string; node: string;
  subject: string; subjectKind: 'workload' | 'node';
  signal: 'pressure' | 'pressure-cleared' | 'degraded' | 'placement';
  from: string; to: string;
}

export interface NodeScore {
  node: string;
  score: number;
  freeAfterMb: number;
  freePenaltyMb?: number;
  compressorMb: number;
  requestRate5m: number;
  eligible: boolean;
  ineligibilityReason?: string;
  pressureState?: 'NORMAL' | 'HIGH';
  modelFilePresent?: boolean;
}

export interface FleetPlacementDecision {
  workload: string;
  requestedNode: string;
  chosenNode: string;
  expectedMemoryMb: number;
  headroomMinMb: number;
  modelFilePenaltyMb: number;
  scores: NodeScore[];
}

export interface FleetPlacementEntry {
  kind: 'fleet-placement';
  ts: string;
  node: string;
  decision: FleetPlacementDecision;
}

export type FleetProposalAction =
  | { type: 'evict'; workload: string; reason: string }
  | { type: 'restart'; workload: string; reason: string }
  | { type: 'mark-degraded'; workload: string; reason: string }
  | { type: 'place'; workload: string; node: string; reason: string }
  | { type: 'move'; workload: string; fromNode: string; toNode: string; reason: string }
  | { type: 'drain'; node: string; reason: string };

export interface FleetProposalEntry {
  kind: 'fleet-proposal';
  ts: string; node: string; proposalId: string;
  transition: Pick<FleetTransitionEntry, 'subject' | 'subjectKind' | 'signal' | 'from' | 'to'>;
  action: FleetProposalAction;
  expiresAt?: string;
}

export interface FleetExecutionEntry {
  kind: 'fleet-execution';
  ts: string; node: string; proposalId: string;
  action: FleetProposalAction;
  status: 'executed' | 'skipped' | 'failed';
  reason?: string;
  exitCode?: number;
}

export function actionTier(action: FleetProposalAction): 1 | 2 | 3 {
  if (action.type === 'mark-degraded') return 2;
  if (action.type === 'place') return 1;
  if (action.type === 'move') return 2;
  if (action.type === 'drain') return 2;
  return 3; // evict | restart
}

export interface FleetPressureStatusEntry {
  kind: 'fleet-pressure-status';
  ts: string;
  node: string;
  state: 'NORMAL' | 'HIGH';
  enteredAt: string;          // ISO ts of last NORMAL→HIGH transition
  durationMs: number;         // ts - enteredAt
  consecutiveClearTicks: number;
  clearTicksNeeded: number;
  free_mb: number;            // latest probe free_mb
  compressor_mb: number;      // latest probe compressor_mb
  headroomBreach: boolean;    // free_mb < headroomMinMb
  compressorBreach: boolean;  // compressor_mb > compressorWarnMb
}

export interface FleetMoveEntry {
  /** @deprecated Moves are now represented by fleet-proposal entries where action.type === 'move'. */
  kind: 'fleet-move';
  workload: string;
  fromNode: string;
  toNode: string;
  proposalId: string;
  expiresAt: string;
  node: string;
  ts: string;
}

export interface FleetLeaseElectionEntry {
  kind: 'fleet-lease-election';
  ts: string;
  node: string;
  holder: string;
}

export interface MoveProposal {
  workload: string;
  fromNode: string;
  toNode: string;
  proposalId: string;
  expiresAt: string;
  expiresAtMs: number;
  evictProposalId: string;
  workloadMemoryMb?: number;
}

export type FleetJournalEntry =
  | FleetSnapshotEntry | FleetHeartbeatEntry
  | FleetTransitionEntry | FleetProposalEntry | FleetExecutionEntry
  | FleetPressureStatusEntry | FleetPlacementEntry | FleetMoveEntry
  | FleetLeaseElectionEntry;
