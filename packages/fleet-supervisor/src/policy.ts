import type {
  FleetProposalAction,
  FleetProposalEntry,
  FleetTransitionEntry,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from './types.js';

export interface PressureThresholds {
  headroomMinMb: number;
  compressorWarnMb: number;
  consecutiveTicks: number;
}

interface PressureWindowEntry {
  node_mem: NodeMemSnapshot;
  workloads: WorkloadSnapshot[];
}

export class PressureWindow {
  private buf: PressureWindowEntry[] = [];
  constructor(private readonly capacity: number) {}
  push(node_mem: NodeMemSnapshot, workloads: WorkloadSnapshot[]): void {
    this.buf.push({ node_mem, workloads });
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  size(): number { return this.buf.length; }
  tail(n: number): PressureWindowEntry[] { return this.buf.slice(-n); }
}

export interface PressureResult {
  level: 'HIGH';
  transition: Pick<FleetTransitionEntry, 'subject' | 'subjectKind' | 'signal' | 'from' | 'to'>;
  proposal: Pick<FleetProposalEntry, 'transition' | 'action'>;
}

/**
 * Returns a HIGH pressure result when the last `consecutiveTicks` entries
 * all satisfy `free_mb <= headroomMinMb AND compressor_mb >= compressorWarnMb`.
 * Eviction proposal target = workload with max `rss_mb`, then alphabetical.
 */
export function detectPressure(
  window: PressureWindow,
  thresholds: PressureThresholds,
): PressureResult | null {
  const tail = window.tail(thresholds.consecutiveTicks);
  if (tail.length < thresholds.consecutiveTicks) return null;
  const allHot = tail.every((entry) =>
    entry.node_mem.free_mb <= thresholds.headroomMinMb &&
    entry.node_mem.compressor_mb >= thresholds.compressorWarnMb,
  );
  if (!allHot) return null;

  const lastWorkloads = tail[tail.length - 1]!.workloads;
  const evictTarget = pickEvictionCandidate(lastWorkloads);
  if (!evictTarget) return null;

  const action: FleetProposalAction = {
    type: 'evict',
    workload: evictTarget.name,
    reason: `sustained memory pressure: ${thresholds.consecutiveTicks} ticks below headroom + above compressor threshold`,
  };
  const transition = {
    subject: 'node',
    subjectKind: 'node' as const,
    signal: 'pressure' as const,
    from: 'NORMAL',
    to: 'HIGH',
  };
  return {
    level: 'HIGH',
    transition,
    proposal: { transition, action },
  };
}

function pickEvictionCandidate(workloads: WorkloadSnapshot[]): WorkloadSnapshot | undefined {
  if (workloads.length === 0) return undefined;
  return [...workloads]
    .filter((w) => w.reachable)
    .sort((a, b) => {
      // Lowest priority first (operators set higher priority to protect from eviction).
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Then highest RSS (frees the most memory). Null RSS is treated as 0 — no preference
      // among workloads that didn't report RSS; the alphabetical tie-break below decides.
      const rb = b.rss_mb ?? 0;
      const ra = a.rss_mb ?? 0;
      if (rb !== ra) return rb - ra;
      return a.name.localeCompare(b.name);
    })[0];
}

export interface DegradationThresholds {
  consecutiveErrorsForDegraded: number;
  p95DegradedMs: number;
}

export type WorkloadHealthState = 'healthy' | 'degraded';

export interface DegradationResult {
  to: WorkloadHealthState;
  transition: Pick<FleetTransitionEntry, 'subject' | 'subjectKind' | 'signal' | 'from' | 'to'>;
  proposal?: Pick<FleetProposalEntry, 'transition' | 'action'>;
}

/**
 * Per-workload degradation detector. Returns null when the state hasn't
 * changed from `priorState`. On healthy→degraded flip, includes a
 * restart proposal. On degraded→healthy recovery flip, transition only
 * (no proposal needed — the workload recovered on its own).
 */
export function detectDegradation(
  workload: WorkloadSnapshot,
  priorState: WorkloadHealthState,
  thresholds: DegradationThresholds,
): DegradationResult | null {
  const unhealthy =
    workload.consecutiveErrors >= thresholds.consecutiveErrorsForDegraded ||
    workload.p95_ms > thresholds.p95DegradedMs;
  const recovered = workload.reachable && workload.consecutiveErrors === 0;

  if (unhealthy && priorState !== 'degraded') {
    const transition = {
      subject: workload.name,
      subjectKind: 'workload' as const,
      signal: 'degraded' as const,
      from: priorState,
      to: 'degraded' as const,
    };
    const action: FleetProposalAction = {
      type: 'restart',
      workload: workload.name,
      reason: workload.consecutiveErrors >= thresholds.consecutiveErrorsForDegraded
        ? `consecutive errors ${workload.consecutiveErrors} ≥ ${thresholds.consecutiveErrorsForDegraded}`
        : `p95 ${workload.p95_ms}ms > ${thresholds.p95DegradedMs}ms`,
    };
    return { to: 'degraded', transition, proposal: { transition, action } };
  }
  if (recovered && priorState === 'degraded') {
    const transition = {
      subject: workload.name,
      subjectKind: 'workload' as const,
      signal: 'degraded' as const,
      from: 'degraded' as const,
      to: 'healthy' as const,
    };
    return { to: 'healthy', transition };
  }
  return null;
}

export type AdmissionDenyReason =
  | 'projected_free_below_headroom'
  | 'compressor_above_threshold';

export interface AdmissionInput {
  currentFreeGiB: number;
  expectedMemoryGiB: number;
  headroomMinGiB: number;
  safetyFactor?: number;
  /**
   * Optional compressor signal — when provided, admission also denies when
   * compressor pressure is already above threshold (matches supervisor's
   * detectPressure model). Pass both to evaluate the gemma-incident shape
   * (free is OK but compressor=2600 MB indicates pressure).
   */
  currentCompressorGiB?: number;
  compressorMaxGiB?: number;
  /**
   * When set (from a prior `llamactl admit measure` probe), the measured
   * peak RSS in MiB is used directly instead of expectedMemoryGiB × safetyFactor.
   * A 5% safety bump is applied: peakMb × 1.05 / 1024 → GiB projection.
   * This catches hand-maintained YAML underestimates (e.g. qwen3-8b declared
   * 7 GiB, actual peak 10 GiB).
   */
  measuredPeakMb?: number;
}

export type AdmissionResult =
  | { projectedFreeGiB: number; allowed: true; currentCompressorGiB?: number; source: 'measured' | 'declared' }
  | { projectedFreeGiB: number; allowed: false; reason: AdmissionDenyReason; currentCompressorGiB?: number; source: 'measured' | 'declared' };

export function projectAdmissionHeadroom(input: AdmissionInput): AdmissionResult {
  const source: 'measured' | 'declared' = input.measuredPeakMb !== undefined ? 'measured' : 'declared';
  const projectedFreeGiB = source === 'measured'
    ? input.currentFreeGiB - (input.measuredPeakMb! * 1.05) / 1024
    : input.currentFreeGiB - input.expectedMemoryGiB * (input.safetyFactor ?? 1.3);

  if (projectedFreeGiB < input.headroomMinGiB) {
    return {
      projectedFreeGiB,
      allowed: false,
      reason: 'projected_free_below_headroom',
      source,
      ...(input.currentCompressorGiB !== undefined ? { currentCompressorGiB: input.currentCompressorGiB } : {}),
    };
  }

  if (
    input.currentCompressorGiB !== undefined &&
    input.compressorMaxGiB !== undefined &&
    input.currentCompressorGiB >= input.compressorMaxGiB
  ) {
    return {
      projectedFreeGiB,
      allowed: false,
      reason: 'compressor_above_threshold',
      source,
      currentCompressorGiB: input.currentCompressorGiB,
    };
  }

  return {
    projectedFreeGiB,
    allowed: true,
    source,
    ...(input.currentCompressorGiB !== undefined ? { currentCompressorGiB: input.currentCompressorGiB } : {}),
  };
}
