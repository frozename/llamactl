import type { MigrationController } from "./migration-controller.js";
import type { DegradationThresholds, PressureThresholds, WorkloadHealthState } from "./policy.js";
import type {
  FleetHeartbeatEntry,
  FleetJournalEntry,
  FleetSnapshotEntry,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from "./types.js";
import type { WorkloadTarget } from "./workload-probe.js";

import { appendFleetJournal, defaultFleetJournalPath } from "./journal.js";
import {
  applyPressureTransition,
  applyWorkloadDegradation,
  emitPeriodicPressureStatus,
  evaluateMigrationWorkloads,
  makeDedupJournalWriter,
  makeDefaultProbeFn,
  makeUnreachableFallback,
  type PressureTransitionResult,
} from "./loop-helpers.js";
import { probeNodeMem as defaultProbeNodeMem } from "./node-probe.js";
import { detectPressure, PressureWindow } from "./policy.js";

export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = {
  headroomMinMb: 512,
  compressorWarnMb: 2048,
  consecutiveTicks: 3,
  clearTicks: 5,
};

export const DEFAULT_DEGRADATION_THRESHOLDS: DegradationThresholds = {
  consecutiveErrorsForDegraded: 3,
  p95DegradedMs: 5000,
};

export interface SupervisorLoopOptions {
  node: string;
  workloads: WorkloadTarget[];
  once?: boolean;
  intervalMs?: number;
  probeTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  probeNodeMem?: () => Promise<NodeMemSnapshot>;
  probeWorkload?: (target: WorkloadTarget) => Promise<WorkloadSnapshot>;
  writeJournal?: (entry: FleetJournalEntry) => void;
  journalPath?: string;
  onTick?: (snapshot: FleetSnapshotEntry) => void | Promise<void>;
  pressureThresholds?: PressureThresholds;
  degradationThresholds?: DegradationThresholds;
  pressureStatusEveryTicks?: number;
  migrationController?: MigrationController | null;
}

export interface SupervisorLoopHandle {
  stop(): void;
  done: Promise<void>;
}

interface TickState extends PressureTransitionResult {
  pressureWindow: PressureWindow;
  workloadHealth: Map<string, WorkloadHealthState>;
}

async function runTick(
  opts: SupervisorLoopOptions,
  state: TickState,
  probeWorkloadFn: (target: WorkloadTarget) => Promise<WorkloadSnapshot>,
  unreachableFallback: (target: WorkloadTarget) => WorkloadSnapshot,
  pressureThresholds: PressureThresholds,
  degradationThresholds: DegradationThresholds,
  pressureStatusEveryTicks: number,
  migrationController: MigrationController | null,
  writeJournalEntry: (entry: FleetJournalEntry) => void,
): Promise<void> {
  const ts = new Date().toISOString();
  const node_mem = await (opts.probeNodeMem ?? defaultProbeNodeMem)();
  const workloads = await Promise.all(
    opts.workloads.map((target) =>
      probeWorkloadFn(target).catch(() => unreachableFallback(target)),
    ),
  );

  const snapshot: FleetSnapshotEntry = {
    kind: "fleet-snapshot",
    ts,
    node: opts.node,
    node_mem,
    workloads,
  };
  const heartbeat: FleetHeartbeatEntry = { kind: "fleet-heartbeat", ts, node: opts.node };
  writeJournalEntry(snapshot);
  writeJournalEntry(heartbeat);

  state.pressureWindow.push(node_mem, workloads);
  const pressure = detectPressure(state.pressureWindow, pressureThresholds);
  const updated = applyPressureTransition(
    ts,
    opts.node,
    node_mem,
    pressure,
    state.pressureWindow,
    state,
    pressureThresholds,
    writeJournalEntry,
  );
  state.lastPressureLevel = updated.lastPressureLevel;
  state.consecutiveClearTicks = updated.consecutiveClearTicks;
  state.enteredHighAt = updated.enteredHighAt;
  state.ticksInHigh = updated.ticksInHigh;
  state.pressureDetected = updated.pressureDetected;

  emitPeriodicPressureStatus(
    ts,
    opts.node,
    node_mem,
    state,
    pressureThresholds,
    pressureStatusEveryTicks,
    writeJournalEntry,
  );

  applyWorkloadDegradation(
    ts,
    opts.node,
    workloads,
    degradationThresholds,
    state.workloadHealth,
    writeJournalEntry,
  );

  if (migrationController) {
    await evaluateMigrationWorkloads(
      ts,
      opts.node,
      workloads,
      node_mem,
      state.pressureDetected,
      migrationController,
      writeJournalEntry,
    );
  }

  await opts.onTick?.(snapshot);
}

export function startSupervisorLoop(opts: SupervisorLoopOptions): SupervisorLoopHandle {
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const journalPath = opts.journalPath ?? defaultFleetJournalPath();
  const writeJournal =
    opts.writeJournal ??
    ((entry: FleetJournalEntry): void => {
      appendFleetJournal(entry, journalPath);
    });
  const pressureThresholds = opts.pressureThresholds ?? DEFAULT_PRESSURE_THRESHOLDS;
  const degradationThresholds = opts.degradationThresholds ?? DEFAULT_DEGRADATION_THRESHOLDS;
  const pressureStatusEveryTicks = opts.pressureStatusEveryTicks ?? 5;
  const migrationController = opts.migrationController ?? null;

  const consecutiveErrors = new Map<string, number>();
  const state: TickState = {
    consecutiveClearTicks: 0,
    enteredHighAt: null,
    lastPressureLevel: "NORMAL",
    ticksInHigh: 0,
    pressureDetected: false,
    pressureWindow: new PressureWindow(pressureThresholds.consecutiveTicks),
    workloadHealth: new Map(),
  };

  const writeJournalEntry = makeDedupJournalWriter(writeJournal, new Set<string>());
  const probeWorkloadFn =
    opts.probeWorkload ??
    makeDefaultProbeFn({ fetch: opts.fetch, timeoutMs: probeTimeoutMs, consecutiveErrors });
  const unreachableFallback = makeUnreachableFallback(consecutiveErrors);

  let stopped = false;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  const isStopped = (): boolean => stopped;

  const intervalMs = opts.intervalMs ?? 30_000;

  const tick = (): Promise<void> =>
    runTick(
      opts,
      state,
      probeWorkloadFn,
      unreachableFallback,
      pressureThresholds,
      degradationThresholds,
      pressureStatusEveryTicks,
      migrationController,
      writeJournalEntry,
    );

  const run = async (): Promise<void> => {
    try {
      await tick();
      if (opts.once || isStopped()) return;
      while (!isStopped()) {
        await new Promise<void>((res) => setTimeout(res, intervalMs));
        if (isStopped()) break;
        await tick();
      }
    } finally {
      resolveDone?.();
    }
  };

  void run();

  return {
    stop(): void {
      stopped = true;
    },
    done,
  };
}
