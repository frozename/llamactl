import { probeNodeMem as defaultProbeNodeMem } from './node-probe.js';
import { probeWorkload as defaultProbeWorkload, redactEndpoint, type WorkloadTarget } from './workload-probe.js';
import { appendFleetJournal, defaultFleetJournalPath } from './journal.js';
import {
  PressureWindow, detectPressure, detectDegradation, isPressureHot,
  type PressureThresholds, type DegradationThresholds, type WorkloadHealthState,
} from './policy.js';
import type {
  FleetHeartbeatEntry,
  FleetJournalEntry,
  FleetProposalEntry,
  FleetSnapshotEntry,
  FleetTransitionEntry,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from './types.js';

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
  /** Run a single tick then resolve `done`. Default: false (loop until stop()). */
  once?: boolean;
  /** Tick interval in ms. Default 30_000. */
  intervalMs?: number;
  /** Per-workload probe timeout. Default 5_000. */
  probeTimeoutMs?: number;
  /** Optional fetch override (used by the default workload probe). */
  fetch?: typeof globalThis.fetch;
  /** Inject a node-memory probe for tests. */
  probeNodeMem?: () => Promise<NodeMemSnapshot>;
  /** Inject a workload probe for tests. */
  probeWorkload?: (target: WorkloadTarget) => Promise<WorkloadSnapshot>;
  /** Inject a journal writer for tests. Defaults to appendFleetJournal at journalPath. */
  writeJournal?: (entry: FleetJournalEntry) => void;
  /** Journal path when writeJournal is not injected. Defaults to ~/.llamactl/fleet-supervisor/journal.jsonl. */
  journalPath?: string;
  /** Callback after each completed snapshot. */
  onTick?: (snapshot: FleetSnapshotEntry) => void | Promise<void>;
  /** Pressure thresholds for L2 detection. Defaults to DEFAULT_PRESSURE_THRESHOLDS. */
  pressureThresholds?: PressureThresholds;
  /** Degradation thresholds for L2 per-workload health. Defaults to DEFAULT_DEGRADATION_THRESHOLDS. */
  degradationThresholds?: DegradationThresholds;
}

export interface SupervisorLoopHandle {
  stop(): void;
  done: Promise<void>;
}

export function startSupervisorLoop(opts: SupervisorLoopOptions): SupervisorLoopHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const probeNodeMem = opts.probeNodeMem ?? defaultProbeNodeMem;
  const journalPath = opts.journalPath ?? defaultFleetJournalPath();
  const writeJournal = opts.writeJournal ?? ((entry: FleetJournalEntry) => appendFleetJournal(entry, journalPath));
  const consecutiveErrors = new Map<string, number>();
  const pressureThresholds = opts.pressureThresholds ?? DEFAULT_PRESSURE_THRESHOLDS;
  const pressureWindow = new PressureWindow(pressureThresholds.consecutiveTicks);
  let lastPressureLevel: 'NORMAL' | 'HIGH' = 'NORMAL';
  let consecutiveClearTicks = 0;
  const degradationThresholds = opts.degradationThresholds ?? DEFAULT_DEGRADATION_THRESHOLDS;
  const workloadHealth = new Map<string, WorkloadHealthState>();

  const probeWorkloadFn = opts.probeWorkload ?? (async (target) => {
    const result = await defaultProbeWorkload(target, {
      fetch: opts.fetch,
      timeoutMs: probeTimeoutMs,
      priorConsecutiveErrors: consecutiveErrors.get(target.name) ?? 0,
    });
    consecutiveErrors.set(target.name, result.consecutiveErrors);
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
    } satisfies WorkloadSnapshot;
  });

  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((res) => { resolveDone = res; });

  const unreachableFallback = (target: WorkloadTarget): WorkloadSnapshot => ({
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
  });

  const tick = async (): Promise<void> => {
    const ts = new Date().toISOString();
    const node_mem = await probeNodeMem();
    const workloads = await Promise.all(
      opts.workloads.map((target) =>
        probeWorkloadFn(target).catch(() => unreachableFallback(target)),
      ),
    );

    const snapshot: FleetSnapshotEntry = {
      kind: 'fleet-snapshot',
      ts,
      node: opts.node,
      node_mem,
      workloads,
    };
    const heartbeat: FleetHeartbeatEntry = {
      kind: 'fleet-heartbeat',
      ts,
      node: opts.node,
    };
    writeJournal(snapshot);
    writeJournal(heartbeat);

  pressureWindow.push(node_mem, workloads);
  const pressure = detectPressure(pressureWindow, pressureThresholds);
  if (pressure && lastPressureLevel === 'NORMAL') {
      const transition: FleetTransitionEntry = {
        kind: 'fleet-transition',
        ts,
        node: opts.node,
        subject: 'node',
        subjectKind: 'node',
        signal: 'pressure',
        from: 'NORMAL',
        to: 'HIGH',
      };
      writeJournal(transition);
      const proposal: FleetProposalEntry = {
        kind: 'fleet-proposal',
        ts,
        node: opts.node,
        proposalId: `pressure-${opts.node}-${ts}`,
        transition: pressure.transition,
        action: pressure.proposal.action,
      };
      writeJournal(proposal);
      lastPressureLevel = 'HIGH';
    consecutiveClearTicks = 0;
  } else if (lastPressureLevel === 'HIGH') {
    const latestWindowEntry = pressureWindow.tail(1)[0];
    if (latestWindowEntry && isPressureHot(latestWindowEntry, pressureThresholds)) {
      consecutiveClearTicks = 0;
    } else {
      consecutiveClearTicks++;
      const clearTicks = pressureThresholds.clearTicks;
      if (consecutiveClearTicks >= clearTicks) {
          const transition: FleetTransitionEntry = {
            kind: 'fleet-transition',
            ts,
            node: opts.node,
            subject: 'node',
            subjectKind: 'node',
            signal: 'pressure-cleared',
            from: 'HIGH',
            to: 'NORMAL',
          };
          writeJournal(transition);
          lastPressureLevel = 'NORMAL';
          consecutiveClearTicks = 0;
        }
      }
    }

    for (const workload of workloads) {
      const prior = workloadHealth.get(workload.name) ?? 'healthy';
      const result = detectDegradation(workload, prior, degradationThresholds);
      if (result) {
        const transition: FleetTransitionEntry = {
          kind: 'fleet-transition',
          ts,
          node: opts.node,
          subject: result.transition.subject,
          subjectKind: result.transition.subjectKind,
          signal: result.transition.signal,
          from: result.transition.from,
          to: result.transition.to,
        };
        writeJournal(transition);
        if (result.proposal) {
          const proposal: FleetProposalEntry = {
            kind: 'fleet-proposal',
            ts,
            node: opts.node,
            proposalId: `degradation-${workload.name}-${ts}`,
            transition: result.proposal.transition,
            action: result.proposal.action,
          };
          writeJournal(proposal);
        }
        workloadHealth.set(workload.name, result.to);
      }
    }

    await opts.onTick?.(snapshot);
  };

  const run = async (): Promise<void> => {
    try {
      await tick();
      if (opts.once || stopped) return;
      while (!stopped) {
        await new Promise<void>((res) => setTimeout(res, intervalMs));
        if (stopped) break;
        await tick();
      }
    } finally {
      resolveDone();
    }
  };

  void run();

  return {
    stop() { stopped = true; },
    done,
  };
}
