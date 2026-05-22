import { probeNodeMem as defaultProbeNodeMem } from './node-probe.js';
import { probeWorkload as defaultProbeWorkload, type WorkloadTarget } from './workload-probe.js';
import { appendFleetJournal, defaultFleetJournalPath } from './journal.js';
import type {
  FleetHeartbeatEntry,
  FleetJournalEntry,
  FleetSnapshotEntry,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from './types.js';

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
  onTick?: (snapshot: FleetSnapshotEntry) => void;
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
      endpoint: target.endpoint,
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
    endpoint: target.endpoint,
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
    opts.onTick?.(snapshot);
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
