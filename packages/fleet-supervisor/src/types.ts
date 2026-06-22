export interface NodeMemSnapshot {
  free_mb: number;
  active_mb: number;
  inactive_mb: number;
  wired_mb: number;
  compressor_mb: number;
  swap_in: number;
  swap_out: number;
  /** False when the probe failed or produced no parseable data. Absent means available. */
  available?: boolean;
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
  /** Forensic: the busy-guard's observed slot counters + stall count when it ran on a
   *  wedge, so a (now-prevented) false-recycle is auditable from the journal. */
  nPast?: number | null;
  nDecoded?: number | null;
  stallChecks?: number;
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
  /** Placement policy from the workload manifest; carried through from WorkloadTarget.placement. */
  placement?: string;
  rss_mb: number | null;
  request_rate_5m: number | null;
  error_rate_5m: number;
  p50_ms: number | null;
  p95_ms: number | null;
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
  /**
   * Self-published scheduler-lease intent (derived leader election). Optional:
   * old peers without it parse as undefined and are treated as ineligible
   * candidates (valid move destinations, never holders). When constructing a
   * snapshot, only include `lease` via a conditional spread — never assign
   * `lease: undefined` (exactOptionalPropertyTypes). See
   * docs/notes/2026-06-20-scheduler-lease-derived-election-design.md §1.
   */
  lease?: { candidate: string; term: number; eligible: boolean; seq: number };
  /**
   * Self-published in-flight-move intent (partition safety, design §2/§4): moves
   * this node has deployed onto a destination but not yet removed from the
   * source. Replicated so a successor that takes over the lease honors the move
   * (the existing per-workload cooldown bounds a double-move) rather than
   * starting a second copy. Optional + conditional-spread only — never assign
   * `inFlightMoves: undefined` (exactOptionalPropertyTypes). Old peers without it
   * parse as undefined (back-compat). See
   * docs/notes/2026-06-20-scheduler-lease-derived-election-design.md §2/§4.
   */
  inFlightMoves?: {
    workload: string;
    fromNode: string;
    toNode: string;
    proposalId: string;
    deployedAtMs: number;
  }[];
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

/**
 * Emitted at a loop boundary when the running source's git HEAD differs from the
 * sha captured at startup — the process is executing stale code. Emitted on EVERY
 * stale boundary (so the warning can't be missed); `reloading` is true on the
 * boundary where the debounce is satisfied and the service exits to be reloaded.
 */
export interface FleetSourceStaleEntry {
  kind: "fleet-source-stale";
  ts: string;
  node: string;
  startupRev: string;
  currentRev: string;
  reloading: boolean;
}

export interface FleetTickErrorEntry {
  kind: "fleet-tick-error";
  ts: string;
  node: string;
  message: string;
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
  | FleetSlotProgressEntry
  | FleetSourceStaleEntry
  | FleetTickErrorEntry;
