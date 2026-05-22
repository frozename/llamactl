export interface NodeMemSnapshot {
  free_mb: number; active_mb: number; inactive_mb: number;
  wired_mb: number; compressor_mb: number;
  swap_in: number; swap_out: number;
}

export interface WorkloadSnapshot {
  name: string;
  kind: 'ModelHost' | 'ModelRun';
  endpoint: string;
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
  signal: 'pressure' | 'degraded';
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

export type FleetJournalEntry =
  | FleetSnapshotEntry | FleetHeartbeatEntry
  | FleetTransitionEntry | FleetProposalEntry;
