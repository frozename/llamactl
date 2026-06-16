export interface NodeMemSnapshot {
  free_mb: number;
  active_mb: number;
  inactive_mb: number;
  wired_mb: number;
  compressor_mb: number;
  swap_in: number;
  swap_out: number;
}

export interface CompletionProbeSnapshot {
  /** False on ticks between the per-workload cadence — the prior result is sticky. */
  ran: boolean;
  ok: boolean;
  /** HTTP status of the last completion probe; null on timeout / network error. */
  status: number | null;
  /** Wedge counter (5xx/timeout despite /health 200). The degradation detector reads this. */
  consecutiveFailures: number;
  latencyMs: number;
  reason?: "busy" | "stall-below-threshold" | "wedge" | "idle-wedge";
  effectiveTimeoutMs?: number;
}

/**
 * One slot's progress, defensively extracted from a llama.cpp `GET /slots`
 * response. The /slots schema varies across engine builds, so every field is
 * nullable — we keep whatever numeric progress signal exists and leave the rest
 * null. Read-only: this feeds the busy-aware-probing data plan, nothing acts on
 * it yet. See docs/notes/2026-06-15-busy-aware-probing-design.md.
 */
export interface SlotProgress {
  /** Slot id if present. */
  id: number | null;
  /** Raw `state` field if present (older llama.cpp: 0 idle / non-0 processing). */
  state: number | null;
  /** Whether the slot is processing: from `is_processing`, else derived from `state !== 0`. */
  processing: boolean | null;
  /** Prompt tokens processed so far (n_past / n_prompt_tokens_processed). */
  nPast: number | null;
  /** Tokens decoded/generated so far (n_decoded / tokens_predicted). */
  nDecoded: number | null;
}

/** Result of one read-only slot-progress poll against a workload's `/slots`. */
export interface SlotProgressReading {
  /** True when the engine returned a parseable `/slots` array. */
  available: boolean;
  /** Why unavailable: HTTP status, parse failure, or endpoint rejection. */
  reason?: string;
  slots: SlotProgress[];
}

export interface WorkloadSnapshot {
  name: string;
  kind: "ModelHost" | "ModelRun";
  endpoint: string;
  /** Eviction priority (0-100). Lower = evict first. Defaults to 50 when omitted. */
  priority: number;
  rss_mb: number | null;
  request_rate_5m: number | null;
  error_rate_5m: number;
  p50_ms: number;
  p95_ms: number;
  models: string[];
  reachable: boolean;
  consecutiveErrors: number;
  /**
   * Boot token (the served model's `created` start time) used by cross-node
   * consumers to invalidate caches when this workload's server restarts/swaps.
   * Optional for back-compat: snapshots from older nodes omit it.
   */
  revision?: string | null;
  /**
   * Last completion-liveness probe result, sticky between probe ticks. Present
   * only when the workload opted into the completion probe. Catches the wedge
   * mode where /health stays 200 but completions return 5xx.
   */
  completionProbe?: CompletionProbeSnapshot;
}

export interface FleetSnapshotEntry {
  kind: "fleet-snapshot";
  ts: string;
  node: string;
  node_mem: NodeMemSnapshot;
  workloads: WorkloadSnapshot[];
}

export interface FleetHeartbeatEntry {
  kind: "fleet-heartbeat";
  ts: string;
  node: string;
}

export interface FleetTransitionEntry {
  kind: "fleet-transition";
  ts: string;
  node: string;
  subject: string;
  subjectKind: "workload" | "node";
  signal: "pressure" | "pressure-cleared" | "degraded" | "placement";
  from: string;
  to: string;
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
  pressureState?: "NORMAL" | "HIGH";
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
  kind: "fleet-placement";
  ts: string;
  node: string;
  decision: FleetPlacementDecision;
}

export type FleetProposalAction =
  | { type: "evict"; workload: string; reason: string }
  | { type: "restart"; workload: string; reason: string }
  | { type: "mark-degraded"; workload: string; reason: string }
  | { type: "place"; workload: string; node: string; reason: string }
  | { type: "move"; workload: string; fromNode: string; toNode: string; reason: string }
  | { type: "drain"; node: string; reason: string };

export interface FleetProposalEntry {
  kind: "fleet-proposal";
  ts: string;
  node: string;
  proposalId: string;
  transition: Pick<FleetTransitionEntry, "subject" | "subjectKind" | "signal" | "from" | "to">;
  action: FleetProposalAction;
  expiresAt?: string;
}

export interface FleetExecutionEntry {
  kind: "fleet-execution";
  ts: string;
  node: string;
  proposalId: string;
  action: FleetProposalAction;
  status: "executed" | "skipped" | "failed";
  reason?: string;
  exitCode?: number;
}

export function actionTier(action: FleetProposalAction): 1 | 2 | 3 {
  if (action.type === "mark-degraded") return 2;
  if (action.type === "place") return 1;
  if (action.type === "move") return 2;
  if (action.type === "drain") return 2;
  return 3; // evict | restart
}

export interface FleetPressureStatusEntry {
  kind: "fleet-pressure-status";
  ts: string;
  node: string;
  state: "NORMAL" | "HIGH";
  enteredAt: string; // ISO ts of last NORMAL→HIGH transition
  durationMs: number; // ts - enteredAt
  consecutiveClearTicks: number;
  clearTicksNeeded: number;
  free_mb: number; // latest probe free_mb
  compressor_mb: number; // latest probe compressor_mb
  headroomBreach: boolean; // free_mb < headroomMinMb
  compressorBreach: boolean; // compressor_mb > compressorWarnMb
}

/** Legacy move entry. Moves are now represented by fleet-proposal entries where action.type === 'move'. */
export interface FleetMoveEntry {
  kind: "fleet-move";
  workload: string;
  fromNode: string;
  toNode: string;
  proposalId: string;
  expiresAt: string;
  node: string;
  ts: string;
}

export interface FleetLeaseElectionEntry {
  kind: "fleet-lease-election";
  ts: string;
  node: string;
  holder: string;
}

/**
 * Read-only per-workload slot-progress sample (busy-aware-probing data plan).
 * Emitted only when the supervisor runs with `--log-slot-progress`. Never drives
 * a proposal — it exists to characterize busy-vs-wedged signatures before the
 * busy-guard is designed. See docs/notes/2026-06-15-busy-aware-probing-design.md.
 */
export interface FleetSlotProgressEntry {
  kind: "fleet-slot-progress";
  ts: string;
  node: string;
  workload: string;
  available: boolean;
  reason?: string;
  slots: SlotProgress[];
}

export interface MoveProposal {
  workload: string;
  fromNode: string;
  toNode: string;
  proposalId: string;
  expiresAt: string;
  expiresAtMs?: number;
  evictProposalId: string;
  workloadMemoryMb?: number;
}

export type FleetJournalEntry =
  | FleetSnapshotEntry
  | FleetHeartbeatEntry
  | FleetTransitionEntry
  | FleetProposalEntry
  | FleetExecutionEntry
  | FleetPressureStatusEntry
  | FleetPlacementEntry
  | FleetMoveEntry
  | FleetLeaseElectionEntry
  | FleetSlotProgressEntry;
