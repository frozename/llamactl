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

export function classifyFleetPressure(
  history: Array<{ freeMb: number; compressorMb: number }>,
  threshold: { freeMb: number; compressorMb: number; consecutiveTicks: number },
): { pressure: 'HIGH' | 'NORMAL' } {
  const tail = history.slice(-threshold.consecutiveTicks);
  const hot =
    tail.length === threshold.consecutiveTicks &&
    tail.every((row) => row.freeMb <= threshold.freeMb && row.compressorMb >= threshold.compressorMb);
  return { pressure: hot ? 'HIGH' : 'NORMAL' };
}

export function projectAdmissionHeadroom(input: {
  currentFreeGiB: number;
  expectedMemoryGiB: number;
  headroomMinGiB: number;
  safetyFactor?: number;
}): { projectedFreeGiB: number; allowed: true } | { projectedFreeGiB: number; allowed: false; reason: 'projected_free_below_headroom' } {
  const projectedFreeGiB = input.currentFreeGiB - input.expectedMemoryGiB * (input.safetyFactor ?? 1.3);
  if (projectedFreeGiB >= input.headroomMinGiB) {
    return { projectedFreeGiB, allowed: true };
  }
  return { projectedFreeGiB, allowed: false, reason: 'projected_free_below_headroom' };
}
