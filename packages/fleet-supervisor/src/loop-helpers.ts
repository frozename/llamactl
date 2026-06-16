import type {
  MigrationController,
  MigrationWorkload,
  NodeSnapshot,
} from "./migration-controller.js";
import type {
  DegradationThresholds,
  PressureResult,
  PressureThresholds,
  PressureWindow,
  WorkloadHealthState,
} from "./policy.js";
import type { readSlotProgress as defaultReadSlotProgress } from "./slot-progress.js";
import type {
  CompletionProbeSnapshot,
  FleetJournalEntry,
  FleetPressureStatusEntry,
  FleetProposalEntry,
  FleetTransitionEntry,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from "./types.js";
import type { WorkloadProbeResult, WorkloadTarget } from "./workload-probe.js";

import {
  applyBusyGuard,
  probeCompletion as defaultProbeCompletion,
  effectiveTimeout,
  pushLatencySample,
} from "./completion-probe.js";
import { detectDegradation, isPressureHot } from "./policy.js";
import { probeWorkload as defaultProbeWorkload, redactEndpoint } from "./workload-probe.js";

export interface LoopState {
  consecutiveErrors: Map<string, number>;
  pressureWindow: PressureWindow;
  lastPressureLevel: "NORMAL" | "HIGH";
  consecutiveClearTicks: number;
  enteredHighAt: string | null;
  ticksInHigh: number;
  workloadHealth: Map<string, WorkloadHealthState>;
  seenProposalIds: Set<string>;
}

export function makeDedupJournalWriter(
  inner: (entry: FleetJournalEntry) => void,
  seenProposalIds: Set<string>,
): (entry: FleetJournalEntry) => void {
  return (entry: FleetJournalEntry): void => {
    if (entry.kind === "fleet-proposal" && seenProposalIds.has(entry.proposalId)) return;
    if (entry.kind === "fleet-proposal") {
      seenProposalIds.add(entry.proposalId);
    }
    inner(entry);
  };
}

/** Per-workload state for the completion-liveness probe, held across ticks. */
export interface CompletionProbeState {
  consecutiveFailures: Map<string, number>;
  tickCounter: Map<string, number>;
  lastResult: Map<string, CompletionProbeSnapshot>;
  lastSlotProgress?: Map<
    string,
    { nPast: number | null; nDecoded: number | null; stallChecks: number }
  >;
  latencySamples?: Map<string, number[]>;
  /** Injectable for tests; defaults to the real completion probe. */
  probe?: typeof defaultProbeCompletion;
  readSlotProgress?: typeof defaultReadSlotProgress;
  allowPublicEndpoints?: boolean;
}

export interface ProbeFnDeps {
  fetch: typeof globalThis.fetch | undefined;
  timeoutMs: number;
  consecutiveErrors: Map<string, number>;
  completion?: CompletionProbeState;
}

function clearCompletionProbeState(state: CompletionProbeState, name: string): void {
  state.consecutiveFailures.delete(name);
  state.tickCounter.delete(name);
  state.lastResult.delete(name);
  state.lastSlotProgress?.delete(name);
  state.latencySamples?.delete(name);
}

async function applyCompletionBusyGuard(
  target: WorkloadTarget,
  config: NonNullable<WorkloadTarget["completionProbe"]>,
  result: Awaited<ReturnType<typeof defaultProbeCompletion>>,
  state: CompletionProbeState,
  deps: ProbeFnDeps,
  priorConsecutiveFailures: number,
): Promise<{ consecutiveFailures: number; reason?: CompletionProbeSnapshot["reason"] }> {
  if (result.classification !== "wedge" || !state.readSlotProgress) {
    return { consecutiveFailures: result.consecutiveFailures };
  }

  const reading = await state.readSlotProgress(target.endpoint, {
    fetch: deps.fetch,
    timeoutMs: config.timeoutMs,
    allowPublicEndpoints: state.allowPublicEndpoints,
  });
  const guarded = applyBusyGuard({
    classification: result.classification,
    prior: priorConsecutiveFailures,
    reading,
    lastProgress: state.lastSlotProgress?.get(target.name),
    busyStallChecks: config.busyStallChecks ?? 2,
  });
  if (guarded.nextProgress) {
    state.lastSlotProgress?.set(target.name, guarded.nextProgress);
  }
  return { consecutiveFailures: guarded.consecutiveFailures, reason: guarded.reason };
}

async function runCompletionProbe(
  target: WorkloadTarget,
  health: WorkloadProbeResult,
  deps: ProbeFnDeps,
): Promise<CompletionProbeSnapshot | undefined> {
  const config = target.completionProbe;
  const state = deps.completion;
  if (!config || !state) return undefined;

  // The completion probe only signals the wedge that hides behind /health 200.
  // When /health itself fails, the health path drives degradation — clear the
  // completion state so the wedge counter starts fresh on recovery.
  if (!health.reachable) {
    clearCompletionProbeState(state, target.name);
    return undefined;
  }

  const tick = state.tickCounter.get(target.name) ?? 0;
  state.tickCounter.set(target.name, tick + 1);
  if (tick % config.everyNTicks !== 0) {
    // Between cadence ticks the prior result is sticky so the degradation state
    // machine stays consistent.
    const last = state.lastResult.get(target.name);
    return last ? { ...last, ran: false } : undefined;
  }

  const probe = state.probe ?? defaultProbeCompletion;
  const priorConsecutiveFailures = state.consecutiveFailures.get(target.name) ?? 0;
  const latencySamples = state.latencySamples?.get(target.name) ?? [];
  const sampleCountBeforeProbe = latencySamples.length;
  const effectiveTimeoutMs = effectiveTimeout({
    samples: latencySamples,
    base: config.timeoutMs,
    k: config.k ?? 3,
    max: config.maxTimeoutMs ?? 600_000,
    minSamples: config.minSamples ?? 5,
  });
  const result = await probe(target.endpoint, {
    config: { ...config, timeoutMs: effectiveTimeoutMs },
    models: health.models,
    fetch: deps.fetch,
    priorConsecutiveFailures,
    allowPublicEndpoints: state.allowPublicEndpoints,
  });
  if (result.ok && state.latencySamples) {
    const ring = state.latencySamples.get(target.name) ?? [];
    pushLatencySample(ring, result.latencyMs, config.latencyRingSize ?? 20);
    state.latencySamples.set(target.name, ring);
  }
  const guarded = await applyCompletionBusyGuard(
    target,
    config,
    result,
    state,
    deps,
    priorConsecutiveFailures,
  );
  if (result.ok) {
    state.lastSlotProgress?.delete(target.name);
  }

  state.consecutiveFailures.set(target.name, guarded.consecutiveFailures);
  const snapshot: CompletionProbeSnapshot = {
    ran: true,
    ok: result.ok,
    status: result.status,
    consecutiveFailures: guarded.consecutiveFailures,
    latencyMs: result.latencyMs,
    ...(guarded.reason ? { reason: guarded.reason } : {}),
    ...(sampleCountBeforeProbe >= (config.minSamples ?? 5) ? { effectiveTimeoutMs } : {}),
  };
  state.lastResult.set(target.name, snapshot);
  return snapshot;
}

export function makeDefaultProbeFn(
  deps: ProbeFnDeps,
): (target: WorkloadTarget) => Promise<WorkloadSnapshot> {
  return async (target): Promise<WorkloadSnapshot> => {
    const result = await defaultProbeWorkload(target, {
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
      priorConsecutiveErrors: deps.consecutiveErrors.get(target.name) ?? 0,
    });
    deps.consecutiveErrors.set(target.name, result.consecutiveErrors);
    const completionProbe = await runCompletionProbe(target, result, deps);
    return {
      name: target.name,
      kind: target.kind,
      endpoint: redactEndpoint(target.endpoint),
      priority: target.priority ?? 50,
      rss_mb: null,
      request_rate_5m: null,
      error_rate_5m: 0,
      p50_ms: result.healthLatencyMs,
      p95_ms: result.healthLatencyMs,
      models: result.models,
      reachable: result.reachable,
      consecutiveErrors: result.consecutiveErrors,
      revision: result.revision,
      ...(completionProbe ? { completionProbe } : {}),
    } satisfies WorkloadSnapshot;
  };
}

export function makeUnreachableFallback(
  consecutiveErrors: Map<string, number>,
): (target: WorkloadTarget) => WorkloadSnapshot {
  return (target): WorkloadSnapshot => ({
    name: target.name,
    kind: target.kind,
    endpoint: redactEndpoint(target.endpoint),
    priority: target.priority ?? 50,
    rss_mb: null,
    request_rate_5m: null,
    error_rate_5m: 1,
    p50_ms: 0,
    p95_ms: 0,
    models: [],
    reachable: false,
    consecutiveErrors: (consecutiveErrors.get(target.name) ?? 0) + 1,
    revision: null,
  });
}

export interface PressureTransitionResult {
  pressureDetected: boolean;
  lastPressureLevel: "NORMAL" | "HIGH";
  consecutiveClearTicks: number;
  enteredHighAt: string | null;
  ticksInHigh: number;
}

export function applyPressureTransition(
  ts: string,
  node: string,
  node_mem: NodeMemSnapshot,
  pressure: PressureResult | null,
  pressureWindow: PressureWindow,
  state: PressureTransitionResult,
  pressureThresholds: PressureThresholds,
  writeJournalEntry: (entry: FleetJournalEntry) => void,
): PressureTransitionResult {
  let { lastPressureLevel, consecutiveClearTicks, enteredHighAt, ticksInHigh } = state;

  if (pressure && lastPressureLevel === "NORMAL") {
    const transition: FleetTransitionEntry = {
      kind: "fleet-transition",
      ts,
      node,
      subject: "node",
      subjectKind: "node",
      signal: "pressure",
      from: "NORMAL",
      to: "HIGH",
    };
    writeJournalEntry(transition);
    const proposal: FleetProposalEntry = {
      kind: "fleet-proposal",
      ts,
      node,
      proposalId: `pressure-${node}-${ts}`,
      transition: pressure.transition,
      action: pressure.proposal.action,
    };
    writeJournalEntry(proposal);
    lastPressureLevel = "HIGH";
    consecutiveClearTicks = 0;
    enteredHighAt = ts;
    ticksInHigh = 0;

    const statusEntry: FleetPressureStatusEntry = {
      kind: "fleet-pressure-status",
      ts,
      node,
      state: "HIGH",
      enteredAt: enteredHighAt,
      durationMs: 0,
      consecutiveClearTicks,
      clearTicksNeeded: pressureThresholds.clearTicks,
      free_mb: node_mem.free_mb,
      compressor_mb: node_mem.compressor_mb,
      headroomBreach: node_mem.free_mb < pressureThresholds.headroomMinMb,
      compressorBreach: node_mem.compressor_mb > pressureThresholds.compressorWarnMb,
    };
    writeJournalEntry(statusEntry);
  } else if (lastPressureLevel === "HIGH") {
    ticksInHigh++;
    const latestWindowEntry = pressureWindow.tail(1)[0];
    if (latestWindowEntry && isPressureHot(latestWindowEntry, pressureThresholds)) {
      consecutiveClearTicks = 0;
    } else {
      consecutiveClearTicks++;
      if (consecutiveClearTicks >= pressureThresholds.clearTicks) {
        const transition: FleetTransitionEntry = {
          kind: "fleet-transition",
          ts,
          node,
          subject: "node",
          subjectKind: "node",
          signal: "pressure-cleared",
          from: "HIGH",
          to: "NORMAL",
        };
        writeJournalEntry(transition);
        lastPressureLevel = "NORMAL";
        consecutiveClearTicks = 0;
        enteredHighAt = null;
        ticksInHigh = 0;
      }
    }
  }

  return {
    pressureDetected: pressure !== null,
    lastPressureLevel,
    consecutiveClearTicks,
    enteredHighAt,
    ticksInHigh,
  };
}

export function emitPeriodicPressureStatus(
  ts: string,
  node: string,
  node_mem: NodeMemSnapshot,
  state: {
    enteredHighAt: string | null;
    consecutiveClearTicks: number;
    ticksInHigh: number;
    lastPressureLevel: "NORMAL" | "HIGH";
  },
  pressureThresholds: PressureThresholds,
  pressureStatusEveryTicks: number,
  writeJournalEntry: (entry: FleetJournalEntry) => void,
): void {
  if (
    state.lastPressureLevel === "HIGH" &&
    pressureStatusEveryTicks > 0 &&
    state.ticksInHigh % pressureStatusEveryTicks === 0
  ) {
    if (state.enteredHighAt === null) return;
    const statusEntry: FleetPressureStatusEntry = {
      kind: "fleet-pressure-status",
      ts,
      node,
      state: "HIGH",
      enteredAt: state.enteredHighAt,
      durationMs: new Date(ts).getTime() - new Date(state.enteredHighAt).getTime(),
      consecutiveClearTicks: state.consecutiveClearTicks,
      clearTicksNeeded: pressureThresholds.clearTicks,
      free_mb: node_mem.free_mb,
      compressor_mb: node_mem.compressor_mb,
      headroomBreach: node_mem.free_mb < pressureThresholds.headroomMinMb,
      compressorBreach: node_mem.compressor_mb > pressureThresholds.compressorWarnMb,
    };
    writeJournalEntry(statusEntry);
  }
}

export function applyWorkloadDegradation(
  ts: string,
  node: string,
  workloads: WorkloadSnapshot[],
  degradationThresholds: DegradationThresholds,
  workloadHealth: Map<string, WorkloadHealthState>,
  writeJournalEntry: (entry: FleetJournalEntry) => void,
): void {
  for (const workload of workloads) {
    const prior = workloadHealth.get(workload.name) ?? "healthy";
    const result = detectDegradation(workload, prior, degradationThresholds);
    if (result) {
      const transition: FleetTransitionEntry = {
        kind: "fleet-transition",
        ts,
        node,
        subject: result.transition.subject,
        subjectKind: result.transition.subjectKind,
        signal: result.transition.signal,
        from: result.transition.from,
        to: result.transition.to,
      };
      writeJournalEntry(transition);
      if (result.proposal) {
        const proposal: FleetProposalEntry = {
          kind: "fleet-proposal",
          ts,
          node,
          proposalId: `degradation-${workload.name}-${ts}`,
          transition: result.proposal.transition,
          action: result.proposal.action,
        };
        writeJournalEntry(proposal);
      }
      workloadHealth.set(workload.name, result.to);
    }
  }
}

export async function evaluateMigrationWorkloads(
  ts: string,
  node: string,
  workloads: WorkloadSnapshot[],
  nodeMem: NodeMemSnapshot,
  pressureDetected: boolean,
  migrationController: MigrationController,
  writeJournalEntry: (entry: FleetJournalEntry) => void,
): Promise<void> {
  const nodeSnapshot: NodeSnapshot = {
    node,
    schedulerLeaseHolder: node,
    pressureState: pressureDetected ? "HIGH" : "NORMAL",
    nodeMem: { freeMb: nodeMem.free_mb },
    workloads,
  };
  for (const workload of workloads) {
    const migrationWorkload: MigrationWorkload = {
      name: workload.name,
      node,
      spec: { placement: "auto" },
      evictProposalId: `evict-${workload.name}-${ts}`,
    };
    const proposal = await migrationController.evaluateMove(migrationWorkload, nodeSnapshot);
    if (proposal) {
      await migrationController.executeMove(proposal, writeJournalEntry);
    }
  }
}
