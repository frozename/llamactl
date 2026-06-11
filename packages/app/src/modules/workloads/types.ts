export type Phase = "Running" | "Stopped" | "Mismatch" | "Unreachable";

export interface WorkloadRow {
  name: string;
  node: string;
  rel: string;
  phase: Phase;
  endpoint: string | null;
  status: unknown;
  /**
   * E.4 — multi-node summary. `workerCount === 0` means single-node;
   * no badge is rendered. `workerNodes` is a plain string[] shown on
   * hover / for compactness. Full per-worker detail comes from
   * `workloadDescribe` when the drawer opens.
   */
  workerCount: number;
  workerNodes: string[];
}
