import type { FleetExecutionEntry, FleetJournalEntry, FleetProposalEntry } from "./types.js";

import { existsSync, readFileSync } from "./safe-fs.js";
import { actionTier } from "./types.js";

export type { FleetExecutionEntry };
export { actionTier };

const DEFAULT_MAX_EXECUTION_ATTEMPTS = 3;
const EXECUTION_RETRY_DELAY_MS = 30_000;

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
  /** Override wall-clock time for retry backoff calculations. */
  nowMs?: number;
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

interface ExecutionRetryState {
  terminal: boolean;
  pending: boolean;
  attempt: number;
  maxAttempts: number;
  blockedUntilMs: number | null;
}

function parseFailureAttemptState(entry: FleetExecutionEntry): ExecutionRetryState | null {
  const attempt = entry.attempt;
  const maxAttempts = entry.maxAttempts ?? DEFAULT_MAX_EXECUTION_ATTEMPTS;
  if (typeof attempt !== "number" || !Number.isFinite(attempt)) return null;
  if (
    !Number.isInteger(attempt) ||
    attempt <= 0 ||
    !Number.isFinite(maxAttempts) ||
    maxAttempts <= 0
  ) {
    return null;
  }
  const blockedUntilMs =
    typeof entry.nextAttemptAt === "string" ? Date.parse(entry.nextAttemptAt) : Number.NaN;
  return {
    terminal: attempt >= maxAttempts,
    pending: attempt < maxAttempts,
    attempt,
    maxAttempts,
    blockedUntilMs: Number.isFinite(blockedUntilMs) ? blockedUntilMs : null,
  };
}

function parseRetryDelayMs(attempt: number): number {
  return EXECUTION_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
}

function getExecutionRetryState(
  proposalId: string,
  entries: FleetJournalEntry[],
  nowMs: number,
): ExecutionRetryState {
  const proposalEntries = entries.filter(
    (entry): entry is FleetExecutionEntry =>
      entry.kind === "fleet-execution" && entry.proposalId === proposalId,
  );

  if (
    proposalEntries.some(
      (entry) =>
        entry.status === "executed" || entry.status === "skipped" || entry.attempt === undefined,
    )
  ) {
    return {
      terminal: true,
      pending: false,
      attempt: 0,
      maxAttempts: DEFAULT_MAX_EXECUTION_ATTEMPTS,
      blockedUntilMs: null,
    };
  }

  const retryCandidates = proposalEntries
    .filter(
      (entry): entry is FleetExecutionEntry =>
        entry.status === "failed" && entry.attempt !== undefined,
    )
    .map((entry) => parseFailureAttemptState(entry))
    .filter((candidate): candidate is ExecutionRetryState => candidate !== null)
    .sort((a, b) => b.attempt - a.attempt);

  if (retryCandidates.length === 0) {
    return {
      terminal: false,
      pending: true,
      attempt: 0,
      maxAttempts: DEFAULT_MAX_EXECUTION_ATTEMPTS,
      blockedUntilMs: null,
    };
  }

  const [latest] = retryCandidates;
  if (latest === undefined) {
    return {
      terminal: false,
      pending: true,
      attempt: 0,
      maxAttempts: DEFAULT_MAX_EXECUTION_ATTEMPTS,
      blockedUntilMs: null,
    };
  }

  if (latest.terminal) {
    return {
      terminal: true,
      pending: false,
      attempt: latest.attempt,
      maxAttempts: latest.maxAttempts,
      blockedUntilMs: null,
    };
  }
  if (latest.blockedUntilMs !== null && latest.blockedUntilMs > nowMs) {
    return {
      terminal: false,
      pending: false,
      attempt: latest.attempt,
      maxAttempts: latest.maxAttempts,
      blockedUntilMs: latest.blockedUntilMs,
    };
  }
  return {
    terminal: false,
    pending: true,
    attempt: latest.attempt,
    maxAttempts: latest.maxAttempts,
    blockedUntilMs: null,
  };
}

function makeRetryFailureEntry(
  entry: FleetExecutionEntry,
  attempt: number,
  maxAttempts: number,
  nowMs: number,
): FleetExecutionEntry {
  if (attempt >= maxAttempts) {
    return {
      ...entry,
      attempt,
      maxAttempts,
      reason: `${entry.reason ?? "execution failed"}; giving up after ${String(attempt)}/${String(maxAttempts)} attempts`,
    };
  }

  const nextAttemptAtMs = nowMs + parseRetryDelayMs(attempt);
  return {
    ...entry,
    attempt,
    maxAttempts,
    nextAttemptAt: new Date(nextAttemptAtMs).toISOString(),
    reason: `${entry.reason ?? "execution failed"}; retry ${String(attempt)}/${String(maxAttempts)}; will retry after ${String(parseRetryDelayMs(attempt))}ms`,
  };
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

  const nowMs = opts.nowMs ?? Date.now();
  const results: FleetExecutionEntry[] = [];
  for (const proposal of proposals) {
    const retryState = getExecutionRetryState(proposal.proposalId, entries, nowMs);
    if (retryState.terminal || !retryState.pending) {
      continue;
    }

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

    const result = await executeOne(proposal, opts, retryState, nowMs);
    if (result !== null) results.push(result);
  }
  return results;
}

type ExecutionEntryBase = Pick<
  FleetExecutionEntry,
  "action" | "kind" | "node" | "proposalId" | "ts"
>;

async function executeRestart(
  workload: string,
  opts: ExecutorOptions,
  base: ExecutionEntryBase,
): Promise<FleetExecutionEntry> {
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
  const recoveryCode = await opts.enable(workload);
  if (recoveryCode === 0) {
    return { ...base, status: "executed", exitCode: recoveryCode };
  }
  // Enable failed after disable + one bounded recovery attempt — keep failure
  // retryable via attempt metadata.
  return {
    ...base,
    status: "failed",
    exitCode: recoveryCode,
    reason: "enable phase failed",
  };
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

function isRetryableFailure(entry: FleetExecutionEntry): boolean {
  if (entry.status !== "failed") return false;
  if (entry.action.type === "mark-degraded") return false;
  if (entry.action.type === "evict") return true;
  if (entry.action.type === "restart") return true;
  return false;
}

async function executeOne(
  proposal: FleetProposalEntry,
  opts: ExecutorOptions,
  retryState: ExecutionRetryState,
  nowMs: number,
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

  let entry = await executeAction(proposal.action, opts, base);
  if (entry === null) return null;
  if (isRetryableFailure(entry)) {
    const retryAttempt = retryState.attempt + 1;
    entry = makeRetryFailureEntry(entry, retryAttempt, retryState.maxAttempts, nowMs);
  }

  // Outcomes are journaled immediately; retry states are represented in entry metadata.
  opts.writeJournal(entry);
  return entry;
}
