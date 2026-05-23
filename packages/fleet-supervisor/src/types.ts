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
  signal: 'pressure' | 'pressure-cleared' | 'degraded';
  from: string; to: string;
}

export type FleetProposalAction =
  | { type: 'evict'; workload: string; reason: string }
  | { type: 'restart'; workload: string; reason: string }
  | { type: 'mark-degraded'; workload: string; reason: string };

export interface FleetProposalEntry {
  kind: 'fleet-proposal';
  ts: string; node: string; proposalId: string;
  transition: Pick<FleetTransitionEntry, 'subject' | 'subjectKind' | 'signal' | 'from' | 'to'>;
  action: FleetProposalAction;
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
  return 3; // evict | restart
}

export interface FleetPressureStatusEntry {
  kind: 'fleet-pressure-status';
  ts: string;
  node: string;
  state: 'NORMAL' | 'HIGH';
  enteredAt: string;          // ISO ts of last NORMAL→HIGH transition (or supervisor start)
  durationMs: number;         // ts - enteredAt
  consecutiveClearTicks: number;
  clearTicksNeeded: number;
  free_mb: number;            // latest probe free_mb
  compressor_mb: number;      // latest probe compressor_mb
  headroomBreach: boolean;    // free_mb < headroomMinMb
  compressorBreach: boolean;  // compressor_mb > compressorWarnMb
}

export type FleetJournalEntry =
  | FleetSnapshotEntry | FleetHeartbeatEntry
  | FleetTransitionEntry | FleetProposalEntry | FleetExecutionEntry
  | FleetPressureStatusEntry;
