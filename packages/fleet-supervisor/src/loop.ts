import type { MigrationController } from "./migration-controller.js";
import type { DegradationThresholds, PressureThresholds, WorkloadHealthState } from "./policy.js";
import type {
  CompletionProbeSnapshot,
  FleetHeartbeatEntry,
  FleetJournalEntry,
  FleetSlotProgressEntry,
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
import { readSlotProgress } from "./slot-progress.js";

export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = {
  headroomMinMb: 512,
  compressorWarnMb: 2048,
  consecutiveTicks: 3,
  clearTicks: 5,
};

export const DEFAULT_DEGRADATION_THRESHOLDS: DegradationThresholds = {
  consecutiveErrorsForDegraded: 3,
  p95DegradedMs: 5000,
  consecutiveCompletionErrorsForDegraded: 2,
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
  /**
   * Self-published scheduler-lease term + eligibility for the derived leader
   * election. When `leaseTerm` is set, every per-tick fleet-snapshot carries a
   * `lease` intent ({ candidate: node, term, eligible: leaseEligible, seq }) that
   * peers replicate; `electLeaseHolder` is a pure function over those intents.
   * Absent => no lease published (back-compat: legacy nodes are ineligible
   * candidates, valid destinations). seq is a per-tick monotonic counter.
   */
  leaseTerm?: number;
  leaseEligible?: boolean;
  /**
   * Read-only: poll each workload's `/slots` per tick and journal a
   * fleet-slot-progress entry. Drives nothing — data collection for the
   * busy-aware-probing design. Default off (`--log-slot-progress`).
   */
  logSlotProgress?: boolean;
  /**
   * Source-staleness auto-reload. OFF unless `startupRev` is set (the CLI sets it
   * in serve mode only). At each loop boundary — after a tick fully resolves,
   * before the next sleep — if the injected `checkSourceStale` reports the running
   * source changed, a `fleet-source-stale` entry is journaled on EVERY stale
   * boundary; once the change is debounced (`shouldReload`) and
   * `reloadOnSourceChange` is on, the service exits via `onSourceReload` so launchd
   * reloads fresh code. The reducer/read live in the injected fn (core-free loop).
   */
  startupRev?: string | null;
  checkSourceStale?: (startupRev: string) => { shouldReload: boolean; currentRev: string | null };
  onSourceReload?: () => void;
  reloadOnSourceChange?: boolean;
}

export interface SupervisorLoopHandle {
  stop(): void;
  done: Promise<void>;
}

interface TickState extends PressureTransitionResult {
  pressureWindow: PressureWindow;
  workloadHealth: Map<string, WorkloadHealthState>;
}

function asMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "unknown tick error";
}

function writeTickError(
  writeJournalEntry: (entry: FleetJournalEntry) => void,
  node: string,
  error: unknown,
): void {
  const message = asMessage(error);
  try {
    writeJournalEntry({
      kind: "fleet-tick-error",
      ts: new Date().toISOString(),
      node,
      message,
    });
  } catch {
    try {
      process.stderr.write(`supervisor: failed to write tick error journal entry: ${message}\n`);
    } catch {
      // Best-effort logging only.
    }
  }
}

async function runTickWithRecovery(
  tick: () => Promise<void>,
  writeJournalEntry: (entry: FleetJournalEntry) => void,
  node: string,
): Promise<void> {
  try {
    await tick();
  } catch (error) {
    writeTickError(writeJournalEntry, node, error);
  }
}

async function logSlotProgressForWorkloads(
  opts: SupervisorLoopOptions,
  ts: string,
  writeJournalEntry: (entry: FleetJournalEntry) => void,
): Promise<void> {
  const timeoutMs = opts.probeTimeoutMs ?? 5_000;
  await Promise.all(
    opts.workloads.map(async (target) => {
      const reading = await readSlotProgress(target.endpoint, {
        ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
        timeoutMs,
      });
      const entry: FleetSlotProgressEntry = {
        kind: "fleet-slot-progress",
        ts,
        node: opts.node,
        workload: target.name,
        available: reading.available,
        slots: reading.slots,
      };
      if (reading.reason !== undefined) entry.reason = reading.reason;
      writeJournalEntry(entry);
    }),
  );
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
  tickSeq: number,
): Promise<void> {
  const ts = new Date().toISOString();
  const node_mem = await (opts.probeNodeMem ?? defaultProbeNodeMem)();
  const workloads = await Promise.all(
    opts.workloads.map((target) =>
      probeWorkloadFn(target).catch(() => unreachableFallback(target)),
    ),
  );

  // Self-published lease intent rides the per-tick snapshot when a term is set.
  // Conditional spread only (exactOptionalPropertyTypes: never `lease: undefined`).
  const leaseIntent =
    opts.leaseTerm !== undefined
      ? {
          candidate: opts.node,
          term: opts.leaseTerm,
          eligible: opts.leaseEligible ?? false,
          seq: tickSeq,
        }
      : undefined;

  // In-flight-move intent (partition safety, design §2/§4): publish moves this
  // node has deployed but not yet removed from the source so a successor honors
  // them. Reflects the state carried into THIS tick (advancePendingHealthPolls
  // runs later, in evaluateMigrationWorkloads). Conditional spread only — never
  // assign `inFlightMoves: undefined` (exactOptionalPropertyTypes).
  const inFlightMoves = migrationController?.getInFlightMoves() ?? [];

  const snapshot: FleetSnapshotEntry = {
    kind: "fleet-snapshot",
    ts,
    node: opts.node,
    node_mem,
    workloads,
    ...(leaseIntent ? { lease: leaseIntent } : {}),
    ...(inFlightMoves.length > 0 ? { inFlightMoves } : {}),
  };
  const heartbeat: FleetHeartbeatEntry = { kind: "fleet-heartbeat", ts, node: opts.node };
  writeJournalEntry(snapshot);
  writeJournalEntry(heartbeat);

  if (opts.logSlotProgress) {
    await logSlotProgressForWorkloads(opts, ts, writeJournalEntry);
  }

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
  const completionState = {
    consecutiveFailures: new Map<string, number>(),
    tickCounter: new Map<string, number>(),
    lastResult: new Map<string, CompletionProbeSnapshot>(),
    lastSlotProgress: new Map<
      string,
      { nPast: number | null; nDecoded: number | null; stallChecks: number; lastAdvanceAt: number }
    >(),
    latencySamples: new Map<string, number[]>(),
    lastRevision: new Map<string, string | null>(),
    readSlotProgress,
  };
  const state: TickState = {
    consecutiveClearTicks: 0,
    enteredHighAt: null,
    lastPressureLevel: "NORMAL",
    ticksInHigh: 0,
    pressureDetected: false,
    pressureWindow: new PressureWindow(pressureThresholds.consecutiveTicks),
    workloadHealth: new Map(),
  };

  const writeJournalEntry = makeDedupJournalWriter(writeJournal);
  const probeWorkloadFn =
    opts.probeWorkload ??
    makeDefaultProbeFn({
      fetch: opts.fetch,
      timeoutMs: probeTimeoutMs,
      consecutiveErrors,
      completion: completionState,
    });
  const unreachableFallback = makeUnreachableFallback(consecutiveErrors);

  let stopped = false;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  const isStopped = (): boolean => stopped;

  const intervalMs = opts.intervalMs ?? 30_000;
  const startupRev = opts.startupRev;
  const reloadOnSourceChange = opts.reloadOnSourceChange ?? true;
  const onSourceReload =
    opts.onSourceReload ??
    ((): void => {
      process.exit(0);
    });
  // Last emitted `(currentRev, reloading)` signature — suppress identical
  // consecutive stale boundaries so the warning fires once per transition, not
  // every poll (otherwise --no-reload-on-source-change spams an unrotated stderr
  // file unboundedly since currentRev stays != startupRev forever).
  let lastSourceStaleSig: string | null = null;

  // Loop boundary: after a tick fully resolves, check whether the running source
  // changed since startup; if so, warn — but only when the (rev,reloading)
  // signature changes (log on transition, not on every boundary) — and once the
  // change is debounced, exit so launchd reloads fresh code. Inert unless
  // startupRev is set.
  const checkSourceBoundary = (): void => {
    if (startupRev === undefined || startupRev === null || !opts.checkSourceStale) return;
    const { shouldReload, currentRev } = opts.checkSourceStale(startupRev);
    if (currentRev === null || currentRev === startupRev) return;
    const reloading = shouldReload && reloadOnSourceChange;
    const sig = `${currentRev}|${String(reloading)}`;
    if (sig === lastSourceStaleSig) return;
    lastSourceStaleSig = sig;
    writeJournalEntry({
      kind: "fleet-source-stale",
      ts: new Date().toISOString(),
      node: opts.node,
      startupRev,
      currentRev,
      reloading,
    });
    process.stderr.write(
      `supervisor: source revision changed since startup (was ${startupRev}, now ${currentRev})${
        reloading ? " — reloading" : ""
      }\n`,
    );
    if (reloading) onSourceReload();
  };

  // Per-tick monotonic counter — the lease intent's seq (skew-independent
  // liveness proof). `(tickSeq += 1)` advances once per tick.
  let tickSeq = 0;
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
      (tickSeq += 1),
    );

  const run = async (): Promise<void> => {
    try {
      await runTickWithRecovery(tick, writeJournalEntry, opts.node);
      checkSourceBoundary();
      if (opts.once || isStopped()) return;
      while (!isStopped()) {
        await new Promise<void>((res) => setTimeout(res, intervalMs));
        if (isStopped()) break;
        await runTickWithRecovery(tick, writeJournalEntry, opts.node);
        checkSourceBoundary();
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
