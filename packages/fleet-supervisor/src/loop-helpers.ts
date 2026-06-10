import type {
  MigrationController,
  MigrationWorkload,
  NodeSnapshot,
} from "./migration-controller.js";
import type {
  PressureResult,
  PressureThresholds,
  PressureWindow,
  WorkloadHealthState,
} from "./policy.js";
import type {
  FleetJournalEntry,
  FleetPressureStatusEntry,
  FleetProposalEntry,
  FleetTransitionEntry,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from "./types.js";
import type { WorkloadTarget } from "./workload-probe.js";

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

export interface ProbeFnDeps {
  fetch: typeof globalThis.fetch | undefined;
  timeoutMs: number;
  consecutiveErrors: Map<string, number>;
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
  degradationThresholds: { consecutiveErrorsForDegraded: number; p95DegradedMs: number },
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
