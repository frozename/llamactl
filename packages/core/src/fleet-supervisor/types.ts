export interface NodeMemSnapshot {
  free_mb: number;
  compressor_mb: number;
  active_mb: number;
  inactive_mb: number;
  wired_mb: number;
}

export interface WorkloadSnapshot {
  name: string;
  kind: 'ModelHost' | 'ModelRun';
  endpoint: string;
  rss_mb?: number;
  request_rate_5m?: number;
  error_rate_5m?: number;
  p50_ms?: number;
  p95_ms?: number;
  models?: string[];
  reachable: boolean;
}

export interface FleetSnapshot {
  ts: string;
  kind: 'fleet-snapshot';
  node: string;
  node_mem: NodeMemSnapshot;
  workloads: WorkloadSnapshot[];
}
