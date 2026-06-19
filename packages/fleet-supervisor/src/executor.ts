import { existsSync, readFileSync } from "node:fs";

import type { FleetExecutionEntry, FleetJournalEntry, FleetProposalEntry } from "./types.js";

import { actionTier } from "./types.js";

export type { FleetExecutionEntry };
export { actionTier };

export interface ExecutorOptions {
  node: string;
  auto: boolean;
  severityThreshold: 1 | 2 | 3;
  /** Manual single-proposal override: execute this proposalId regardless of tier/auto. */
  executeId?: string;
  journalPath: string;
  writeJournal: (entry: FleetJournalEntry) => void;
  /** Injectable for tests; defaults to reading from journalPath. */
  readJournal?: (path: string) => FleetJournalEntry[];
  /** Disable a workload by name; returns exit code. */
  disable: (workload: string) => Promise<number>;
  /** Enable a workload by name; returns exit code. */
  enable: (workload: string) => Promise<number>;
  /**
   * Resolve a workload's `spec.restartPolicy` from its manifest. When it returns
   * "Never", evict/restart actions are skipped so the supervisor cannot thrash a
   * workload the controller's reconcile loop deliberately leaves alone (see
   * remote `reconcileLoop` — it filters Never-policy manifests out). Returning
   * undefined (manifest missing / unreadable) means "no protection" and the
   * action proceeds. Optional: when omitted, no restartPolicy gate is applied.
   */
  loadRestartPolicy?: (workload: string) => string | undefined;
}

function defaultReadJournal(path: string): FleetJournalEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FleetJournalEntry];
      } catch {
        return [];
      }
    });
}

export async function runExecutor(opts: ExecutorOptions): Promise<FleetExecutionEntry[]> {
  const read = opts.readJournal ?? defaultReadJournal;
  const entries = read(opts.journalPath);

  const proposals = entries.filter(
    (e): e is FleetProposalEntry => e.kind === "fleet-proposal" && e.node === opts.node,
  );

  const executedIds = new Set(
    entries
      .filter((e): e is FleetExecutionEntry => e.kind === "fleet-execution")
      .map((e) => e.proposalId),
  );

  const pending = proposals.filter((p) => !executedIds.has(p.proposalId));

  const nowMs = Date.now();
  const results: FleetExecutionEntry[] = [];
  for (const proposal of pending) {
    if (typeof proposal.expiresAt === "string") {
      const expiresAtMs = Date.parse(proposal.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
        const entry: FleetExecutionEntry = {
          kind: "fleet-execution",
          ts: new Date(nowMs).toISOString(),
          node: opts.node,
          proposalId: proposal.proposalId,
          action: proposal.action,
          status: "skipped",
          reason: "expired",
        };
        opts.writeJournal(entry);
        results.push(entry);
        continue;
      }
    }
    const result = await executeOne(proposal, opts);
    if (result !== null) results.push(result);
  }
  return results;
}

type ExecutionEntryBase = Pick<
  FleetExecutionEntry,
  "action" | "kind" | "node" | "proposalId" | "ts"
>;

// Returns null when both the initial enable and the recovery re-enable fail after
// a successful disable — null suppresses journaling so the proposal stays
// retryable on the next supervisor tick instead of being permanently deduped.
async function executeRestart(
  workload: string,
  opts: ExecutorOptions,
  base: ExecutionEntryBase,
): Promise<FleetExecutionEntry | null> {
  const disableCode = await opts.disable(workload);
  if (disableCode !== 0) {
    return {
      ...base,
      status: "failed",
      exitCode: disableCode,
      reason: "disable phase failed",
    };
  }
  const enableCode = await opts.enable(workload);
  if (enableCode === 0) {
    return { ...base, status: "executed", exitCode: enableCode };
  }
  // Enable failed after disable — attempt one bounded recovery re-enable to
  // avoid stranding the workload in the disabled state.
  const recoveryCode = await opts.enable(workload);
  if (recoveryCode === 0) {
    return { ...base, status: "executed", exitCode: recoveryCode };
  }
  // Both enable attempts failed; return null to suppress the journal write so
  // the proposal is not permanently deduped and the next tick can retry.
  return null;
}

function isRestartPolicyNever(workload: string, opts: ExecutorOptions): boolean {
  if (!opts.loadRestartPolicy) return false;
  try {
    return opts.loadRestartPolicy(workload) === "Never";
  } catch {
    // Manifest unreadable / missing → no protection signal, let the action run.
    return false;
  }
}

async function executeAction(
  action: FleetProposalEntry["action"],
  opts: ExecutorOptions,
  base: ExecutionEntryBase,
): Promise<FleetExecutionEntry | null> {
  try {
    if (action.type === "mark-degraded") {
      return { ...base, status: "executed" };
    }

    if (action.type === "evict") {
      if (isRestartPolicyNever(action.workload, opts)) {
        return { ...base, status: "skipped", reason: "restartPolicy:Never" };
      }
      const exitCode = await opts.disable(action.workload);
      return { ...base, status: exitCode === 0 ? "executed" : "failed", exitCode };
    }

    if (action.type === "restart") {
      if (isRestartPolicyNever(action.workload, opts)) {
        return { ...base, status: "skipped", reason: "restartPolicy:Never" };
      }
      return await executeRestart(action.workload, opts, base);
    }
  } catch (err) {
    return { ...base, status: "failed", reason: (err as Error).message };
  }

  // TypeScript exhaustive guard — unreachable with current action union
  return { ...base, status: "skipped", reason: "unknown action type" };
}

async function executeOne(
  proposal: FleetProposalEntry,
  opts: ExecutorOptions,
): Promise<FleetExecutionEntry | null> {
  const ts = new Date().toISOString();
  const tier = actionTier(proposal.action);
  const isManualOverride = opts.executeId === proposal.proposalId;
  const shouldExecute = isManualOverride || (opts.auto && tier <= opts.severityThreshold);

  const base: ExecutionEntryBase = {
    kind: "fleet-execution",
    ts,
    node: opts.node,
    proposalId: proposal.proposalId,
    action: proposal.action,
  };

  if (!shouldExecute) {
    const reason = !opts.auto
      ? "--auto not set"
      : `tier ${String(tier)} exceeds threshold ${String(opts.severityThreshold)}`;
    const entry: FleetExecutionEntry = { ...base, status: "skipped", reason };
    opts.writeJournal(entry);
    return entry;
  }

  const entry = await executeAction(proposal.action, opts, base);
  if (entry !== null) {
    opts.writeJournal(entry);
  }
  return entry;
}
